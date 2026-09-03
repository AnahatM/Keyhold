// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { writeJsonFileSync } from '../config-file.js';
import { coerceAutoLockSettings, type AutoLockSettings } from './auto-lock.js';
import type { QuickUnlockRecord } from './quick-unlock.js';

/**
 * Machine-scoped application preferences.
 *
 * **Nothing secret lives here.** Vault paths, window behaviour, auto-lock timings, and the
 * OS-wrapped quick-unlock records — which are themselves ciphertext only the OS key store
 * can open. No password, no key, no credential.
 *
 * Deliberately separate from vault settings, which live *inside* the encrypted file: those
 * are properties of the data and should travel with it to another machine, while these are
 * properties of this machine and should not. Carrying a vault to a friend's laptop must not
 * re-theme their app or import your idle timeout.
 *
 * Written synchronously. The file is a few hundred bytes, it is written on user actions
 * rather than in a loop, and an async write would need its own ordering guarantees for no
 * measurable gain. Synchronous does not mean careless: it goes through
 * `writeJsonFileSync`, which writes `0o600` and renames into place, so the file is never
 * observed empty and never world-readable.
 */

export interface RecentVault {
  readonly path: string;
  readonly displayName: string;
  readonly vaultId: string;
  readonly lastOpenedAt: number;
}

export interface Preferences {
  readonly recentVaults: readonly RecentVault[];
  readonly autoLock: AutoLockSettings;
  /** Milliseconds before a copied secret is cleared. `null` disables the timer. */
  readonly clipboardClearMs: number | null;
  /**
   * Erase the vault file after N consecutive failed unlocks.
   *
   * `null` — the default — means never. This is a genuinely dangerous option: a forgotten
   * password or a child at the keyboard destroys the vault permanently. It exists because
   * some threat models want it, and it is off, opt-in, and type-to-confirm.
   */
  readonly wipeAfterFailedAttempts: number | null;
  /**
   * The global network kill-switch. **Off, and this is the default that matters.**
   *
   * Machine-scoped, and deliberately not a vault setting: vault settings travel inside the
   * `.keep` file, and a vault carried to a friend's laptop must not be able to turn that
   * machine's network on. See `src/main/network-policy.ts` for the whole argument.
   *
   * Named positively so no call site reads a double negative. `NetworkPolicy` is the only
   * thing that reads it — hard rule 8 — and the coercion below is fail-closed.
   */
  readonly networkAllowed: boolean;
  /** Quick-unlock enrolments, keyed by vault id. */
  readonly quickUnlock: Readonly<Record<string, QuickUnlockRecord>>;
}

export const DEFAULT_PREFERENCES: Preferences = {
  recentVaults: [],
  autoLock: coerceAutoLockSettings(undefined),
  clipboardClearMs: 30_000,
  wipeAfterFailedAttempts: null,
  networkAllowed: false,
  quickUnlock: {},
};

const MAX_RECENT = 10;

function preferencesFile(): string {
  return join(app.getPath('userData'), 'preferences.json');
}

function isRecentVault(value: unknown): value is RecentVault {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.path === 'string' &&
    raw.path !== '' &&
    typeof raw.displayName === 'string' &&
    typeof raw.vaultId === 'string' &&
    typeof raw.lastOpenedAt === 'number'
  );
}

function isQuickUnlockRecord(value: unknown): value is QuickUnlockRecord {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.vaultId === 'string' &&
    typeof raw.protectedDek === 'string' &&
    typeof raw.enrolledAt === 'number' &&
    typeof raw.generation === 'number'
  );
}

/**
 * Coerces stored data field by field.
 *
 * A preferences file can be hand-edited, written by an older build, or truncated by a full
 * disk. Rejecting the whole file for one bad field would throw away every other setting
 * the user had chosen, so each is validated independently.
 */
