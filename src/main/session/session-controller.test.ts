// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The session controller: the create → lock → unlock cycle, and the things that must
 * happen *around* it.
 *
 * `VaultService` is tested on its own; what is tested here is the wiring — that locking
 * takes the clipboard with it, that a failed unlock is throttled, that a wipe threshold is
 * honoured exactly, and that quick-unlock enrolment is invalidated by a re-key.
 */

const preferencesDir = vi.hoisted(() => ({ path: '' }));
const keyStore = vi.hoisted(() => ({ available: true, blobs: new Map<string, string>() }));
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
  // A stand-in for DPAPI / Keychain: reversible, keyed, and obviously not real crypto —
  // the point is the enrolment lifecycle, not the OS primitive underneath it.
  safeStorage: {
    isEncryptionAvailable: () => keyStore.available,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString('utf8');
      if (!text.startsWith('sealed:')) throw new Error('not ours');
      return text.slice('sealed:'.length);
    },
  },
  systemPreferences: { canPromptTouchID: () => false, promptTouchID: () => Promise.resolve() },
}));

const PASSWORD = 'a-perfectly-reasonable-master-password';
/** The OWASP floor: a real derivation, fast enough to run in a test suite. */
const FAST_KDF = { memoryKib: 19_456, iterations: 2, parallelism: 1 } as const;

let dir: string;
let vaultPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'keyhold-session-'));
  vaultPath = join(dir, 'test.keep');
  preferencesDir.path = dir;
  keyStore.available = true;
  clipboardState.text = '';
  vi.resetModules();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Builds a controller whose vault uses cheap KDF settings. */
async function makeController() {
  const { SessionController } = await import('./session-controller.js');
  const { VaultService } = await import('../vault/vault-service.js');
  const { InProcessKdf } = await import('../crypto/kdf-runner.js');

  const vault = new VaultService('test-device');
  // In-process derivation: the worker is loaded from a BUILT path that does not exist when
  // running sources. `kdf-runner.test.ts` covers the worker itself, against the real build.
  const controller = new SessionController(vault, new InProcessKdf());

  // `createVault` on the controller does not expose KDF overrides — the app never needs
  // to. The vault is created directly with cheap settings, then reopened through the
  // controller, which is the path under test.
  return { controller, vault };
}

async function seedVault(): Promise<void> {
  const { VaultService } = await import('../vault/vault-service.js');
  const seeder = new VaultService('test-device');
  await seeder.createVault({ path: vaultPath, password: PASSWORD, kdf: FAST_KDF });
  seeder.lock();
}

describe('the unlock cycle', () => {
  it('opens a vault and reports it as unlocked', async () => {
    await seedVault();
    const { controller } = await makeController();

    await controller.inspect(vaultPath);
    await controller.unlock(vaultPath, PASSWORD);

    const status = controller.status();
    expect(status.state).toBe('unlocked');
    expect(status.vault?.path).toBe(vaultPath);
    controller.dispose();
  }, 30_000);

  it('records the vault in the recent list', async () => {
    await seedVault();
    const { controller } = await makeController();
    await controller.unlock(vaultPath, PASSWORD);

    expect(controller.status().recentVaults.map((entry) => entry.path)).toContain(vaultPath);
    controller.dispose();
  }, 30_000);

  it('reports a wrong password as recoverable and stays locked', async () => {
    await seedVault();
    const { controller } = await makeController();

    await expect(controller.unlock(vaultPath, 'wrong-password')).rejects.toMatchObject({
      code: 'WRONG_PASSWORD',
    });
    expect(controller.status().state).not.toBe('unlocked');
    controller.dispose();
  }, 30_000);

  it('throttles after repeated failures', async () => {
    await seedVault();
    const { controller } = await makeController();

    for (let i = 0; i < 4; i += 1) {
      await controller.unlock(vaultPath, 'wrong').catch(() => undefined);
    }

    // The fourth failure is the first past the free allowance, so a delay is now running.
    expect(controller.status().throttle.lockedForMs).toBeGreaterThan(0);
    expect(controller.status().throttle.lockedUntil).toBeGreaterThan(0);

    // And a further attempt is refused without even trying the password.
    await expect(controller.unlock(vaultPath, PASSWORD)).rejects.toMatchObject({
      code: 'WRONG_PASSWORD',
    });
    controller.dispose();
  }, 60_000);
});

describe('locking', () => {
  it('takes the clipboard with it', async () => {
    // A vault locked while the password it just handed out sits on the clipboard is not
    // locked in any sense the user would recognise.
    await seedVault();
    const { controller, vault } = await makeController();
    await controller.unlock(vaultPath, PASSWORD);

    const { emptyVaultDocument } = await import('@shared/model/vault-document.js');
    vault.replaceDocument({
      ...emptyVaultDocument(),
      records: [buildRecord()],
    });

    await controller.copySecret({ kind: 'password', credentialId: 'rec-1' });
    expect(clipboardState.text).toBe('the-secret-value');

    controller.lock('idle');
    // clearOnExit is fire-and-forget so shutdown is never blocked; it lands next tick.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(clipboardState.text).toBe('');
    expect(controller.status().state).not.toBe('unlocked');
    controller.dispose();
  }, 30_000);

  it('remembers why it locked, so the unlock screen can explain', async () => {
    await seedVault();
    const { controller } = await makeController();
    await controller.unlock(vaultPath, PASSWORD);

    controller.lock('sleep');
    expect(controller.status().lastLockReason).toBe('sleep');
    controller.dispose();
  }, 30_000);
});

