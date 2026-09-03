// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_ID, type KdfParams, type KeepHeader, type SealedBox } from '@shared/format/types.js';
import { randomBytes, randomSecret, uuid } from '../crypto/random.js';
import { writeContainer } from '../format/container.js';
import { newHeader } from '../format/header.js';
import { backupPathFor, tempPathFor, writeVaultFileAtomically } from '../vault/atomic-write.js';
import {
  probeVaultHeader,
  VaultWatcher,
  type DirectoryWatchCallbacks,
  type ExternalChange,
  type ScheduleFn,
  type UnreadableReason,
  type VaultWatcherOptions,
  type WatchDirectoryFn,
} from './vault-watcher.js';

/**
 * The watcher's job is almost entirely negative: with one exception these tests assert that
 * *nothing* happened. That is the point. A watcher that reports a real external change is
 * easy; a watcher that reports our own save, or a touched mtime, or a sync client's momentary
 * rename, trains the user to dismiss the prompt — and the one time it matters, they dismiss
 * that too. So every way this thing can cry wolf gets a test, and the "it works" case gets
 * one.
 *
 * **Nothing here sleeps.** Both sources of time are injected: `FakeClock` is the only timer,
 * and `FakeWatchSource` is the only source of filesystem events. Every test drives the state
 * machine one step at a time and is therefore as deterministic on a loaded CI box as on an
 * idle laptop. The *file* is real — a real temp directory, real `writeVaultFileAtomically`,
 * real KEEP containers — because the thing being tested is what the header on disk says.
 */

// ── Fixtures ─────────────────────────────────────────────────────────────────

const LOCAL_DEVICE = 'device-this-process';
const PEER_DEVICE = 'device-the-other-laptop';

/** A DEK, not a derived key: `writeContainer` needs one and nothing here ever unlocks. */
const DEK = randomSecret(32);

const KDF: KdfParams = {
  alg: KDF_ID,
  memoryKib: 19_456,
  iterations: 2,
  parallelism: 1,
  salt: Buffer.from(randomBytes(16)).toString('base64'),
};

const WRAPPED_DEK: SealedBox = {
  nonce: Buffer.from(randomBytes(12)).toString('base64'),
  ciphertext: Buffer.from(randomBytes(32)).toString('base64'),
  tag: Buffer.from(randomBytes(16)).toString('base64'),
};

interface VaultShape {
  readonly vaultId?: string;
  readonly deviceId?: string;
  readonly generation?: number;
  readonly modifiedAt?: number;
  /** Padding inside the encrypted body, to make a file whose header is far from its end. */
  readonly bodyPadding?: number;
}

let vaultId: string;

function vaultBytes(shape: VaultShape = {}): Uint8Array {
  const base = newHeader({
    vaultId: shape.vaultId ?? vaultId,
    deviceId: shape.deviceId ?? PEER_DEVICE,
    kdf: KDF,
    wrappedDek: WRAPPED_DEK,
    now: 1_700_000_000_000,
  });
  const header: KeepHeader = {
    ...base,
    generation: shape.generation ?? 1,
    modifiedAt: shape.modifiedAt ?? base.modifiedAt,
  };
  const body = `{"records":[],"pad":"${'x'.repeat(shape.bodyPadding ?? 0)}"}`;
  return writeContainer(
    header,
    { body: new Uint8Array(Buffer.from(body, 'utf8')), attachments: [] },
    DEK
  );
}

// ── The injected clock ───────────────────────────────────────────────────────

/**
 * Every timer the watcher asks for, held until a test runs it.
 *
 * Delays are recorded but not ordered by: with the poll disabled there is at most one settle
 * timer and one re-arm timer outstanding, so insertion order is the real order.
 */
class FakeClock {
  #pending = new Map<number, { callback: () => void; delayMs: number }>();
  #nextId = 1;

  readonly schedule: ScheduleFn = (callback, delayMs) => {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#pending.set(id, { callback, delayMs });
    return () => {
      this.#pending.delete(id);
    };
  };

  get pending(): number {
    return this.#pending.size;
  }

