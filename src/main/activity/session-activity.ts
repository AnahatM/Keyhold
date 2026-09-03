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

/**
 * The three numbers a committed import produced.
 *
 * Three `number`s and nothing else, deliberately. `ImportCommitOutcome` — the shape the
 * commit actually returns — also carries the whole new `VaultDocument` and the undo batch's
 * pre-merge record snapshots, which is to say **every password in the vault**. Taking that
 * object here would put it one property access away from an in-memory log the user can read
 * on screen, and the property access that reached it would look entirely innocent in review.
 *
 * So the commit hands over a fresh object built from three of its fields, and this type is
 * what makes that a compile-time fact rather than a convention: there is no `document` to
 * reach for, because the parameter's type does not have one. Same reasoning as
 * `ActivityLog.record` assigning detail fields through a single gate — a field that was never
 * assigned cannot leak.
 */
export interface ImportOutcomeCounts {
  /** Incoming records that became a new credential. */
  readonly importedCount: number;
  /** Incoming records folded into another record. */
  readonly mergedCount: number;
  /** Incoming records deliberately not written, or that the vault refused. */
  readonly skippedCount: number;
}

/**
 * The one method an import commit needs in order to record itself.
 *
 * Declared here rather than in `import-service/commit.ts` so there is one definition of what
 * an import may tell the log, and so the dependency runs one way: the import service knows
 * about the activity log, and the activity log knows nothing about imports. `SessionActivity`
 * satisfies it, and so does a spy in a test.
 */
export interface ImportActivityRecorder {
  imported(outcome: ImportOutcomeCounts): ActivityEntry;
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

  /**
   * An import was committed into the vault.
   *
   * **Takes the whole set of counts and picks the one to record itself.** A bare `number`
   * parameter would let a call site pass `mergedCount`, or `plan.secretRecords.length` — which
   * counts rows in a file rather than records in a vault — and the log would then quietly be
   * describing something other than what happened. Which number the entry means is a decision
   * about what the log says, so it is made once, here, exactly as the vault label and the
   * privacy level are.
   *
   * The number recorded is `importedCount`: the records this import **created**. That is the
   * question the log exists to answer — how much bigger did the vault just get, and did I ask
   * for that — and it is the number the renderer's "N records imported" row already reads.
   *
   * The merged and skipped counts, and the source format, are deliberately **not** in the
   * entry. `ActivityEntry` carries one count, no free text, and no field a format id could go
   * in, and that shape is a security decision rather than an oversight — see the header of
   * `@shared/model/activity.ts`, which makes the same argument about not inventing a field so
   * a higher privacy level has something to unlock. The full breakdown is not lost: it travels
   * to the user on `ImportCommitResult`, on the wizard's own result screen, which is where
   * somebody is actually looking at the moment it matters.
   *
   * Recorded at the commit rather than after the save, so the entry marks the moment the
   * records entered the vault. Whether they reached the disk is the `save` entry's fact, and
   * it states it separately — an import followed by no save is a pair a reader can see.
   */
  imported(outcome: ImportOutcomeCounts): ActivityEntry {
    return this.#record({ kind: 'import', count: outcome.importedCount });
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
