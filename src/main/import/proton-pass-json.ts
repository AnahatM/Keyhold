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
 * Proton Pass's **unencrypted** JSON export — the `data.json` inside the export zip.
 *
 * ## What the user actually has in their hands
 *
 * Proton Pass's export dialog produces a **zip**, and the JSON is one file inside it. Keyhold
 * does not unpack zips, so the user has to extract `data.json` first. That is worth knowing
 * because the failure it causes is silent-looking: the user picks the zip, the file picker
 * accepts it because the picker filters on extension and nothing else, and the parse throws
 * "not valid JSON" — which is true and useless. The refusal below names the file to pick.
 *
 * The other export option is PGP-encrypted (`.pgp`), which is not JSON at all and is refused
 * for the same reason Bitwarden's encrypted export is: decrypting somebody else's format
 * means re-implementing their key derivation and then tracking it forever, and hard rule 3
 * says the answer to that is "no", not "carefully".
 *
 * ## Vaults are folders
 *
 * Proton Pass has no folder tree. It has **vaults** — a flat list, each with a name — and
 * every item belongs to exactly one. So a vault becomes a single-segment folder path, which
 * is the closest honest mapping: nesting would invent structure the source never had, and
 * dropping it would merge two vaults the user deliberately kept apart.
 *
 * The vault's key in the `vaults` object is a `shareId`, and it is never surfaced anywhere —
 * it is an opaque server identifier, and a folder called `b7f3…` helps nobody.
 *
 * ## What is known versus inferred about this format
 *
 * Known from real exports: the `vaults` → `items` → `data` → `{ metadata, content, extraFields,
 * type }` nesting, `state` as the trash flag, and the `hidden` / `text` / `totp` extra-field
 * types. Inferred and therefore handled *generically* rather than by a hard-coded key list:
 * the exact content keys of cards, identities and SSH keys. `applyContentFields` copies every
 * string it finds, so a content key nobody here anticipated arrives as a labelled custom field
 * instead of vanishing — the same defence `bitwarden-json.ts` uses for the same reason.
 */

/** `state` on an item. Proton keeps trashed items in the export rather than omitting them. */
const STATE_TRASHED = 2;

/**
 * Item content keys that deserve a better label than `humaniseKey` would produce, and — the
 * part that matters — the ones that must be typed as secret rather than guessed at.
 *
 * A card number guessed from its label lands on `number`, which is a *visible* type, so the
 * value would sit in the safe projection in plain sight. A card number is exactly as sensitive
 * as a password. The model has no card type, so the closest secret type is used, exactly as
 * `bitwarden-json.ts` does for the same fields.
 */
const CONTENT_LABELS: Readonly<Record<string, string>> = {
  cardholderName: 'Cardholder name',
  cardType: 'Card type',
  number: 'Card number',
  verificationNumber: 'Security code',
  expirationDate: 'Expiry date',
  pin: 'PIN',
  privateKey: 'Private key',
  publicKey: 'Public key',
  fullName: 'Full name',
  socialSecurityNumber: 'Social security number',
  passportNumber: 'Passport number',
  licenseNumber: 'Licence number',
};

const CONTENT_TYPES: Readonly<Record<string, CustomFieldType>> = {
  number: 'password',
  verificationNumber: 'pin',
  pin: 'pin',
  privateKey: 'password',
  socialSecurityNumber: 'password',
  passportNumber: 'password',
  licenseNumber: 'password',
  // Proton writes an expiry as `MMYYYY` — `052030`. The label says "expiry", so the guesser
  // would call it a `date`, and the UI would then render `052030` through a date formatter and
  // produce something that is not the card's expiry. Text is the truthful answer.
  expirationDate: 'text',
};

export const protonPassJsonParser: ImportParser = {
  id: 'proton-pass-json',
  name: 'Proton Pass (JSON)',
  extensions: ['.json'],
  description: 'Proton Pass’s unencrypted JSON export — data.json from inside the export zip.',
  needsMapping: false,

  detect(content: string): boolean {
    // A Windows-written JSON export can carry a BOM, and `JSON.parse` rejects one outright.
    const head = stripBom(content).slice(0, 4096).trimStart();
    if (!head.startsWith('{')) return false;
    // `vaults` is the discriminator: no other supported format has one. The second clause is
    // there so a file that merely mentions the word in a note is not claimed on that alone.
    return head.includes('"vaults"') && (head.includes('"items"') || head.includes('"userId"'));
  },

  parse(content: string): ImportResult {
    return parseProtonPassJson(content);
  },
};