  get delays(): number[] {
    return [...this.#pending.values()].map((entry) => entry.delayMs);
  }

  /** Runs everything scheduled right now. Anything scheduled during the run waits its turn. */
  runPending(): void {
    for (const [id, entry] of [...this.#pending]) {
      if (this.#pending.delete(id)) entry.callback();
    }
  }
}

// ── The injected watch ───────────────────────────────────────────────────────

class FakeWatchSource {
  #callbacks: DirectoryWatchCallbacks | null = null;
  directories: string[] = [];
  closes = 0;
  /** Set to make the next `watchDirectory` throw, as `fs.watch` does on a missing directory. */
  failNextArm = false;

  readonly watchDirectory: WatchDirectoryFn = (directory, callbacks) => {
    if (this.failNextArm) {
      this.failNextArm = false;
      throw new Error('simulated ENOENT from fs.watch');
    }
    this.directories.push(directory);
    this.#callbacks = callbacks;
    return {
      close: () => {
        this.closes += 1;
        this.#callbacks = null;
      },
    };
  };

  get armed(): boolean {
    return this.#callbacks !== null;
  }

  emit(...filenames: (string | null)[]): void {
    const callbacks = this.#callbacks;
    if (callbacks === null) throw new Error('emit() with no watch armed');
    for (const filename of filenames) callbacks.onEntry(filename);
  }

  fail(): void {
    this.#callbacks?.onError();
  }
}

// ── Harness ──────────────────────────────────────────────────────────────────

let dir: string;
let vaultPath: string;
let clock: FakeClock;
let source: FakeWatchSource;
let changes: ExternalChange[];
let unreadable: UnreadableReason[];
let watcher: VaultWatcher | null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'keyhold-watch-'));
  vaultPath = join(dir, 'test.keep');
  vaultId = uuid();
  clock = new FakeClock();
  source = new FakeWatchSource();
  changes = [];
  unreadable = [];
  watcher = null;
});

afterEach(async () => {
  watcher?.stop();
  await rm(dir, { recursive: true, force: true });
});

function makeWatcher(overrides: Partial<VaultWatcherOptions> = {}): VaultWatcher {
  const created = new VaultWatcher({
    path: vaultPath,
    localDeviceId: LOCAL_DEVICE,
    onExternalChange: (change) => changes.push(change),
    onUnreadable: (reason) => unreadable.push(reason),
    settleMs: 5,
    // Off by default so `clock.pending` is a clean statement about the settle timer alone.
    // The poll gets its own test.
    pollIntervalMs: null,
    rearmDelayMs: 7,
    schedule: clock.schedule,
    watchDirectory: source.watchDirectory,
    ...overrides,
  });
  watcher = created;
  return created;
}

/** Runs the timers that are due, then waits for any probe they started. */
async function step(target: VaultWatcher): Promise<void> {
  clock.runPending();
  await target.settled();
}

/** Runs until nothing is scheduled, or `rounds` steps have passed. */
async function drain(target: VaultWatcher, rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    if (clock.pending === 0) return;
    await step(target);
  }
}

/** Starts a watcher and lets its first probe establish the baseline. */
async function started(overrides: Partial<VaultWatcherOptions> = {}): Promise<VaultWatcher> {
  const created = makeWatcher(overrides);
  created.start();
  await drain(created);
  return created;
}

const entry = (path: string): string => basename(path);

/**
 * A file that is long enough to hold a KEEP signature and is not one.
 *
 * Length matters: a file shorter than the eight-byte magic runs off the end of the reader
 * before the signature is compared, so it is reported as `malformed` rather than
 * `not-a-vault`. Both are real states and both have a test; they are just not the same test.
 */
const NOT_A_VAULT = 'this is a text file, not a vault, and it is long enough to say so';

/**
 * Every directory entry one `writeVaultFileAtomically` can touch, plus a `null`.
 *
 * Derived from `atomic-write.ts`'s own exported helpers rather than spelled out, so this
 * cannot drift from the naming scheme it is imitating. Deliberately pessimistic: a real save
 * does not touch every backup slot on every write, and `null` stands for a platform that
 * declines to name the entry that changed. Feeding the watcher more than the OS ever would is
 * the point — the suppression has to hold for the worst case, not the average one.
 */
