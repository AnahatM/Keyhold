// SPDX-License-Identifier: GPL-3.0-or-later
import { watch } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { VaultError } from '../crypto/errors.js';
import { readPreamble } from '../format/container.js';

/**
 * Noticing that the open vault file changed underneath us.
 *
 * The sync story is "two devices, one cloud folder, and never a lost edit". `mergeDocuments`
 * can reconcile two vaults, but nothing was looking at the file, so a copy pulled down by
 * Dropbox, OneDrive or iCloud — or written by Keyhold on another machine — stayed invisible
 * until the next save overwrote it. This watcher closes that gap, and **only** that gap: it
 * reports, and the caller decides.
 *
 * ## What it must not do, which is most of the design
 *
 * **It must not fire on our own writes.** One save is not one filesystem event. Read
 * `../vault/atomic-write.ts` and count them: a temp file is created and written; the oldest
 * `.bak.N` is removed; every surviving backup is renamed one slot down; the live vault is
 * *copied* to `.bak.1`; and only then is the temp renamed over the vault. That is a dozen
 * directory entries touched for one user action, several of them repeatedly. A watcher that
 * translated each into "someone changed your vault" would be worse than no watcher at all,
 * because people learn to dismiss a prompt that is usually wrong, and then dismiss the one
 * time it is right.
 *
 * Four independent things suppress it, in the order they take effect:
 *
 *   1. **Only the vault's own filename is considered.** `vault.keep.tmp`, `vault.keep.bak.3`
 *      and `vault.keep.recovered-…` are the *majority* of the events a save produces, and
 *      every one of them is dropped by a single name comparison. Note the shape: this is an
 *      allow-list of the one name we care about, not a deny-list of sidecar names — a deny
 *      list would be a second copy of `atomic-write.ts`'s naming scheme (hard rule 8) and
 *      would silently start reporting the day someone adds a new sidecar.
 *   2. **A write window.** `beginLocalWrite()` brackets our own save so nothing is even
 *      probed while the rename is in flight. This is an optimisation, not the correctness
 *      mechanism — see below.
 *   3. **The device id in the header.** `VaultService` stamps its own `deviceId` into every
 *      header it writes, and in production that id is a fresh UUID per process. So a file
 *      whose header carries *our* id, at a generation no older than the one we last saw, was
 *      written by this process — not by a peer, not by a sync client. This is the mechanism
 *      that closes the race the write window cannot: the event for the final rename can be
 *      delivered and settled *before* the caller's `await save()` returns and releases the
 *      window.
 *   4. **The generation counter.** If nothing about the header's identity changed, nothing
 *      changed, whatever the filesystem said.
 *
 * **It must not fire on nothing.** A cloud client re-downloading an identical file, or simply
 * touching an mtime, produces events with no change behind them; `fs.watch` on Windows
 * produces duplicate and phantom events on its own. So an event is never evidence — it is
 * only a reason to look. What decides is the plaintext header, which carries `vaultId`,
 * `deviceId` and a monotonic `generation`, and which is readable **without the master
 * password**. That is what makes this cheap enough to do on every event: a bounded read of
 * the first few kilobytes and a JSON parse, no Argon2, no decryption, no unlocked vault
 * required. Nothing here ever needs a key, and nothing here ever sees a secret — by
 * construction, since the header is the only part of the file it reads.
 *
 * **It must not hold the file open or block a save.** Every probe opens the file read-only,
 * reads a bounded prefix, and closes in a `finally`. On Windows libuv opens with
 * `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`, so even that microsecond does not
 * stand in the way of a rename — but the handle is released regardless, because a watcher
 * that can break the save it is watching is not worth having.
 *
 * **It must survive the file disappearing and coming back.** That is precisely what a sync
 * client does mid-download: rename away, write, rename back. So the *directory* is watched,
 * never the file — `fs.watch` on a file dies permanently the first time that file is
 * replaced by a rename, which is both what a sync client does and what our own atomic save
 * does. A vanished file is a state, not an error: it is reported only after it is still
 * missing on a second look, and a file that comes back identical reports nothing at all.
 *
 * ## What it deliberately does not do
 *
 * It does not reload, merge, prompt, back up, or lock. It hands the caller two numbers, two
 * ids and two booleans, which is everything needed to decide, and stops there.
 */

