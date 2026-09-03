// SPDX-License-Identifier: GPL-3.0-or-later
import { rm } from 'node:fs/promises';
import { basename } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { SecretRef } from '@shared/model/credential.js';
import type { PasswordStrength } from '@shared/model/strength.js';
import type { VaultLockedInfo, VaultSummary } from '@shared/model/vault-document.js';
import { DEFAULT_SECRET_REVEAL_LIMITS, type MachineSettings } from '@shared/model/settings-plan.js';
import { KdfRunner, type KdfProvider } from '../crypto/kdf-runner.js';
import { VaultError } from '../crypto/errors.js';
import { listVaultCopyPaths } from '../vault/atomic-write.js';
import { VaultService } from '../vault/vault-service.js';
import { AutoLock, type LockReason } from './auto-lock.js';
import { SecretClipboard, type ClipboardState } from './clipboard.js';
import { PreferencesStore, type Preferences, type RecentVault } from './preferences.js';
import { describeCapability, QuickUnlock, type QuickUnlockCapability } from './quick-unlock.js';
import { estimateStrength } from './strength.js';
import { UnlockThrottle, type ThrottleState } from './unlock-throttle.js';

/**
 * Binds the vault to everything that guards it.
 *
 * `VaultService` knows how to open and read a vault. It deliberately knows nothing about
 * throttling, idle timers, clipboards, or the OS key store — keeping those out of it is
 * what let it be tested exhaustively without mocking Electron. This class is where they
 * meet, and it is the only thing the IPC layer talks to.
 *
 * The lock path is the important part. Locking has to be **one operation that always does
 * everything**: destroy the key, drop the document, revoke outstanding secret grants, stop
 * the idle timer, and clear the clipboard. A lock that does four of those five is a lock
 * that leaves the user's password sitting in Win+V.
 */

export type SessionState = 'no-vault' | 'locked' | 'unlocked';

export interface SessionStatus {
  readonly state: SessionState;
  readonly vault: VaultSummary | null;
  /** The vault awaiting a password, when locked. */
  readonly pendingVault: VaultLockedInfo | null;
  readonly throttle: ThrottleState;
  readonly clipboard: ClipboardState;
  readonly quickUnlock: QuickUnlockCapability & { readonly enrolledForThisVault: boolean };
  readonly recentVaults: readonly RecentVault[];
  readonly lastLockReason: LockReason | null;
  readonly hasUnsavedChanges: boolean;
}

export class SessionController {
  readonly #vault: VaultService;
  readonly #kdf: KdfProvider;
  readonly #throttle = new UnlockThrottle();
  readonly #clipboard = new SecretClipboard();
  readonly #quickUnlock = new QuickUnlock();
  readonly #preferences = new PreferencesStore();
  readonly #autoLock: AutoLock;

  #pendingVault: VaultLockedInfo | null = null;
  #lastLockReason: LockReason | null = null;
  #window: BrowserWindow | null = null;
  #onStatusChange: (() => void) | null = null;
  readonly #lockListeners = new Set<() => void>();

