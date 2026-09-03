// SPDX-License-Identifier: GPL-3.0-or-later
import type { CustomFieldType } from '@shared/model/credential.js';
import { MAX_CUSTOM_FIELDS, MAX_TAGS, MAX_URLS } from '@shared/model/credential.js';
import { normaliseFolderPath } from '@shared/model/import.js';
import { VaultError } from '../crypto/errors.js';
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
import type { ImportParser, ImportResult } from './types.js';
import { looksLikeZip, ZipArchive } from './zip-reader.js';

/**
 * 1Password's **1PUX** export — the archive, not the CSV.
 *
 * ## Why this is the one to use
 *
 * `onepassword-csv.ts` says it at the top and it is worth repeating here from the other side:
 * the CSV flattens every item to a login. A Credit Card, a Software Licence, an Identity, a
 * Passport, an API Credential — 1Password does not put their typed fields in the CSV **at
 * all**, so no importer can recover them from it. The 1PUX keeps every field of every
 * category, the vault each item lived in, per-item tags, and the concealed/plain distinction
 * that decides whether a value is a secret. Everything below exists to carry that across.
 *
 * ## The file
 *
 * A `.1pux` is a ZIP archive containing:
 *
 *   export.data          the whole vault, as JSON            ← everything this parser reads
 *   export.attributes    a small manifest (version, date)    ← ignored; nothing to import
 *   files/…              attachment and document bytes       ← see "Attachments" below
 *
 * The ZIP half is `zip-reader.ts`, which exists because this is the only binary import format
 * and because pulling in a general-purpose archive library for one JSON file would be a poor
 * trade in the process that holds the master key. Read that file's threat-model note before
 * changing anything here that touches bytes.
 *
 * ## Attachments are **not** imported, and that is a pipeline limit rather than a choice
 *
 * `NewCredentialInput` — the only thing a parser is allowed to produce — has no attachment
 * field, and it should not have one: attachments are chunks in the KEEP container, encrypted
 * individually and addressed by chunk id, and minting those is the commit stage's job, not a
 * pure function's. So a `.1pux` full of documents imports every item, every field and every
 * note, and leaves the bytes behind. **It says so, per import, with a count** — the one thing
 * that must never happen is a user discovering months later that their passport scan did not
 * come across. Carrying them is `docs/12-Roadmap/01-Feature-Backlog.md` material.
 *
 * ## What is known about the schema, and what is inferred
 *
 * 1Password documents the 1PUX layout, and the shapes below follow it: the
 * accounts → vaults → items nesting, the `categoryUuid` codes, `details.loginFields` with
 * their `designation`, `details.sections[].fields[]` with single-key typed `value` objects,
 * and the `overview` block holding title, URLs and tags.
 *
 * Everything is nevertheless read **defensively**, because this is a file another program
 * wrote and versions drift. Three places make a deliberate guess rather than assuming:
 *
 *  - **Items may or may not be wrapped.** Exports have been seen with `items: [{ item: {…} }]`
 *    and with `items: [{…}]`. Both are accepted; the wrapper is unwrapped if present.
 *  - **An unrecognised value kind is kept, not dropped.** A `value` object whose single key is
 *    not in {@link readTypedValue}'s table still yields its string or number as a text field.
 *    A new 1Password field type therefore arrives as a labelled custom field instead of
 *    vanishing, which is the failure this whole import engine exists to prevent.
 *  - **Archived items are recognised from either `state: "archived"` or `archived: true`.**
 *
 * ## The one rule that is not a guess
 *
 * **A `concealed` value is a secret, full stop.** Its type comes from the JSON key, never from
 * the label — exactly as `bitwarden-json.ts` trusts `FIELD_HIDDEN`. This matters more than it
 * looks: a security question's answer is stored `concealed` under a label like "What was your
 * first pet's name?", which no label heuristic would ever call secret. Guessing `text` there
 * would put that answer into the safe projection, which is decision D13's boundary and a
 * vulnerability rather than a cosmetic mistake.
 */