// ── The report ───────────────────────────────────────────────────────────────

/** The identity of the file on disk, as far as the plaintext header describes it. */
export interface VaultFileState {
  readonly vaultId: string;
  /** Which device wrote the copy currently on disk. */
  readonly deviceId: string;
  /** Monotonic per vault, incremented on every save. */
  readonly generation: number;
  /** The header's own timestamp — written by the saver, not the filesystem's mtime. */
  readonly modifiedAt: number;
}

/** Everything the caller needs to decide what to do, and nothing else. */
export interface ExternalChange {
  readonly path: string;
  /** What we believed was on disk. */
  readonly known: VaultFileState;
  /** What is on disk now. */
  readonly current: VaultFileState;
  /**
   * A *different vault* now sits at this path — not a newer copy of ours.
   *
   * Merging into this would be wrong, so it is called out separately rather than left for
   * the caller to infer from two ids.
   */
  readonly differentVault: boolean;
  /**
   * The same vault, at an *older* generation than the one we knew.
   *
   * A sync client resolving a conflict by restoring an earlier version, or a backup copied
   * over the live file. Reloading this would throw away newer edits, so the caller is told.
   */
  readonly wentBackwards: boolean;
}

/**
 * Why the header could not be read.
 *
 * Every value is a literal defined here. Nothing read out of the file reaches it — see the
 * header of `../format/header.ts` for why that rule exists and what it cost to learn.
 */
export type UnreadableReason =
  /** The file is not there. Confirmed, not a mid-rename glimpse. */
  | 'missing'
  /** Present, but does not start with the KEEP signature. */
  | 'not-a-vault'
  /** A newer KEEP format than this build understands. */
  | 'unsupported-version'
  /** Truncated, or the header does not parse. */
  | 'malformed'
  /** Present but unreadable: locked by another process, permissions, a dead network share. */
  | 'io-error';

// ── Injected timing and injected watching ────────────────────────────────────

/** Cancels a scheduled callback. Safe to call after it has already run. */
export type CancelTimer = () => void;

/**
 * Schedules a callback.
 *
 * Every delay in this file goes through one of these, so a test drives the whole state
 * machine by hand instead of sleeping. A test that sleeps is a test that fails on a loaded
 * machine, and this is a component whose entire behaviour is about timing.
 */
export type ScheduleFn = (callback: () => void, delayMs: number) => CancelTimer;

export interface DirectoryWatch {
  close(): void;
}

export interface DirectoryWatchCallbacks {
  /** `null` when the platform did not say which entry changed — treat as "look anyway". */
  readonly onEntry: (filename: string | null) => void;
  readonly onError: () => void;
}

/** Injected so tests can deliver an exact event sequence rather than hope for one. */
export type WatchDirectoryFn = (
  directory: string,
  callbacks: DirectoryWatchCallbacks
) => DirectoryWatch;

// ── Defaults ─────────────────────────────────────────────────────────────────

/**
 * How long the events have to stop before the file is looked at.
 *
 * Long enough that a save's burst — and a sync client's rename-write-rename — collapses into
 * a single probe; short enough that a user switching to the app does not beat it there.
 */
const DEFAULT_SETTLE_MS = 400;

/**
 * The safety net.
 *
 * `fs.watch` misses things: network shares, some FUSE mounts, a watched directory replaced
 * wholesale on Windows. A slow poll costs one bounded read every quarter minute and turns
 * "never noticed" into "noticed late", which is the difference that matters here.
 */
const DEFAULT_POLL_INTERVAL_MS = 15_000;

/** How long to wait before trying to re-establish a directory watch that failed or died. */
const DEFAULT_REARM_DELAY_MS = 5_000;

/**
 * How much of the file a probe reads.
 *
 * A KEEP header is a few hundred bytes of JSON — the wrapped DEK and the salt are the only
 * substantial fields. 8 KiB is generous by an order of magnitude, and reading a prefix
 * rather than the file is what keeps this cheap on a vault with a 200 MB attachment.
 */