  constructor(vault: VaultService = new VaultService(), kdf: KdfProvider = new KdfRunner()) {
    this.#vault = vault;
    this.#kdf = kdf;
    this.#autoLock = new AutoLock((reason) => {
      this.lock(reason);
      // The renderer has to be told, or it keeps rendering a vault that is no longer open.
      this.#onStatusChange?.();
    }, this.#preferences.get().autoLock);
  }

  attachWindow(window: BrowserWindow, onStatusChange: () => void): void {
    this.#window = window;
    this.#onStatusChange = onStatusChange;
  }

  /**
   * The machine-scoped settings, as one object.
   *
   * Assembled from `PreferencesStore` rather than stored separately, because preferences are
   * already the single home for "how this computer behaves" — a second store would be a
   * second list, and the two would disagree the first time one of them was written.
   */
  machineSettings(): MachineSettings {
    const preferences = this.#preferences.get();
    return {
      autoLock: preferences.autoLock,
      clipboardClearMs: preferences.clipboardClearMs,
      wipeAfterFailedAttempts: preferences.wipeAfterFailedAttempts,
      secretReveal: DEFAULT_SECRET_REVEAL_LIMITS,
      networkAllowed: preferences.networkAllowed,
    };
  }

  /**
   * Applies a machine-settings patch, and makes it take effect now.
   *
   * Auto-lock is reconfigured immediately rather than at the next unlock: a user who has just
   * shortened their idle timeout because they are about to walk away should not have to lock
   * and reopen the vault for the change to mean anything.
   */
  updateMachineSettings(patch: Partial<MachineSettings>): MachineSettings {
    // Assembled field by field rather than spread: under `exactOptionalPropertyTypes` a
    // spread of an all-optional patch widens every key to include `undefined`, and an
    // explicitly-undefined preference is a *different* thing from an absent one — it would
    // overwrite the stored value with nothing.
    const applied: { -readonly [K in keyof Preferences]?: Preferences[K] } = {};
    if (patch.autoLock !== undefined) applied.autoLock = patch.autoLock;
    if (patch.clipboardClearMs !== undefined) applied.clipboardClearMs = patch.clipboardClearMs;
    if (patch.wipeAfterFailedAttempts !== undefined) {
      applied.wipeAfterFailedAttempts = patch.wipeAfterFailedAttempts;
    }

    this.#preferences.update(applied);
    if (patch.autoLock !== undefined) this.#autoLock.configure(patch.autoLock);
    return this.machineSettings();
  }

  get vault(): VaultService {
    return this.#vault;
  }

  get preferences(): Preferences {
    return this.#preferences.get();
  }

  // ── Opening ────────────────────────────────────────────────────────────────

  /**
   * Reads what can be known without the password, and remembers it as the pending vault.
   *
   * Surfaces an interrupted write here rather than after unlocking: telling someone their
   * previous save may not have completed *after* they have typed their password means they
   * have already committed to a path.
   */
  async inspect(path: string): Promise<VaultLockedInfo> {
    const info = await VaultService.inspect(path);
    this.#pendingVault = info;
    return info;
  }

  async createVault(path: string, password: string): Promise<VaultSummary> {
    const summary = await this.#vault.createVault({
      path,
      password,
      derive: (pw, params) => this.#kdf.derive(pw, params),
    });

    this.#afterOpen(summary);
    return summary;
  }

  /**
   * Unlocks with the master password.
   *
   * Throttling is applied here rather than inside `VaultService`, because the delay is a
   * property of *this session at this keyboard* — not of the vault, which an attacker with
   * the file can hammer offline regardless. See `unlock-throttle.ts`.
   */
  async unlock(path: string, password: string): Promise<VaultSummary> {
    if (!this.#throttle.canAttempt()) {
      const seconds = Math.ceil(this.#throttle.state.lockedForMs / 1000);
      throw new VaultError(
        'WRONG_PASSWORD',
        `Too many failed attempts. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`
      );
    }

    try {
      const summary = await this.#vault.unlock(path, password, (pw, params) =>
        this.#kdf.derive(pw, params)
      );
      this.#throttle.recordSuccess();
      this.#afterOpen(summary);
      return summary;
    } catch (error) {
      if (error instanceof VaultError && error.code === 'WRONG_PASSWORD') {
        this.#throttle.recordFailure();
        await this.#maybeWipe(path);
      }
      throw error;
    }
  }

  /**
   * Unlocks using the stored, OS-wrapped key.
   *
   * Returns `null` when there is no enrolment, when it no longer applies, or when the user
   * declined a biometric prompt — all of which mean "fall back to the password", and none
   * of which is worth distinguishing to the caller.
   */
  async unlockWithQuickUnlock(path: string): Promise<VaultSummary | null> {
    const info = await VaultService.inspect(path);
    const record = this.#preferences.getQuickUnlock(info.vaultId);
    if (record === null) return null;

    if (!this.#quickUnlock.isValidFor(record, info.vaultId, info.generation)) {
      // The vault was re-keyed since enrolment. The stored wrapping is stale, so remove it
      // rather than leaving a dead entry that fails every time.
      this.#preferences.setQuickUnlock(info.vaultId, null);
      return null;
    }

    const dekBytes = await this.#quickUnlock.unlock(record, 'unlock your Keyhold vault');
    if (dekBytes === null) return null;

    const summary = await this.#vault.unlockWithKey(path, dekBytes);
    this.#throttle.recordSuccess();
    this.#afterOpen(summary);
    return summary;
  }

  /** Wraps the current vault's key for reuse. Requires an unlocked vault. */
  enrolQuickUnlock(): QuickUnlockCapability & { enrolledForThisVault: boolean } {
    const summary = this.#vault.summary();
    const record = this.#vault.exportKeyForQuickUnlock((dekBytes) =>
      this.#quickUnlock.enrol(summary.vaultId, dekBytes, summary.generation)
    );
    this.#preferences.setQuickUnlock(summary.vaultId, record);
    return { ...describeCapability(), enrolledForThisVault: true };
  }

  revokeQuickUnlock(vaultId?: string): void {
    const id = vaultId ?? (this.#vault.state === 'unlocked' ? this.#vault.summary().vaultId : null);
    if (id !== null) this.#preferences.setQuickUnlock(id, null);
  }

  // ── Locking ────────────────────────────────────────────────────────────────

  /**
   * The one lock path.
   *
   * Everything that must happen on lock happens here, in one place, so no caller can
   * perform a partial lock. In particular the clipboard is cleared: a vault locked while
   * the password it just handed out is still in Win+V is not locked in any sense the user
   * would recognise.
   */
  /**
   * Registers something to be torn down when the vault locks.
   *
   * Additive, and a set rather than a single slot, because the things that must die with
   * the key keep arriving: the import service holds a plaintext file and pre-merge copies of
   * records, a future sync session would hold a snapshot, a breach sweep holds range
   * prefixes. Every one of them is a thing whose owner has to *remember* to hook the lock,
   * and "remember" is how a decrypted note outlives the vault it came from.
   *
   * Listeners run in registration order, and one that throws does not stop the others: a
   * failed cleanup must not leave the rest of the app unlocked.
   */
  onLock(listener: () => void): () => void {
    this.#lockListeners.add(listener);
    return () => this.#lockListeners.delete(listener);
  }

  lock(reason: LockReason = 'manual'): void {
    this.#autoLock.disarm();
    this.#clipboard.clearOnExit();
    this.#vault.lock();
    this.#lastLockReason = reason;

    // After the key is gone, not before. A listener that reads the vault on its way out gets
    // a locked one, which is the state it is being told about.
    for (const listener of this.#lockListeners) {
      try {
        listener();
      } catch (error) {
        // Logged, never rethrown. This is the teardown path for secret material; one
        // listener failing must not prevent the next one from running.
        console.error('[session] a lock listener threw:', error);
      }
    }
  }

  async save(): Promise<VaultSummary> {
    return this.#vault.save();
  }

  // ── Secrets ────────────────────────────────────────────────────────────────

  /** Reveals a secret and copies it, with the configured auto-clear. */
  async copySecret(ref: SecretRef): Promise<ClipboardState | null> {
    const value = this.#vault.revealSecret(ref);
    if (value === null) return null;

    return this.#clipboard.copySecret(value, {
      clearAfterMs: this.#preferences.get().clipboardClearMs,
    });
  }

  async clearClipboard(): Promise<ClipboardState> {
    return this.#clipboard.clear();
  }

  async estimateStrength(password: string): Promise<PasswordStrength> {
    return estimateStrength(password);
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  status(): SessionStatus {
    const unlocked = this.#vault.state === 'unlocked';
    const summary = unlocked ? this.#vault.summary() : null;
    const capability = describeCapability();

    return {
      state: unlocked ? 'unlocked' : this.#pendingVault === null ? 'no-vault' : 'locked',
      vault: summary,
      pendingVault: unlocked ? null : this.#pendingVault,
      throttle: this.#throttle.state,
      clipboard: this.#clipboard.state,
      quickUnlock: {
        ...capability,
        enrolledForThisVault:
          summary !== null && this.#preferences.getQuickUnlock(summary.vaultId) !== null,
      },
      recentVaults: this.#preferences.get().recentVaults,
      lastLockReason: this.#lastLockReason,
      hasUnsavedChanges: this.#vault.hasUnsavedChanges,
    };
  }

  updatePreferences(patch: Partial<Preferences>): Preferences {
    const next = this.#preferences.update(patch);
    this.#autoLock.configure(next.autoLock);
    return next;
  }

  forgetVault(path: string): Preferences {
    return this.#preferences.forgetVault(path);
  }

  /** Called on quit. Locks, clears, and tears the worker down. */
  dispose(): void {
    this.lock('manual');
    this.#kdf.dispose();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  #afterOpen(summary: VaultSummary): void {
    this.#pendingVault = null;
    this.#lastLockReason = null;
    this.#preferences.recordOpened({
      path: summary.path,
      displayName: summary.displayName || basename(summary.path),
      vaultId: summary.vaultId,
    });
    this.#autoLock.configure(this.#preferences.get().autoLock);
    this.#autoLock.arm(this.#window ?? undefined);
  }

  /**
   * Destroys the vault after too many failures, if the user asked for that.
   *
   * Off by default and deliberately hard to enable — see `preferences.ts`. It is a real
   * request in some threat models and a permanent data-loss trap in most, so it never
   * happens without an explicit, type-to-confirm opt-in, and never below three attempts.
   *
   * **Every copy goes, not just the vault and its backups.** An earlier version removed the
   * vault and ten `.bak.N` slots by name, which left behind the two files most likely to be
   * a complete openable vault: the `.tmp` an interrupted write orphans, and the
   * `.recovered-<stamp>` that `quarantineOrphanedTemp` deliberately creates and never
   * deletes. Either one hands back everything the wipe was asked to destroy. `atomic-write`
   * owns the naming and answers what the copies are, so this cannot drift from the write
   * path that creates them.
   *
   * Deletion is best-effort per file: one locked handle must not stop the rest being
   * removed, because a partial wipe is still better than none.
   */
  async #maybeWipe(path: string): Promise<void> {
    const threshold = this.#preferences.get().wipeAfterFailedAttempts;
    if (threshold === null) return;
    if (this.#throttle.state.failedAttempts < threshold) return;

    // The vault itself is removed explicitly as well as through the listing, so a directory
    // that cannot be read still loses the file the user actually pointed at.
    await rm(path, { force: true });
    for (const copy of await listVaultCopyPaths(path)) {
      await rm(copy, { force: true }).catch(() => undefined);
    }
    this.#preferences.forgetVault(path);
    this.#pendingVault = null;
  }
}
