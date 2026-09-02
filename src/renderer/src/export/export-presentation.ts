// SPDX-License-Identifier: GPL-3.0-or-later

import type { ExportFormatDescriptor, ExportLoss, ExportLossKind } from '@shared/model/export.js';
import type { ExportPreview, ExportScope } from '@shared/model/export-plan.js';
import type { StatusTone } from '../components/Feedback.js';
// Reused rather than reimplemented. A second pluraliser is a second place for "1 records"
// to appear, and this one is already the app's.
import { countLabel } from '../health/health-presentation.js';

/**
 * Turning an export into sentences a person can act on before they commit to it.
 *
 * Pure, and outside the components for the same reason `health-presentation.ts` is: these
 * strings *are* the feature. The engine's job is to itemise what a format loses; this
 * file's job is to make sure the itemisation is read. A dialog that prints
 * `flattened / custom field type / 12` is a debug view, and a user who exports a CSV, wipes
 * their vault, and only then discovers their security answers are gone was failed here, not
 * in the serialiser.
 *
 * ## Two standing constraints
 *
 * **Nothing here may render a credential value.** It cannot, structurally: an `ExportLoss`
 * carries a kind, a field name, a message and a count, and the engine's own property test
 * asserts that no loss message contains a value. This module never receives a record, a
 * projection or a secret, so there is nothing for it to leak.
 *
 * **No loss kind may render blank.** Every map below is an exhaustive `Record`, so adding a
 * kind to `EXPORT_LOSS_KINDS` is a compile error until it has a label, a meaning, a symbol
 * and a tone — and `export-presentation.test.ts` asserts the ordering array covers the
 * union too, which the type system cannot check for an array.
 */

// ── Loss kinds, in English ───────────────────────────────────────────────────

/** Short enough for a chip, and phrased as the *outcome* rather than the mechanism. */
export const LOSS_KIND_LABELS: Readonly<Record<ExportLossKind, string>> = {
  dropped: 'Not in the file',
  altered: 'Written differently',
  flattened: 'Packed into a cell',
  excluded: 'Left out on purpose',
};

/** The line under the chip. What this kind of loss actually means for the file. */
export const LOSS_KIND_MEANINGS: Readonly<Record<ExportLossKind, string>> = {
  dropped:
    'This is not in the exported file at all. Importing the file somewhere else will not bring it back.',
  altered:
    'The value in the file is not character-for-character the value in your vault, so it may not work if it is pasted straight into a login form.',
  flattened:
    'The data is in the file, but not as its own field — it is packed into a shared cell, so its structure is gone even though its content is not.',
  excluded: 'Left out because you asked for it to be left out. Nothing is wrong.',
};

/**
 * A distinguishable glyph per kind — never colour alone (WCAG 1.4.1).
 *
 * Four different shapes, not four coloured dots: a cross, an inequality, a grid and a
 * slashed circle stay four different things in greyscale and in the high-contrast theme.
 * On the one screen whose job is telling someone what they are about to lose, a signal only
 * a full-colour eye can read would be exactly the wrong economy.
 */
export const LOSS_KIND_SYMBOLS: Readonly<Record<ExportLossKind, string>> = {
  dropped: '✕',
  altered: '≠',
  flattened: '▤',
  excluded: '⊘',
};

export const LOSS_KIND_TONES: Readonly<Record<ExportLossKind, StatusTone>> = {
  dropped: 'danger',
  altered: 'warning',
  flattened: 'info',
  excluded: 'neutral',
};

/**
 * Heaviest first, and `excluded` last because it is the only one the user chose.
 *
 * `dropped` outranks `altered` because data absent from the file cannot be recovered from
 * it, while a neutralised cell still contains the value with a prefix on it. `excluded`
 * sits at the bottom rather than being hidden: a trashed-record exclusion is information,
 * not a defect, and burying it would undo the reason the engine reports it at all.
 */
export const LOSS_KIND_ORDER: readonly ExportLossKind[] = [
  'dropped',
  'altered',
  'flattened',
  'excluded',
];

// ── Grouping ─────────────────────────────────────────────────────────────────

export interface LossGroup {
  readonly kind: ExportLossKind;
  readonly label: string;
  readonly meaning: string;
  readonly symbol: string;
  readonly tone: StatusTone;
  readonly losses: readonly ExportLoss[];
  /** Records affected across this group. `0` when every loss in it is vault-level. */
  readonly records: number;
}

/**
 * The engine's flat loss list, grouped by kind and ordered by weight.
 *
 * Grouped rather than listed flat because the flat list mixes "your history is gone" with
 * "you chose not to export the Trash", and a reader who has to sort those apart themselves
 * will sort neither. Only kinds that actually occurred appear — a permanent
 * "Not in the file: none" heading is noise that trains people to skim the headings that
 * are not empty.
 *
 * Order within a group is the engine's own, which is document order. Sorting it here would
 * replace a deterministic order with an arbitrary one.
 */