function saveBurst(backupCount = 5): (string | null)[] {
  const names: (string | null)[] = [entry(vaultPath), entry(tempPathFor(vaultPath))];
  for (let index = 1; index <= backupCount; index += 1) {
    names.push(entry(backupPathFor(vaultPath, index)));
  }
  // Doubled, because fs.watch on Windows routinely delivers each change more than once.
  return [...names, ...names, null];
}

// ── 1. Our own save ──────────────────────────────────────────────────────────

describe('our own save', () => {
  it('reports nothing, even bracketed with the full burst a real atomic write produces', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 4 }));
    const active = await started();
    expect(changes).toHaveLength(0);

    const release = active.beginLocalWrite();
    try {
      // The real writer: temp file, fsync, backup rotation, rename, directory fsync.
      await writeVaultFileAtomically(
        vaultPath,
        vaultBytes({ generation: 5, deviceId: LOCAL_DEVICE })
      );
      source.emit(...saveBurst());
      await drain(active);
    } finally {
      release();
    }
    await drain(active);

    expect(changes).toEqual([]);
    expect(unreadable).toEqual([]);
    // The baseline moved forward, so the *next* external change is measured correctly.
    expect(active.known?.generation).toBe(5);
  });

  it('reports nothing even when the caller forgets to bracket it', async () => {
    // The device-id rule is the load-bearing one; the write window is an optimisation on top.
    // A save that skips the bracket entirely must still be silent.
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 1 }));
    const active = await started();

    await writeVaultFileAtomically(
      vaultPath,
      vaultBytes({ generation: 2, deviceId: LOCAL_DEVICE })
    );
    source.emit(...saveBurst());
    await drain(active);

    expect(changes).toEqual([]);
    expect(active.known?.generation).toBe(2);
  });

  it('does not even read the file for a backup or temp-file event', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 1 }));
    await started();
    expect(clock.pending).toBe(0);

    source.emit(entry(tempPathFor(vaultPath)), entry(backupPathFor(vaultPath, 1)));

    // Nothing scheduled at all. The sidecars are the majority of a save's events and they are
    // dropped by name, before any I/O — see the allow-list note in the watcher's header.
    expect(clock.pending).toBe(0);
    expect(changes).toEqual([]);
  });

  it('does not report a transient missing file while our own write is in flight', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 1 }));
    const active = await started();

    const release = active.beginLocalWrite();
    // The instant between "the old file is gone" and "the new one is in place".
    await rm(vaultPath, { force: true });
    source.emit(entry(vaultPath), entry(vaultPath));
    await drain(active);
    expect(unreadable).toEqual([]);

    await writeVaultFileAtomically(
      vaultPath,
      vaultBytes({ generation: 2, deviceId: LOCAL_DEVICE })
    );
    release();
    await drain(active);

    expect(unreadable).toEqual([]);
    expect(changes).toEqual([]);
    expect(active.known?.generation).toBe(2);
  });
});

// ── 2. A genuine external change ─────────────────────────────────────────────