const DEFAULT_HEADER_PROBE_BYTES = 8_192;

/** The ceiling a probe will grow to before calling a header unreadable. */
const MAX_HEADER_PROBE_BYTES = 1_048_576;

export interface VaultWatcherOptions {
  /** The `.keep` file to watch. Its directory is what actually gets watched. */
  readonly path: string;
  /**
   * The device id this process stamps into the headers it writes.
   *
   * **Must be the id `VaultService` was constructed with**, or self-write suppression stops
   * working and every save reports itself. See `docs/12-Roadmap` and the integration note in
   * this phase's report for the one-line wiring change that guarantees it.
   */
  readonly localDeviceId: string;
  readonly onExternalChange: (change: ExternalChange) => void;
  /** Edge-triggered: fires once per transition into an unreadable state, never repeatedly. */
  readonly onUnreadable?: ((reason: UnreadableReason) => void) | undefined;
  readonly settleMs?: number | undefined;
  /** `null` disables the poll and leaves only the filesystem watch. */
  readonly pollIntervalMs?: number | null | undefined;
  readonly rearmDelayMs?: number | undefined;
  readonly headerProbeBytes?: number | undefined;
  readonly schedule?: ScheduleFn | undefined;
  readonly watchDirectory?: WatchDirectoryFn | undefined;
}

/**
 * Watches one vault file for changes made by something other than this process.
 *
 * Start it when a vault is unlocked, stop it when the vault is locked or closed. Bracket
 * every save with `beginLocalWrite()`. Nothing else is required.
 */
export class VaultWatcher {
  readonly #path: string;
  readonly #directory: string;
  /** Lower-cased, because the comparison is deliberately case-insensitive. See `#isVaultEntry`. */
  readonly #entryName: string;
  readonly #localDeviceId: string;
  readonly #onExternalChange: (change: ExternalChange) => void;
  readonly #onUnreadable: ((reason: UnreadableReason) => void) | null;
  readonly #settleMs: number;
  readonly #pollIntervalMs: number | null;
  readonly #rearmDelayMs: number;
  readonly #headerProbeBytes: number;
  readonly #schedule: ScheduleFn;
  readonly #watchDirectory: WatchDirectoryFn;

  #started = false;
  #watch: DirectoryWatch | null = null;
  #cancelSettle: CancelTimer | null = null;
  #cancelPoll: CancelTimer | null = null;
  #cancelRearm: CancelTimer | null = null;

  /** What we believe is on disk. `null` until the first successful probe. */
  #known: VaultFileState | null = null;
  /** Nesting depth of `beginLocalWrite()`, so overlapping saves cannot un-suppress each other. */
  #localWrites = 0;
  #probing = false;
  #probeAgain = false;
  #inflight: Promise<void> = Promise.resolve();
  /** An unreadable state seen once and awaiting a second opinion. See `#considerUnreadable`. */
  #unreadableSeen: UnreadableReason | null = null;
  /** An unreadable state already handed to the caller, so it is not handed over again. */
  #unreadableReported: UnreadableReason | null = null;

  constructor(options: VaultWatcherOptions) {
    this.#path = options.path;
    this.#directory = dirname(options.path);
    this.#entryName = basename(options.path).toLowerCase();
    this.#localDeviceId = options.localDeviceId;
    this.#onExternalChange = options.onExternalChange;
    this.#onUnreadable = options.onUnreadable ?? null;
    this.#settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.#pollIntervalMs =
      options.pollIntervalMs === undefined ? DEFAULT_POLL_INTERVAL_MS : options.pollIntervalMs;
    this.#rearmDelayMs = options.rearmDelayMs ?? DEFAULT_REARM_DELAY_MS;
    this.#headerProbeBytes = options.headerProbeBytes ?? DEFAULT_HEADER_PROBE_BYTES;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#watchDirectory = options.watchDirectory ?? defaultWatchDirectory;
  }

  get path(): string {
    return this.#path;
  }

  get watching(): boolean {
    return this.#started;
  }