export function groupLossesByKind(losses: readonly ExportLoss[]): readonly LossGroup[] {
  const groups: LossGroup[] = [];

  for (const kind of LOSS_KIND_ORDER) {
    const matching = losses.filter((loss) => loss.kind === kind);
    if (matching.length === 0) continue;

    groups.push({
      kind,
      label: LOSS_KIND_LABELS[kind],
      meaning: LOSS_KIND_MEANINGS[kind],
      symbol: LOSS_KIND_SYMBOLS[kind],
      tone: LOSS_KIND_TONES[kind],
      losses: matching,
      records: matching.reduce((total, loss) => total + loss.records, 0),
    });
  }

  return groups;
}

/** How many distinct fields a format fails to carry intact. Drives the "n things" counts. */
export function affectedFields(losses: readonly ExportLoss[]): readonly string[] {
  const seen: string[] = [];
  for (const kind of LOSS_KIND_ORDER) {
    for (const loss of losses) {
      if (loss.kind === kind && !seen.includes(loss.field)) seen.push(loss.field);
    }
  }
  return seen;
}

/** "a, b and c". Extracted because the index arithmetic is where the off-by-one lives. */
function joinWithAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  const last = items[items.length - 1] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${last}`;
}

/**
 * One line naming what this format costs, for the format list and the confirm step.
 *
 * Names up to three fields and then counts the rest, because a sentence listing nine things
 * is read as a paragraph and skipped. The three it names are the three that matter most,
 * since `affectedFields` walks the kinds in weight order — so "history" beats "trashed
 * records" for the limited space, every time.
 */
export function summariseLosses(losses: readonly ExportLoss[]): string {
  const fields = affectedFields(losses);
  if (fields.length === 0) return 'Nothing is left out. This format carries everything.';

  const named = fields.slice(0, 3);
  const remaining = fields.length - named.length;
  const list = joinWithAnd(named);

  return remaining === 0
    ? `Does not carry ${list} intact.`
    : `Does not carry ${list}, and ${remaining} other thing${remaining === 1 ? '' : 's'}, intact.`;
}

// ── Formats ──────────────────────────────────────────────────────────────────

export interface SafetyBadge {
  readonly label: string;
  readonly symbol: string;
  readonly tone: StatusTone;
  /** The sentence under the badge. Says what the file *is*, not how careful to be. */
  readonly meaning: string;
}

/**
 * How dangerous the resulting file is, as a badge with a word and a shape in it.
 *
 * The single most important thing on the format step, and the reason the format list is not
 * just names and descriptions. "Encrypted parcel" and "Keyhold JSON" read as two equally
 * ordinary technical choices unless something on the row says that one of them produces a
 * file anybody can open.
 */
export function safetyBadge(descriptor: ExportFormatDescriptor): SafetyBadge {
  return descriptor.encrypted
    ? {
        label: 'Encrypted',
        symbol: '🔒',
        tone: 'success',
        meaning:
          'The file is sealed under a passphrase you choose. Whoever receives it needs that passphrase to open it.',
      }
    : {
        label: 'Readable by anyone',
        symbol: '⚠',
        tone: 'danger',
        meaning:
          'The file is plain text. Anyone who opens it can read every password in it, and so can anything it passes through.',
      };
}

/** "Lossless" is a claim worth stating positively when it is true, and not implying when not. */
export function fidelityLabel(descriptor: ExportFormatDescriptor): string {
  return descriptor.lossless
    ? 'Carries every field, every version and every origin.'
    : 'Some of what is in your vault cannot be written in this format.';
}

// ── Scope ────────────────────────────────────────────────────────────────────

/** "412 records will be written to this file." Plain, and always a real number. */
export function recordSentence(preview: ExportPreview): string {
  return preview.recordCount === 0
    ? 'No records match what you have chosen, so this file would be empty.'
    : `${countLabel(preview.recordCount)} will be written to this file.`;
}

/**
 * The trash sentence, which appears **whichever way the checkbox is set**.
 *
 * The requirement is not "warn when trashed records are included" — it is that the count is
 * visible either way. Someone exporting a vault to hand to a colleague needs to know that
 * twelve deleted records are in the file; someone archiving their own vault needs to know
 * that twelve are missing from it. Both are surprises, and only one of them is usually
 * warned about.
 *
 * The empty case says so explicitly rather than rendering nothing, because a checkbox with
 * no number beside it invites the reader to guess at one.
 */
export function trashSentence(scope: ExportScope, preview: ExportPreview): string {
  if (preview.trashedInScope === 0) return 'Nothing you have chosen is in the Trash.';
  return scope.includeTrashed
    ? `${countLabel(preview.trashedInScope)} in the Trash will be included in this file.`
    : `${countLabel(preview.trashedInScope)} in the Trash will be left out.`;
}

/**
 * A file size a person can sanity-check, in decimal units.
 *
 * Decimal (kB = 1000) rather than binary, because the number is going to be compared
 * against what the operating system's file browser shows beside the same file, and both
 * Windows Explorer and macOS Finder report the size of an export this way. Being
 * technically righter than the thing the user is comparing against is being wrong.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
}

/** Stale ids in a saved selection. Reported, because silently exporting fewer records is not ok. */
export function unknownSentence(preview: ExportPreview): string | null {
  if (preview.unknownIds === 0) return null;
  return `${countLabel(preview.unknownIds)} you selected are no longer in this vault and cannot be exported.`;
}
