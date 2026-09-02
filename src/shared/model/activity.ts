// SPDX-License-Identifier: GPL-3.0-or-later
import type { AuditPrivacyLevel, SecretRef } from './credential.js';

/**
 * The session activity log's vocabulary.
 *
 * ## What this records, and — more importantly — what it must never record
 *
 * An activity log in a password manager is a *second index of the vault*. "Revealed the
 * password for Barclays at 14:02" is not a neutral fact: it names an account the user
 * holds, binds it to a moment, and does so in a compact list that is far easier to read
 * over a shoulder, screenshot, or announce aloud than the credential list it was derived
 * from. So the shape of an entry is a security decision, not a display convenience, and it
 * is made here rather than at each call site.
 *
 * Three rules, enforced by the shape of `ActivityEntry` itself:
 *
 * 1. **No value, ever.** There is no field on an entry that can hold a password, a note, a
 *    security answer, a TOTP seed, or an attachment's bytes. `secretKind` says *that* a
 *    password was revealed; nothing says *which characters*. Not even a length — the
 *    `passwordLength` the safe projection carries for mask-width has no business in a log
 *    where it would accumulate into a per-record profile.
 *
 * 2. **No name, ever.** An entry carries a credential **id** — a UUID that is meaningless
 *    outside the open vault — and never a title. Resolving that id to a title is the
 *    renderer's job, from the safe projection it already holds, and it is
 *    off by default. See `ACTIVITY_LEVEL_DETAIL` and the renderer's
 *    `activity-presentation.ts`.
 *
 * 3. **Nothing durable.** These types describe an in-memory structure only. There is no
 *    serialiser here and no `documentVersion`, deliberately: a persisted activity log is an
 *    unencrypted shadow of which credentials exist and when they were touched, and it would
 *    outlive the lock that is supposed to make all of that unreadable.
 *
 * The type lives in `@shared` because the renderer renders entries the main process
 * produces. It is types and constants only — the log itself is main-process code.
 */

// ── What can happen ──────────────────────────────────────────────────────────

/**
 * A runtime array as well as a type, for the same reason as `HISTORY_ACTIONS` and
 * `AUDIT_PRIVACY_LEVELS`: anything that has to label, filter, or count every kind needs
 * something to iterate, and a hand-written list at each of those sites is three lists that
 * disagree.
 */
