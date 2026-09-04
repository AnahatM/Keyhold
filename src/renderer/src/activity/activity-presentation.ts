// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  ActivityEntry,
  ActivityKind,
  ActivityLockReason,
  ActivityUnlockMethod,
} from '@shared/model/activity.js';
import type { SecretRef } from '@shared/model/credential.js';
import type { StatusTone } from '../components/Feedback.js';
import type { IconName } from '../components/Icon.js';
import { MEANINGFUL_DISTRIBUTION_MIN, type Distribution } from './vault-statistics.js';

/**
 * Turning the activity log into English, and deciding how much of it to say out loud.
 *
 * Pure and outside the components, like `origin-labels.ts` and `health-presentation.ts`, for
 * the same reason: the strings are the feature, and `@testing-library/react` is not a
 * dependency here, so pure functions are what can actually be tested.
 *
 * ## The naming decision
 *
 * An entry carries a credential **id**. Whether a row reads "Password revealed" or
 * "Password revealed for Barclays" is decided here, at display time, from a toggle that is
 * **off by default**. The full argument is in the report accompanying this change; the short
 * version is that the log is a compact, timestamped, screenshot-friendly, screen-reader-read-
 * aloud list of which accounts were touched, and that is a genuinely different disclosure
 * from the credential list it was derived from — which shows the same titles but binds them
 * to nothing and scrolls away.
 *
 * The default answers the question the log exists for ("did something walk my vault?")
 * without naming anything, because that question is answered by counts and rates. Turning
 * names on is one click for the user who wants "what did I just do" instead.
 */

// ── Vocabulary ───────────────────────────────────────────────────────────────

/**
 * Exhaustive `Record`s rather than lookups with a fallback: a new kind with no label is a
 * compile error rather than an identifier appearing on screen.
 *
 * These were geometric marks — `○`, `△`, `◇` — which read as decoration rather than as
 * meaning: nothing about a diamond says "revealed". The icons say it, and they say it in the
 * same drawing the rest of the app uses for the same idea, so a reveal here and a reveal on a
 * credential row are recognisably the same event.
 *
 * `lock` and `unlock` are deliberately the same object with the shackle moved, because the
 * two rows they mark are the same event in two directions. `clipboard-clear` is `close`
 * rather than a second clipboard: the interesting thing about it is the *undoing*.
 */
const KIND_VERBS: Readonly<Record<ActivityKind, string>> = {
  unlock: 'Vault unlocked',
  'unlock-failed': 'Unlock failed',
  lock: 'Vault locked',
  reveal: 'Revealed',
  copy: 'Copied',
  'clipboard-clear': 'Clipboard cleared',
  save: 'Vault saved',
  import: 'Records imported',
  export: 'Records exported',
};

export const LOCK_REASON_LABELS: Readonly<Record<ActivityLockReason, string>> = {
  idle: 'no activity for a while',
  sleep: 'the computer went to sleep',
  'screen-lock': 'the screen locked',
  minimise: 'the window was minimised',
  blur: 'the window lost focus',
  manual: 'you locked it',
};

export const UNLOCK_METHOD_LABELS: Readonly<Record<ActivityUnlockMethod, string>> = {
  password: 'with the master password',
  'quick-unlock': 'with quick unlock',
  created: 'as a new vault',
};

/**
 * What kind of secret. Never how long it was, never anything about its content.
 *
 * The `historic-*` kinds read as "past …" rather than as a version number: a row saying
 * "Past password revealed" is the fact that matters, and the version number would be a
 * detail the timeline already shows in context.
 */
const SECRET_KIND_LABELS: Readonly<Record<SecretRef['kind'], string>> = {
  password: 'a password',
  notes: 'a note',
  'security-answer': 'a security answer',
  'custom-value': 'a custom field',
  'historic-password': 'a past password',
  'historic-notes': 'a past note',
  // Never the filename. An attachment's name is often the most descriptive thing about it —
  // "Passport.pdf" — and the activity log is read over a shoulder.
  attachment: 'an attachment',
  'historic-answer': 'a past security answer',
  'historic-custom': 'a past custom field',
};

