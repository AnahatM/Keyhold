// SPDX-License-Identifier: GPL-3.0-or-later
import { LOCK_NOTICE_SEQ } from '@shared/model/activity.js';
import type {
  ActivityEntry,
  ActivityLockReason,
  ActivitySnapshot,
  ActivityUnlockMethod,
} from '@shared/model/activity.js';
import type { AuditPrivacyLevel, SecretRef } from '@shared/model/credential.js';
import type { LockReason } from '../session/auto-lock.js';
import { ActivityLog, type ActivityLogOptions } from './activity-log.js';

/**
 * The session's view of the activity log: one named method per thing that can happen.
 *
 * `ActivityLog` is a ring buffer with a privacy gate and knows nothing about vaults. This
 * is the layer that knows the vocabulary — and, more usefully, it is the layer that owns
 * the *invariants a call site must not be able to get wrong*:
 *
 *  - the vault label is set once, when the vault opens, rather than passed at every call
 *    site (where one forgotten argument would produce a log half of which names the vault);
 *  - the privacy level is read from the vault's own settings at the same moment, so a log
 *    can never be recording detail the vault's audit setting forbids;
 *  - locking clears, and there is no method that records without going through here.
 *
 * Bind it in `SessionController`; the exact wiring is in the report accompanying this
 * change and in `docs/05-Features` when that doc is written.
 */

/**
 * Compile-time proof that the shared lock-reason list has not drifted from the real one.
 *
 * `@shared` cannot import from `src/main`, so `ACTIVITY_LOCK_REASONS` restates `LockReason`.
 * Hard rule 8 forbids a second list that can disagree, so this makes disagreement a type
 * error instead: adding a reason to `LockReason` without adding it to
 * `ACTIVITY_LOCK_REASONS` fails to compile here. The genuine fix is for `auto-lock.ts` to
 * import its type from `@shared`; until it does, this is the guard.
 */
type _LockReasonsCovered = LockReason extends ActivityLockReason
  ? true
  : ['Unlisted lock reason — add it to ACTIVITY_LOCK_REASONS in @shared/model/activity.ts'];
export const _lockReasonsCovered: _LockReasonsCovered = true;

/** The little of a vault summary this needs. A `VaultSummary` satisfies it. */
export interface ActivityVaultRef {
  /** The display name, never the path — a path contains the OS user's name. */
  readonly displayName: string;
  readonly settings: { readonly auditPrivacyLevel: AuditPrivacyLevel };
}

export class SessionActivity {
  readonly #log: ActivityLog;
  #vaultLabel: string | null = null;

  constructor(log: ActivityLog | ActivityLogOptions = {}) {
    this.#log = log instanceof ActivityLog ? log : new ActivityLog(log);
  }

  get log(): ActivityLog {
    return this.#log;
  }

  snapshot(): ActivitySnapshot {
    return this.#log.snapshot();
  }

  // ── Session lifecycle ──────────────────────────────────────────────────────

  /**
   * A vault opened. Call from `SessionController.#afterOpen`.
   *
   * The privacy level is applied *before* the entry is recorded, so the very first entry of
   * a session already obeys the vault's own setting. Applying it afterwards would leak one
   * label per unlock, forever, at level `none` — the kind of off-by-one that is invisible
   * in review and permanent in behaviour.
   */
  vaultOpened(vault: ActivityVaultRef, method: ActivityUnlockMethod): ActivityEntry {
    this.#log.setPrivacyLevel(vault.settings.auditPrivacyLevel);
    this.#vaultLabel = vault.displayName;
    return this.#record({ kind: 'unlock', unlockMethod: method });
  }

  /**
   * A wrong master password.
   *
   * Carries no label and no attempt count: the throttle owns the count, and duplicating it
   * here would be a second number that could disagree with the one on the unlock screen.
   * There is nothing to identify — a failed unlock has no vault open to name.
   */
  unlockFailed(): ActivityEntry {
    return this.#log.record({ kind: 'unlock-failed' });
  }

  /**
   * The vault locked.
   *
   * **Returns the entry rather than storing it, and clears the log.** Storing it would be a
   * hole in "cleared on lock" — one entry surviving the wipe, saying the wipe happened —
   * and it would be an entry nothing can ever display, because the only UI that shows this
   * log is the one that unmounts when the vault locks. Returning it lets the caller hand
   * the reason to the renderer with the status change that follows, which is where
   * "Vault locked — no activity for 10 minutes" belongs, without anything retaining it.
   */
  locked(reason: LockReason): ActivityEntry {
    // Built by hand rather than through `#record`, because `record()` stores, and this must
    // not. `seq` is 0 — reserved for exactly this notice, since the log's own counter starts
    // at 1 — so a renderer keying a list by `seq` can tell a notice from a stored entry.
    // No `vaultLabel`: naming the vault in the announcement that it just locked would be the
    // one disclosure the lock exists to prevent, spoken aloud by a live region.
    const notice: ActivityEntry = {
      seq: LOCK_NOTICE_SEQ,
      at: Date.now(),
      kind: 'lock',
      lockReason: reason,
    };

    this.#vaultLabel = null;
    this.#log.clear();
    return notice;
  }

  // ── Secrets ────────────────────────────────────────────────────────────────

  /** A secret was resolved for display. One entry per reveal — the broker grants one at a time. */
  secretRevealed(ref: SecretRef): ActivityEntry {
    return this.#record({ kind: 'reveal', subjectId: ref.credentialId, secretKind: ref.kind });
  }

  /** A secret was put on the clipboard. Distinct from a reveal: it left the app. */
  secretCopied(ref: SecretRef): ActivityEntry {
    return this.#record({ kind: 'copy', subjectId: ref.credentialId, secretKind: ref.kind });
  }

  /**
   * The clipboard was wiped.
   *
   * Recorded because its *absence* is the interesting case: a copy with no matching clear
   * means the value is still sitting in Win+V, and a user looking at this log deserves to
   * be able to see that from the log rather than infer it.
   */
  clipboardCleared(): ActivityEntry {
    return this.#record({ kind: 'clipboard-clear' });
  }

  // ── The file ───────────────────────────────────────────────────────────────

  vaultSaved(recordCount: number): ActivityEntry {
    return this.#record({ kind: 'save', count: recordCount });
  }

  imported(recordCount: number): ActivityEntry {
    return this.#record({ kind: 'import', count: recordCount });
  }

  /**
   * Records an export.
   *
   * The most sensitive action in the app — a plaintext export is the vault, in a file, with
   * no key on it — so it is recorded with its record count even though nothing else about
   * it is. The destination path is deliberately absent: it names a directory on this
   * machine, which is provenance the audit level governs, and a truncated path would be
   * worse than none.
   */
  exported(recordCount: number): ActivityEntry {
    return this.#record({ kind: 'export', count: recordCount });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Adds the vault label to every entry, so no call site can forget it or invent one. */
  #record(input: Omit<Parameters<ActivityLog['record']>[0], 'vaultLabel'>): ActivityEntry {
    return this.#log.record(
      this.#vaultLabel === null ? input : { ...input, vaultLabel: this.#vaultLabel }
    );
  }
}
