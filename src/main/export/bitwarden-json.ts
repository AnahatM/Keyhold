// SPDX-License-Identifier: GPL-3.0-or-later
import {
  isCustomFieldValueSecret,
  type Credential,
  type CustomField,
} from '@shared/model/credential.js';
import type { ExportFormatId } from '@shared/model/export.js';
import type { Folder, VaultDocument } from '@shared/model/vault-document.js';
import { folderPathOf, isoOrEmpty } from './flat.js';
import { reportSelectionLosses, selectRecords, type ExportSelection } from './select.js';
import { LossLog, plaintextExport, type PlaintextExport } from './types.js';

/**
 * Bitwarden's **unencrypted** JSON export, written by Keyhold.
 *
 * The other direction of `src/main/import/bitwarden-json.ts`, and it exists for the same
 * reason the compatible CSV does: **a password manager you cannot leave is a trap.** Keyhold
 * can already read this format; being able to write it is what makes "I want my vault in
 * Bitwarden instead" a file the other product accepts on the first try, with the field types,
 * the folder tree and the multiple URIs that the CSV path flattens away.
 *
 * ## The encrypted variants are out of scope, deliberately
 *
 * Bitwarden also has an account-encrypted and a password-protected JSON export. Neither is
 * produced here. Writing one means implementing Bitwarden's KDF profile, their cipher-string
 * format and their key-derivation chain — somebody else's crypto, re-implemented inside a
 * password manager, which is what hard rule 3 forbids and what the *importer* already refuses
 * to read for exactly the same reasons. A user who wants a sealed file has `keyhold-parcel`,
 * which is sealed with crypto this project owns and tests. So this format is plaintext, full
 * stop, and it carries `PLAINTEXT_EXPORT_WARNING` like every other readable export — through
 * `plaintextExport`, so a caller cannot reach the bytes without also holding the warning.
 *
 * ## Guarantees
 *
 *  - **The importer accepts it.** `bitwarden-json.test.ts` exports a document and parses the
 *    result with the real `bitwardenJsonParser`, then asserts the records survived. That is
 *    the strongest test available here: it fails if either side drifts.
 *  - **Determinism.** Nothing in this file reads a clock — there is no `now` option, because
 *    Bitwarden's envelope has no export timestamp to stamp. The same document produces
 *    byte-identical output, and every object is written key by key in Bitwarden's own order.
 *  - **Readability.** Two-space indentation by default, for the same reason as the Keyhold
 *    JSON: this is the file a user opens to check what they are about to hand over.
 *
 * ## What Keyhold holds that Bitwarden has no field for — the dropped set
 *
 * A silent loss on the way out is how somebody discovers their notes are gone *after* they
 * have deleted the vault. So the complete list lives here, and every entry is also reported
 * through `LossLog` so it reaches the user rather than only the reader of this file:
 *
 *  - **Attachments.** Bitwarden's unencrypted export carries no attachments — not the bytes,
 *    not even the metadata. Names, sizes and hashes are all lost. Use an encrypted parcel.
 *  - **History, except the passwords.** Old passwords do have a home (`passwordHistory`) and
 *    are written there. Everything else about the timeline is not: version numbers, which
 *    fields changed, the previous titles/URLs/tags/custom fields/security answers, the
 *    per-record history switch and retention cap — and, most of all, the **device and network
 *    origin** of every change, which is Keyhold's headline differentiator and has no
 *    counterpart in any other manager's export.
 *  - **`meta.createdOrigin`.** Same reason, for the record's own creation.
 *  - **Usage and password age.** `lastUsedAt`, `useCount` and `passwordUpdatedAt`. Only
 *    `creationDate` and `revisionDate` have Bitwarden fields.
 *  - **The chosen icon.** Bitwarden derives an item's icon from its URI; a letter or emoji
 *    icon the user picked has nowhere to go.
 *  - **Record and custom-field identity.** The ids are written, but every importer — Keyhold's
 *    own included — mints fresh ones, so re-importing creates new records rather than
 *    updating existing ones.
 *  - **Trash state.** See `deletedDate` below.
 *  - **Tag colours**, and **every vault setting**: history retention, the audit privacy level,
 *    trash retention, the health thresholds, the attachment caps, the breach-check settings.
 *    A Bitwarden export is a list of items and folders and nothing else.
 *
 * And what survives only by being *flattened* into a custom field, which is a different and
 * lesser loss — the data is in the file, but not as its own structure: the email when the
 * record also has a username, the security questions, the tags, the expiry date and the
 * rotation interval.
 *
 * ## Three mappings worth knowing about
 *
 *  - **`login.username` takes the username, or the email when there is no username.** Keyhold
 *    keeps the two apart and Bitwarden has one field. Same rule as the compatible CSV's
 *    `login_username` column — and it is written out twice, once there and once here, which is
 *    a rule-8 duplicate that wants lifting into `flat.ts` the next time somebody may edit it.
 *  - **`login.totp` takes the first `otp-secret` custom field.** Keyhold has no first-class
 *    TOTP field; hoisting the seed into the field Bitwarden expects is the difference between
 *    two-factor codes working after the move and re-enrolling every account by hand.
 *  - **`deletedDate` is always `null`, even for a record exported out of the Trash.** Writing
 *    the real timestamp would be more faithful to the format and worse for the user: every
 *    importer that understands the field — including Keyhold's — *skips* an item that carries
 *    one, so a deliberate "include trashed records" would produce a file whose extra records
 *    silently never arrive. They are written as ordinary items instead, and the fact that they
 *    will arrive un-deleted is reported as a loss.
 */