/**
 * Tone per kind — a hint, never the signal.
 *
 * Only two kinds are not neutral, and both are things a user might genuinely need to notice:
 * a failed unlock, and an export (the one action that produces a copy of the vault with no
 * key on it). Colouring every row would make neither stand out, which is the argument the
 * global guidance makes about decorative colour and the reason the health dashboard owns
 * red and green in this app.
 */
export const KIND_TONES: Readonly<Record<ActivityKind, StatusTone>> = {
  unlock: 'neutral',
  'unlock-failed': 'warning',
  lock: 'neutral',
  reveal: 'neutral',
  copy: 'neutral',
  'clipboard-clear': 'neutral',
  save: 'neutral',
  import: 'neutral',
  export: 'info',
};

/**
 * A glyph for each kind, so a row is distinguishable without colour and without reading the
 * whole sentence. Shapes, not hues — they survive greyscale and the high-contrast theme.
 */
export const KIND_ICONS: Readonly<Record<ActivityKind, IconName>> = {
  unlock: 'unlock',
  'unlock-failed': 'warning',
  lock: 'lock',
  reveal: 'reveal',
  copy: 'clipboard',
  'clipboard-clear': 'close',
  save: 'save',
  import: 'import',
  export: 'export',
};

// ── Naming ───────────────────────────────────────────────────────────────────

export interface EntryNaming {
  /**
   * Whether a row may name the record it is about. **Off by default** — see the header.
   *
   * Forced off by the caller when the vault's audit privacy level is `none`, which is also
   * the level at which entries carry no id to resolve, so this is belt and braces rather
   * than the only guard.
   */
  readonly showRecordNames: boolean;
  /** Resolves a credential id to a title, from the safe projection the renderer already holds. */
  readonly nameFor?: ((credentialId: string) => string | undefined) | undefined;
}

export const NAMING_OFF: EntryNaming = { showRecordNames: false };

/**
 * The record's name, or nothing.
 *
 * Returns nothing — rather than "Unknown record" — when the id cannot be resolved or naming
 * is off, for the same reason `originSummary` returns an empty string when provenance was
 * never captured: a placeholder on every row reads as a fault in the app rather than as the
 * setting its owner chose, and pushes people to switch the setting off to make it go away.
 */
export function subjectName(entry: ActivityEntry, naming: EntryNaming): string | null {
  if (!naming.showRecordNames) return null;
  if (entry.subjectId === undefined || naming.nameFor === undefined) return null;
  const name = naming.nameFor(entry.subjectId)?.trim();
  return name === undefined || name === '' ? null : name;
}

// ── One row ──────────────────────────────────────────────────────────────────

/**
 * The whole sentence for one entry.
 *
 * One function, used by both the visible row and the live-region announcement. Two functions
 * would drift, and the way they would drift is that a screen-reader user would hear
 * something different from what is on screen — which is the specific failure the "text
 * equivalent" rule exists to prevent.
 */
export function describeEntry(entry: ActivityEntry, naming: EntryNaming = NAMING_OFF): string {
  const name = subjectName(entry, naming);
  const forRecord = name === null ? '' : ` for ${name}`;

  switch (entry.kind) {
    case 'unlock':
      return `${KIND_VERBS.unlock}${
        entry.unlockMethod === undefined ? '' : ` ${UNLOCK_METHOD_LABELS[entry.unlockMethod]}`
      }`;

    case 'unlock-failed':
      return `${KIND_VERBS['unlock-failed']} — wrong master password`;

    case 'lock':
      return `${KIND_VERBS.lock}${
        entry.lockReason === undefined ? '' : ` — ${LOCK_REASON_LABELS[entry.lockReason]}`
      }`;

    case 'reveal':
      return `${KIND_VERBS.reveal} ${secretPhrase(entry)}${forRecord}`;

    case 'copy':
      return `${KIND_VERBS.copy} ${secretPhrase(entry)}${forRecord} to the clipboard`;

    case 'clipboard-clear':
      return KIND_VERBS['clipboard-clear'];

    case 'save':
      return entry.count === undefined
        ? KIND_VERBS.save
        : `${KIND_VERBS.save} — ${recordCount(entry.count)}`;

    case 'import':
      return `${recordCount(entry.count ?? 0)} imported`;

    case 'export':
      // Said plainly. An export is the one action that puts the vault somewhere the master
      // password does not protect, and a row that reads like a save would be underselling it.
      return `${recordCount(entry.count ?? 0)} exported out of the vault`;
  }
}