function parseProtonPassJson(content: string): ImportResult {
  const root = parseJsonObject(content);

  if (root.encrypted === true) {
    throw new VaultError(
      'MALFORMED',
      'This Proton Pass export is encrypted. Keyhold does not decrypt Proton’s PGP export — export again choosing the unencrypted JSON option, then pick data.json from inside the zip.'
    );
  }

  const vaults = root.vaults;
  if (!isRecord(vaults)) {
    // The loudest failure this parser has, and the one worth having: a Proton export that is
    // shaped some other way must not produce "imported 0 records, no problems found".
    throw new VaultError(
      'MALFORMED',
      'This JSON file is not a Proton Pass export — it has no "vaults" section. Proton Pass writes data.json inside the export zip; extract it and pick that file.'
    );
  }

  const log = new WarningLog();
  const folders = new FolderSet();
  const records: NewCredentialInput[] = [];

  const vaultEntries = Object.values(vaults).filter(isRecord);
  // A vault object with no `items` key at all is not a Proton vault, whatever the top level
  // claimed. Checking the *key* rather than the array's length is deliberate: an empty vault
  // is an ordinary thing and must import as zero records, while a vault-shaped object that
  // has never heard of `items` means the file is something else entirely.
  if (vaultEntries.length > 0 && !vaultEntries.some((vault) => 'items' in vault)) {
    throw new VaultError(
      'MALFORMED',
      'This file has a "vaults" section, but nothing in it holds an "items" list. It does not look like a Proton Pass export; if it came from a newer Proton Pass than this build knows about, please report it.'
    );
  }

  let position = 0;
  let totalItems = 0;
  let passkeyCount = 0;
  let aliasCount = 0;

  for (const vault of vaultEntries) {
    const vaultPath = normaliseFolderPath(readString(vault, 'name'));
    const items = readArray(vault, 'items');
    totalItems += items.length;

    for (const raw of items) {
      // Items are referred to by position, never by name. A warning is displayed, logged and
      // pasted into bug reports; naming the item would put vault content in all three.
      position += 1;
      const record = readItem(raw, vaultPath, position, log, (kind) => {
        if (kind === 'passkey') passkeyCount += 1;
        else aliasCount += 1;
      });
      if (record === null) continue;
      folders.add(vaultPath);
      records.push(record);
    }
  }

  if (totalItems === 0) log.add('format', 'The export contains no items.');

  if (passkeyCount > 0) {
    log.add(
      'unsupported-item',
      `${passkeyCount} item(s) carry a passkey. Passkeys are bound to Proton Pass’s own store and cannot be exported into another product.`
    );
  }
  if (aliasCount > 0) {
    log.add(
      'dropped-value',
      `${aliasCount} item(s) are Proton Pass aliases. The forwarding address was kept as the record’s email, but the alias itself is a Proton service — it stops forwarding if that account is closed.`
    );
  }
  log.flushColumns(
    'dropped-value',
    (column, count) =>
      `The "${column}" value on ${count} item(s) is not text — Keyhold stores custom fields as text, so it was not carried.`
  );

  return { records, warnings: log.all, folders: folders.all };
}

/** What the caller has to tally across the whole file rather than per item. */
type ItemTally = 'passkey' | 'alias';

function readItem(
  raw: unknown,
  vaultPath: string | null,
  position: number,
  log: WarningLog,
  tally: (kind: ItemTally) => void
): NewCredentialInput | null {
  if (!isRecord(raw)) {
    log.add('skipped-row', `Item ${position} is not an object and was skipped.`);
    return null;
  }

  if (readNumber(raw, 'state') === STATE_TRASHED) {
    log.add('skipped-row', `Item ${position} is in Proton Pass’s trash and was not imported.`);
    return null;
  }

  const data = raw.data;
  if (!isRecord(data)) {
    log.add('skipped-row', `Item ${position} has no "data" section and was skipped.`);
    return null;
  }

  const draft = newDraft();
  draft.folderPath = vaultPath;
  draft.favorite = raw.pinned === true;

  const metadata = isRecord(data.metadata) ? data.metadata : {};
  draft.title = readString(metadata, 'name');
  addNote(draft, readString(metadata, 'note'));

  const content = isRecord(data.content) ? data.content : {};
  switch (readString(data, 'type')) {
    case 'login':
      if (applyLogin(draft, content)) tally('passkey');
      break;
    case 'note':
      // The body is `metadata.note`, which is already in the draft. `content` is `{}`.
      break;
    case 'alias': {
      // The alias address lives on the item, not in its content, and it *is* the account
      // identifier — it is the address the site sends mail to.
      const aliasEmail = readString(raw, 'aliasEmail');
      if (aliasEmail !== '') {
        draft.email = aliasEmail;
        tally('alias');
      }
      break;
    }
    default:
      applyContentFields(draft, content, log);
      // The type discriminator is deliberately *not* quoted here. It is a string out of the
      // user's file, and a warning is rendered on screen, written to the import report and
      // pasted into bug reports — so no string from the file goes in one, however innocuous
      // this particular string looks. The position and the consequence are what the user
      // needs anyway.
      log.add(
        'unsupported-item',
        `Item ${position} is not a login, a note or an alias. Keyhold stores logins, so its details were kept as custom fields.`
      );
      break;
  }

  applyExtraFields(draft, data);

  const record = finishDraft(draft);
  if (record === null) {
    log.add('skipped-row', `Item ${position} held no importable values.`);
    return null;
  }
  return record;
}