  /** What the watcher currently believes is on disk. `null` before the first probe lands. */
  get known(): VaultFileState | null {
    return this.#known;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Starts watching. Idempotent.
   *
   * The first probe adopts whatever is on disk as the baseline without reporting it — there
   * is no honest way to call a file "changed" before knowing what it was. A restart, by
   * contrast, keeps the baseline from before `stop()`, so a change made while the vault was
   * locked is reported the moment it is unlocked again. That asymmetry is the useful one.
   */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#arm();
    this.#schedulePoll();
    this.#scheduleProbe(0);
  }

  /**
   * Stops watching, releases the directory handle, and cancels every pending timer.
   *
   * On Windows the directory handle is not incidental: while it is open the watched folder
   * cannot be renamed or removed. Stopping on lock is what gives that handle back.
   */
  stop(): void {
    this.#started = false;
    this.#closeWatch();
    this.#cancelSettle?.();
    this.#cancelSettle = null;
    this.#cancelPoll?.();
    this.#cancelPoll = null;
    this.#cancelRearm?.();
    this.#cancelRearm = null;
  }

  /**
   * Brackets one of our own saves.
   *
   * Call it before the write and call the returned release afterwards, in a `finally`. While
   * the window is open nothing is probed, which keeps a probe from landing on a file that is
   * mid-rename and reporting a transient `missing` or `io-error`. The release is idempotent,
   * and the depth is counted, so a nested or overlapping save cannot reopen the window early.
   *
   * **This is not what makes self-writes silent** — the device-id rule in `#consider` is, and
   * it holds even if a caller forgets to bracket a save entirely. Do not "simplify" this away
   * on the grounds that the device-id rule covers it, and do not simplify *that* away on the
   * grounds that this covers it: the window cannot close the race where the rename's event is
   * delivered and settled before `await save()` returns, and the device-id rule cannot stop a
   * probe from reading a half-renamed file.
   */
  beginLocalWrite(): () => void {
    this.#localWrites += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#localWrites -= 1;
      // Re-baseline once the dust settles. The probe reports nothing, because what it finds
      // carries our own device id — but it does bring `#known` forward to the generation we
      // just wrote, so the *next* external change is measured against the right number.
      if (this.#localWrites === 0 && this.#started) this.#scheduleProbe();
    };
  }

  /** Probes now rather than on the next event. Resolves when the probe has been considered. */
  checkNow(): Promise<void> {
    return this.#startProbe();
  }

  /** Resolves once any probe already under way has finished. */
  async settled(): Promise<void> {
    let awaited: Promise<void> | null = null;
    while (awaited !== this.#inflight) {
      awaited = this.#inflight;
      await awaited;
    }
  }

  // ── Watching ───────────────────────────────────────────────────────────────