/**
 * This format's id.
 *
 * The double assertion is the one deliberate lie in this file, and it is temporary:
 * `'bitwarden-json'` is not in `EXPORT_FORMAT_IDS` yet because registering it means editing
 * `@shared/model/export.ts` and `formats.ts`, the shared registry, which is owned elsewhere.
 * Once the id is registered this becomes a plain `const FORMAT: ExportFormatId` and the
 * assertion can go. Nothing else in this file depends on the difference.
 */
export const BITWARDEN_JSON_EXPORT_ID = 'bitwarden-json';
const FORMAT = BITWARDEN_JSON_EXPORT_ID as unknown as ExportFormatId;
const EXTENSION = '.json';

/**
 * Bitwarden's own discriminators, mirroring the private constants in the importer.
 *
 * Two copies of a small closed set is exactly what rule 8 dislikes, and the honest fix is one
 * shared module the parser and the writer both read. That module would have to live beside the
 * parser, which is not this file's to edit — so the duplication is recorded here rather than
 * left for someone to find. Only the values used are declared: an exporter that never writes a
 * card, an identity, a secure note or a linked field has no business naming them.
 */
const ITEM_LOGIN = 1;
const FIELD_TEXT = 0;
const FIELD_HIDDEN = 1;
const FIELD_BOOLEAN = 2;

/** Bitwarden's "ask for the master password again" flag. Keyhold has no equivalent. */
const NO_REPROMPT = 0;

export interface BitwardenJsonOptions extends ExportSelection {
  /** Indent the output. Defaults to `true`. */
  readonly pretty?: boolean | undefined;
}

// ── Writing ──────────────────────────────────────────────────────────────────

export function exportBitwardenJson(
  document: VaultDocument,
  options: BitwardenJsonOptions = {}
): PlaintextExport {
  const selected = selectRecords(document, options);
  const losses = new LossLog();
  reportSelectionLosses(selected, losses);

  const folders = folderScope(document, selected.records, options);
  if (folders.length < document.folders.length) {
    losses.add(
      'dropped',
      'folders',
      `${document.folders.length - folders.length} folder(s) hold none of the selected records and were left out.`
    );
  }

  const text = serialiseEnvelope(document, selected.records, folders, options);

  reportFormatLosses(document, selected.records, losses);
  losses.flush();

  return plaintextExport({
    format: FORMAT,
    extension: EXTENSION,
    secretBytes: new Uint8Array(Buffer.from(text, 'utf8')),
    recordCount: selected.records.length,
    losses: losses.all,
  });
}

/** The text form, for the tests to parse back and for the determinism assertion to compare. */
export function serialiseBitwardenJson(
  document: VaultDocument,
  options: BitwardenJsonOptions = {}
): string {
  const selected = selectRecords(document, options);
  return serialiseEnvelope(
    document,
    selected.records,
    folderScope(document, selected.records, options),
    options
  );
}

