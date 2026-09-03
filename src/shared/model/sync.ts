// SPDX-License-Identifier: GPL-3.0-or-later
import type { DiffSide } from './history.js';

/**
 * The shapes a merge produces: what it decided, what it refused to decide, and the report
 * the conflict resolver renders.
 *
 * Lives in `@shared` because the renderer draws the resolver — it needs the conflict ids to
 * key rows, the sides to show a diff, and the note kinds to explain what happened. The merge
 * itself runs in the main process only (`src/main/sync/`), because that is the only place the
 * two decrypted documents exist.
 *
 * **This file is types and declarative constants. No logic, and no Node imports** — it is
 * compiled into the renderer bundle, which has no Node at all.
 *
 * ## A merge report crosses the bridge, so decision D13 binds it
 *
 * A conflict is, by definition, about a value that differs — and for `password`, `notes`,
 * `securityQuestions` and `custom` that value **is** secret material. So a conflict carries a
 * `ConflictSide`, never a raw value: the same discriminated union the history diff uses, where
 * a secret crosses only as its length. That is not a convention this file hopes someone
 * remembers; `src/main/sync/conflict-projection.ts` builds every side by running the value
 * through the *existing* history projector, and a property test plants a marker in every
 * secret in both documents and asserts the serialised report does not contain it.
 *
 * The resolver still works, because resolving a conflict never needs the value in the
 * renderer: the user picks a side by name, the choice comes back as a `ConflictChoice`, and
 * the merge is re-run in the main process with that choice folded in. The actual values are
 * revealed one at a time through the secret broker, exactly like a historic password.
 */

// ── Which merge was performed ────────────────────────────────────────────────

/**
 * `'three-way'` when a common ancestor was supplied, `'two-way'` when one was not.
 *
 * The distinction is surfaced in the report rather than hidden, because the two modes give
 * genuinely different guarantees and the user is entitled to know which one they got:
 *
 *  - **Three-way** can tell an edit from a stale copy. If one side matches the ancestor, it
 *    did not change, so the other side's value is taken with no conflict and no question.
 *  - **Two-way cannot.** With no ancestor, "these differ" is all that is knowable — it is
 *    impossible to say whether they changed the title or we did. So every difference becomes
 *    a conflict, and a record present on one side only is *kept*, because absence and
 *    deletion are indistinguishable without a tombstone or an ancestor to compare against.
 *
 * A two-way merge is therefore noisier by design. That is the honest outcome, not a defect:
 * the alternative is to guess, and guessing in a password manager loses passwords.
 */
export const MERGE_MODES = ['three-way', 'two-way'] as const;
export type MergeMode = (typeof MERGE_MODES)[number];

// ── Conflicts ────────────────────────────────────────────────────────────────

/**
 * One side of a conflict, as the renderer may hold it.
 *
 * `DiffSide` — reused rather than redeclared, so there is exactly one definition of "how a
 * value crosses the bridge safely" and a change to it cannot leave this one behind — plus
 * `'absent'`, which the history diff has no use for but a merge does: a record can exist on
 * one side and not the other, and "the title was empty" and "there was no record" are
 * different facts that a UI must not render the same way.
 */
export type ConflictSide = DiffSide | { readonly kind: 'absent' };

/**
 * What kind of thing disagreed.
 *
 * A runtime array as well as a type, following `HISTORY_ACTIONS` and `HEALTH_RULE_IDS`:
 * anything validating a report that arrived over IPC needs something to check against, and a
 * hand-written list at each of those sites is three lists that disagree.
 */
export const MERGE_CONFLICT_KINDS = [
  /** Both sides changed the same field of the same record to different values. */
  'record-field',
  /** One side trashed the record; the other edited it. See `MergeConflict.applied`. */
  'record-delete-vs-edit',
  /** The per-record history switch or retention cap disagreed. */
  'record-history',
  'folder',
  'tag',
  'setting',
] as const;
export type MergeConflictKind = (typeof MERGE_CONFLICT_KINDS)[number];

/** Which document a value was taken from. Never "newer" — see `MergeResolution`. */
export type ConflictChoice = 'ours' | 'theirs';

/**
 * Where the value in the merged document actually came from.
 *
 * `'merged'` is not a third choice the user can make — it is what an id-keyed field looks
 * like when both sides contributed. Two devices each adding a custom field produce a record
 * holding both, which is neither side's list; saying `'ours'` there would be a lie the
 * resolver would render as "yours was kept" while showing a value that is not yours.
 */
export type AppliedSide = ConflictChoice | 'merged';

/**
 * How a conflict came to have a value in the merged document.
 *
 * The three are deliberately distinguished, because "the app chose for you" and "you chose"
 * and "nobody has chosen yet" carry completely different weight, and a report that flattened
 * them would let an unresolved conflict be saved as though it had been settled.
 *
 *  - `'unresolved'` — the merged document holds a **provisional** value. The caller must not
 *    write the vault without asking. `MergeReport.requiresResolution` is true whenever any
 *    conflict is in this state.
 *  - `'user'` — a `ConflictChoice` was supplied in `MergeOptions.resolutions`.
 *  - `'policy'` — settled automatically by a rule written down in `src/main/sync/`, and only
 *    ever for things where one answer is strictly safer than the other: the more private
 *    audit level, the longer trash retention, the larger history cap, history switched off.
 *    Never for a credential field — a password is never chosen for the user.
 */