/** The JSON entry. Everything this parser reads comes out of it. */
export const ONE_PUX_DATA_ENTRY = 'export.data';
/** Attachment bytes live under here. Counted, reported, and not imported — see the note above. */
export const ONE_PUX_FILES_PREFIX = 'files/';

/**
 * 1Password's item categories.
 *
 * Present so a warning can say "3 Credit Card items" rather than "3 items of category 002".
 * Only Login and Password map cleanly onto a Keyhold record; everything else keeps its fields
 * as custom fields and is reported by name, the same treatment `bitwarden-json.ts` gives a
 * card or an identity.
 */
const CATEGORY_NAMES: Readonly<Record<string, string>> = {
  '001': 'Login',
  '002': 'Credit Card',
  '003': 'Secure Note',
  '004': 'Identity',
  '005': 'Password',
  '006': 'Document',
  '100': 'Software Licence',
  '101': 'Bank Account',
  '102': 'Database',
  '103': 'Driver Licence',
  '104': 'Outdoor Licence',
  '105': 'Membership',
  '106': 'Passport',
  '107': 'Rewards Programme',
  '108': 'Social Security Number',
  '109': 'Wireless Router',
  '110': 'Server',
  '111': 'Email Account',
  '112': 'API Credential',
  '113': 'Medical Record',
  '114': 'SSH Key',
};

const CATEGORY_LOGIN = '001';
const CATEGORY_PASSWORD = '005';

/** `loginFields[].fieldType` — the HTML input type 1Password saw on the page. */
const LOGIN_FIELD_TYPES: Readonly<Record<string, CustomFieldType>> = {
  P: 'password',
  E: 'email',
  U: 'url',
  N: 'number',
  T: 'text',
  A: 'multiline',
  C: 'boolean',
  TEL: 'phone',
};

export const onePassword1puxParser: ImportParser = {
  id: 'onepassword-1pux',
  name: '1Password (1PUX archive)',
  extensions: ['.1pux'],
  description: '1Password 8’s full export. Keeps every category, vault and field.',
  needsMapping: false,

  detect(content: string): boolean {
    // Two cheap checks, in the order that rejects fastest. The signature survives text
    // decoding — `P`, `K` and the two control bytes are all valid UTF-8 — so a `.1pux` is
    // still *recognisable* even when its body has not survived; see `bytesOf` for why that
    // distinction exists and why it is reported rather than ignored.
    if (!content.startsWith('PK\u0003\u0004')) return false;
    // Entry names are stored uncompressed in both the local headers and the directory, so the
    // marker is findable without inflating anything. Only files that already look like a ZIP
    // pay for this scan.
    return content.includes(ONE_PUX_DATA_ENTRY);
  },

  parse(content: string): ImportResult {
    return parseOnePassword1pux(bytesOf(content));
  },
};

/**
 * The real entry point: a `.1pux` as **bytes**.
 *
 * `ImportParser.parse` takes a `string`, which is right for the eleven text formats and wrong
 * for this one. See `bytesOf` for the adapter and for what the import pipeline still owes this
 * parser before it can be registered.
 */