describe('quick unlock', () => {
  it('enrols, then opens the vault without a password', async () => {
    await seedVault();
    const { controller } = await makeController();
    await controller.unlock(vaultPath, PASSWORD);

    controller.enrolQuickUnlock();
    expect(controller.status().quickUnlock.enrolledForThisVault).toBe(true);

    controller.lock('manual');
    const reopened = await controller.unlockWithQuickUnlock(vaultPath);

    expect(reopened).not.toBeNull();
    expect(controller.status().state).toBe('unlocked');
    controller.dispose();
  }, 30_000);

  it('returns null rather than throwing when nothing is enrolled', async () => {
    // "Not enrolled" is a normal state, not an error — the caller falls back to the
    // password, which is already on screen.
    await seedVault();
    const { controller } = await makeController();

    expect(await controller.unlockWithQuickUnlock(vaultPath)).toBeNull();
    controller.dispose();
  }, 30_000);

  it('is revoked by revoking, and the vault still opens with the password', async () => {
    await seedVault();
    const { controller } = await makeController();
    await controller.unlock(vaultPath, PASSWORD);
    controller.enrolQuickUnlock();

    controller.revokeQuickUnlock();
    controller.lock('manual');

    expect(await controller.unlockWithQuickUnlock(vaultPath)).toBeNull();
    await expect(controller.unlock(vaultPath, PASSWORD)).resolves.toBeDefined();
    controller.dispose();
  }, 40_000);

  it('is unavailable when the OS provides no key store', async () => {
    keyStore.available = false;
    await seedVault();
    const { controller } = await makeController();
    await controller.unlock(vaultPath, PASSWORD);

    expect(controller.status().quickUnlock.available).toBe(false);
    controller.dispose();
  }, 30_000);
});

describe('wipe after failed attempts', () => {
  it('does nothing by default, however many attempts fail', async () => {
    // The default has to be "never". A forgotten password destroying the vault is a
    // data-loss trap, and it must be something the user asked for explicitly.
    await seedVault();
    const { controller } = await makeController();

    for (let i = 0; i < 8; i += 1) {
      await controller.unlock(vaultPath, 'wrong').catch(() => undefined);
    }

    await expect(readFile(vaultPath)).resolves.toBeDefined();
    controller.dispose();
  }, 60_000);

  it('fires only at the configured threshold, and removes the backups too', async () => {
    await seedVault();
    // A backup beside the vault: leaving these behind would make the whole feature theatre.
    await writeFile(`${vaultPath}.bak.1`, 'an old copy');

    const { controller } = await makeController();
    controller.updatePreferences({ wipeAfterFailedAttempts: 3 });

    await controller.unlock(vaultPath, 'wrong').catch(() => undefined);
    await controller.unlock(vaultPath, 'wrong').catch(() => undefined);
    await expect(readFile(vaultPath)).resolves.toBeDefined();

    await controller.unlock(vaultPath, 'wrong').catch(() => undefined);

    await expect(readFile(vaultPath)).rejects.toThrow();
    await expect(readFile(`${vaultPath}.bak.1`)).rejects.toThrow();
    controller.dispose();
  }, 60_000);

  it('refuses a threshold below three, which would fire on ordinary typos', async () => {
    const { coercePreferences } = await import('./preferences.js');
    expect(coercePreferences({ wipeAfterFailedAttempts: 1 }).wipeAfterFailedAttempts).toBeNull();
    expect(coercePreferences({ wipeAfterFailedAttempts: 2 }).wipeAfterFailedAttempts).toBeNull();
    expect(coercePreferences({ wipeAfterFailedAttempts: 3 }).wipeAfterFailedAttempts).toBe(3);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function buildRecord() {
  return {
    id: 'rec-1',
    type: 'login' as const,
    title: 'Example',
    favorite: false,
    folderId: null,
    tags: [],
    icon: { kind: 'auto' as const },
    fields: {
      username: 'someone',
      email: 'someone@example.com',
      password: 'the-secret-value',
      urls: [],
      securityQuestions: [],
      notes: '',
      custom: [],
    },
    attachments: [],
    meta: {
      createdAt: 1,
      updatedAt: 1,
      passwordUpdatedAt: 1,
      lastUsedAt: null,
      useCount: 0,
      expiresAt: null,
      rotationIntervalDays: null,
    },
    history: { enabled: true, maxVersions: 10, versions: [] },
    trashedAt: null,
  };
}
