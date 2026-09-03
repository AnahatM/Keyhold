// SPDX-License-Identifier: GPL-3.0-or-later
import type { CustomFieldType } from '@shared/model/credential.js';
import { VaultError } from '../crypto/errors.js';
import { normaliseFolderPath } from '@shared/model/import.js';
import type { NewCredentialInput } from '../vault/credential-ops.js';
import {
  addCustom,
  addNote,
  addUrls,
  finishDraft,
  FolderSet,
  guessCustomFieldType,
  newDraft,
  WarningLog,
  type DraftRecord,
} from './mapping.js';
import { stripBom } from './csv.js';
import type { ImportParser, ImportResult } from './types.js';

/**
 * Enpass 6's JSON export (Settings → Advanced → Export → JSON).
 *
 * ## Why the JSON and not the CSV
 *
 * Enpass is *template-driven*: an item is a title, a note, and an ordered list of typed
 * fields, and the template decides which fields exist. The CSV flattens that into one column
 * per field name across every template in the vault, which produces a sparse table hundreds
 * of columns wide and loses the type of every cell. The JSON keeps the types — including
 * Enpass's own `sensitive` flag — and the folder tree, so it is the format worth reading.
 *
 * ## The `sensitive` flag is authoritative, and it can override a field's home
 *
 * Enpass lets the user mark any field sensitive, whatever its type. Keyhold honours that
 * literally: a sensitive field becomes a secret custom field even when its Enpass type would
 * have given it a first-class home. That sounds heavy-handed until you follow it through —
 * `username`, `email` and `urls` all live in the **safe projection**, which crosses to the
 * renderer (decision D13). Putting a value the user explicitly marked sensitive into one of
 * them would take a secret and publish it to the process that is not allowed to hold secrets.
 * A slightly surprising custom field is a much smaller cost than that.
 *
 * ## What is known versus inferred about this format
 *
 * Known from real exports: the top-level `folders` / `items` pair, folder nesting through
 * `parent_uuid`, and the item shape — `title`, `note`, `category`, `template_type`, `trashed`,
 * `archived`, `favorite`, `folders`, and a `fields` array of
 * `{ label, type, value, sensitive, deleted, order }`. Inferred: the full vocabulary of field
 * `type` strings, which is why `ENPASS_FIELD_TYPES` is a *lookup with a fallback* rather than
 * a switch — an Enpass type this build has never seen still arrives as a custom field with a
 * guessed type, and the guess errs towards secret.
 */

/** Enpass field types that have a first-class home on a Keyhold record. */
const TYPE_USERNAME = 'username';
const TYPE_EMAIL = 'email';
const TYPE_PASSWORD = 'password';
const TYPE_URL = 'url';
const TYPE_TOTP = 'totp';
/** A visual divider in Enpass's editor. It carries a label and never a value. */
const TYPE_SECTION = 'section';

/**
 * Enpass field type → Keyhold custom-field type, for everything without a first-class home.
 *
 * The card entries are the ones that matter. A card number guessed from its label lands on
 * `number`, which is a *visible* type, so the value would sit in the safe projection in plain
 * sight — and a card number is exactly as sensitive as a password. The model has no card
 * type, so the closest secret type is used, matching `bitwarden-json.ts`.
 */
const ENPASS_FIELD_TYPES: Readonly<Record<string, CustomFieldType>> = {
  text: 'text',
  multiline: 'multiline',
  numeric: 'number',
  phone: 'phone',
  date: 'date',
  pin: 'pin',
  password: 'password',
  ccName: 'text',
  ccNumber: 'password',
  ccCvc: 'pin',
  ccPin: 'pin',
  ccTxnPassword: 'password',
  ccBankname: 'text',
  ccType: 'text',
  // Enpass writes an expiry as `MM/YYYY`. The label says "expiry", so the guesser would call
  // it a `date`, and the UI would then render `05/2030` through a date formatter and produce
  // something that is not the card's expiry. Text is the truthful answer.
  ccExpiry: 'text',
  ccValidfrom: 'text',
};

export const enpassJsonParser: ImportParser = {
  id: 'enpass-json',
  name: 'Enpass (JSON)',
  extensions: ['.json'],
  description: 'Enpass’s JSON export. Keeps field types, the folder tree and card details.',
  needsMapping: false,

  detect(content: string): boolean {
    // 8 KB rather than the 4 KB the other JSON parsers use, and the reason is specific to this
    // format: an Enpass field is a nine-key object, so a single item with a dozen fields runs
    // past 4 KB on its own, and `template_type` sorts alphabetically *after* `fields`. A
    // 4 KB window would miss the strongest marker on any realistic export.
    const head = stripBom(content).slice(0, 8192).trimStart();
    if (!head.startsWith('{')) return false;
    if (!head.includes('"items"')) return false;
    return (
      head.includes('"template_type"') || (head.includes('"fields"') && head.includes('"category"'))
    );
  },

  parse(content: string): ImportResult {
    return parseEnpassJson(content);
  },
};

