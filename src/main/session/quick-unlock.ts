// SPDX-License-Identifier: GPL-3.0-or-later
import { safeStorage, systemPreferences } from 'electron';

/**
 * Quick unlock — reopening a vault without retyping the master password.
 *
 * ## What this actually is, stated plainly
 *
 * It is tempting to call this "biometric unlock" everywhere, and on macOS that is
 * accurate. On Windows it currently is not, and the difference matters enough that the API
 * reports it rather than papering over it.
 *
 * | Platform | What guards the stored key | Is there a biometric prompt? |
 * |---|---|---|
 * | macOS | Keychain, plus an explicit **Touch ID** prompt before each use | **Yes**, where the hardware exists |
 * | Windows | **DPAPI**, bound to the logged-in Windows account | **No** — see below |
 * | Linux | The desktop secret store (kwallet / gnome-libsecret) | No |
 *
 * On Windows, Electron's `safeStorage` uses DPAPI, which ties the ciphertext to the Windows
 * user account. That is a real protection — another user on the same machine cannot
 * decrypt it, and neither can someone who copies the file to another machine — but it is
 * **not** a biometric gate. Anyone already sitting at an unlocked Windows session can use
 * it. Windows Hello has no Electron API and would need a native module, which conflicts
 * with the no-native-binaries decision (D14). It is in the backlog.
 *
 * So the honest framing, and the one the UI uses: *"Unlock without retyping your master
 * password. Protected by your <platform mechanism>."* — never "biometric" on a platform
 * where there is no biometric prompt. Overstating this would lead someone to enable it in
 * a threat model where it does not hold.
 *
 * ## Why it is safe to store anything at all
 *
 * What is stored is the **DEK, wrapped again** under a key `safeStorage` controls — an
 * independent wrapping of the same data key (decision D13's envelope design). The master
 * password is never stored, in any form. Revoking quick unlock deletes this one wrapping
 * and touches nothing else, so it can be turned off without re-encrypting the vault or
 * changing the password.
 */

export type QuickUnlockMechanism =
  'touch-id' | 'windows-account' | 'desktop-keyring' | 'unavailable';

export interface QuickUnlockCapability {
  readonly available: boolean;
  readonly mechanism: QuickUnlockMechanism;
  /** Whether using the stored key requires an explicit biometric confirmation. */
  readonly promptsForBiometrics: boolean;
  /** Shown verbatim in the UI. Must never overstate what the platform provides. */
  readonly description: string;
}

export function describeCapability(): QuickUnlockCapability {
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      available: false,
      mechanism: 'unavailable',
      promptsForBiometrics: false,
      description:
        'Your system does not provide a secure key store, so quick unlock is unavailable. Your master password is still the only way in.',
    };
  }

  if (process.platform === 'darwin') {
    const hasTouchId = systemPreferences.canPromptTouchID();
    return {
      available: true,
      mechanism: 'touch-id',
      promptsForBiometrics: hasTouchId,
      description: hasTouchId
        ? 'Unlock with Touch ID instead of retyping your master password. The key is stored in your macOS Keychain and Touch ID is required each time.'
        : 'Unlock without retyping your master password. The key is stored in your macOS Keychain. This Mac has no Touch ID sensor, so anyone using your account can unlock the vault.',
    };
  }

  if (process.platform === 'win32') {
    return {
      available: true,
      mechanism: 'windows-account',
      // Deliberately false. DPAPI binds the key to the Windows account; it does not ask
      // for a fingerprint or a PIN.
      promptsForBiometrics: false,
      description:
        'Unlock without retyping your master password. The key is protected by Windows and tied to your Windows account — but anyone already signed in to this account can use it. Windows Hello is not yet supported.',
    };
  }

  return {
    available: true,
    mechanism: 'desktop-keyring',
    promptsForBiometrics: false,
    description:
      'Unlock without retyping your master password. The key is stored in your desktop keyring, and anyone signed in to this account can use it.',
  };
}

/** What is persisted. Contains no plaintext key and no password. */
export interface QuickUnlockRecord {
  readonly vaultId: string;
  /** The DEK, wrapped by the OS key store. Base64. */
  readonly protectedDek: string;
  readonly mechanism: QuickUnlockMechanism;
  readonly enrolledAt: number;
  /** The vault generation at enrolment, so a re-keyed vault invalidates it. */
  readonly generation: number;
}

export class QuickUnlock {
  /**
   * Wraps the DEK for later reuse.
   *
   * Takes the raw key bytes rather than a `SecretBytes`, so the caller has to reach into
   * one explicitly — this is a place where key material genuinely leaves the usual
   * handling, and that should be visible at the call site.
   */
  enrol(vaultId: string, dekBytes: Uint8Array, generation: number): QuickUnlockRecord {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('This system does not provide a secure key store.');
    }

    // base64 rather than raw bytes because `safeStorage` works in strings; the value is
    // re-encrypted immediately, so it is never at rest in this form.
    const encoded = Buffer.from(dekBytes).toString('base64');
    const protectedDek = safeStorage.encryptString(encoded).toString('base64');

    return {
      vaultId,
      protectedDek,
      mechanism: describeCapability().mechanism,
      enrolledAt: Date.now(),
      generation,
    };
  }

  /**
   * Recovers the DEK, prompting for biometrics where the platform supports it.
   *
   * Returns `null` for every failure — a wrong user, a revoked keychain entry, a declined
   * Touch ID prompt, a record from another machine. The caller falls back to the master
   * password, which always works, so there is nothing useful to distinguish.
   */
  async unlock(record: QuickUnlockRecord, reason: string): Promise<Uint8Array | null> {
    if (!safeStorage.isEncryptionAvailable()) return null;

    if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
      try {
        await systemPreferences.promptTouchID(reason);
      } catch {
        // Declined, cancelled, or failed. Not an error — the user simply types their
        // password instead.
        return null;
      }
    }

    try {
      const decoded = safeStorage.decryptString(Buffer.from(record.protectedDek, 'base64'));
      const bytes = new Uint8Array(Buffer.from(decoded, 'base64'));
      // A wrong-sized key means a corrupted or foreign record. Refuse rather than handing
      // back something that will fail confusingly deeper in.
      return bytes.length === 32 ? bytes : null;
    } catch {
      return null;
    }
  }

  /**
   * Whether a stored record still applies to this vault.
   *
   * **This is not what invalidates an enrolment after a re-key, and it never was.** The
   * record stores the data key, and neither a password change nor a re-key rotates that
   * key — envelope encryption exists precisely so they do not — so a stale record would
   * decrypt the vault perfectly well. `generation` only ever increases, so `<=` cannot fail
   * on a vault that has merely been written since enrolment. Invalidation is done where the
   * decision belongs: `kh:settings:change-master-password` and `kh:settings:rekey` revoke
   * the enrolment outright, because a stored key that opens the vault with no password at
   * all would defeat the intent of both operations.
   *
   * What this check does catch is the one case the operations cannot: a record enrolled
   * against a *newer* copy of the vault than the file now on disk — a restored backup, or an
   * older file synced back over a newer one. The key would still work; refusing is the
   * conservative answer to "this record was made for a file I am not looking at".
   */
  isValidFor(record: QuickUnlockRecord, vaultId: string, generation: number): boolean {
    return record.vaultId === vaultId && record.generation <= generation;
  }
}
