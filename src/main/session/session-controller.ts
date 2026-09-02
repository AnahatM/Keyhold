// SPDX-License-Identifier: GPL-3.0-or-later
import { rm } from 'node:fs/promises';
import { basename } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { SecretRef } from '@shared/model/credential.js';
import type { PasswordStrength } from '@shared/model/strength.js';
import type { VaultLockedInfo, VaultSummary } from '@shared/model/vault-document.js';
import { KdfRunner, type KdfProvider } from '../crypto/kdf-runner.js';
import { VaultError } from '../crypto/errors.js';
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
  lock(reason: LockReason = 'manual'): void {
    this.#autoLock.disarm();
    this.#clipboard.clearOnExit();
    this.#vault.lock();
    this.#lastLockReason = reason;
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
   * Backups are removed too. Leaving them would make the whole feature theatre.
   */
  async #maybeWipe(path: string): Promise<void> {
    const threshold = this.#preferences.get().wipeAfterFailedAttempts;
    if (threshold === null) return;
    if (this.#throttle.state.failedAttempts < threshold) return;

    await rm(path, { force: true });
    for (let index = 1; index <= 10; index += 1) {
      await rm(`${path}.bak.${index}`, { force: true });
    }
    this.#preferences.forgetVault(path);
    this.#pendingVault = null;
  }
}