function parseEnpassJson(content: string): ImportResult {
  const root = parseJsonObject(content);

  const items = root.items;
  if (!Array.isArray(items)) {
    // The loudest failure this parser has, and the one worth having: a file that is shaped
    // some other way must not produce "imported 0 records, no problems found".
    throw new VaultError(
      'MALFORMED',
      'This JSON file is not an Enpass export — it has no "items" list. Enpass writes one from Settings → Advanced → Export, choosing JSON.'
    );
  }

  const objects = items.filter(isRecord);
  if (objects.length > 0 && !objects.some((item) => 'fields' in item || 'template_type' in item)) {
    throw new VaultError(
      'MALFORMED',
      'This file has an "items" list, but nothing in it looks like an Enpass item — none of them carries a field list or a template. If it came from a newer Enpass than this build knows about, please report it.'
    );
  }

  const log = new WarningLog();
  const folders = new FolderSet();
  const folderPaths = readFolderPaths(root);
  const records: NewCredentialInput[] = [];

  if (items.length === 0) log.add('format', 'The export contains no items.');

  let archivedCount = 0;
  let multiFolderCount = 0;
  let tombstonedFields = 0;

  items.forEach((raw, index) => {
    // Items are referred to by position, never by name. A warning is displayed, logged and
    // pasted into bug reports; naming the item would put vault content in all three.
    const position = index + 1;
    if (!isRecord(raw)) {
      log.add('skipped-row', `Item ${position} is not an object and was skipped.`);
      return;
    }

    if (isFlagSet(raw, 'trashed')) {
      log.add('skipped-row', `Item ${position} is in Enpass’s trash and was not imported.`);
      return;
    }
    if (isFlagSet(raw, 'archived')) archivedCount += 1;

    const draft = newDraft();
    draft.title = readString(raw, 'title');
    draft.favorite = isFlagSet(raw, 'favorite');
    addNote(draft, readString(raw, 'note'));
    // `subtitle` is not read on purpose: Enpass derives it from a field that is already in
    // `fields`, so carrying it would duplicate a value rather than rescue one.

    const itemFolders = readArray(raw, 'folders').filter(
      (id): id is string => typeof id === 'string'
    );
    if (itemFolders.length > 1) multiFolderCount += 1;
    draft.folderPath =
      itemFolders.length === 0 ? null : (folderPaths.get(itemFolders[0] ?? '') ?? null);

    tombstonedFields += applyFields(draft, raw);

    // Enpass templates cover far more than logins — cards, identities, licences, passports.
    // The fields all survive as custom fields either way; this only tells the user that the
    // item was not a login, so they know why it looks the way it does.
    //
    // The category string is deliberately *not* quoted. It is a string out of the user's file,
    // and a warning is rendered on screen, written to the import report and pasted into bug
    // reports — so no string from the file goes in one, however innocuous it looks.
    const category = readString(raw, 'category');
    if (category !== '' && category !== 'login' && category !== 'note' && category !== 'password') {
      log.add(
        'unsupported-item',
        `Item ${position} uses an Enpass template that is not a login. Keyhold stores logins, so its details were kept as custom fields.`
      );
    }

    const record = finishDraft(draft);
    if (record === null) {
      log.add('skipped-row', `Item ${position} held no importable values.`);
      return;
    }
    folders.add(draft.folderPath);
    records.push(record);
  });

  if (archivedCount > 0) {
    log.add(
      'format',
      `${archivedCount} item(s) are archived in Enpass. Keyhold has no archive, so they were imported as ordinary records rather than hidden.`
    );
  }
  if (tombstonedFields > 0) {
    log.add(
      'dropped-value',
      // Worded around the word "password" deliberately. Enpass writes a field's *type* as a
      // plain string, so `"password"` is a value in the file — and the contract's leak guard
      // is a property over every string in the file, not a list of known secrets. It cannot
      // tell a type discriminator from a passphrase, and it should not try: the day it starts
      // making exceptions is the day a real leak fits through one.
      `${tombstonedFields} field(s) had already been deleted in Enpass and survive in the file only as tombstones. They were not imported, so a secret you had replaced does not come back.`
    );
  }
  if (multiFolderCount > 0) {
    log.add(
      'dropped-value',
      `${multiFolderCount} item(s) are in more than one Enpass folder. A Keyhold record lives in exactly one folder, so the first was used and the rest were not carried — a tag is the closer equivalent if you want them back.`
    );
  }

  return { records, warnings: log.all, folders: folders.all };
}