/**
 * The envelope, in Bitwarden's own key order.
 *
 * `encrypted: false` is not decoration. Keyhold's own parser — and Bitwarden's — reads that
 * key to decide whether the file is one of the encrypted variants, and its `detect` needs
 * either `encrypted` or `folders` present alongside `items` before it will offer this format
 * for a file. A file written without it is a file the round trip cannot open.
 */
function serialiseEnvelope(
  document: VaultDocument,
  records: readonly Credential[],
  folders: readonly Folder[],
  options: BitwardenJsonOptions
): string {
  const envelope = {
    encrypted: false,
    folders: folders.map((folder) => serialiseFolder(document, folder)),
    items: records.map((record) => serialiseItem(record)),
  };

  return JSON.stringify(envelope, null, (options.pretty ?? true) ? 2 : undefined);
}

/**
 * A folder, as Bitwarden's flat list of `/`-joined names.
 *
 * Bitwarden has no folder *tree*: nesting is spelled out in the name, which is why the
 * importer runs every one of these through `normaliseFolderPath`. `folderPathOf` produces
 * exactly that shape, walking the real tree — so a Keyhold folder called `Mail` under
 * `Personal` is written once, as `Personal/Mail`.
 *
 * The Keyhold id travels as the Bitwarden id. It is not a UUID and Bitwarden mints its own on
 * import; what it has to be is *stable within this file*, so `items[].folderId` resolves.
 */
function serialiseFolder(document: VaultDocument, folder: Folder): Record<string, unknown> {
  return { id: folder.id, name: folderPathOf(document.folders, folder.id) };
}

/**
 * One item, key by key in the order Bitwarden's own export writes them.
 *
 * Key by key rather than by spreading, for the same reason the Keyhold JSON does it: a field
 * added to the record model has to be written in here deliberately — and classified as carried,
 * flattened or dropped — rather than riding along unnoticed or, worse, vanishing unreported.
 */
function serialiseItem(record: Credential): Record<string, unknown> {
  const totp = totpField(record);

  return {
    passwordHistory: passwordHistoryOf(record),
    revisionDate: isoOrEmpty(record.meta.updatedAt),
    creationDate: isoOrEmpty(record.meta.createdAt),
    // Always null, even out of the Trash. See the note at the top of this file.
    deletedDate: null,
    id: record.id,
    organizationId: null,
    folderId: record.folderId,
    // Every Keyhold record is a login today, so this is a constant rather than a lie waiting
    // to be told. A future record type needs its own mapping here, not a default.
    type: ITEM_LOGIN,
    reprompt: NO_REPROMPT,
    name: record.title,
    notes: orNull(record.fields.notes),
    favorite: record.favorite,
    fields: fieldsOf(record, totp),
    login: {
      // Written empty rather than omitted: Bitwarden writes the key, and a passkey cannot be
      // exported out of the store that holds it by anyone, us included.
      fido2Credentials: [],
      uris: record.fields.urls.map((uri) => ({ match: null, uri })),
      username: orNull(loginUsername(record)),
      password: orNull(record.fields.password),
      totp: totp === undefined ? null : totp.value,
    },
    collectionIds: null,
  };
}

/** The username field: the username, or the email when there is no username. */
function loginUsername(record: Credential): string {
  return record.fields.username === '' ? record.fields.email : record.fields.username;
}

/** The first one-time-password seed on the record, which `login.totp` takes. */
function totpField(record: Credential): CustomField | undefined {
  return record.fields.custom.find((field) => field.type === 'otp-secret');
}

/** Bitwarden writes an absent string as `null`, and its reader treats the two alike. */
function orNull(value: string): string | null {
  return value === '' ? null : value;
}

/**
 * Everything that becomes a Bitwarden custom field, in a fixed order.
 *
 * The order matches the compatible CSV's packed cell — identity, then the record's own custom
 * fields, then its security questions, then its classification and dates — so a user who
 * exports both formats sees the same fields in the same sequence rather than wondering which
 * one reordered them.
 */