export function parseOnePassword1pux(bytes: Uint8Array): ImportResult {
  const archive = ZipArchive.open(bytes);

  if (!archive.has(ONE_PUX_DATA_ENTRY)) {
    throw new VaultError(
      'MALFORMED',
      `This ZIP archive is not a 1Password export — it contains no ${ONE_PUX_DATA_ENTRY} entry. Export again from 1Password choosing "1Password Unencrypted Export".`
    );
  }

  const root = parseJsonObject(archive.readText(ONE_PUX_DATA_ENTRY));
  const log = new WarningLog();
  const counts = new Counters();

  // Counted from the archive rather than from the JSON: the JSON's file references and the
  // archive's payloads can disagree, and the honest number for "what did not come across" is
  // the number of payloads actually sitting in the file.
  counts.attachmentEntries = archive
    .entriesUnder(ONE_PUX_FILES_PREFIX)
    .filter((entry) => !entry.isDirectory).length;

  const accounts = readAccounts(root);
  if (accounts.length === 0) log.add('format', 'The export contains no accounts.');

  const folders = new FolderSet();
  const records: NewCredentialInput[] = [];
  let position = 0;

  for (const account of accounts) {
    for (const vault of readArray(account.raw, 'vaults')) {
      if (!isRecord(vault)) continue;
      const folderPath = vaultFolderPath(account.name, vault, accounts.length > 1);

      for (const rawItem of readArray(vault, 'items')) {
        position += 1;
        const record = readItem(rawItem, folderPath, position, log, counts);
        if (record === null) continue;
        folders.add(folderPath);
        records.push(record);
      }
    }
  }

  if (records.length === 0 && position === 0) {
    log.add('format', 'The export contains no items.');
  }
  counts.report(log);

  return { records, warnings: log.all, folders: folders.all };
}

// ── One item ─────────────────────────────────────────────────────────────────

/**
 * Turns one 1PUX item into a record, or `null` when it is not one.
 *
 * Items are identified by **position**, never by title. A warning is shown on screen, written
 * into the import report and pasted into bug reports; naming the item would put vault content
 * in all three (hard rule 1). This is the same rule `bitwarden-json.ts` follows.
 */
function readItem(
  rawItem: unknown,
  folderPath: string | null,
  position: number,
  log: WarningLog,
  counts: Counters
): NewCredentialInput | null {
  if (!isRecord(rawItem)) {
    log.add('skipped-row', `Item ${position} is not an object and was skipped.`);
    return null;
  }

  // Exports have been seen both wrapped and unwrapped. Unwrapping when the wrapper is there
  // costs one property read; assuming either shape costs a silently empty import.
  const inner = rawItem.item;
  const item = isRecord(inner) ? inner : rawItem;

  if (item.trashed === true) {
    counts.trashed += 1;
    return null;
  }
  if (item.archived === true || readString(item, 'state') === 'archived') {
    counts.archived += 1;
    return null;
  }

  const details = isRecord(item.details) ? item.details : {};
  const overview = isRecord(item.overview) ? item.overview : {};
  const category = readString(item, 'categoryUuid');

  const draft = newDraft();
  draft.title = readString(overview, 'title');
  draft.folderPath = folderPath;
  const favIndex = readNumber(item, 'favIndex');
  draft.favorite = favIndex !== null && favIndex !== 0;
  addNote(draft, readString(details, 'notesPlain'));

  applyUrls(draft, overview);
  applyTags(draft, overview, counts);
  applyLoginFields(draft, details, counts);
  applySections(draft, details, counts);
  applyDocument(draft, details, counts);

  if (readArray(details, 'passwordHistory').length > 0) counts.withHistory += 1;
  if (category !== CATEGORY_LOGIN && category !== CATEGORY_PASSWORD) {
    counts.countCategory(category);
  }

  const record = finishDraft(draft);
  if (record === null) {
    log.add('skipped-row', `Item ${position} held no importable values.`);
    return null;
  }
  return record;
}

function applyUrls(draft: DraftRecord, overview: Record<string, unknown>): void {
  addUrls(draft, readString(overview, 'url'));
  for (const entry of readArray(overview, 'urls')) {
    if (draft.urls.length >= MAX_URLS) break;
    if (typeof entry === 'string') addUrls(draft, entry);
    else if (isRecord(entry)) addUrls(draft, readString(entry, 'url'));
  }
  // `addUrls` de-duplicates but does not cap, and a record over the model's ceiling is
  // refused by `assertValidCredential` at commit time — which would fail the whole import
  // rather than one record.
  draft.urls = draft.urls.slice(0, MAX_URLS);
}