describe('a genuine external change', () => {
  it('reports exactly one, and does not report it again', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 7 }));
    const active = await started();

    await writeVaultFileAtomically(
      vaultPath,
      vaultBytes({ generation: 8, deviceId: 'device-a-third-machine' })
    );
    source.emit(entry(vaultPath));
    await drain(active);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      path: vaultPath,
      differentVault: false,
      wentBackwards: false,
    });
    expect(changes[0]?.known.generation).toBe(7);
    expect(changes[0]?.current.generation).toBe(8);
    expect(changes[0]?.current.deviceId).toBe('device-a-third-machine');

    // Every further event about the same file is silent: the baseline moved.
    source.emit(entry(vaultPath), entry(vaultPath), null);
    await drain(active);
    expect(changes).toHaveLength(1);
  });

  it('flags a different vault dropped at the same path', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 3 }));
    const active = await started();

    await writeVaultFileAtomically(
      vaultPath,
      vaultBytes({ vaultId: uuid(), generation: 1, deviceId: PEER_DEVICE })
    );
    source.emit(entry(vaultPath));
    await drain(active);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.differentVault).toBe(true);
    // A different vault is not "went backwards", even though its generation is lower.
    expect(changes[0]?.wentBackwards).toBe(false);
  });

  it('flags an older copy restored over the live file', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 9 }));
    const active = await started();

    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 4 }));
    source.emit(entry(vaultPath));
    await drain(active);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.wentBackwards).toBe(true);
  });

  it('flags an older copy even when our own device id is on it', async () => {
    // A `.bak.N` this process wrote, copied back over the vault out of band. Reloading it
    // would silently discard newer edits, so the device-id suppression must not swallow it.
    await writeVaultFileAtomically(
      vaultPath,
      vaultBytes({ generation: 9, deviceId: LOCAL_DEVICE })
    );
    const active = await started();

    await writeVaultFileAtomically(
      vaultPath,
      vaultBytes({ generation: 6, deviceId: LOCAL_DEVICE })
    );
    source.emit(entry(vaultPath));
    await drain(active);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.wentBackwards).toBe(true);
  });

  it('reports a change made while the watcher was stopped, once it starts again', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 1 }));
    const active = await started();
    active.stop();

    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 2 }));
    active.start();
    await drain(active);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.current.generation).toBe(2);
  });
});

// ── 3. The file vanishing and coming back ────────────────────────────────────

describe('the file vanishing and coming back', () => {
  it('says nothing when it returns unchanged', async () => {
    const bytes = vaultBytes({ generation: 2 });
    await writeVaultFileAtomically(vaultPath, bytes);
    const active = await started();

    // Exactly what a sync client does mid-download: rename away, write, rename back.
    await rm(vaultPath, { force: true });
    source.emit(entry(vaultPath));
    await step(active);
    expect(unreadable).toEqual([]);

    await writeFile(vaultPath, bytes);
    source.emit(entry(vaultPath));
    await drain(active);

    expect(unreadable).toEqual([]);
    expect(changes).toEqual([]);
    expect(active.watching).toBe(true);
  });

  it('reports the change when it returns different', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 2 }));
    const active = await started();

    await rm(vaultPath, { force: true });
    source.emit(entry(vaultPath));
    await step(active);

    await writeFile(vaultPath, vaultBytes({ generation: 3 }));
    source.emit(entry(vaultPath));
    await drain(active);

    expect(unreadable).toEqual([]);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.current.generation).toBe(3);
  });

  it('reports a file that is really gone, once, and recovers afterwards', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 2 }));
    const active = await started();

    await rm(vaultPath, { force: true });
    source.emit(entry(vaultPath));
    await drain(active);
    expect(unreadable).toEqual(['missing']);

    // Still gone, still only reported once.
    source.emit(entry(vaultPath), entry(vaultPath));
    await drain(active);
    expect(unreadable).toEqual(['missing']);

    await writeFile(vaultPath, vaultBytes({ generation: 5 }));
    source.emit(entry(vaultPath));
    await drain(active);
    expect(unreadable).toEqual(['missing']);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.current.generation).toBe(5);
  });
});

// ── 4. A burst collapsing ────────────────────────────────────────────────────

describe('a burst of events', () => {
  it('collapses to a single scheduled probe and a single report', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 1 }));
    const active = await started();

    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 2 }));
    for (let index = 0; index < 20; index += 1) source.emit(entry(vaultPath));

    // Twenty events, one timer. Each event replaces the pending probe rather than queueing
    // one, so the file is read after the writer stops rather than twenty times during.
    expect(clock.pending).toBe(1);
    await drain(active);
    expect(changes).toHaveLength(1);
  });

  it('coalesces events that arrive while a probe is already reading', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 1 }));
    const active = await started();
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 2 }));

    // Start a probe and, without awaiting it, deliver more events.
    const inflight = active.checkNow();
    source.emit(entry(vaultPath), entry(vaultPath));
    await inflight;
    await drain(active);

    expect(changes).toHaveLength(1);
  });
});

// ── 5. A touched mtime ───────────────────────────────────────────────────────