export const MERGE_RESOLUTIONS = ['unresolved', 'user', 'policy'] as const;
export type MergeResolution = (typeof MERGE_RESOLUTIONS)[number];

export interface MergeConflict {
  /**
   * Stable, deterministic, and **independent of which document was passed first** —
   * `record:<id>:field:password`. That is what lets a resolver keep its selection across a
   * re-merge, and what lets the commutativity test compare two merges by conflict id.
   */
  readonly id: string;
  readonly kind: MergeConflictKind;
  /** The record, folder or tag id; for `'setting'`, the settings key. */
  readonly targetId: string;
  /** The property within the target. `null` when the whole object is the subject. */
  readonly field: string | null;
  readonly ours: ConflictSide;
  readonly theirs: ConflictSide;
  /** The common ancestor's value. Always `null` in two-way mode — there was no ancestor. */
  readonly base: ConflictSide | null;
  /** Which side's value the merged document currently holds. */
  readonly applied: AppliedSide;
  readonly resolution: MergeResolution;
}

// ── Notes: decisions taken automatically, reported rather than hidden ─────────

/**
 * Things the merge decided on its own that the user should still be able to see.
 *
 * A note is not a conflict: nothing is pending and nothing is provisional. It exists because
 * "the merge silently did the right thing" and "the merge silently did something" are
 * indistinguishable to a user staring at a vault that changed, and the whole point of a merge
 * report is that a merge is never silent.
 */
export const MERGE_NOTE_KINDS = [
  /** A record that exists only on the other side was brought in. */
  'record-added',
  /**
   * A record present in the ancestor and on one side only was **kept**, not deleted.
   *
   * Absence is not deletion — only a tombstone deletes. See `src/main/sync/merge-document.ts`
   * for why that trade is made deliberately, and what it costs.
   */
  'record-kept-unmatched',
  /** Gone from both sides relative to the ancestor: both devices purged it. Dropped. */
  'record-purged',
  /** A tombstone was honoured although the other side still held the record live. */
  'tombstone-preserved',
  /** The other side restored it from the trash, so the merged record is live again. */
  'record-restored',
  /** Version numbers were reassigned because two timelines were interleaved. */
  'history-renumbered',
  /** The combined timeline exceeded the record's retention cap; the oldest were dropped. */
  'history-truncated',
  'folder-added',
  'folder-kept-unmatched',
  /** A folder deleted on one side was kept because a surviving record still lives in it. */
  'folder-resurrected',
  /** A folder's parent did not survive the merge, so it was moved to the root. */
  'folder-reparented',
  /** The merged folder tree contained a cycle; one link was cut to break it. */
  'folder-cycle-broken',
  /** A record referenced a folder that exists nowhere; the record was moved to the root. */
  'record-unfiled',
  /** A saved search that exists only on the other side was brought in. */
  'saved-search-added',
  /** Present in the ancestor and on one side only. Kept — absence alone never deletes. */
  'saved-search-kept-unmatched',
  'tag-added',
  'tag-kept-unmatched',
  /**
   * The merged document references an attachment whose bytes live in the *other* vault file.
   *
   * This engine merges documents, not containers. The caller must copy the chunk across
   * before writing, or the record will point at an attachment that cannot be opened.
   */
  'attachment-needed',
] as const;
export type MergeNoteKind = (typeof MERGE_NOTE_KINDS)[number];

export interface MergeNote {
  readonly kind: MergeNoteKind;
  /** The record, folder, tag or attachment id this is about. `null` for document-wide notes. */
  readonly targetId: string | null;
  /**
   * A count, where the note is about a quantity — versions dropped, and so on.
   *
   * A number rather than a formatted string, because the renderer owns wording and
   * pluralisation, and because a number cannot accidentally carry a value from a record.
   */
  readonly count: number | null;
}

// ── The report ───────────────────────────────────────────────────────────────

export interface MergeRecordCounts {
  readonly ours: number;
  readonly theirs: number;
  /** `null` in two-way mode. */
  readonly base: number | null;
  readonly merged: number;
  /** Records the merged document has that ours did not. */
  readonly added: number;
  /** Records present in ours whose merged form differs from it. */
  readonly updated: number;
  readonly unchanged: number;
  /** Records carrying a tombstone in the merged document. */
  readonly trashed: number;
  /** Records carrying at least one conflict. */
  readonly conflicted: number;
}

export interface MergeReport {
  readonly mode: MergeMode;
  /** The `now` the caller supplied. The whole merge is a pure function of its inputs and this. */
  readonly generatedAt: number;
  readonly counts: MergeRecordCounts;
  readonly conflicts: readonly MergeConflict[];
  readonly notes: readonly MergeNote[];
  /**
   * True while any conflict is `'unresolved'`.
   *
   * **The merged document is provisional while this is true.** Writing it would commit one
   * side of every unsettled disagreement without asking, which is precisely the last-writer-
   * wins behaviour this engine exists to avoid.
   */
  readonly requiresResolution: boolean;
  /**
   * Attachment chunk ids the merged document references that our vault does not hold.
   *
   * Copy these from the other container before writing, or those records will point at
   * attachments that cannot be opened. Also present, one per id, in `notes`.
   */
  readonly attachmentsToImport: readonly string[];
}
