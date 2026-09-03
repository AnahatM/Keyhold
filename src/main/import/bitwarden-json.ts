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
 * Bitwarden's **unencrypted** JSON export.
 *
 * ## The encrypted export is not supported, on purpose
 *
 * Bitwarden offers two encrypted variants and this parser refuses both, loudly, rather than
 * appearing to half-work:
 *
 *  - **Account-encrypted** (`"encrypted": true` with no `passwordProtected`) is bound to the
 *     user's Bitwarden *account key*. It cannot be decrypted by anyone who is not logged into
 *     that account — not by Keyhold, not by Bitwarden's own importer on a different account.
 *     There is no file the user could give us that would make it work.
 *  - **Password-protected** (`"passwordProtected": true`) is decryptable in principle, but
 *     doing so means implementing Bitwarden's KDF profile, their cipher-string format and
 *     their key-derivation chain, and then keeping all three correct as Bitwarden changes
 *     them. That is a re-implementation of somebody else's crypto inside a password manager —
 *     precisely the thing hard rule 3 forbids inventing and hard rule 6 makes expensive to
 *     get wrong.
 *
 * Bitwarden's own export dialog offers the plain JSON, so the fix is one checkbox on the
 * user's side. The error below says exactly that.
 *
 * ## Why the JSON is better than the CSV
 *
 * It keeps the **field types** (a hidden custom field stays hidden rather than being guessed
 * at), the folder tree, multiple URIs per item, and cards and identities as structured data
 * instead of omitting them entirely.
 */

/** Bitwarden's item type discriminator. */
const ITEM_LOGIN = 1;
const ITEM_SECURE_NOTE = 2;
const ITEM_CARD = 3;
const ITEM_IDENTITY = 4;

/** Bitwarden's custom-field type discriminator. */
const FIELD_TEXT = 0;
const FIELD_HIDDEN = 1;
const FIELD_BOOLEAN = 2;
const FIELD_LINKED = 3;

export const bitwardenJsonParser: ImportParser = {
  id: 'bitwarden-json',
  name: 'Bitwarden (JSON)',
  extensions: ['.json'],
  description: 'Bitwarden’s unencrypted JSON export. Keeps more than the CSV.',
  needsMapping: false,

  detect(content: string): boolean {
    // A Windows-written JSON export can carry a BOM, and `JSON.parse` rejects one outright.
    const head = stripBom(content).slice(0, 4096).trimStart();
    if (!head.startsWith('{')) return false;
    if (!head.includes('"items"')) return false;

    // `"items"` plus `"encrypted"` or `"folders"` was not enough, and the cost was not
    // theoretical. Enpass pairs a top-level `items` with a top-level `folders`; Proton Pass
    // pairs it with a top-level `encrypted`. This claimed both. An Enpass export read as
    // Bitwarden produced four untitled records whose every field was called "Field", and a
    // Proton export produced a silent zero-record import — the "plausible-looking, wrong
    // records" failure `index.test.ts`'s own header warns about, happening in the shipped app.
    //
    // So a Bitwarden-only key has to be present too. `folderId` and `collectionIds` are on
    // every Bitwarden item and on nothing else; `passwordProtected` marks the encrypted
    // variant, which this parser must still claim in order to refuse it by name.
    //
    // The one behaviour lost: a Bitwarden export containing zero items no longer
    // auto-detects. Detection is documented as a suggestion rather than a decision, the user
    // can still pick the format by hand, and an empty export has nothing to import — a cheap
    // trade for closing a wrong-import that silently produces junk records.
    return (
      head.includes('"folderId"') ||
      head.includes('"collectionIds"') ||
      head.includes('"passwordProtected"')
    );
  },

  parse(content: string): ImportResult {
    return parseBitwardenJson(content);
  },
};