function fieldsOf(record: Credential, totp: CustomField | undefined): Record<string, unknown>[] {
  const fields: Record<string, unknown>[] = [];

  // Only when it is not already the username — otherwise every imported record grows a
  // redundant "Email" field saying what `login.username` already says.
  if (hasSeparateEmail(record)) fields.push(field('Email', record.fields.email, FIELD_TEXT));

  for (const custom of record.fields.custom) {
    if (custom.id === totp?.id) continue;
    fields.push(field(custom.label, custom.value, bitwardenFieldType(custom)));
  }

  // Hidden, always. A security answer is a credential in every sense — `SecurityQuestion` in
  // the model says so — and a hidden Bitwarden field is the only thing in this format that
  // carries "this value is secret" across, which is what makes the answer come back as a
  // secret custom field rather than as plain text sitting in a projection.
  for (const question of record.fields.securityQuestions) {
    fields.push(field(question.question, question.answer, FIELD_HIDDEN));
  }

  if (record.tags.length > 0) fields.push(field('Tags', record.tags.join(', '), FIELD_TEXT));
  if (record.meta.expiresAt !== null) {
    fields.push(field('Expires', isoOrEmpty(record.meta.expiresAt), FIELD_TEXT));
  }
  if (record.meta.rotationIntervalDays !== null) {
    fields.push(
      field('Rotation interval (days)', String(record.meta.rotationIntervalDays), FIELD_TEXT)
    );
  }

  return fields;
}

function field(name: string, value: string, type: number): Record<string, unknown> {
  return { name, value, type, linkedId: null };
}

function hasSeparateEmail(record: Credential): boolean {
  return record.fields.email !== '' && record.fields.email !== loginUsername(record);
}

/**
 * Keyhold's thirteen custom-field types, collapsed onto Bitwarden's three writable ones.
 *
 * **Secrecy is preserved; precision is not.** `isCustomFieldValueSecret` is the model's single
 * definition of "this value is secret material" (decision D13), and anything it calls secret —
 * a password, a PIN, an OTP seed, or any field the user hid by hand — is written as a *hidden*
 * field. Re-deriving that here from a list of type names would be a second definition of the
 * secret boundary, and the copies would disagree the first time a type was added.
 *
 * A boolean stays boolean only when its value is one Bitwarden would render as a checkbox;
 * anything else is text, because a Bitwarden boolean field holding `"maybe"` is a field its own
 * UI cannot display. Everything else — email, url, phone, date, number, address, multiline —
 * lands on plain text, which is a real loss of the *type* and is reported as one.
 */
function bitwardenFieldType(custom: CustomField): number {
  if (isCustomFieldValueSecret(custom)) return FIELD_HIDDEN;
  if (custom.type === 'boolean' && /^(true|false)$/i.test(custom.value.trim())) {
    return FIELD_BOOLEAN;
  }
  return FIELD_TEXT;
}

/**
 * The old passwords, as Bitwarden's `passwordHistory`.
 *
 * This is the one part of Keyhold's timeline that has a real home in this format, so it is
 * written rather than dropped: a user leaving with three years of rotated passwords keeps
 * them. Only versions whose snapshot actually carries a password qualify — Keyhold's history
 * is a backward delta, so a version that changed only a title has no password to contribute.
 *
 * Newest first, which is the order Bitwarden writes and shows. Keyhold stores versions oldest
 * first, so the array is reversed rather than sorted: the stored order is already
 * `versionNumber`-ascending and contiguous, and sorting on `savedAt` would reorder two edits
 * made in the same millisecond differently on different runs, which would break determinism.
 *
 * `null` rather than `[]` when there is nothing, because that is what Bitwarden writes for an
 * item that has never had its password changed.
 */
function passwordHistoryOf(record: Credential): Record<string, unknown>[] | null {
  const entries: Record<string, unknown>[] = [];

  for (const version of record.history.versions) {
    const previous = version.snapshot.password;
    if (previous === undefined) continue;
    // `lastUsedDate` is Bitwarden's name for "when this password stopped being the current
    // one", which is exactly what `savedAt` records on a backward delta.
    entries.unshift({ lastUsedDate: isoOrEmpty(version.savedAt), password: previous });
  }

  return entries.length === 0 ? null : entries;
}

// ── Scoping folders to a subset ──────────────────────────────────────────────

/**
 * Which folders travel with the export.
 *
 * A **whole-vault** export keeps every folder, including empty ones — Bitwarden's own export
 * does, and an empty folder someone made on purpose is part of their vault.
 *
 * A **subset** export keeps only the folders its records point at. No ancestor walk, unlike
 * the Keyhold JSON's version of this: Bitwarden's folder names are complete paths, so
 * `Personal/Mail` stands on its own and needs no `Personal` entry beside it. Shipping the rest
 * of the tree with a three-record parcel would disclose the shape and the names of a vault the
 * recipient was never given.
 */