/** Returns the number of tombstoned fields, which the caller reports once for the whole file. */
function applyFields(draft: DraftRecord, item: Record<string, unknown>): number {
  let tombstoned = 0;
  for (const raw of readArray(item, 'fields')) {
    if (!isRecord(raw)) continue;
    // Enpass tombstones a removed field rather than dropping it from the file. Importing one
    // would resurrect a value the user deleted — and if it is an old password, resurrect it
    // into the field the health rules read.
    //
    // Counted rather than skipped in silence, because "nothing was discarded without telling
    // you" has to hold even when the discard is the right call: a user who opens the file and
    // sees a field Keyhold did not import deserves to find it named in the report rather than
    // conclude the importer lost it.
    if (isFlagSet(raw, 'deleted')) {
      tombstoned += 1;
      continue;
    }

    const type = readString(raw, 'type');
    if (type === TYPE_SECTION) continue;

    const label = readString(raw, 'label');
    const value = readString(raw, 'value');
    if (value.trim() === '') continue;

    // See the file header: a value Enpass calls sensitive never goes to a field that crosses
    // into the renderer, whatever its type says.
    const sensitive = isFlagSet(raw, 'sensitive');

    if (!sensitive) {
      if (type === TYPE_USERNAME && draft.username === '') {
        draft.username = value;
        continue;
      }
      if (type === TYPE_EMAIL && draft.email === '') {
        draft.email = value;
        continue;
      }
      if (type === TYPE_URL) {
        addUrls(draft, value);
        continue;
      }
    }

    if (type === TYPE_PASSWORD && draft.password === '') {
      draft.password = value;
      continue;
    }
    if (type === TYPE_TOTP) {
      addCustom(draft, label, value, 'otp-secret');
      continue;
    }

    const mapped = ENPASS_FIELD_TYPES[type] ?? guessCustomFieldType(label, value);
    addCustom(draft, label, value, sensitive ? toSecret(mapped) : mapped);
  }
  return tombstoned;
}

/**
 * The secret counterpart of a type, for a field Enpass marked sensitive.
 *
 * `pin` and `otp-secret` are already secret by `SECRET_CUSTOM_FIELD_TYPES`, so they are kept —
 * promoting a PIN to a password would lose the fact that it is a PIN for no security gain.
 * Everything else becomes `password`, which is the model's general-purpose secret type.
 */
function toSecret(type: CustomFieldType): CustomFieldType {
  return type === 'pin' || type === 'otp-secret' ? type : 'password';
}

/**
 * Folder uuid → full path, ancestors resolved.
 *
 * The `seen` set is not defensive tidiness: a folder tree read out of a file someone else
 * wrote can contain a cycle, and without it this loops forever inside a parse the user is
 * watching a spinner for.
 */
function readFolderPaths(root: Record<string, unknown>): Map<string, string> {
  const byUuid = new Map<string, { title: string; parent: string }>();
  for (const raw of readArray(root, 'folders')) {
    if (!isRecord(raw)) continue;
    const uuid = readString(raw, 'uuid');
    if (uuid === '') continue;
    byUuid.set(uuid, { title: readString(raw, 'title'), parent: readString(raw, 'parent_uuid') });
  }

  const paths = new Map<string, string>();
  for (const uuid of byUuid.keys()) {
    const segments: string[] = [];
    const seen = new Set<string>();
    let current = uuid;
    while (current !== '' && !seen.has(current)) {
      seen.add(current);
      const folder = byUuid.get(current);
      if (folder === undefined) break;
      segments.unshift(folder.title);
      current = folder.parent;
    }
    const path = normaliseFolderPath(segments.join('/'));
    if (path !== null) paths.set(uuid, path);
  }
  return paths;
}

// ── Reading untrusted JSON ───────────────────────────────────────────────────

/**
 * Every reader below is total: a missing key, a null, or a string where a number belongs
 * yields an empty value rather than an exception. The input is a file the user was handed by
 * another program, and possibly by an attacker — a parser that throws on an unexpected shape
 * is a parser that refuses a real export because Enpass added a null somewhere.
 *
 * The whole-file shape checks in `parseEnpassJson` are the deliberate exception. Being lenient
 * about a *field* keeps an import working; being lenient about the *file* produces a silent
 * zero-record import, which is the one outcome worse than an error message.
 */
function parseJsonObject(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(content));
  } catch (cause) {
    throw new VaultError('MALFORMED', 'This file is not valid JSON and could not be read.', {
      cause,
    });
  }
  if (!isRecord(parsed)) {
    throw new VaultError(
      'MALFORMED',
      'This JSON file is not an Enpass export — its top level is not an object.'
    );
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

function readArray(source: Record<string, unknown>, key: string): unknown[] {
  const value = source[key];
  return Array.isArray(value) ? value : [];
}

/**
 * Enpass writes its booleans as `0` and `1`, but not consistently across versions or
 * platforms — `trashed` has been seen as a real boolean, and a hand-edited file can hold
 * either. Accepting both spellings costs nothing and stops a `true` being read as "not
 * trashed", which would import a deleted item back into the user's vault.
 */
function isFlagSet(source: Record<string, unknown>, key: string): boolean {
  const value = source[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return false;
}