export function coercePreferences(value: unknown): Preferences {
  if (typeof value !== 'object' || value === null) return DEFAULT_PREFERENCES;
  const raw = value as Record<string, unknown>;

  const recentVaults = Array.isArray(raw.recentVaults)
    ? raw.recentVaults.filter(isRecentVault).slice(0, MAX_RECENT)
    : DEFAULT_PREFERENCES.recentVaults;

  const quickUnlock: Record<string, QuickUnlockRecord> = {};
  if (typeof raw.quickUnlock === 'object' && raw.quickUnlock !== null) {
    for (const [key, record] of Object.entries(raw.quickUnlock)) {
      if (isQuickUnlockRecord(record)) quickUnlock[key] = record;
    }
  }

  const clipboardClearMs =
    raw.clipboardClearMs === null
      ? null
      : typeof raw.clipboardClearMs === 'number' && raw.clipboardClearMs > 0
        ? Math.min(10 * 60_000, Math.round(raw.clipboardClearMs))
        : DEFAULT_PREFERENCES.clipboardClearMs;

  // A wipe threshold below 3 would fire on ordinary typos, which is not a security setting
  // but a data-loss trap. Anything nonsensical falls back to "never".
  const wipeAfterFailedAttempts =
    typeof raw.wipeAfterFailedAttempts === 'number' &&
    Number.isInteger(raw.wipeAfterFailedAttempts) &&
    raw.wipeAfterFailedAttempts >= 3
      ? Math.min(100, raw.wipeAfterFailedAttempts)
      : null;

  return {
    recentVaults,
    autoLock: coerceAutoLockSettings(raw.autoLock),
    clipboardClearMs,
    wipeAfterFailedAttempts,
    // `=== true`, not truthiness and not a fallback to the default. Every other field here
    // falls back to what the user most likely wanted; this one falls back to off. A missing
    // key, `null`, the string "true", a truncated file or one written by a future build all
    // read as false, because a kill-switch that fails open on corruption is not one.
    networkAllowed: raw.networkAllowed === true,
    quickUnlock,
  };
}

export class PreferencesStore {
  #cache: Preferences | null = null;

  get(): Preferences {
    if (this.#cache !== null) return this.#cache;
    try {
      this.#cache = coercePreferences(JSON.parse(readFileSync(preferencesFile(), 'utf8')));
    } catch {
      // No file yet, or an unreadable one. Neither is worth surfacing — first run looks
      // exactly like this.
      this.#cache = DEFAULT_PREFERENCES;
    }
    return this.#cache;
  }

  update(patch: Partial<Preferences>): Preferences {
    const next = { ...this.get(), ...patch };
    this.#cache = next;
    try {
      // Atomic and `0o600`, not a plain truncating write: this file carries the OS-wrapped
      // `protectedDek`, and a crash mid-write would otherwise leave it empty and silently
      // drop every quick-unlock enrolment and the recent-vault list. See `config-file.ts`.
      writeJsonFileSync(preferencesFile(), next);
    } catch {
      // Losing a preference is never a reason to interrupt someone mid-task. The value is
      // still live in memory for this session.
    }
    return next;
  }

  /** Moves a vault to the top of the recent list, de-duplicating by path. */
  recordOpened(vault: Omit<RecentVault, 'lastOpenedAt'>): Preferences {
    const others = this.get().recentVaults.filter((entry) => entry.path !== vault.path);
    return this.update({
      recentVaults: [{ ...vault, lastOpenedAt: Date.now() }, ...others].slice(0, MAX_RECENT),
    });
  }

  forgetVault(path: string): Preferences {
    return this.update({
      recentVaults: this.get().recentVaults.filter((entry) => entry.path !== path),
    });
  }

  setQuickUnlock(vaultId: string, record: QuickUnlockRecord | null): Preferences {
    const quickUnlock = { ...this.get().quickUnlock };
    if (record === null) {
      // Deleting the wrapping IS the revocation — it is the only copy of the DEK under the
      // OS key, so removing it makes quick unlock impossible without touching the vault.
      // Setting it to undefined instead would serialise as a null and leave a dead entry
      // that fails on every future unlock attempt.
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete quickUnlock[vaultId];
    } else {
      quickUnlock[vaultId] = record;
    }
    return this.update({ quickUnlock });
  }

  getQuickUnlock(vaultId: string): QuickUnlockRecord | null {
    return this.get().quickUnlock[vaultId] ?? null;
  }
}