function folderScope(
  document: VaultDocument,
  records: readonly Credential[],
  selection: ExportSelection
): readonly Folder[] {
  if (selection.recordIds === undefined) return document.folders;

  const used = new Set(records.map((record) => record.folderId));
  return document.folders.filter((folder) => used.has(folder.id));
}

// ── Loss accounting ──────────────────────────────────────────────────────────

/**
 * Everything the dropped set at the top of this file promises to report, reported.
 *
 * Per-record losses are counted and collapsed into one line each by `LossLog`, because a
 * 3,000-record vault that says "history was not carried" 3,000 times has said nothing.
 */
function reportFormatLosses(
  document: VaultDocument,
  records: readonly Credential[],
  losses: LossLog
): void {
  for (const record of records) {
    if (record.attachments.length > 0) {
      losses.countRecord(
        'dropped',
        'attachments',
        (count) =>
          `Attached files were not carried on ${count} record(s) — not even their names. A Bitwarden JSON export holds no attachments at all. Use an encrypted parcel to move them.`
      );
    }
    if (record.history.versions.length > 0) {
      losses.countRecord(
        'dropped',
        'history',
        (count) =>
          `Old passwords on ${count} record(s) were carried as Bitwarden’s password history. The rest of the timeline was not: which other fields changed, their previous values, and the device and network each change came from. Export to Keyhold JSON to keep those.`
      );
    }
    if (record.icon.kind !== 'auto') {
      losses.countRecord(
        'dropped',
        'icon',
        (count) =>
          `A chosen icon was not carried on ${count} record(s). Bitwarden derives an item’s icon from its address.`
      );
    }
    if (record.fields.custom.length > 0) {
      losses.countRecord(
        'flattened',
        'custom field type',
        (count) =>
          `Custom fields on ${count} record(s) kept their labels, values and whether they are hidden, but not their exact type — Bitwarden has text, hidden and boolean, where Keyhold has thirteen.`
      );
    }
    if (hasSeparateEmail(record)) {
      losses.countRecord(
        'flattened',
        'email',
        (count) =>
          `${count} record(s) have both a username and an email. This format has one field for the two, so the email travels as a custom field named “Email”.`
      );
    }
    if (record.fields.securityQuestions.length > 0) {
      losses.countRecord(
        'flattened',
        'security questions',
        (count) =>
          `Security questions on ${count} record(s) travel as hidden custom fields, one per question. The answers are all there, and still marked secret; they are no longer marked as security answers.`
      );
    }
    if (record.tags.length > 0) {
      losses.countRecord(
        'flattened',
        'tags',
        (count) =>
          `Bitwarden has no tags, so the tags on ${count} record(s) travel as a custom field named “Tags”.`
      );
    }
    if (record.meta.expiresAt !== null || record.meta.rotationIntervalDays !== null) {
      losses.countRecord(
        'flattened',
        'expiry',
        (count) =>
          `The expiry date and rotation interval on ${count} record(s) travel as custom fields. Nothing will act on them after the move.`
      );
    }
    if (record.trashedAt !== null) {
      losses.countRecord(
        'dropped',
        'trash state',
        (count) =>
          `${count} exported record(s) are in the Trash. They are written as ordinary items — an item marked deleted is skipped by every importer, this one included — so they will arrive un-deleted.`
      );
    }
  }

  if (records.length > 0) {
    losses.add(
      'dropped',
      'record identity',
      'Record ids are written but not honoured: importing this file anywhere, Keyhold included, creates new records rather than updating the existing ones.',
      records.length
    );
    losses.add(
      'dropped',
      'dates',
      'Created and last-changed dates are carried. How often a record was used, when it was last used, and when its password last changed have no Bitwarden field and were not.',
      records.length
    );
  }

  losses.add(
    'dropped',
    'vault settings',
    'Vault settings — history retention, the audit privacy level, trash retention, the health thresholds — are not part of a Bitwarden export and were not carried.'
  );

  if (document.tags.length > 0) {
    losses.add(
      'dropped',
      'tag colours',
      'Tag names are carried inside a custom field; the colour assigned to each tag is not.',
      document.tags.length
    );
  }
}
