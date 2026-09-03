// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityKind } from '@shared/model/activity.js';
import { InProcessKdf } from '../crypto/kdf-runner.js';
import { VaultService } from '../vault/vault-service.js';
import { SessionController } from './session-controller.js';

// The same stand-ins `session-controller.test.ts` uses, kept to the minimum this file needs:
// a preferences directory, a clipboard, and a key store that reports itself unavailable so
// nothing here wanders into quick-unlock enrolment.
const preferencesDir = vi.hoisted(() => ({ path: '' }));
const clipboardState = vi.hoisted(() => ({ text: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => preferencesDir.path },
  ClipboardItem: class {
    constructor(public readonly payload: Record<string, string>) {}
  },
  clipboard: {
    write: (items: { payload: Record<string, string> }[]) => {
      clipboardState.text = items[0]?.payload['text/plain'] ?? '';
      return Promise.resolve();
    },
    writeText: (text: string) => {
      clipboardState.text = text;
      return Promise.resolve();
    },
    readText: () => Promise.resolve(clipboardState.text),
  },
  powerMonitor: { on: vi.fn(), off: vi.fn(), getSystemIdleTime: () => 0 },
  safeStorage: { isEncryptionAvailable: () => false },
  systemPreferences: { canPromptTouchID: () => false, promptTouchID: () => Promise.resolve() },
}));

/**
 * Guard: the activity log is actually wired to the session.
 *
 * `SessionActivity` and `ActivityLog` were both finished, both thoroughly tested, and both
 * constructed nowhere outside their own tests — so not one action in the running app
 * recorded anything. Every test of the recorder passed the whole time. That is the failure
 * these tests exist for: a subsystem can be entirely correct and entirely unreachable, and
 * only a test that drives the caller can tell the difference.
 *
 * They deliberately go through `SessionController` rather than calling the recorder, because
 * the wiring is the thing under test.
 */

let dir: string;
let vaultPath: string;
let session: SessionController;

const PASSWORD = 'a-perfectly-reasonable-master-password';
const SECRET = 'the-password-on-the-record';

/** The OWASP floor. This file is not testing Argon2's strength. */
const FAST_KDF = { memoryKib: 19_456, iterations: 2, parallelism: 1 } as const;

/** Every kind currently in the log, in order. */
function kinds(): readonly ActivityKind[] {
  return session.activity.snapshot().entries.map((entry) => entry.kind);
}

/**
 * A vault on disk at the cheapest legal cost, with nothing open.
 *
 * Seeded through `VaultService` rather than `SessionController.createVault`, which calibrates
 * Argon2 against the machine — a multi-second search, and not what any of this is testing.
 * The controller is then driven for real from `unlock` onwards, which is the path the
 * binding lives on.
 */
async function seedVault(): Promise<void> {
  const seeder = new VaultService('test-device');
  await seeder.createVault({ path: vaultPath, password: PASSWORD, kdf: FAST_KDF });
  seeder.lock();
}

/** An open vault, unlocked through the controller, its unlock already in the log. */
async function openVault(): Promise<void> {
  await seedVault();
  await session.unlock(vaultPath, PASSWORD);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'keyhold-activity-'));
  vaultPath = join(dir, 'test.keep');
  preferencesDir.path = dir;
  clipboardState.text = '';
  // In-process derivation: the worker is loaded from a BUILT path that does not exist when
  // running sources. `kdf-runner.test.ts` covers the worker itself, against a real build.
  session = new SessionController(new VaultService('test-device'), new InProcessKdf());
});

afterEach(async () => {
  session.lock();
  session.dispose();
  await rm(dir, { recursive: true, force: true });
});