function parseBitwardenJson(content: string): ImportResult {
  const root = parseJsonObject(content);

  if (root.encrypted === true) {
    throw new VaultError(
      'MALFORMED',
      root.passwordProtected === true
        ? 'This Bitwarden export is password-protected. Keyhold does not decrypt Bitwarden’s own encrypted format — export again with "Export as .json" instead of the encrypted option.'
        : 'This Bitwarden export is encrypted with your Bitwarden account key, which only Bitwarden holds. Export again choosing the unencrypted .json format.'
    );
  }

  const log = new WarningLog();
  const folders = new FolderSet();
  const folderNames = readFolderNames(root);
  const records: NewCredentialInput[] = [];

  const items = readArray(root, 'items');
  if (items.length === 0) {
    log.add('format', 'The export contains no items.');
  }

  let repromptCount = 0;
  let passkeyCount = 0;
  let historyCount = 0;

  items.forEach((raw, index) => {
    // Items are referred to by position, never by name. A warning is displayed, logged and
    // pasted into bug reports; naming the item would put vault content in all three.
    const position = index + 1;
    if (!isRecord(raw)) {
      log.add('skipped-row', `Item ${position} is not an object and was skipped.`);
      return;
    }

    if (raw.deletedDate != null) {
      log.add('skipped-row', `Item ${position} is in Bitwarden’s trash and was not imported.`);
      return;
    }

    const draft = newDraft();
    draft.title = readString(raw, 'name');
    draft.favorite = raw.favorite === true;
    addNote(draft, readString(raw, 'notes'));

    const folderPath = folderNames.get(readString(raw, 'folderId'));
    draft.folderPath = folderPath === undefined ? null : normaliseFolderPath(folderPath);

    if (readNumber(raw, 'reprompt') === 1) repromptCount += 1;
    if (readArray(raw, 'passwordHistory').length > 0) historyCount += 1;

    const type = readNumber(raw, 'type');
    switch (type) {
      case ITEM_LOGIN:
        passkeyCount += applyLogin(draft, raw);
        break;
      case ITEM_SECURE_NOTE:
        // Nothing beyond the note itself; `notes` is already set above.
        break;
      case ITEM_CARD:
        applyPrefixed(draft, raw, 'card', CARD_LABELS, CARD_TYPES);
        log.add(
          'unsupported-item',
          `Item ${position} is a Bitwarden card. Keyhold stores logins, so its details were kept as custom fields.`
        );
        break;
      case ITEM_IDENTITY:
        applyPrefixed(draft, raw, 'identity', IDENTITY_LABELS, IDENTITY_TYPES);
        log.add(
          'unsupported-item',
          `Item ${position} is a Bitwarden identity. Keyhold stores logins, so its details were kept as custom fields.`
        );
        break;
      case null:
      default:
        log.add(
          'unsupported-item',
          `Item ${position} has an unrecognised Bitwarden type. Its custom fields were kept; anything type-specific was not.`
        );
        break;
    }

    applyCustomFields(draft, raw, log, position);

    const record = finishDraft(draft);
    if (record === null) {
      log.add('skipped-row', `Item ${position} held no importable values.`);
      return;
    }
    folders.add(draft.folderPath);
    records.push(record);
  });

  if (repromptCount > 0) {
    log.add(
      'dropped-value',
      `${repromptCount} item(s) asked Bitwarden to re-prompt for the master password. Keyhold has no equivalent yet, so the flag was not carried.`
    );
  }
  if (passkeyCount > 0) {
    log.add(
      'unsupported-item',
      `${passkeyCount} item(s) carry a passkey. Passkeys are bound to Bitwarden’s own store and cannot be exported into another product.`
    );
  }
  if (historyCount > 0) {
    log.add(
      'dropped-value',
      `${historyCount} item(s) have a Bitwarden password history. Imported records start with a fresh history.`
    );
  }

  return { records, warnings: log.all, folders: folders.all };
}

/** Returns the number of passkeys found, which the caller reports once for the whole file. */
function applyLogin(draft: DraftRecord, item: Record<string, unknown>): number {
  const login = item.login;
  if (!isRecord(login)) return 0;

  // `finishDraft` mirrors an email-shaped username into `email`; that rule lives in one place.
  draft.username = readString(login, 'username');
  draft.password = readString(login, 'password');

  const totp = readString(login, 'totp');
  if (totp !== '') addCustom(draft, 'One-time password', totp, 'otp-secret');

  for (const uri of readArray(login, 'uris')) {
    if (isRecord(uri)) addUrls(draft, readString(uri, 'uri'));
    else if (typeof uri === 'string') addUrls(draft, uri);
  }

  return readArray(login, 'fido2Credentials').length;
}

const CARD_LABELS: Readonly<Record<string, string>> = {
  cardholderName: 'Cardholder name',
  brand: 'Card brand',
  number: 'Card number',
  expMonth: 'Expiry month',
  expYear: 'Expiry year',
  code: 'Security code',
};