function applyTags(draft: DraftRecord, overview: Record<string, unknown>, counts: Counters): void {
  for (const tag of readArray(overview, 'tags')) {
    if (typeof tag !== 'string' || tag.trim() === '') continue;
    if (draft.tags.length >= MAX_TAGS) {
      counts.clippedTags += 1;
      continue;
    }
    if (!draft.tags.includes(tag)) draft.tags.push(tag);
  }
}

/**
 * The username and password, plus whatever else the saved form carried.
 *
 * `designation` is 1Password's own answer to "which box on the page was this?", so it decides
 * where the value lands rather than the field's name. The rest of a saved form — a second
 * hidden input, a "remember me" checkbox — is kept as custom fields rather than dropped: it is
 * rarely interesting and it is occasionally the only copy of an account number somebody typed
 * into a badly-built site.
 */
function applyLoginFields(
  draft: DraftRecord,
  details: Record<string, unknown>,
  counts: Counters
): void {
  for (const raw of readArray(details, 'loginFields')) {
    if (!isRecord(raw)) continue;
    const value = readString(raw, 'value');
    if (value.trim() === '') continue;

    const designation = readString(raw, 'designation');
    if (designation === 'username' && draft.username === '') {
      draft.username = value;
      continue;
    }
    if (designation === 'password' && draft.password === '') {
      draft.password = value;
      continue;
    }

    const label = firstNonEmpty(readString(raw, 'name'), readString(raw, 'id'), 'Form field');
    // The field type comes from the input 1Password saw. A `P` is a password box, whatever the
    // input happened to be called, so it is trusted over the label heuristic.
    const type = LOGIN_FIELD_TYPES[readString(raw, 'fieldType')];
    counts.addCustom(draft, label, value, type ?? guessCustomFieldType(label, value));
  }
}

/**
 * Every typed field of every section — the part the CSV throws away entirely.
 *
 * Section titles are kept as a label prefix. 1Password users organise a Server item into
 * "Admin Console" and "Hosting Provider" sections, and flattening those to a list of bare
 * labels loses which credential belongs to which service — information the export had.
 */
function applySections(
  draft: DraftRecord,
  details: Record<string, unknown>,
  counts: Counters
): void {
  for (const rawSection of readArray(details, 'sections')) {
    if (!isRecord(rawSection)) continue;
    const sectionTitle = readString(rawSection, 'title').trim();

    for (const rawField of readArray(rawSection, 'fields')) {
      if (!isRecord(rawField)) continue;

      const bare = firstNonEmpty(
        readString(rawField, 'title'),
        readString(rawField, 'id'),
        'Field'
      );
      const label = sectionTitle === '' ? bare : `${sectionTitle}: ${bare}`;
      const read = readTypedValue(rawField.value);

      if (read.kind === 'file') {
        counts.fileFields += 1;
        continue;
      }
      if (read.kind === 'reference') {
        // A link to another 1Password item. There is no value in it to carry, and the id it
        // points at means nothing outside 1Password.
        counts.references += 1;
        continue;
      }
      if (read.text.trim() === '') continue;

      if (read.kind === 'unknown') counts.unknownKinds.add(read.valueKey);
      counts.addCustom(
        draft,
        label,
        read.text,
        read.type ?? guessCustomFieldType(label, read.text)
      );
    }
  }
}

/** A Document item's attached file. Counted, never imported — see the header note. */
function applyDocument(
  draft: DraftRecord,
  details: Record<string, unknown>,
  counts: Counters
): void {
  const attributes = details.documentAttributes;
  if (!isRecord(attributes)) return;
  counts.documents += 1;

  // The filename is metadata the user chose and is genuinely useful in the record — "which
  // file was attached to this?" is otherwise unanswerable after the import.
  const fileName = readString(attributes, 'fileName');
  counts.addCustom(draft, 'Attached file (not imported)', fileName, 'text');
}

// ── Typed values ─────────────────────────────────────────────────────────────

interface TypedValue {
  readonly text: string;
  /** `null` means "let the label heuristic decide"; anything else is authoritative. */
  readonly type: CustomFieldType | null;
  readonly kind: string;
  /** The JSON key the value arrived under, for the unknown-kind warning. Never the value. */
  readonly valueKey: string;
}