function secretPhrase(entry: ActivityEntry): string {
  return entry.secretKind === undefined ? 'a secret' : SECRET_KIND_LABELS[entry.secretKind];
}

/** "1 record" / "12 records". */
export function recordCount(count: number, noun = 'record'): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// ── Announcements ────────────────────────────────────────────────────────────

/**
 * The kinds a live region announces, when announcements are on.
 *
 * Not every kind. A save fires after every edit and a reveal fires whenever an eye icon is
 * clicked — announcing those means a screen-reader user hears the log narrate every action
 * they just took, immediately after the action's own feedback. That is the fastest way to
 * make a live region something people switch off, and a live region that has been switched
 * off announces nothing at all, including the two things here that matter.
 *
 * What is left is the set a user would want interrupting them: something went wrong, the
 * vault closed, or a copy of the vault left it.
 */
export const ANNOUNCED_KINDS: readonly ActivityKind[] = ['unlock-failed', 'lock', 'export'];

export function shouldAnnounce(entry: ActivityEntry): boolean {
  return ANNOUNCED_KINDS.includes(entry.kind);
}

// ── Statistics copy ──────────────────────────────────────────────────────────

/** "37%" — whole percentages, because a tenth of a percent of a vault is not a fact. */
export function formatShare(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/**
 * The sentence that goes above a distribution too small to draw, or `null` when it is fine.
 *
 * The threshold and the arithmetic in the sentence both come from
 * `MEANINGFUL_DISTRIBUTION_MIN`, so raising it moves the copy rather than making the copy a
 * lie. Saying what one record is worth, in percent, is the honest version of "small sample":
 * it lets the reader judge rather than asking them to take the warning on trust.
 */
export function smallSampleNote(distribution: Distribution): string | null {
  if (distribution.meaningful) return null;
  if (distribution.total === 0) return 'Nothing to summarise yet.';

  const each = Math.round((1 / distribution.total) * 100);
  return `Too few records for a distribution — with ${recordCount(distribution.total)}, each one is ${each}% of the total. The counts below are exact; the shape of them is not a tendency.`;
}

/**
 * The distribution as a sentence, for anything that needs it as text rather than as a table.
 *
 * Every chart in this view has a real table beside it, so this is not the primary
 * alternative — it is the summary that names the shape, which a table does not.
 */
export function describeDistribution(distribution: Distribution, subject: string): string {
  if (distribution.total === 0) return `No ${subject} to summarise.`;

  const parts = distribution.buckets
    .filter((bucket) => bucket.count > 0)
    .map((bucket) => `${bucket.label}: ${bucket.count} (${formatShare(bucket.share)})`);

  if (parts.length === 0) return `No ${subject} to summarise.`;
  return `${subject}, out of ${recordCount(distribution.total)} — ${parts.join('; ')}.`;
}

/** Whether the tag chart needs its "bars do not add up" caveat. Multi-valued, so usually yes. */
export function tagsOverlap(distribution: Distribution): boolean {
  const tagged = distribution.buckets.reduce((total, bucket) => total + bucket.count, 0);
  return tagged > distribution.total;
}

/** Re-exported so a component never restates the threshold. */
export { MEANINGFUL_DISTRIBUTION_MIN };