/** Returns true when the item carries a passkey, which the caller reports once for the file. */
function applyLogin(draft: DraftRecord, content: Record<string, unknown>): boolean {
  // Proton Pass keeps the email and the username genuinely apart, and Keyhold does too, so
  // this is one of the rare imports where neither has to be guessed at. `finishDraft` will
  // mirror an email-shaped username into `email` only if `email` is still empty, so setting
  // both here is safe and loses nothing.
  draft.email = readString(content, 'itemEmail');
  draft.username = readString(content, 'itemUsername');

  // Proton Pass before the email/username split wrote a single `username` holding whichever
  // the user typed. Reading it only when the newer pair is absent means an export from either
  // era imports, and a file that somehow has all three is read the modern way.
  if (draft.email === '' && draft.username === '') {
    draft.username = readString(content, 'username');
  }

  draft.password = readString(content, 'password');

  const totp = readString(content, 'totpUri');
  if (totp !== '') addCustom(draft, 'One-time password', totp, 'otp-secret');

  for (const url of readArray(content, 'urls')) {
    if (typeof url === 'string') addUrls(draft, url);
  }

  return readArray(content, 'passkeys').length > 0;
}

/**
 * Copies every populated string in an item's `content` into custom fields.
 *
 * Iterating the object rather than listing known keys is what makes this survive Proton
 * adding a field, or shipping an item type this build has never heard of: a new key arrives
 * as a labelled custom field instead of being dropped because nobody updated a list.
 *
 * Non-string values are counted rather than stringified. Proton uses numeric enums for things
 * like a card's brand, and `Card type: 1` in a user's vault is worse than nothing — it looks
 * like data and is not. The count is reported by key name, which names no content.
 */
function applyContentFields(
  draft: DraftRecord,
  content: Record<string, unknown>,
  log: WarningLog
): void {
  for (const [key, value] of Object.entries(content)) {
    const label = CONTENT_LABELS[key] ?? humaniseKey(key);
    if (typeof value !== 'string') {
      if (value !== null && value !== undefined) log.countColumn(label);
      continue;
    }
    if (value.trim() === '') continue;
    addCustom(draft, label, value, CONTENT_TYPES[key] ?? guessCustomFieldType(label, value));
  }
}

function applyExtraFields(draft: DraftRecord, data: Record<string, unknown>): void {
  for (const raw of readArray(data, 'extraFields')) {
    if (!isRecord(raw)) continue;
    const label = readString(raw, 'fieldName');
    const fieldData = isRecord(raw.data) ? raw.data : {};

    switch (readString(raw, 'type')) {
      case 'hidden':
        // Proton says this one is secret. That is authoritative — do not re-guess it. A hidden
        // field named "Nickname" would otherwise come out as plain text and reach the renderer.
        addCustom(draft, label, readString(fieldData, 'content'), 'password');
        break;
      case 'totp':
        // Proton stores a seed field's value under `totpUri`, not `content`.
        addCustom(draft, label, readString(fieldData, 'totpUri'), 'otp-secret');
        break;
      default: {
        const value = readString(fieldData, 'content');
        addCustom(draft, label, value, guessCustomFieldType(label, value));
        break;
      }
    }
  }
}

// ── Reading untrusted JSON ───────────────────────────────────────────────────

/**
 * Every reader below is total: a missing key, a null, or a number where a string belongs
 * yields an empty value rather than an exception. The input is a file the user was handed by
 * another program, and possibly by an attacker — a parser that throws on an unexpected shape
 * is a parser that refuses a real export because Proton added a null somewhere.
 *
 * The whole-file shape checks in `parseProtonPassJson` are the deliberate exception. Being
 * lenient about a *field* keeps an import working; being lenient about the *file* produces a
 * silent zero-record import, which is the one outcome worse than an error message.
 */
function parseJsonObject(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(content));
  } catch (cause) {
    throw new VaultError(
      'MALFORMED',
      'This file is not valid JSON and could not be read. Proton Pass exports a zip; the file to pick is the data.json inside it, not the zip itself.',
      { cause }
    );
  }
  if (!isRecord(parsed)) {
    throw new VaultError(
      'MALFORMED',
      'This JSON file is not a Proton Pass export — its top level is not an object.'
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