describe('a touched mtime with an unchanged generation', () => {
  it('reports nothing', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 3 }));
    const active = await started();

    // A cloud client re-stamping a file it did not change. Real `utimes`, real mtime.
    const later = new Date(Date.now() + 60_000);
    await utimes(vaultPath, later, later);
    source.emit(entry(vaultPath), entry(vaultPath), null);
    await drain(active);

    expect(changes).toEqual([]);
    expect(unreadable).toEqual([]);
  });

  it('reports nothing when an identical file is re-downloaded byte for byte', async () => {
    const bytes = vaultBytes({ generation: 3 });
    await writeVaultFileAtomically(vaultPath, bytes);
    const active = await started();

    await writeFile(vaultPath, bytes);
    source.emit(entry(vaultPath));
    await drain(active);

    expect(changes).toEqual([]);
  });
});

// ── 6. A header that cannot be read ──────────────────────────────────────────

describe('a header that cannot be read', () => {
  it('reports "not-a-vault" once for a file that is not a KEEP container', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 1 }));
    const active = await started();

    await writeFile(vaultPath, 'this is a text file, not a vault');
    source.emit(entry(vaultPath));
    await drain(active);

    expect(unreadable).toEqual(['not-a-vault']);
    // Unreadable is not a change. The caller must not be told the vault moved on.
    expect(changes).toEqual([]);

    source.emit(entry(vaultPath));
    await drain(active);
    expect(unreadable).toEqual(['not-a-vault']);
  });

  it('reports "malformed" for a truncated container', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 1 }));
    const active = await started();

    await writeFile(vaultPath, Buffer.from(vaultBytes({ generation: 2 }).subarray(0, 40)));
    source.emit(entry(vaultPath));
    await drain(active);

    expect(unreadable).toEqual(['malformed']);
    expect(changes).toEqual([]);
  });

  it('clears the unreadable state and reports the change once the file is good again', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 1 }));
    const active = await started();

    await writeFile(vaultPath, NOT_A_VAULT);
    source.emit(entry(vaultPath));
    await drain(active);
    expect(unreadable).toEqual(['not-a-vault']);

    await writeFile(vaultPath, vaultBytes({ generation: 2 }));
    source.emit(entry(vaultPath));
    await drain(active);
    expect(changes).toHaveLength(1);

    await writeFile(vaultPath, NOT_A_VAULT);
    source.emit(entry(vaultPath));
    await drain(active);
    expect(unreadable).toEqual(['not-a-vault', 'not-a-vault']);
  });

  it('survives without an onUnreadable callback at all', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 1 }));
    const active = await started({ onUnreadable: undefined });

    await writeFile(vaultPath, 'garbage');
    source.emit(entry(vaultPath));
    await drain(active);

    await writeFile(vaultPath, vaultBytes({ generation: 2 }));
    source.emit(entry(vaultPath));
    await drain(active);
    expect(changes).toHaveLength(1);
  });
});

// ── 7. Stopping ──────────────────────────────────────────────────────────────

describe('stopping', () => {
  it('closes the watch and cancels every timer', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 1 }));
    const active = await started({ pollIntervalMs: 60_000 });
    expect(source.armed).toBe(true);
    expect(clock.pending).toBeGreaterThan(0);

    active.stop();

    expect(active.watching).toBe(false);
    expect(source.armed).toBe(false);
    expect(source.closes).toBe(1);
    expect(clock.pending).toBe(0);
  });

  it('reports nothing after stop, however many events arrive', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 1 }));
    const active = await started();
    const callbacks = source;
    active.stop();

    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 2 }));
    // The watch is closed, so drive the callback the way a late in-flight event would.
    expect(callbacks.armed).toBe(false);
    await active.checkNow();
    clock.runPending();
    await active.settled();

    expect(changes).toEqual([]);
    expect(unreadable).toEqual([]);
    expect(clock.pending).toBe(0);
  });

  it('does not report a change from a probe that was already reading when it stopped', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 1 }));
    const active = await started();
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 2 }));

    const inflight = active.checkNow();
    active.stop();
    await inflight;

    expect(changes).toEqual([]);
  });
});

// ── The watch itself ─────────────────────────────────────────────────────────