const EMPTY_VALUE: TypedValue = { text: '', type: null, kind: 'empty', valueKey: '' };

/**
 * Reads one `{ <kind>: <value> }` wrapper.
 *
 * 1Password encodes a field's type as the **single key** of its value object, which is a much
 * better signal than anything derivable from the label — and the reason this parser can be
 * confident about secrets where a CSV importer can only guess.
 *
 * The secret kinds get secret types deliberately, on the same reasoning as
 * `bitwarden-json.ts`'s `CARD_TYPES`: a card number is exactly as sensitive as a password,
 * and a value typed `text` is a value the renderer receives (decision D13). Guessing secret
 * for something harmless costs one click to reveal; guessing harmless for a secret is a leak.
 */
function readTypedValue(value: unknown): TypedValue {
  if (!isRecord(value)) return EMPTY_VALUE;

  const [valueKey] = Object.keys(value);
  if (valueKey === undefined) return EMPTY_VALUE;
  const inner: unknown = value[valueKey];

  const typed = (text: string, type: CustomFieldType | null): TypedValue => ({
    text,
    type,
    kind: valueKey,
    valueKey,
  });

  switch (valueKey) {
    case 'concealed':
      return typed(asText(inner), 'password');
    case 'creditCardNumber':
      return typed(asText(inner), 'password');
    case 'totp':
      return typed(asText(inner), 'otp-secret');
    case 'email':
      // Newer exports wrap this as `{ email: { email_address, provider } }`.
      return typed(isRecord(inner) ? readString(inner, 'email_address') : asText(inner), 'email');
    case 'url':
      return typed(asText(inner), 'url');
    case 'phone':
      return typed(asText(inner), 'phone');
    case 'date':
      return typed(formatUnixDate(inner), 'date');
    case 'monthYear':
      return typed(formatMonthYear(inner), 'date');
    case 'address':
      return typed(formatAddress(inner), 'address');
    case 'sshKey':
      return typed(isRecord(inner) ? readString(inner, 'privateKey') : asText(inner), 'password');
    case 'file':
      return { text: '', type: null, kind: 'file', valueKey };
    case 'reference':
      return { text: '', type: null, kind: 'reference', valueKey };
    case 'string':
    case 'menu':
    case 'gender':
    case 'creditCardType':
      return typed(asText(inner), null);
    default:
      // A kind 1Password added since this was written. Keeping the value and reporting the
      // *kind* — never the value — is what stops a schema change from silently deleting data.
      return { text: asText(inner), type: null, kind: 'unknown', valueKey };
  }
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return '';
}