  #arm(): void {
    if (this.#watch !== null || !this.#started) return;
    try {
      this.#watch = this.#watchDirectory(this.#directory, {
        onEntry: (filename) => {
          this.#onEntry(filename);
        },
        onError: () => {
          this.#onWatchError();
        },
      });
    } catch {
      // The directory is gone, or is on a share that will not give us a watch. Not fatal:
      // the poll still notices changes, just later. Retry on a timer rather than giving up,
      // because "the directory came back" is exactly the sync-client case this must survive.
      this.#watch = null;
      this.#scheduleRearm();
    }
  }

  #closeWatch(): void {
    if (this.#watch === null) return;
    const watcher = this.#watch;
    this.#watch = null;
    try {
      watcher.close();
    } catch {
      // Closing a watch that the platform already tore down throws on some filesystems.
      // There is nothing to do about it and nothing at stake.
    }
  }

  #onWatchError(): void {
    this.#closeWatch();
    if (!this.#started) return;
    this.#scheduleRearm();
    // A watch often dies *because* the thing it was watching moved, so look now as well as
    // re-arming — otherwise the change that killed the watch is the one change we miss.
    this.#scheduleProbe();
  }

  #onEntry(filename: string | null): void {
    if (!this.#started) return;
    if (filename !== null && !this.#isVaultEntry(filename)) return;
    this.#scheduleProbe();
  }

  /**
   * Is this event about the vault itself, rather than one of its sidecars?
   *
   * Case-insensitive on every platform, not just the two that need it. Over-matching costs a
   * wasted probe that reports nothing; under-matching costs a missed change. Those are not
   * comparable, so the comparison is deliberately loose in the harmless direction.
   */
  #isVaultEntry(filename: string): boolean {
    return basename(filename).toLowerCase() === this.#entryName;
  }

  // ── Probing ────────────────────────────────────────────────────────────────

  /**
   * Schedules the next probe, replacing any already pending.
   *
   * Replacing rather than queueing is what collapses a burst into one report: every new event
   * pushes the probe further out, and the file is read once, after the writer has stopped.
   */
  #scheduleProbe(delayMs: number = this.#settleMs): void {
    if (!this.#started) return;
    this.#cancelSettle?.();
    this.#cancelSettle = this.#schedule(() => {
      this.#cancelSettle = null;
      void this.#startProbe();
    }, delayMs);
  }

  #schedulePoll(): void {
    if (this.#pollIntervalMs === null || !this.#started) return;
    this.#cancelPoll = this.#schedule(() => {
      this.#cancelPoll = null;
      if (!this.#started) return;
      // Deliberately not `#scheduleProbe` — the poll must not be pushed back by the same
      // events it exists to survive, or a writer touching the file continuously would defer
      // the probe forever.
      void this.#startProbe();
      // A no-op while the watch is alive; the point is the case where it is not.
      this.#arm();
      this.#schedulePoll();
    }, this.#pollIntervalMs);
  }

  #scheduleRearm(): void {
    if (this.#cancelRearm !== null || !this.#started) return;
    this.#cancelRearm = this.#schedule(() => {
      this.#cancelRearm = null;
      this.#arm();
    }, this.#rearmDelayMs);
  }

  #startProbe(): Promise<void> {
    if (this.#probing) {
      // Do not read the file twice at once. Whatever arrived while we were reading is
      // handled by one more probe after this one finishes.
      this.#probeAgain = true;
      return this.#inflight;
    }
    this.#probing = true;
    this.#inflight = this.#runProbe();
    return this.#inflight;
  }

  /**
   * May a probe's result be acted on right now?
   *
   * A method rather than two inline field reads, and that is not a style choice. TypeScript
   * narrows `this.#started` at the first check and does not widen it again across the
   * `await`, so the *second* check — the only one that matters — gets reported as dead code
   * and invites exactly the "simplification" that reintroduces the bug. Both flags can and do
   * change while the file is being read: `stop()` on lock, and a save starting.
   */
  #live(): boolean {
    return this.#started && this.#localWrites === 0;
  }

  async #runProbe(): Promise<void> {
    try {
      if (!this.#live()) return;
      const probe = await probeVaultHeader(this.#path, this.#headerProbeBytes);
      // Re-checked after the await: the watcher may have been stopped, or one of our own
      // saves may have started, while the read was in flight.
      if (!this.#live()) return;
      this.#consider(probe);
    } catch {
      // Nothing above is supposed to throw — `probeVaultHeader` returns its failures as
      // values, and `#report` absorbs a throwing callback. This exists so that if something
      // ever does, it cannot become an unhandled rejection out of a timer callback and take
      // the whole process down with it.
    } finally {
      this.#probing = false;
      if (this.#probeAgain) {
        this.#probeAgain = false;
        if (this.#started) this.#scheduleProbe();
      }
    }
  }

  #consider(probe: Probe): void {
    if (!probe.ok) {
      this.#considerUnreadable(probe.reason);
      return;
    }

    this.#unreadableSeen = null;
    this.#unreadableReported = null;

    const current = probe.state;
    const known = this.#known;
    // Adopted unconditionally, and before any decision below, so that one change is reported
    // once. A watcher that reported the same change on every subsequent event would train
    // the user to dismiss it, which is the failure this whole file is built to avoid.
    this.#known = current;

    // Nothing to compare against yet: this is the first look at the file.
    if (known === null) return;

    // Identity, not content — and deliberately not the filesystem's mtime, nor the header's
    // `modifiedAt`. A cloud client that re-downloads a byte-identical file, or merely touches
    // it, changes neither `generation` nor `deviceId`, and so changes nothing here.
    if (
      known.vaultId === current.vaultId &&
      known.deviceId === current.deviceId &&
      known.generation === current.generation
    ) {
      return;
    }

    // Our own save. In production `deviceId` is a fresh UUID per process, so this id names
    // *this running process* and nothing else — two Keyhold instances on one machine hold
    // different ids and correctly see each other as external.
    //
    // WARNING, and the reason this reads `>=` rather than a bare id check: if `deviceId` ever
    // becomes stable per *installation* instead of per process, this test starts suppressing
    // a second instance's genuine saves, and the write bracket in `beginLocalWrite()` becomes
    // the only line of defence. The generation clause at least keeps a restored older copy —
    // a backup dropped over the live file — visible even when our own id is on it.
    if (
      current.deviceId === this.#localDeviceId &&
      current.vaultId === known.vaultId &&
      current.generation >= known.generation
    ) {
      return;
    }

    const differentVault = current.vaultId !== known.vaultId;
    this.#report({
      path: this.#path,
      known,
      current,
      differentVault,
      wentBackwards: !differentVault && current.generation < known.generation,
    });
  }

  /**
   * A header we could not read.
   *
   * Never reported on first sight. A sync client's rename-write-rename passes through
   * "missing" and "truncated" on its way to a perfectly good file, and reporting those would
   * be the "fires on nothing" failure wearing a different hat. So the state has to survive a
   * second look, one settle period later, before the caller hears about it — and then only
   * once, until it changes or clears.
   */
  #considerUnreadable(reason: UnreadableReason): void {
    if (this.#unreadableReported === reason) return;

    if (this.#unreadableSeen !== reason) {
      this.#unreadableSeen = reason;
      this.#scheduleProbe();
      return;
    }

    this.#unreadableReported = reason;
    if (this.#onUnreadable === null) return;
    try {
      this.#onUnreadable(reason);
    } catch {
      console.error('vault watcher: the unreadable callback threw');
    }
  }

  #report(change: ExternalChange): void {
    try {
      this.#onExternalChange(change);
    } catch {
      // A throwing callback is the caller's bug, but it must not take the watcher's timer
      // chain down with it — a watcher that silently stops watching after one bad render is
      // the worst outcome available here. The message carries no path and no file content;
      // hard rule 1, and the same reasoning as `crypto/errors.ts`.
      console.error('vault watcher: the change callback threw');
    }
  }
}

