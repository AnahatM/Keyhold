// SPDX-License-Identifier: GPL-3.0-or-later
import type { Credential, CustomField } from '@shared/model/credential.js';
import {
  type ImportMergeEffect,
  type ImportMergeField,
  type ImportMergeableField,
} from '@shared/model/import-plan.js';
import { importFolderPath } from '@shared/model/import.js';
import {
  normaliseTags,
  type CredentialPatch,
  type NewCredentialInput,
} from '../vault/credential-ops.js';

/**
 * What "merge" means, stated once.
 *
 * The wizard offers three answers to a duplicate and this file owns the dangerous one. It is
 * written as **a single function that returns both the patch and the description of the
 * patch**, because those two must not be able to disagree: the review screen's "this would
 * replace the password" and the write that then replaces the password are the same
 * computation, run twice, with the second run's result actually applied. A separate
 * "describe what a merge would do" routine is exactly the thing that drifts, and the field
 * it drifts on first is the password.
 *
 * ## The policy, and why it is asymmetric
 *
 * - **Single-valued text — password, username, email, notes.** Empty in the vault and
 *   present in the file: `fills-empty`. Present in both and different: `replaces`. Anything
 *   else: unchanged. `replaces` is the one genuinely destructive effect this whole screen
 *   can produce, which is why `ImportMergeEffect` names it separately and why the wizard
 *   warns specifically when the field is `password`.
 *
 * - **Set-valued — urls, tags, custom fields.** Additive only, never subtractive: `adds`.
 *   A merge that removed a URL the user had would be deleting data on the strength of an
 *   export's omission, and an export omits things for reasons that have nothing to do with
 *   the user's intent.
 *
 * - **Folder.** `fills-empty` when the record is filed nowhere, and *never* `replaces`.
 *   Filing is a decision the user made in this vault; an import from a different product's
 *   tree has no standing to overrule it, and unlike a password the previous location is not
 *   recoverable from the record itself. So a merge can put a loose record into a folder and
 *   cannot move one out of the folder its owner chose.
 *
 * Effects that come out `unchanged` are **not emitted**. `ImportDuplicateGroup.mergeableFields`
 * is documented as empty when nothing would change, and the wizard reads `length === 0` as
 * exactly that; a list of eight rows saying "nothing" would bury the one row that matters.
 *
 * `extraTags` from the commit request deliberately do **not** reach here. They are documented
 * as applying to every *imported* record, and a merged record is a record the user already
 * had — stamping it with an `imported-2026-09` tag is an edit they did not ask for. Keeping
 * them out also keeps the preview's merge description honest, since the preview runs before
 * the user has chosen any extra tags.
 */

export interface MergeContext {
  /** For the ids of custom fields a merge adds. Vault-unique, so `OpsContext.newId`. */
  readonly newId: () => string;
  /** Resolves an `import-folder:` path to a real folder id, or `null` when it has none yet. */
  readonly folderIdFor: (path: string) => string | null;
}

/**
 * The context the *preview* passes.
 *
 * Neither member can affect {@link PlannedMerge.fields} — a custom field's effect is decided
 * by its label and a folder's by whether the record has one, not by the ids either would be
 * given — so the preview calls the identical function and reads only the half that is
 * meaningful to it. The patch it gets back is inert and is discarded.
 */
export const PREVIEW_MERGE_CONTEXT: MergeContext = {
  newId: () => '',
  folderIdFor: () => null,
};

export interface PlannedMerge {
  /** Only the fields that would actually change, in `IMPORT_MERGEABLE_FIELDS` order. */
  readonly fields: readonly ImportMergeField[];
  /** The patch that produces exactly those changes. Empty when `fields` is empty. */
  readonly patch: CredentialPatch;
}

/**
 * Folds one or more incoming records into an existing one.
 *
 * More than one because a duplicate group can hold several rows of the same export. They are
 * applied **in file order**, so a later row's value wins where both have one — the same rule
 * a user would apply reading the file top to bottom.
 */
