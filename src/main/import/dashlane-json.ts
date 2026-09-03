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
 * Dashlane's JSON export (My Account → Settings → Export → Export to JSON).
 *
 * ## This is a different, richer file from `credentials.csv`
 *
 * `dashlane-csv.ts` reads one file out of Dashlane's *multi-file* CSV export — the one
 * holding logins — and the other four (secure notes, payments, ids, personal info) have no
 * parser and need a hand-made mapping through the generic CSV. The JSON export is a **single
 * file containing all of them**, which is why it is worth its own parser: it is the only
 * Dashlane export that can round-trip a whole account in one pass.
 *
 * The two are deliberately left independent. Folding them together would mean one module
 * translating between two unrelated shapes, and the CSV one is already correct.
 *
 * ## The top level is a section map, not an item list
 *
 * Dashlane keys its export by its own internal type names — `AUTHENTIFIANT` for a login
 * (Dashlane's codebase is French in origin), `SECURENOTE`, `PAYMENTMEANS_CREDITCARD`, and so
 * on — each mapping to an array. **Every section is read**, not just the logins: an importer
 * that took `AUTHENTIFIANT` and stopped would silently discard the user's cards, passports
 * and bank details, and they would not find out until they went looking for one.
 *
 * Sections this build has never heard of are imported *generically*, as records made of
 * labelled custom fields, rather than skipped. A Dashlane release that adds a section should
 * cost the user nothing.
 *
 * ## What is known versus inferred about this format
 *
 * Known from real exports: the section-map top level, the `AUTHENTIFIANT` key names below,
 * `SECURENOTE`'s `title` / `content` / `category` / `secured`, and the fact that Dashlane
 * writes **every** value as a JSON string — booleans arrive as `"true"`, timestamps as
 * `"1730000000"`. Inferred: the exact key names inside the personal-data sections, which is
 * exactly why those are handled generically instead of by a hard-coded list.
 *
 * Less certain, and worth stating: whether `category` on an item holds a category *name* or an
 * id referencing `AUTHCATEGORY`. Real exports observed carry the name, and that is what this
 * reads. If an id ever turns up it becomes a folder with an ugly name — visible and fixable,
 * rather than a silently lost folder tree.
 */

/** Dashlane's login section. */
const SECTION_LOGINS = 'AUTHENTIFIANT';
/** Dashlane's secure-note section. */
const SECTION_NOTES = 'SECURENOTE';

/**
 * Sections that are lists of *category names*, not items.
 *
 * They are consumed rather than dropped: every name in them already reaches Keyhold as a
 * folder, through the `category` on the items themselves. Importing them as records would
 * produce a credential called "Work" whose only content is the word "Work".
 */
const CATEGORY_SECTIONS: ReadonlySet<string> = new Set(['AUTHCATEGORY', 'SECURENOTECATEGORY']);

/**
 * Section names this build recognises.
 *
 * Used only for the "is this a Dashlane export at all?" check. A file whose top level has
 * arrays but not one of these names is far more likely to be some other product's JSON than
 * a Dashlane export, and saying so is better than importing nothing and calling it a success.
 */
const KNOWN_SECTIONS: ReadonlySet<string> = new Set([
  SECTION_LOGINS,
  SECTION_NOTES,
  'AUTHCATEGORY',
  'SECURENOTECATEGORY',
  'ADDRESS',
  'BANKSTATEMENT',
  'COMPANY',
  'DRIVERLICENCE',
  'EMAIL',
  'FISCALSTATEMENT',
  'IDCARD',
  'IDENTITY',
  'PASSPORT',
  'PAYMENTMEANS_CREDITCARD',
  'PAYMENTMEAN_PAYPAL',
  'PERSONALWEBSITE',
  'PHONE',
  'SOCIALSECURITYSTATEMENT',
]);

/** Readable names for the sections whose key is an internal code word. */
const SECTION_LABELS: Readonly<Record<string, string>> = {
  ADDRESS: 'Address',
  BANKSTATEMENT: 'Bank account',
  COMPANY: 'Company',
  DRIVERLICENCE: 'Driving licence',
  EMAIL: 'Email account',
  FISCALSTATEMENT: 'Tax number',
  IDCARD: 'ID card',
  IDENTITY: 'Identity',
  PASSPORT: 'Passport',
  PAYMENTMEANS_CREDITCARD: 'Credit card',
  PAYMENTMEAN_PAYPAL: 'PayPal account',
  PERSONALWEBSITE: 'Website',
  PHONE: 'Phone',
  SOCIALSECURITYSTATEMENT: 'Social security number',
};

/**
 * Readable labels for the personal-data keys this build recognises.
 *
 * The generic path calls `humaniseKey` for everything else, and `humaniseKey` produces title
 * case — "Date Of Birth" — because it is a straight copy of the one in `bitwarden-json.ts`,
 * where it is a rare fallback. Here it would be the *common* case, on every field of every
 * card and ID document, so the keys that are actually known get a proper sentence-case label
 * and the fallback goes back to being rare. This is the same arrangement `bitwarden-json.ts`
 * uses with `CARD_LABELS` and `IDENTITY_LABELS`, for the same reason.
 */
const GENERIC_LABELS: Readonly<Record<string, string>> = {
  bank: 'Bank',
  bankAccountBIC: 'BIC',
  bankAccountIBAN: 'IBAN',
  cardNumber: 'Card number',
  cardPin: 'Card PIN',
  dateOfBirth: 'Date of birth',
  deliveryDate: 'Issued on',
  expireDate: 'Expires on',
  expireMonth: 'Expiry month',
  expireYear: 'Expiry year',
  fiscalNumber: 'Tax number',
  fullname: 'Full name',
  ownerName: 'Cardholder name',
  securityCode: 'Security code',
  socialSecurityNumber: 'Social security number',
};

/**
 * Keys in the personal-data sections whose type must not be guessed at.
 *
 * The guesser would call a card number a `number` and a security code a `number` too, and both
 * would then sit in the safe projection in plain sight. A card number is exactly as sensitive
 * as a password. The model has no card type, so the closest secret type is used, matching
 * `bitwarden-json.ts`.
 *
 * The two month/year entries are the mirror image of that: their *labels* say "expiry", so the
 * guesser would call them dates, and a UI would then push `5` through a date formatter. They
 * are bare numbers and are typed as such — again exactly as `bitwarden-json.ts` does.
 */
const GENERIC_TYPES: Readonly<Record<string, CustomFieldType>> = {
  cardNumber: 'password',
  securityCode: 'pin',
  cardPin: 'pin',
  number: 'password',
  socialSecurityNumber: 'password',
  bankAccountIBAN: 'password',
  bankAccountBIC: 'password',
  fiscalNumber: 'password',
  teledeclarantNumber: 'password',
  expireMonth: 'number',
  expireYear: 'number',
};

/**
 * `AUTHENTIFIANT` keys consumed by the mapping above, plus Dashlane's own UI behaviour flags.
 *
 * The second group — autofill toggles, space ids, the "checked" bit — describes how Dashlane
 * behaves, not what the user stored, so there is nothing for a Keyhold record to hold. They
 * are listed here by name so that anything *not* on this list and not mapped becomes a custom
 * field: a key Dashlane adds tomorrow arrives as data rather than disappearing.
 */
const LOGIN_CONSUMED: ReadonlySet<string> = new Set([
  'title',
  'login',
  'email',
  'secondaryLogin',
  'password',
  'note',
  'url',
  'domain',
  'category',
  'otpSecret',
  'otpUrl',
  'autoLogin',
  'autoProtected',
  'anonId',
  'checked',
  'id',
  'localeFormat',
  'spaceId',
  'status',
  'subdomainOnly',
  'trustedUrlGroup',
  'useFixedUrl',
]);

/**
 * Facts Dashlane records *about* a record that Keyhold has no home for.
 *
 * Reported once for the whole file rather than per key or per item. A user who is told "your
 * use counts and strength scores did not come across" understands the loss; the same fact
 * spread over six warnings on three thousand records is a wall nobody reads.
 */
const LOGIN_BOOKKEEPING: ReadonlySet<string> = new Set([
  'creationDatetime',
  'modificationDatetime',
  'lastBackupTime',
  'lastUse',
  'numberOfUse',
  'strength',
]);

/** Keys that name a personal-data item well enough to be its title. */
const TITLE_KEYS: readonly string[] = ['title', 'name', 'fullname', 'fullName', 'bank', 'login'];

export const dashlaneJsonParser: ImportParser = {
  id: 'dashlane-json',
  name: 'Dashlane (JSON)',
  extensions: ['.json'],
  description: 'Dashlane’s single-file JSON export. Carries notes, cards and IDs as well.',
  needsMapping: false,

  detect(content: string): boolean {
    // A Windows-written JSON export can carry a BOM, and `JSON.parse` rejects one outright.
    const head = stripBom(content).slice(0, 4096).trimStart();
    if (!head.startsWith('{')) return false;
    // Only the section names no other product would plausibly use. `SECURENOTE` and `EMAIL`
    // are real Dashlane sections but far too generic to claim a file on.
    return ['AUTHENTIFIANT', 'AUTHCATEGORY', 'SECURENOTECATEGORY', 'PAYMENTMEANS_CREDITCARD'].some(
      (marker) => head.includes(`"${marker}"`)
    );
  },

  parse(content: string): ImportResult {
    return parseDashlaneJson(content);
  },
};

function parseDashlaneJson(content: string): ImportResult {
  const root = parseJsonObject(content);

  const sections = Object.entries(root).filter((entry): entry is [string, unknown[]] =>
    Array.isArray(entry[1])
  );
  if (sections.length === 0) {
    // The loudest failure this parser has, and the one worth having: a file that is shaped
    // some other way must not produce "imported 0 records, no problems found".
    throw new VaultError(
      'MALFORMED',
      'This JSON file is not a Dashlane export — its top level holds no item lists. Dashlane writes one from My Account → Settings → Export → Export to JSON.'
    );
  }
  if (!sections.some(([name]) => KNOWN_SECTIONS.has(name))) {
    throw new VaultError(
      'MALFORMED',
      'This JSON file has item lists, but none of them is a section Dashlane writes (AUTHENTIFIANT, SECURENOTE and the rest). If it came from a newer Dashlane than this build knows about, please report it.'
    );
  }

  const log = new WarningLog();
  const folders = new FolderSet();
  const records: NewCredentialInput[] = [];

  let itemCount = 0;
  let securedNotes = 0;
  let bookkeeping = 0;

  for (const [section, items] of sections) {
    if (CATEGORY_SECTIONS.has(section)) continue;
    itemCount += items.length;

    if (section !== SECTION_LOGINS && section !== SECTION_NOTES && items.length > 0) {
      // Section *names* are safe to quote: they are JSON keys chosen by Dashlane, not content
      // out of the user's vault. Item titles and values never appear in a warning.
      log.add(
        'unsupported-item',
        `The export’s “${sectionLabel(section)}” section is not a login. Its ${items.length} item(s) were imported as records made of custom fields.`
      );
    }

    items.forEach((raw, index) => {
      // Items are referred to by section and position, never by name. A warning is displayed,
      // logged and pasted into bug reports; naming the item would put vault content in all
      // three.
      const where = `${sectionLabel(section)} item ${index + 1}`;
      if (!isRecord(raw)) {
        log.add('skipped-row', `${where} is not an object and was skipped.`);
        return;
      }

      const draft = newDraft();
      if (section === SECTION_LOGINS) {
        if (applyLogin(draft, raw)) bookkeeping += 1;
      } else if (section === SECTION_NOTES) {
        if (applyNote(draft, raw)) securedNotes += 1;
      } else {
        applyGeneric(draft, raw, section);
      }

      const record = finishDraft(draft);
      if (record === null) {
        log.add('skipped-row', `${where} held no importable values.`);
        return;
      }
      folders.add(draft.folderPath);
      records.push(record);
    });
  }

  if (itemCount === 0) log.add('format', 'The export contains no items.');
  if (securedNotes > 0) {
    log.add(
      'dropped-value',
      `${securedNotes} note(s) were marked "protected" in Dashlane, which asks for the master password again before showing them. Keyhold has no equivalent yet, so the flag was not carried.`
    );
  }
  if (bookkeeping > 0) {
    log.add(
      'dropped-value',
      `Dashlane’s own bookkeeping — creation and backup dates, use counts and strength scores — was not carried on ${bookkeeping} item(s). Imported records start with a fresh history.`
    );
  }

  return { records, warnings: log.all, folders: folders.all };
}

/** Returns true when the item carried bookkeeping the caller reports once for the whole file. */
function applyLogin(draft: DraftRecord, item: Record<string, unknown>): boolean {
  draft.title = readString(item, 'title');
  draft.username = readString(item, 'login');
  draft.email = readString(item, 'email');
  draft.password = readString(item, 'password');
  addNote(draft, readString(item, 'note'));
  draft.folderPath = normaliseFolderPath(readString(item, 'category'));

  // Dashlane's alternate login is often an email alias. It becomes a custom field rather than
  // being merged into `username`, because which one a site actually wants is a fact only the
  // user knows and picking one silently would mean the other is gone. Same label and type as
  // `dashlane-csv.ts` uses, so the two Dashlane paths produce the same record.
  addCustom(draft, 'Alternate login', readString(item, 'secondaryLogin'), 'text');

  // `domain` is Dashlane's parsed host for the same site as `url`, so taking both would give
  // one login two URLs that differ only in their scheme — and the dedupe rule would then see
  // two hosts where the user has one account.
  const url = readString(item, 'url');
  addUrls(draft, url === '' ? readString(item, 'domain') : url);

  // `otpUrl` is a full `otpauth://` URI and `otpSecret` is the bare seed. The URI carries the
  // issuer, the account and the digit count as well, so it is preferred when both are present.
  const otpUrl = readString(item, 'otpUrl');
  addCustom(
    draft,
    'One-time password',
    otpUrl === '' ? readString(item, 'otpSecret') : otpUrl,
    'otp-secret'
  );

  let sawBookkeeping = false;
  for (const [key, value] of Object.entries(item)) {
    if (LOGIN_BOOKKEEPING.has(key)) {
      if (typeof value === 'string' && value.trim() !== '') sawBookkeeping = true;
      continue;
    }
    if (LOGIN_CONSUMED.has(key) || typeof value !== 'string') continue;
    const label = humaniseKey(key);
    addCustom(draft, label, value, guessCustomFieldType(label, value));
  }
  return sawBookkeeping;
}

/** Returns true when the note was one Dashlane keeps behind a second master-password prompt. */
function applyNote(draft: DraftRecord, item: Record<string, unknown>): boolean {
  draft.title = readString(item, 'title');
  addNote(draft, readString(item, 'content'));
  draft.folderPath = normaliseFolderPath(readString(item, 'category'));
  // `type` is the note's colour swatch in Dashlane's UI. There is nothing to carry.
  return readString(item, 'secured').trim().toLowerCase() === 'true';
}

/**
 * A personal-data item — a card, a passport, a bank account — as a record of custom fields.
 *
 * Iterating the object rather than listing known keys is what makes this survive Dashlane
 * adding a field or a whole section: a new key arrives as a labelled custom field instead of
 * being dropped because nobody updated a list.
 */
function applyGeneric(draft: DraftRecord, item: Record<string, unknown>, section: string): void {
  for (const key of TITLE_KEYS) {
    const value = readString(item, key);
    if (value.trim() !== '') {
      draft.title = value;
      break;
    }
  }
  // A card with no name of its own still needs a title a user can find in a list, and the
  // section it came from is the most useful thing available. `finishDraft` would otherwise
  // fall back to "Untitled", and every card in the export would share that name.
  if (draft.title.trim() === '') draft.title = sectionLabel(section);

  draft.folderPath = normaliseFolderPath(readString(item, 'category'));

  for (const [key, value] of Object.entries(item)) {
    if (key === 'id' || key === 'anonId' || key === 'spaceId' || key === 'category') continue;
    if (typeof value !== 'string' || value.trim() === '') continue;
    const label = GENERIC_LABELS[key] ?? humaniseKey(key);
    addCustom(draft, label, value, GENERIC_TYPES[key] ?? guessCustomFieldType(label, value));
  }
}

function sectionLabel(section: string): string {
  return SECTION_LABELS[section] ?? humaniseKey(section.toLowerCase());
}

// ── Reading untrusted JSON ───────────────────────────────────────────────────

/**
 * Every reader below is total: a missing key, a null, or a number where a string belongs
 * yields an empty value rather than an exception. The input is a file the user was handed by
 * another program, and possibly by an attacker — a parser that throws on an unexpected shape
 * is a parser that refuses a real export because Dashlane added a null somewhere.
 *
 * The whole-file shape checks in `parseDashlaneJson` are the deliberate exception. Being
 * lenient about a *field* keeps an import working; being lenient about the *file* produces a
 * silent zero-record import, which is the one outcome worse than an error message.
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
      'This JSON file is not a Dashlane export — its top level is not an object.'
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

function humaniseKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