// ── Reading the header, cheaply and without a key ────────────────────────────

type Probe =
  | { readonly ok: true; readonly state: VaultFileState }
  | { readonly ok: false; readonly reason: UnreadableReason };

/**
 * Reads the plaintext header, and nothing else.
 *
 * Exported because "what does the file on disk currently say" is a question worth being able
 * to ask directly — on window focus, before a merge, in a test — and because it is the whole
 * of the watcher's contact with the filesystem.
 *
 * No key, no decryption, no unlocked vault. The KEEP header is plaintext by design (it has to
 * be: it says how to derive the key) and authenticated as AAD, so reading it is both possible
 * and meaningful. Failures come back as values rather than exceptions, because every one of
 * them is an ordinary state for a file living in a sync folder.
 */
export async function probeVaultHeader(
  path: string,
  probeBytes: number = DEFAULT_HEADER_PROBE_BYTES
): Promise<Probe> {
  let length = Math.max(1, Math.min(probeBytes, MAX_HEADER_PROBE_BYTES));

  for (;;) {
    let prefix: { bytes: Uint8Array; filled: boolean };
    try {
      prefix = await readPrefix(path, length);
    } catch (error) {
      return { ok: false, reason: ioReason(error) };
    }

    try {
      const { header } = readPreamble(prefix.bytes);
      return {
        ok: true,
        state: {
          vaultId: header.vaultId,
          deviceId: header.deviceId,
          generation: header.generation,
          modifiedAt: header.modifiedAt,
        },
      };
    } catch (error) {
      // A header longer than the prefix we read is indistinguishable from a truncated file:
      // both run off the end of the buffer. So when the buffer came back completely full,
      // the file has more to give and it is worth one more, larger read before calling the
      // header unreadable. Growing rather than reading the whole file is what keeps a probe
      // cheap on a vault carrying a 200 MB attachment.
      if (prefix.filled && length < MAX_HEADER_PROBE_BYTES) {
        length = Math.min(MAX_HEADER_PROBE_BYTES, length * 8);
        continue;
      }
      return { ok: false, reason: vaultErrorReason(error) };
    }
  }
}