/**
 * Card and identity secrets get **secret types deliberately**.
 *
 * The type guesser would call a card number a `number` and a security code a `number` too,
 * and both would then sit in the safe projection in plain sight. A card number is exactly as
 * sensitive as a password; the model has no card type, so the closest secret type is used.
 */
const CARD_TYPES: Readonly<Record<string, CustomFieldType>> = {
  number: 'password',
  code: 'pin',
  // Bitwarden stores these as bare month and year strings — "5" and "2030" — so the date
  // guess the label would otherwise trigger would be wrong about both.
  expMonth: 'number',
  expYear: 'number',
};

const IDENTITY_LABELS: Readonly<Record<string, string>> = {
  // Bitwarden's identity `title` is an honorific. Left as "Title" it reads like the record's
  // own title in the field list, which is confusing at exactly the wrong moment.
  title: 'Honorific',
  firstName: 'First name',
  middleName: 'Middle name',
  lastName: 'Last name',
  address1: 'Address',
  address2: 'Address line 2',
  address3: 'Address line 3',
  postalCode: 'Postcode',
  ssn: 'Social security number',
  passportNumber: 'Passport number',
  licenseNumber: 'Licence number',
  phone: 'Phone',
  company: 'Company',
};

const IDENTITY_TYPES: Readonly<Record<string, CustomFieldType>> = {
  ssn: 'password',
  passportNumber: 'password',
  licenseNumber: 'password',
};

/**
 * Copies every populated string under `item[section]` into custom fields.
 *
 * Iterating the object rather than listing known keys is what makes this survive Bitwarden
 * adding a field: a new key on a card arrives as a labelled custom field instead of being
 * dropped because nobody updated a list.
 */
function applyPrefixed(
  draft: DraftRecord,
  item: Record<string, unknown>,
  section: string,
  labels: Readonly<Record<string, string>>,
  types: Readonly<Record<string, CustomFieldType>>
): void {
  const data = item[section];
  if (!isRecord(data)) return;

  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    const label = labels[key] ?? humaniseKey(key);
    // `email` and `username` on an identity are real logins; give them their proper homes.
    if (key === 'email' && draft.email === '') {
      draft.email = value;
      continue;
    }
    if (key === 'username' && draft.username === '') {
      draft.username = value;
      continue;
    }
    addCustom(draft, label, value, types[key] ?? guessCustomFieldType(label, value));
  }
}

function applyCustomFields(
  draft: DraftRecord,
  item: Record<string, unknown>,
  log: WarningLog,
  position: number
): void {
  for (const raw of readArray(item, 'fields')) {
    if (!isRecord(raw)) continue;
    const label = readString(raw, 'name');
    const value = readString(raw, 'value');
    if (value.trim() === '') continue;

    switch (readNumber(raw, 'type')) {
      case FIELD_HIDDEN:
        // Bitwarden says this one is secret. That is authoritative — do not re-guess it.
        addCustom(draft, label, value, 'password');
        break;
      case FIELD_BOOLEAN:
        addCustom(draft, label, value, 'boolean');
        break;
      case FIELD_LINKED:
        log.add(
          'dropped-value',
          `Item ${position} has a Bitwarden "linked" field, which points at another field rather than holding a value. There is nothing to import.`
        );
        break;
      case FIELD_TEXT:
      case null:
      default:
        addCustom(draft, label, value, guessCustomFieldType(label, value));
        break;
    }
  }
}

// ── Reading untrusted JSON ───────────────────────────────────────────────────

/**
 * Every reader below is total: a missing key, a null, or a number where a string belongs
 * yields an empty value rather than an exception. The input is a file the user was handed by
 * another program, and possibly by an attacker — a parser that throws on an unexpected shape
 * is a parser that refuses a real export because Bitwarden added a null somewhere.
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
      'This JSON file is not a Bitwarden export — its top level is not an object.'
    );
  }
  return parsed;
}

function readFolderNames(root: Record<string, unknown>): Map<string, string> {
  const names = new Map<string, string>();
  for (const folder of readArray(root, 'folders')) {
    if (!isRecord(folder)) continue;
    const id = readString(folder, 'id');
    const name = readString(folder, 'name');
    if (id !== '' && name !== '') names.set(id, name);
  }
  return names;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' ? value : null;
}

function readArray(source: Record<string, unknown>, key: string): unknown[] {
  const value = source[key];
  return Array.isArray(value) ? value : [];
}

function humaniseKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