describe('the directory watch', () => {
  it('watches the containing directory, never the file', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes());
    await started();
    expect(source.directories).toEqual([dir]);
  });

  it('re-arms after the watch dies, and looks at the file straight away', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 1 }));
    const active = await started();

    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 2 }));
    source.fail();
    expect(source.armed).toBe(false);

    await drain(active);
    expect(source.armed).toBe(true);
    // The watch often dies *because* the thing it watched moved, so the change is not lost.
    expect(changes).toHaveLength(1);
  });

  it('retries when the directory cannot be watched at all', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes());
    source.failNextArm = true;
    const active = makeWatcher();
    active.start();

    expect(source.armed).toBe(false);
    await drain(active);
    expect(source.armed).toBe(true);
  });

  it('polls when told to, catching a change no event announced', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 1 }));
    const active = await started({ pollIntervalMs: 30_000 });

    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 2 }));
    // No `source.emit` at all — this is the missed-event case a network share produces.
    await step(active);
    await drain(active);

    expect(changes).toHaveLength(1);
    expect(clock.delays).toContain(30_000);
  });
});

// ── The probe ────────────────────────────────────────────────────────────────

describe('probeVaultHeader', () => {
  it('reads the header of a vault it has no key for', async () => {
    await writeVaultFileAtomically(
      vaultPath,
      vaultBytes({ generation: 12, deviceId: PEER_DEVICE })
    );

    const probe = await probeVaultHeader(vaultPath);
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.state).toEqual({
      vaultId,
      deviceId: PEER_DEVICE,
      generation: 12,
      modifiedAt: 1_700_000_000_000,
    });
  });

  it('does not touch the body: a corrupt body still yields a readable header', async () => {
    // Proof that the probe is header-only. Authenticating the body would need the DEK, which
    // would need the master password, which would make this useless on a locked vault.
    const bytes = vaultBytes({ generation: 3, bodyPadding: 4_096 });
    const damaged = Uint8Array.from(bytes);
    const target = damaged.length - 64;
    damaged[target] = (damaged[target] ?? 0) ^ 0xff;
    await writeFile(vaultPath, damaged);

    const probe = await probeVaultHeader(vaultPath);
    expect(probe.ok).toBe(true);
    if (probe.ok) expect(probe.state.generation).toBe(3);
  });

  it('grows its read when the first prefix is too small to hold the header', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 5 }));

    // 32 bytes does not even reach the end of the header's JSON.
    const probe = await probeVaultHeader(vaultPath, 32);
    expect(probe.ok).toBe(true);
    if (probe.ok) expect(probe.state.generation).toBe(5);
  });

  it('reports a missing file as missing, not as an error', async () => {
    const probe = await probeVaultHeader(join(dir, 'nothing-here.keep'));
    expect(probe).toEqual({ ok: false, reason: 'missing' });
  });

  it('reports a non-vault as not-a-vault', async () => {
    await writeFile(vaultPath, NOT_A_VAULT);
    expect(await probeVaultHeader(vaultPath)).toEqual({ ok: false, reason: 'not-a-vault' });
  });

  it('reports a file too short to hold a signature as malformed', async () => {
    await writeFile(vaultPath, 'hi');
    expect(await probeVaultHeader(vaultPath)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('reports an empty file as malformed rather than as a change', async () => {
    // A sync client that has created the destination but not yet written to it.
    await writeFile(vaultPath, '');
    expect(await probeVaultHeader(vaultPath)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('leaves no handle behind: the file can be replaced immediately afterwards', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 1 }));
    for (let index = 0; index < 25; index += 1) await probeVaultHeader(vaultPath);

    // A leaked handle per probe is the failure that only shows up on Windows, days later,
    // as a save that will not complete.
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 2 }));
    const probe = await probeVaultHeader(vaultPath);
    expect(probe.ok && probe.state.generation).toBe(2);
  });

  it('works with a tiny probe size on a large file', async () => {
    await writeVaultFileAtomically(vaultPath, vaultBytes({ generation: 2, bodyPadding: 300_000 }));
    const probe = await probeVaultHeader(vaultPath, 64);
    expect(probe.ok && probe.state.generation).toBe(2);
  });
});