/**
 * Reads the first `length` bytes, holding the file open for as short a time as possible.
 *
 * `filled` says whether the read reached the requested length, which is the only way to tell
 * "the file is shorter than this" from "there is more where that came from".
 */
async function readPrefix(
  path: string,
  length: number
): Promise<{ bytes: Uint8Array; filled: boolean }> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return {
      bytes: new Uint8Array(buffer.subarray(0, bytesRead)),
      filled: bytesRead === length,
    };
  } finally {
    // In a `finally`, always: a watcher that leaks a handle per event is a watcher that
    // eventually stops the app from saving, on the platform where that is hardest to debug.
    await handle.close();
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function ioReason(error: unknown): UnreadableReason {
  return errorCode(error) === 'ENOENT' ? 'missing' : 'io-error';
}

/**
 * Maps a container error to a reason.
 *
 * A closed set of literals, never the error's message. The message is safe today — see the
 * header of `../format/header.ts`, which went to some trouble to make it so — but a reason
 * code is what a caller should be branching on anyway, and it cannot regress.
 *
 * Every `VaultErrorCode` is written out rather than collapsed into a `default`, so that adding
 * a code to `crypto/errors.ts` fails the build here instead of quietly becoming "malformed".
 * Those that cannot reach a header-only read are grouped and labelled as such.
 */
function vaultErrorReason(error: unknown): UnreadableReason {
  if (!(error instanceof VaultError)) return 'io-error';
  switch (error.code) {
    case 'NOT_A_VAULT':
      return 'not-a-vault';
    case 'UNSUPPORTED_VERSION':
      return 'unsupported-version';
    case 'MALFORMED':
      return 'malformed';
    // Unreachable from `readPreamble`. The first five are raised only once a key exists and
    // the body or a chunk is being authenticated, and a probe never gets that far; the last
    // two belong to `reloadFromDisk`, which is a *response* to this watcher rather than
    // anything it calls. Mapped rather than thrown, because a watcher is not the place to
    // discover a new error code — and written out rather than collapsed into a `default`, so
    // the next code added to `crypto/errors.ts` fails the build here and gets a decision
    // instead of quietly becoming "malformed". It just did, for these two.
    case 'WRONG_PASSWORD':
    case 'TAMPERED':
    case 'BAD_KDF_PARAMS':
    case 'TOO_LARGE':
    case 'CHUNK_INTEGRITY':
    case 'UNSAVED_CHANGES':
    case 'DIFFERENT_VAULT':
      return 'malformed';
  }
}

// ── The real timer and the real watch ────────────────────────────────────────

const defaultSchedule: ScheduleFn = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  // Never hold the process open for a watch, exactly as `session/auto-lock.ts` does not hold
  // it open for an idle poll.
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
};

/**
 * `fs.watch` on the vault's **directory**.
 *
 * Not on the file: a file watch dies permanently the first time the file is replaced by a
 * rename, and rename-replace is what both our own atomic save and every sync client do. A
 * directory watch survives that, and is the only shape that survives the file disappearing
 * and coming back.
 *
 * `persistent: false` so the watch never keeps Electron's main process alive on its own.
 * `recursive: false` because a vault's siblings are all we care about, and a recursive watch
 * on a folder that happens to be someone's whole Dropbox would be a performance incident.
 */
const defaultWatchDirectory: WatchDirectoryFn = (directory, callbacks) => {
  const watcher = watch(directory, { persistent: false, recursive: false }, (_event, filename) => {
    callbacks.onEntry(typeof filename === 'string' ? filename : null);
  });
  watcher.on('error', () => {
    callbacks.onError();
  });
  return {
    close: () => {
      watcher.close();
    },
  };
};