export const ACTIVITY_KINDS = [
  'unlock',
  'unlock-failed',
  'lock',
  'reveal',
  'copy',
  'clipboard-clear',
  'save',
  'import',
  'export',
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * Why the vault locked.
 *
 * Mirrors `LockReason` in `src/main/session/auto-lock.ts` one for one. It is restated here
 * rather than imported because `@shared` must not depend on main-process code — but a
 * silently drifting copy is exactly what hard rule 8 forbids, so
 * `src/main/activity/session-activity.ts` carries a compile-time check that every
 * `LockReason` is one of these. Adding a reason without adding it here is a type error.
 */
export const ACTIVITY_LOCK_REASONS = [
  'idle',
  'sleep',
  'screen-lock',
  'minimise',
  'blur',
  'manual',
] as const;

export type ActivityLockReason = (typeof ACTIVITY_LOCK_REASONS)[number];

/** How the vault was opened. `created` is a new vault, which opens without an unlock. */
export const ACTIVITY_UNLOCK_METHODS = ['password', 'quick-unlock', 'created'] as const;
export type ActivityUnlockMethod = (typeof ACTIVITY_UNLOCK_METHODS)[number];

// ── The privacy level applies here too ───────────────────────────────────────

/**
 * The fields on an entry that are *about the user's situation* rather than about the
 * action, and are therefore governed by the audit privacy level.
 *
 * `subjectId` says which record; `vaultLabel` says which vault. Both are the session log's
 * equivalent of the provenance `ChangeOrigin` carries, and a user who set the level to
 * `none` has said they do not want that recorded. `origin.ts` enforces its levels **at
 * capture, not at display**, and this does the same: a field that was never put in the log
 * cannot be read out of a heap dump, cannot be announced by a live region, and cannot be
 * un-hidden by a future version of the app that has forgotten why the setting existed.
 */
export const ACTIVITY_DETAIL_FIELDS = ['subjectId', 'vaultLabel'] as const;
export type ActivityDetailField = (typeof ACTIVITY_DETAIL_FIELDS)[number];

/**
 * Which detail fields each level permits. Consumed by `ActivityLog` and by its test.
 *
 * There is deliberately nothing extra at `network` and `full`. A session log has no
 * network-shaped fact to record — it describes this process, on this machine, right now —
 * and inventing an SSID field so the higher levels had something to unlock would be adding
 * a leak to satisfy a table.
 */
export const ACTIVITY_LEVEL_DETAIL: Record<AuditPrivacyLevel, readonly ActivityDetailField[]> = {
  none: [],
  device: ['subjectId', 'vaultLabel'],
  network: ['subjectId', 'vaultLabel'],
  full: ['subjectId', 'vaultLabel'],
};

// ── An entry ─────────────────────────────────────────────────────────────────

/**
 * One thing that happened.
 *
 * Every optional field is *absent* rather than `undefined` when it does not apply — the
 * distinction `exactOptionalPropertyTypes` draws, and the one that makes "was this
 * suppressed by the privacy level?" answerable with `in`.
 */
export interface ActivityEntry {
  /**
   * Monotonic within the process, and **not reset by `clear()`**.
   *
   * A counter that restarted on every lock would hand the renderer two different entries
   * with the same key across a lock/unlock, which React resolves by reusing the wrong DOM
   * node. It counts actions, not secrets, so its value discloses nothing.
   */
  readonly seq: number;
  readonly at: number;
  readonly kind: ActivityKind;
  /** A credential id. **Never a title.** Absent at privacy level `none`. */
  readonly subjectId?: string;
  /** The vault's display name — never its path, which contains the OS user. Absent at `none`. */
  readonly vaultLabel?: string;
  /** How many records this entry is about. Never a size, never a length of anything secret. */
  readonly count?: number;
  /**
   * Which *kind* of secret was revealed or copied — password, notes, a security answer.
   *
   * Kept at every privacy level including `none`: it describes the action, not the user's
   * situation, and it is the field that makes the log useful as a tripwire. "Forty security
   * answers were revealed in ten seconds" is the sentence this log exists to be able to say.
   */
  readonly secretKind?: SecretRef['kind'];
  /** Present on `lock`. Kept at every level — it says what the action was, not where it was. */
  readonly lockReason?: ActivityLockReason;
  /** Present on `unlock`. Kept at every level, for the same reason as `lockReason`. */
  readonly unlockMethod?: ActivityUnlockMethod;
}

/**
 * The whole log, as a consumer sees it.
 *
 * `totals` and `droppedCount` exist because the buffer is bounded. A log that silently
 * under-reports after eviction would be worse than no log at all in the one scenario it is
 * for: a bulk harvest is exactly the workload that overflows the buffer, so the count must
 * survive the entries being dropped.
 */
export interface ActivitySnapshot {
  /** Oldest first. The renderer reverses for display; ordering is stated once, here. */
  readonly entries: readonly ActivityEntry[];
  /** Every action since the log was last cleared, including entries no longer listed. */
  readonly totals: Readonly<Record<ActivityKind, number>>;
  /** How many entries have been evicted from the ring. Non-zero means `entries` is partial. */
  readonly droppedCount: number;
  readonly capacity: number;
  /** When the first entry since the last clear was recorded. `null` for an empty log. */
  readonly startedAt: number | null;
}

/**
 * How many entries the ring holds.
 *
 * Bounded because an unbounded log grows fastest during exactly the operations that already
 * stress the app — a ten-thousand-record import would otherwise allocate ten thousand
 * objects nobody will scroll to. Five hundred is roughly a full working day of ordinary use
 * and several seconds of a runaway loop, which is long enough for a person to notice the
 * latter while it is still on screen.
 */
export const ACTIVITY_LOG_CAPACITY = 500;

/**
 * The `seq` of the lock notice — the one `ActivityEntry` that is never stored.
 *
 * Locking clears the log, so the entry describing the lock has nowhere to live; it is handed
 * to the renderer once, announced, and dropped. Zero is reserved for it because the log's own
 * counter starts at 1, which lets a list keyed by `seq` tell a notice from a stored entry
 * without a second flag. See `SessionActivity.locked`.
 */
export const LOCK_NOTICE_SEQ = 0;

/** A zeroed total for every kind. One place, so a new kind cannot be forgotten by a counter. */
export function emptyActivityTotals(): Record<ActivityKind, number> {
  const totals = {} as Record<ActivityKind, number>;
  for (const kind of ACTIVITY_KINDS) totals[kind] = 0;
  return totals;
}