export function planMerge(
  existing: Credential,
  incoming: readonly NewCredentialInput[],
  context: MergeContext
): PlannedMerge {
  const fields: ImportMergeField[] = [];
  const record = (field: ImportMergeableField, effect: ImportMergeEffect): void => {
    if (effect !== 'unchanged') fields.push({ field, effect });
  };

  const password = textMerge(existing.fields.password, incoming, (item) => item.password);
  const username = textMerge(existing.fields.username, incoming, (item) => item.username);
  const email = textMerge(existing.fields.email, incoming, (item) => item.email);
  const notes = textMerge(existing.fields.notes, incoming, (item) => item.notes);
  const urls = urlMerge(existing, incoming);
  const tags = tagMerge(existing, incoming);
  const folder = folderMerge(existing, incoming, context);
  const custom = customMerge(existing, incoming, context);

  record('password', password.effect);
  record('username', username.effect);
  record('email', email.effect);
  record('urls', urls.effect);
  record('notes', notes.effect);
  record('tags', tags.effect);
  record('folder', folder.effect);
  record('custom', custom.effect);

  const patch: CredentialPatch = {
    ...(tags.effect === 'unchanged' ? {} : { tags: tags.value }),
    ...(folder.effect === 'unchanged' ? {} : { folderId: folder.value }),
    fields: {
      ...(password.effect === 'unchanged' ? {} : { password: password.value }),
      ...(username.effect === 'unchanged' ? {} : { username: username.value }),
      ...(email.effect === 'unchanged' ? {} : { email: email.value }),
      ...(notes.effect === 'unchanged' ? {} : { notes: notes.value }),
      ...(urls.effect === 'unchanged' ? {} : { urls: urls.value }),
      ...(custom.effect === 'unchanged' ? {} : { custom: custom.value }),
    },
  };

  return { fields, patch };
}

interface MergedValue<T> {
  readonly effect: ImportMergeEffect;
  readonly value: T;
}

/**
 * A single-valued text field.
 *
 * The *last* non-empty incoming value wins, not the first: within one group the rows are in
 * file order, and a later row is the more recent statement of the same account.
 */
function textMerge(
  current: string,
  incoming: readonly NewCredentialInput[],
  read: (record: NewCredentialInput) => string | undefined
): MergedValue<string> {
  let value = '';
  for (const record of incoming) {
    const candidate = read(record) ?? '';
    if (candidate !== '') value = candidate;
  }

  if (value === '' || value === current) return { effect: 'unchanged', value: current };
  return { effect: current === '' ? 'fills-empty' : 'replaces', value };
}

/** URLs the vault does not already have, appended in file order. Never removes one. */
function urlMerge(
  existing: Credential,
  incoming: readonly NewCredentialInput[]
): MergedValue<readonly string[]> {
  const seen = new Set(existing.fields.urls.map((url) => url.trim().toLowerCase()));
  const added: string[] = [];

  for (const record of incoming) {
    for (const raw of record.urls ?? []) {
      const url = raw.trim();
      const key = url.toLowerCase();
      if (url === '' || seen.has(key)) continue;
      seen.add(key);
      added.push(url);
    }
  }

  if (added.length === 0) return { effect: 'unchanged', value: existing.fields.urls };
  return { effect: 'adds', value: [...existing.fields.urls, ...added] };
}

/** Tags are unioned through `normaliseTags`, which is the codebase's one tag-uniqueness rule. */
function tagMerge(
  existing: Credential,
  incoming: readonly NewCredentialInput[]
): MergedValue<readonly string[]> {
  const merged = normaliseTags([
    ...existing.tags,
    ...incoming.flatMap((item) => [...(item.tags ?? [])]),
  ]);
  if (merged.length === existing.tags.length) return { effect: 'unchanged', value: existing.tags };
  return { effect: 'adds', value: merged };
}

/** Fills a record that is filed nowhere. Never moves one that is filed somewhere. */
function folderMerge(
  existing: Credential,
  incoming: readonly NewCredentialInput[],
  context: MergeContext
): MergedValue<string | null> {
  if (existing.folderId !== null) return { effect: 'unchanged', value: existing.folderId };

  let path: string | null = null;
  for (const record of incoming) {
    const placeholder = record.folderId ?? null;
    if (placeholder === null) continue;
    path = importFolderPath(placeholder) ?? path;
  }
  if (path === null) return { effect: 'unchanged', value: null };

  return { effect: 'fills-empty', value: context.folderIdFor(path) };
}

/**
 * Custom fields the record does not already have a label for.
 *
 * Matched on the label, case-insensitively, because that is what a person means by "it
 * already has an account number". Matching on the value instead would add a second
 * `Account number` row every time the export's copy was stale, which is precisely the case
 * merge exists to handle.
 */
function customMerge(
  existing: Credential,
  incoming: readonly NewCredentialInput[],
  context: MergeContext
): MergedValue<readonly CustomField[]> {
  const seen = new Set(existing.fields.custom.map((field) => field.label.trim().toLowerCase()));
  const added: CustomField[] = [];

  for (const record of incoming) {
    for (const field of record.custom ?? []) {
      const key = field.label.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      added.push({
        ...field,
        // A fresh id, not the parser's record-scoped `imported-field-N`: the reveal path
        // addresses a value by (credential id, field id), so a collision with a field the
        // record already had would hand back the wrong secret.
        id: context.newId(),
        order: existing.fields.custom.length + added.length,
      });
    }
  }

  if (added.length === 0) return { effect: 'unchanged', value: existing.fields.custom };
  return { effect: 'adds', value: [...existing.fields.custom, ...added] };
}
