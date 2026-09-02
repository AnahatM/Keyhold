// SPDX-License-Identifier: GPL-3.0-or-later
import type { CustomFieldType } from '@shared/model/credential.js';
import {
  IMPORT_FIELD_TARGETS,
  normaliseColumnKey,
  type ColumnMapping,
  type ImportFieldTarget,
} from '@shared/model/import.js';

/**
 * The words for each column target, and the pure edits the mapping table performs.
 *
 * The vocabulary is `IMPORT_FIELD_TARGETS` from `@shared/model/import.ts` — this file adds
 * only what a human needs to choose between them, keyed as a `Record` over the union so a
 * new target is a type error here rather than a blank option in a dropdown.
 *
 * The edits are pure functions over `ColumnMapping` rather than mutations, because the same
 * mapping object is what the preview request carries: an in-place edit would change the
 * mapping a pending preview was issued for, and the answer that came back would describe
 * something the user had already moved on from.
 */

export interface FieldTargetCopy {
  readonly label: string;
  /** Shown under the dropdown for the selected option. Says what happens to the column. */
  readonly help: string;
}

export const FIELD_TARGET_COPY: Readonly<Record<ImportFieldTarget, FieldTargetCopy>> = {
  title: { label: 'Title', help: 'The name of the record, as it appears in your list.' },
  username: { label: 'Username', help: 'The login name, kept exactly as the file has it.' },
  email: { label: 'Email', help: 'The email address on the account.' },
  password: { label: 'Password', help: 'Stored encrypted. Never shown on this screen.' },
  url: { label: 'Web address', help: 'One or more addresses. Several columns can feed this.' },
  notes: { label: 'Notes', help: 'Free text. Treated as secret, so it is not previewed here.' },
  folder: { label: 'Folder', help: 'A folder path. Folders that do not exist are created.' },
  tags: { label: 'Tags', help: 'Split on commas, semicolons and new lines.' },
  favorite: { label: 'Favourite', help: 'A yes/no column. 1, true, yes, y and x all mean yes.' },
  totp: { label: 'Authenticator secret', help: 'A TOTP seed. Stored as a secret custom field.' },
  custom: { label: 'Custom field', help: 'Kept under its own label, with a type you choose.' },
  drop: { label: "Don't import", help: 'This column will not be in your vault. You will be told.' },
  ignore: {
    label: 'Handled by the format',
    help: 'The parser uses this column itself. Nothing is lost.',
  },
};

/**
 * The options offered in the mapping dropdown.
 *
 * `ignore` is excluded: it means "the parser consumes this column internally", which is a
 * statement about a built-in format, not a choice a user can meaningfully make about a
 * generic CSV. Offering it would present "nothing is lost" and "this is discarded" as two
 * interchangeable options, which is exactly the confusion `import.ts` warns against.
 */
export const SELECTABLE_FIELD_TARGETS: readonly ImportFieldTarget[] = IMPORT_FIELD_TARGETS.filter(
  (target) => target !== 'ignore'
);

/**
 * Targets that can put something in a record.
 *
 * A mapping made entirely of `tags`, `folder`, `favorite` and `drop` produces no records at
 * all — `finishDraft` returns `null` for a draft with no title, login, password, url, note or
 * custom field. Stated here so the mapping step can say so *before* the dry run rather than
 * reporting zero records afterwards.
 */
export const CONTENT_FIELD_TARGETS: readonly ImportFieldTarget[] = [
  'title',
  'username',
  'email',
  'password',
  'url',
  'notes',
  'totp',
  'custom',
];

// ── Reading a mapping ────────────────────────────────────────────────────────

/** The target for a column as written in the header. `custom` when the mapping has no entry. */
export function targetFor(mapping: ColumnMapping, column: string): ImportFieldTarget {
  return mapping.columns[normaliseColumnKey(column)] ?? 'custom';
}

export function customTypeFor(mapping: ColumnMapping, column: string): CustomFieldType | null {
  return mapping.customTypes?.[normaliseColumnKey(column)] ?? null;
}

export function customLabelFor(mapping: ColumnMapping, column: string): string | null {
  return mapping.customLabels?.[normaliseColumnKey(column)] ?? null;
}

/** Every column key pointed at a given target. Keys, not headers — the mapping's own form. */
export function columnsWithTarget(
  mapping: ColumnMapping,
  target: ImportFieldTarget
): readonly string[] {
  return Object.entries(mapping.columns)
    .filter(([, value]) => value === target)
    .map(([key]) => key);
}

// ── Editing a mapping ────────────────────────────────────────────────────────

export function withTarget(
  mapping: ColumnMapping,
  column: string,
  target: ImportFieldTarget
): ColumnMapping {
  const key = normaliseColumnKey(column);
  const next: ColumnMapping = {
    ...mapping,
    columns: { ...mapping.columns, [key]: target },
  };
  // Moving a column off `custom` leaves its label and type override behind as dead entries
  // that would silently reappear if the user moved it back — and, worse, would be sent in
  // the preview request for a column that is no longer custom.
  return target === 'custom' ? next : withoutCustomOverrides(next, key);
}

/**
 * Sets an explicit custom-field type, or clears the override with `null`.
 *
 * Clearing is a real choice, not an absence: with no override the engine guesses from the
 * label *and* the value, which is more information than the user has from a dropdown before
 * they have seen the data. So "work it out" has to be reachable again after picking wrongly.
 */
export function withCustomType(
  mapping: ColumnMapping,
  column: string,
  type: CustomFieldType | null
): ColumnMapping {
  const key = normaliseColumnKey(column);
  if (type === null) {
    const { [key]: _removed, ...rest } = mapping.customTypes ?? {};
    return { ...mapping, customTypes: rest };
  }
  return { ...mapping, customTypes: { ...mapping.customTypes, [key]: type } };
}

/**
 * Sets a custom label, or clears it when the text is blank.
 *
 * Clearing rather than storing `''` because the parser's documented default is "the header
 * text", and an empty override would produce a field labelled `Field` instead — a silent
 * downgrade from emptying a box the user only meant to retype.
 */
export function withCustomLabel(
  mapping: ColumnMapping,
  column: string,
  label: string
): ColumnMapping {
  const key = normaliseColumnKey(column);
  if (label.trim() === '') {
    const { [key]: _removed, ...rest } = mapping.customLabels ?? {};
    return { ...mapping, customLabels: rest };
  }
  return { ...mapping, customLabels: { ...mapping.customLabels, [key]: label } };
}

function withoutCustomOverrides(mapping: ColumnMapping, key: string): ColumnMapping {
  const { [key]: _type, ...customTypes } = mapping.customTypes ?? {};
  const { [key]: _label, ...customLabels } = mapping.customLabels ?? {};
  return { ...mapping, customTypes, customLabels };
}
