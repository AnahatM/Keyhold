// SPDX-License-Identifier: GPL-3.0-or-later
import {
  IMPORT_WARNING_KINDS,
  type ImportWarning,
  type ImportWarningKind,
} from '@shared/model/import.js';

/**
 * Warnings, grouped by kind and never hidden.
 *
 * The engine already collapses per-column repeats — a 3,000-row export with one unmapped
 * column produces one warning, not three thousand (`WarningLog.flushColumns`). What is left
 * for this layer is presentation: a flat list of nineteen mixed warnings is read as noise and
 * dismissed, while "3 columns had no Keyhold field" with the three named under it is read.
 *
 * **Nothing is truncated and nothing is filtered.** Every warning the engine produced appears
 * in exactly one group, and `totalWarnings` is asserted against the input length by the test
 * beside this file. An importer that quietly drops the tail of its own warning list is worse
 * than one that has no warnings at all, because the user has been told there is nothing more
 * to see.
 */

export interface ImportWarningGroup {
  readonly kind: ImportWarningKind;
  readonly label: string;
  /** One sentence on what this kind of warning means for the user's data. */
  readonly description: string;
  /** Whether this kind means data did not survive, or merely that something was inferred. */
  readonly severity: ImportWarningSeverity;
  readonly count: number;
  readonly warnings: readonly ImportWarning[];
}

/**
 * Two levels, not three.
 *
 * `loss` means something in the file is not in the vault. `notice` means Keyhold made a
 * decision the user might disagree with, but nothing was lost. Anything finer would be a
 * distinction the user has to learn before they can read the list.
 */
export type ImportWarningSeverity = 'loss' | 'notice';

interface WarningKindCopy {
  readonly label: string;
  readonly description: string;
  readonly severity: ImportWarningSeverity;
}

/**
 * The words for each kind, keyed by the closed set in `@shared/model/import.ts`.
 *
 * A `Record` over the union rather than a lookup with a fallback: adding a warning kind to
 * the engine and forgetting the copy here is then a **type error**, instead of a warning that
 * renders as its own raw identifier in front of a user.
 */
const WARNING_COPY: Readonly<Record<ImportWarningKind, WarningKindCopy>> = {
  'dropped-value': {
    label: 'Values that could not be carried',
    description: 'These are in your file but will not be in your vault. Named by column.',
    severity: 'loss',
  },
  'skipped-row': {
    label: 'Rows that became nothing',
    description: 'A row with no title, no login and no password cannot become a record.',
    severity: 'loss',
  },
  'unsupported-item': {
    label: 'Items of a kind Keyhold does not import',
    description: 'Cards, identities and SSH keys are not logins, so they are left behind.',
    severity: 'loss',
  },
  'ragged-row': {
    label: 'Rows that did not match the header',
    description: 'More or fewer cells than the header declared. Extra cells are not guessed at.',
    severity: 'loss',
  },
  'unmapped-column': {
    label: 'Columns kept as custom fields',
    description: 'No Keyhold field matched, so the column is carried as a custom field instead.',
    severity: 'notice',
  },
  'derived-value': {
    label: 'Values Keyhold filled in',
    description: 'Your file had none, so one was worked out — a title from a web address, mostly.',
    severity: 'notice',
  },
  format: {
    label: 'Notes about the file itself',
    description: 'A header quirk, a truncated quote, or an export from an older version.',
    severity: 'notice',
  },
};

/**
 * Display order: everything that lost data, then everything that did not.
 *
 * Derived from `IMPORT_WARNING_KINDS` filtered by severity rather than written out again, so
 * a new kind cannot be added to the engine and silently fail to appear here (rule 8).
 */
const KIND_ORDER: readonly ImportWarningKind[] = [
  ...IMPORT_WARNING_KINDS.filter((kind) => WARNING_COPY[kind].severity === 'loss'),
  ...IMPORT_WARNING_KINDS.filter((kind) => WARNING_COPY[kind].severity === 'notice'),
];

/** Groups in display order, omitting kinds with nothing in them. */
export function groupWarnings(warnings: readonly ImportWarning[]): readonly ImportWarningGroup[] {
  const byKind = new Map<ImportWarningKind, ImportWarning[]>();
  for (const warning of warnings) {
    const existing = byKind.get(warning.kind);
    if (existing === undefined) byKind.set(warning.kind, [warning]);
    else existing.push(warning);
  }

  const groups: ImportWarningGroup[] = [];
  for (const kind of KIND_ORDER) {
    const kindWarnings = byKind.get(kind);
    if (kindWarnings === undefined || kindWarnings.length === 0) continue;
    const copy = WARNING_COPY[kind];
    groups.push({
      kind,
      label: copy.label,
      description: copy.description,
      severity: copy.severity,
      count: kindWarnings.length,
      warnings: kindWarnings,
    });
  }
  return groups;
}

/** Warnings across every group. Must equal the input length — nothing is dropped. */
export function totalWarnings(groups: readonly ImportWarningGroup[]): number {
  return groups.reduce((total, group) => total + group.count, 0);
}

/** Warnings that mean data in the file will not be in the vault. */
export function lossWarnings(groups: readonly ImportWarningGroup[]): number {
  return groups
    .filter((group) => group.severity === 'loss')
    .reduce((total, group) => total + group.count, 0);
}

/**
 * The line at the top of the warnings panel.
 *
 * Says the loss count out loud when there is one. "12 notes" and "12 things you are about to
 * lose" are the same number and completely different sentences, and the user is entitled to
 * the second one.
 */
export function warningHeadline(groups: readonly ImportWarningGroup[]): string {
  const total = totalWarnings(groups);
  if (total === 0) return 'Nothing was lost — every field in the file has somewhere to go.';
  const losses = lossWarnings(groups);
  const notes = total - losses;
  if (losses === 0) return `${plural(notes, 'note')} about how this file was read.`;
  if (notes === 0) return `${plural(losses, 'thing')} in this file will not reach your vault.`;
  return `${plural(losses, 'thing')} will not reach your vault, and ${plural(notes, 'note')} besides.`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