describe('the session records what it does', () => {
  it('records an unlock, and says which method opened the vault', async () => {
    await openVault();

    const [first] = session.activity.snapshot().entries;
    expect(first?.kind).toBe('unlock');
    // The model distinguishes 'password', 'quick-unlock' and 'created', so the binding has to
    // pass the right one. A log whose first line says "unlocked" for a vault that did not
    // exist a second earlier misreports the one event a reader most wants to find.
    expect(first?.unlockMethod).toBe('password');
  });

  it('records a failed unlock', async () => {
    await seedVault();
    await expect(session.unlock(vaultPath, 'the-wrong-password')).rejects.toThrow();

    expect(kinds()).toContain('unlock-failed');
  });

  it('records a save, with how many records were written', async () => {
    await openVault();
    session.vault.createCredential({ title: 'One', password: SECRET });
    await session.save();

    const save = session.activity.snapshot().entries.find((entry) => entry.kind === 'save');
    expect(save).toBeDefined();
    expect(save?.count).toBe(1);
  });

  it('records a reveal, which the vault history cannot', async () => {
    await openVault();
    const created = session.vault.createCredential({ title: 'One', password: SECRET });
    const ref = { credentialId: created.id, kind: 'password' } as const;

    expect(session.revealSecret(ref)).toBe(SECRET);

    const reveal = session.activity.snapshot().entries.find((entry) => entry.kind === 'reveal');
    expect(reveal?.subjectId).toBe(created.id);
    expect(reveal?.secretKind).toBe('password');
  });

  it('does not record a reveal that returned nothing', async () => {
    await openVault();

    // No such record, so nothing was revealed. A log that disagrees with what the user saw is
    // worse than no log, and this is the direction that would matter: it would report a read
    // of a credential that was never read.
    expect(session.revealSecret({ credentialId: 'nope', kind: 'password' })).toBeNull();
    expect(kinds()).not.toContain('reveal');
  });

  it('clears the log on lock, and hands back a notice saying why', async () => {
    await openVault();
    session.vault.createCredential({ title: 'One', password: SECRET });
    await session.save();
    expect(kinds().length).toBeGreaterThan(0);

    session.lock('idle');

    // A lock that left behind a list of everything the session revealed is a lock in name
    // only — and that list is more use to somebody sitting down at the locked machine than
    // the lock screen is.
    expect(session.activity.snapshot().entries).toEqual([]);
    expect(session.lastLockNotice?.kind).toBe('lock');
    expect(session.lastLockNotice?.lockReason).toBe('idle');
  });

  it('names no vault in the lock notice', async () => {
    await openVault();
    session.lock('idle');

    // Naming the vault in the announcement that it just locked would be the one disclosure
    // the lock exists to prevent, spoken aloud by a live region.
    expect(session.lastLockNotice?.vaultLabel).toBeUndefined();
  });
});

describe('what the log never holds', () => {
  it('holds no secret, and no record title, however much it records', async () => {
    await openVault();
    const created = session.vault.createCredential({
      title: 'A Very Distinctive Title',
      username: 'someone@example.com',
      password: SECRET,
    });
    await session.save();
    session.revealSecret({ credentialId: created.id, kind: 'password' });

    // Serialised whole, so a field added to `ActivityEntry` later is covered without anyone
    // remembering to add it here. The entry type has no field that could hold either of
    // these, and this is what keeps that true.
    const serialised = JSON.stringify(session.activity.snapshot());

    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain('A Very Distinctive Title');
    expect(serialised).not.toContain('someone@example.com');
    // The control. Without an id in there, the assertions above would pass on an empty log.
    expect(serialised).toContain(created.id);
  });

  it('holds no filesystem path, which would carry the OS user name', async () => {
    await openVault();
    await session.save();

    // The needle is the path **as JSON would write it**, not the raw path. On Windows a path
    // is full of backslashes and `JSON.stringify` doubles every one, so searching the
    // serialised log for the raw string can never match — the assertion passes whatever the
    // log contains. Fault injection found this: feeding the path in as the vault's display
    // name failed nothing until this line was fixed.
    const asJson = JSON.stringify(vaultPath).slice(1, -1);
    const serialised = JSON.stringify(session.activity.snapshot());

    expect(serialised).not.toContain(asJson);
    // The control: the label the log *is* allowed to hold is in there, so the assertion
    // above is searching a log with something in it.
    expect(serialised).toContain('vaultLabel');
  });
});