/** 1Password stores dates as Unix seconds. Rendered as a plain ISO date, no time zone claim. */
function formatUnixDate(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return asText(value);
  const millis = value * 1000;
  if (!Number.isSafeInteger(millis)) return '';
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

/** An expiry, stored as the integer `YYYYMM` — 202601 is January 2026. */
function formatMonthYear(value: unknown): string {
  if (typeof value !== 'number' || !Number.isInteger(value)) return asText(value);
  const year = Math.floor(value / 100);
  const month = value % 100;
  if (year < 1000 || year > 9999 || month < 1 || month > 12) return String(value);
  return `${year}-${String(month).padStart(2, '0')}`;
}

const ADDRESS_PARTS = ['street', 'city', 'state', 'zip', 'country'] as const;

function formatAddress(value: unknown): string {
  if (!isRecord(value)) return asText(value);
  return ADDRESS_PARTS.map((part) => readString(value, part).trim())
    .filter((part) => part !== '')
    .join(', ');
}

// ── Accounts, vaults, folders ────────────────────────────────────────────────

interface Account {
  readonly name: string;
  readonly raw: Record<string, unknown>;
}

function readAccounts(root: Record<string, unknown>): readonly Account[] {
  const accounts: Account[] = [];
  for (const raw of readArray(root, 'accounts')) {
    if (!isRecord(raw)) continue;
    const attrs = isRecord(raw.attrs) ? raw.attrs : {};
    accounts.push({
      name: firstNonEmpty(readString(attrs, 'name'), readString(attrs, 'accountName'), ''),
      raw,
    });
  }
  if (accounts.length > 0) return accounts;

  // Inferred, not documented: an export shaped `{ vaults: [...] }` with no account wrapper.
  // Accepting it costs nothing and means a hand-assembled or older file still imports.
  return Array.isArray(root.vaults) ? [{ name: '', raw: root }] : [];
}

/**
 * A 1Password vault becomes a Keyhold folder.
 *
 * The account name is prefixed **only** when the export holds more than one account. With a
 * single account it is pure noise — every record would sit under "Ada Lovelace/Personal" — and
 * with two it is the only thing separating one "Personal" from the other.
 */
function vaultFolderPath(
  accountName: string,
  vault: Record<string, unknown>,
  prefixAccount: boolean
): string | null {
  const attrs = isRecord(vault.attrs) ? vault.attrs : {};
  const vaultName = readString(attrs, 'name').trim();
  if (vaultName === '') return null;
  const path =
    prefixAccount && accountName.trim() !== '' ? `${accountName}/${vaultName}` : vaultName;
  return normaliseFolderPath(path);
}

// ── Whole-file counters ──────────────────────────────────────────────────────

/**
 * Everything reported once for the file rather than once per item.
 *
 * A 3,000-item export with attachments would otherwise produce 3,000 identical warnings, which
 * is indistinguishable from none: nobody reads that list, so the loss it describes goes
 * unnoticed. `WarningLog` makes the same argument about columns; this is the item-shaped half.
 */
class Counters {
  trashed = 0;
  archived = 0;
  withHistory = 0;
  documents = 0;
  fileFields = 0;
  references = 0;
  attachmentEntries = 0;
  clippedFields = 0;
  clippedTags = 0;
  readonly unknownKinds = new Set<string>();
  readonly categories = new Map<string, number>();

  countCategory(categoryUuid: string): void {
    const name = CATEGORY_NAMES[categoryUuid] ?? 'an unrecognised category';
    this.categories.set(name, (this.categories.get(name) ?? 0) + 1);
  }

  /**
   * Adds a custom field, stopping at the model's ceiling.
   *
   * `assertValidCredential` refuses a record with more than `MAX_CUSTOM_FIELDS`, and it throws
   * — so without this cap a single pathological item would fail the **entire** commit rather
   * than arrive slightly reduced. A 1PUX is the one format that can realistically produce two
   * hundred fields on one item, because sections nest and every one of them is carried.
   */
  addCustom(draft: DraftRecord, label: string, value: string, type: CustomFieldType): void {
    if (draft.custom.length >= MAX_CUSTOM_FIELDS) {
      this.clippedFields += 1;
      return;
    }
    addCustom(draft, label, value, type);
  }

  report(log: WarningLog): void {
    if (this.trashed > 0) {
      log.add(
        'skipped-row',
        `${this.trashed} item(s) are in 1Password’s Trash and were not imported.`
      );
    }
    if (this.archived > 0) {
      // Same reasoning as the CSV parser: an archived item is one the user has already decided
      // they are done with, and reviving it into the active list is a mess they clean up by hand.
      log.add(
        'skipped-row',
        `${this.archived} item(s) are archived in 1Password and were skipped.`
      );
    }
    for (const [name, count] of this.categories) {
      log.add(
        'unsupported-item',
        `${count} ${name} item(s). Keyhold stores logins, so their fields were kept as custom fields rather than as a typed ${name}.`
      );
    }
    const attachments = Math.max(this.attachmentEntries, this.documents + this.fileFields);
    if (attachments > 0) {
      log.add(
        'dropped-value',
        `${attachments} attached file(s) are in the archive. Keyhold’s import cannot carry attachment contents yet, so the items came across without them — keep the .1pux until you have re-attached anything you need.`
      );
    }
    if (this.references > 0) {
      log.add(
        'dropped-value',
        `${this.references} field(s) link to another 1Password item rather than holding a value, so there was nothing to import.`
      );
    }
    if (this.withHistory > 0) {
      log.add(
        'dropped-value',
        `${this.withHistory} item(s) carry a 1Password password history. Imported records start with a fresh history.`
      );
    }
    if (this.clippedFields > 0) {
      log.add(
        'dropped-value',
        `${this.clippedFields} custom field(s) were past the ${MAX_CUSTOM_FIELDS}-field limit for one record and were not imported.`
      );
    }
    if (this.clippedTags > 0) {
      log.add(
        'dropped-value',
        `${this.clippedTags} tag(s) were past the ${MAX_TAGS}-tag limit for one record and were not imported.`
      );
    }
    for (const kind of this.unknownKinds) {
      log.add(
        'format',
        `This export contains a "${kind}" field type that Keyhold does not recognise. Its values were imported as plain text.`
      );
    }
  }
}

// ── Bytes, and the pipeline's missing half ───────────────────────────────────

/**
 * The string→bytes adapter, and an honest error when it cannot work.
 *
 * `ImportParser.parse` takes a `string`. That is the right contract for the eleven text
 * formats and it cannot express a binary one, so this parser's real entry point is
 * {@link parseOnePassword1pux} and this is the bridge.
 *
 * **The bridge only works if the string preserved every byte.** `latin1` maps bytes 0–255 to
 * code points 0–255 one for one, so a string produced by decoding the archive as `latin1`
 * round-trips exactly. A string produced by decoding it as **UTF-8** does not: every invalid
 * sequence — and a compressed stream is full of them — collapses to U+FFFD, irreversibly.
 *
 * `decodeSourceText` in `import-service/source-store.ts` decodes as UTF-8 today, so a `.1pux`
 * routed through the wizard as it stands arrives already destroyed. Rather than failing with
 * a confusing "corrupt archive", the replacement character is detected and named: it can only
 * come from a lossy decode, because `latin1` has no invalid bytes to replace. Registering this
 * parser therefore needs a byte path through the source store first.
 */
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

function bytesOf(content: string): Uint8Array {
  if (content.includes(REPLACEMENT_CHARACTER)) {
    throw new VaultError(
      'MALFORMED',
      'This .1pux archive could not be read: it is a compressed binary file, and its contents were altered by text decoding before reaching the importer. Keyhold needs to read a .1pux as raw bytes.'
    );
  }
  const bytes = new Uint8Array(Buffer.from(content, 'latin1'));
  if (!looksLikeZip(bytes)) {
    throw new VaultError(
      'MALFORMED',
      'This file is not a 1Password .1pux archive — a .1pux is a ZIP archive and this one does not begin like one.'
    );
  }
  return bytes;
}

// ── Reading untrusted JSON ───────────────────────────────────────────────────

/**
 * Every reader below is total, on the same reasoning as `bitwarden-json.ts`: a missing key, a
 * null, or a number where a string belongs yields an empty value rather than an exception.
 * The input is a file another program wrote and possibly an attacker edited — a parser that
 * throws on an unexpected shape is a parser that refuses a real export because 1Password
 * added a null somewhere.
 */
function parseJsonObject(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    throw new VaultError(
      'MALFORMED',
      `The ${ONE_PUX_DATA_ENTRY} entry inside this archive is not valid JSON, so the export could not be read.`,
      { cause }
    );
  }
  if (!isRecord(parsed)) {
    throw new VaultError(
      'MALFORMED',
      `The ${ONE_PUX_DATA_ENTRY} entry inside this archive is not a 1Password export — its top level is not an object.`
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

function firstNonEmpty(...candidates: readonly string[]): string {
  return candidates.find((candidate) => candidate.trim() !== '') ?? '';
}
