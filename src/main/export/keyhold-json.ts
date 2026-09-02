// SPDX-License-Identifier: GPL-3.0-or-later
import { HEALTH_RULE_IDS } from '@shared/model/health.js';
import { DEFAULT_VAULT_HEALTH_SETTINGS } from '@shared/model/vault-document.js';
import { AUDIT_PRIVACY_LEVELS, type Credential } from '@shared/model/credential.js';
import type { ExportFormatId } from '@shared/model/export.js';
import {
  VAULT_DOCUMENT_VERSION,
  type Folder,
  type Tag,
  type VaultDocument,
  type VaultSettings,
} from '@shared/model/vault-document.js';
import { malformed } from '../crypto/errors.js';
import { stripBom } from '../import/csv.js';
import {
  requireArray,
  requireBoolean,
  requireMember,
  requireNullableNumber,
  requireNullableString,
  requireNumber,
  requireObject,
  requireString,
} from './json-shape.js';
import { parseRecord, serialiseRecord } from './record-json.js';
import { reportSelectionLosses, selectRecords, type ExportSelection } from './select.js';
import { LossLog, plaintextExport, type PlaintextExport } from './types.js';

/**
 * The Keyhold JSON export: everything, in a form anyone can read.
 *
 * This is the format that makes the data genuinely portable, and the only one that loses
 * nothing about a record — every field, every custom field with its type and its hidden
 * flag, every security question, every version of the history with the device and network it
 * came from. A CSV cannot carry a timeline; this can, and a user's audit trail is theirs.
 *
 * ## Guarantees
 *
 *  - **Round trip.** `parseKeyholdJson(serialiseKeyholdJson(document, { includeTrashed: true }))`
 *    yields a document deep-equal to the original. That is a test, not a hope.
 *  - **Determinism.** The same document and the same `now` produce byte-identical output.
 *    Every object is written key by key in a fixed order and nothing reads a clock it was
 *    not handed.
 *  - **Readability.** Two-space indentation, by default. This is the file a user opens to
 *    check what they are about to hand over, and a 40,000-character single line answers that
 *    question with "trust me". The size cost of the whitespace buys the one property that
 *    makes a plaintext export defensible: you can see exactly what is in it.
 *
 * ## What it does not carry
 *
 * **Attachment bytes.** A `VaultDocument` holds attachment *metadata*; the file contents live
 * in the KEEP container's chunks and never reach this function. The metadata is exported so
 * the loss is visible and a re-import knows what is missing, and the omission is reported as
 * a loss rather than left for the user to discover. The encrypted export carries the chunks.
 */

const FORMAT: ExportFormatId = 'keyhold-json';
const EXTENSION = '.json';

/** Written into the file and checked on the way back in. Independent of the KEEP format version. */
export const KEYHOLD_JSON_FORMAT = 'keyhold-export';
export const KEYHOLD_JSON_VERSION = 1;

export interface KeyholdJsonOptions extends ExportSelection {
  /** The timestamp stamped into the envelope. A parameter, so this function has no clock. */
  readonly now: number;
  /** Indent the output. Defaults to `true`. */
  readonly pretty?: boolean | undefined;
}

export interface KeyholdJsonDocument {
  readonly document: VaultDocument;
  /** When the export was written, as its author claimed. Metadata, not part of the vault. */
  readonly exportedAt: number;
  readonly formatVersion: number;
}

// ── Writing ──────────────────────────────────────────────────────────────────

export function exportKeyholdJson(
  document: VaultDocument,
  options: KeyholdJsonOptions
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

  const withAttachments = selected.records.filter((record) => record.attachments.length > 0).length;
  if (withAttachments > 0) {
    losses.add(
      'dropped',
      'attachment contents',
      `Attachment files are not carried by a JSON export — their names and sizes are, so you can see what is missing. Use an encrypted export to move the files themselves.`,
      withAttachments
    );
  }

  const text = serialiseEnvelope(document, selected.records, folders, options);

  return plaintextExport({
    format: FORMAT,
    extension: EXTENSION,
    secretBytes: new Uint8Array(Buffer.from(text, 'utf8')),
    recordCount: selected.records.length,
    losses: losses.all,
  });
}

/** The text form, for the encrypted export to seal and for the determinism test to compare. */
export function serialiseKeyholdJson(document: VaultDocument, options: KeyholdJsonOptions): string {
  const selected = selectRecords(document, options);
  return serialiseEnvelope(
    document,
    selected.records,
    folderScope(document, selected.records, options),
    options
  );
}

/**
 * The envelope's key order is fixed and explicit, for the same reason the KEEP header's is:
 * a reordering — a refactor, a spread, a different JSON implementation — would silently
 * change the bytes of every export, and determinism is not a property you can test for once
 * and then leave to luck.
 *
 * `documentVersion`, `settings`, `folders`, `tags` and `records` sit at the top level rather
 * than under an `export` key deliberately: that makes the envelope a **superset of a vault
 * body**, so the encrypted export's payload is something `parseVaultDocument` can open
 * directly. One payload shape, two readers, no conversion step between them.
 */
function serialiseEnvelope(
  document: VaultDocument,
  records: readonly Credential[],
  folders: readonly Folder[],
  options: KeyholdJsonOptions
): string {
  const envelope = {
    format: KEYHOLD_JSON_FORMAT,
    formatVersion: KEYHOLD_JSON_VERSION,
    exportedAt: options.now,
    documentVersion: document.documentVersion,
    settings: serialiseSettings(document.settings),
    folders: folders.map(serialiseFolder),
    tags: tagScope(document, records, options).map(serialiseTag),
    records: records.map(serialiseRecord),
  };

  return JSON.stringify(envelope, null, (options.pretty ?? true) ? 2 : undefined);
}

function serialiseSettings(settings: VaultSettings): Record<string, unknown> {
  return {
    historyEnabledByDefault: settings.historyEnabledByDefault,
    historyMaxVersions: settings.historyMaxVersions,
    auditPrivacyLevel: settings.auditPrivacyLevel,
    passwordAgeWarningDays: settings.passwordAgeWarningDays,
    trashRetentionDays: settings.trashRetentionDays,
    // Written key-by-key like everything else in this file, and in `HEALTH_RULE_IDS` order,
    // so the output is deterministic and a rule added to the engine cannot silently start
    // or stop being exported depending on object insertion order.
    health: {
      enabledRules: Object.fromEntries(
        HEALTH_RULE_IDS.map((rule) => [rule, settings.health.enabledRules[rule]])
      ),
      weakEntropyBits: settings.health.weakEntropyBits,
      expiringWithinDays: settings.health.expiringWithinDays,
    },
  };
}

function serialiseFolder(folder: Folder): Record<string, unknown> {
  return { id: folder.id, name: folder.name, parentId: folder.parentId, order: folder.order };
}

function serialiseTag(tag: Tag): Record<string, unknown> {
  return { id: tag.id, name: tag.name, colour: tag.colour };
}

// ── Scoping folders and tags to a subset ─────────────────────────────────────

/**
 * Which folders travel with the export.
 *
 * A **whole-vault** export keeps every folder, including empty ones: it is the archival
 * format, and an empty folder someone made on purpose is part of their vault.
 *
 * A **subset** export — one that named `recordIds`, which is what a parcel handed to another
 * person is — keeps only the folders its records live in, plus their ancestors. Shipping the
 * whole folder tree with a three-record parcel would disclose the shape and the names of a
 * vault the recipient was never given, which is a privacy leak dressed as completeness.
 */
function folderScope(
  document: VaultDocument,
  records: readonly Credential[],
  selection: ExportSelection
): readonly Folder[] {
  if (selection.recordIds === undefined) return document.folders;

  const byId = new Map(document.folders.map((folder) => [folder.id, folder]));
  const keep = new Set<string>();

  for (const record of records) {
    let current = record.folderId;
    // Bounded by the folder count: a corrupt parent chain that loops would otherwise spin
    // here forever, and this runs on data that may have come from a file.
    for (let step = 0; current !== null && step <= byId.size; step += 1) {
      if (keep.has(current)) break;
      const folder = byId.get(current);
      if (folder === undefined) break;
      keep.add(folder.id);
      current = folder.parentId;
    }
  }

  return document.folders.filter((folder) => keep.has(folder.id));
}

/** The same rule for tags, matched by name because that is what a record stores. */
function tagScope(
  document: VaultDocument,
  records: readonly Credential[],
  selection: ExportSelection
): readonly Tag[] {
  if (selection.recordIds === undefined) return document.tags;

  const used = new Set<string>();
  for (const record of records) {
    for (const tag of record.tags) used.add(tag.toLowerCase());
  }
  return document.tags.filter((tag) => used.has(tag.name.toLowerCase()));
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * Parses an export back into a vault document.
 *
 * Treats the file as hostile: a `.json` export can be handed to a user by anyone, and unlike
 * the vault body it has never been through an AEAD before it is parsed. Every field is
 * checked; nothing is trusted to be the shape the type declaration claims.
 */
export function parseKeyholdJson(source: string | Uint8Array): KeyholdJsonDocument {
  // `stripBom` comes from the CSV reader because a BOM is a BOM: an editor that saved this
  // file on Windows may well have added one, and `JSON.parse` refuses a leading BOM outright.
  // Two copies of "does this start with U+FEFF" is exactly the duplicate rule 8 forbids.
  const text = stripBom(typeof source === 'string' ? source : Buffer.from(source).toString('utf8'));

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw malformed('the export is not valid JSON');
  }

  const envelope = requireObject(raw, 'the export');

  const format = requireString(envelope.format, 'format');
  if (format !== KEYHOLD_JSON_FORMAT) {
    throw malformed(`"format" is "${format}", not a Keyhold export`);
  }

  const formatVersion = requireNumber(envelope.formatVersion, 'formatVersion');
  if (formatVersion > KEYHOLD_JSON_VERSION) {
    throw malformed(
      `the export uses format version ${formatVersion}, newer than the supported ${KEYHOLD_JSON_VERSION}`
    );
  }

  const documentVersion = requireNumber(envelope.documentVersion, 'documentVersion');
  if (documentVersion > VAULT_DOCUMENT_VERSION) {
    throw malformed(
      `the export uses document version ${documentVersion}, newer than the supported ${VAULT_DOCUMENT_VERSION}`
    );
  }

  return {
    exportedAt: requireNumber(envelope.exportedAt, 'exportedAt'),
    formatVersion,
    document: {
      documentVersion,
      settings: parseSettings(envelope.settings),
      folders: requireArray(envelope.folders, 'folders').map((item, index) =>
        parseFolder(item, `folders[${index}]`)
      ),
      tags: requireArray(envelope.tags, 'tags').map((item, index) =>
        parseTag(item, `tags[${index}]`)
      ),
      records: requireArray(envelope.records, 'records').map((item, index) =>
        parseRecord(item, `records[${index}]`)
      ),
    },
  };
}

function parseHealthSettings(raw: unknown): VaultSettings['health'] {
  // Absent means "written before this field existed", which is a real and expected file.
  // Present-but-wrong means a hand-edited or corrupt one, and is refused by the readers
  // below rather than repaired into something plausible.
  if (raw === undefined) return DEFAULT_VAULT_HEALTH_SETTINGS;

  const source = requireObject(raw, 'settings.health');
  const rules = requireObject(source.enabledRules, 'settings.health.enabledRules');
  return {
    enabledRules: Object.fromEntries(
      HEALTH_RULE_IDS.map((rule) => [
        rule,
        rules[rule] === undefined
          ? DEFAULT_VAULT_HEALTH_SETTINGS.enabledRules[rule]
          : requireBoolean(rules[rule], `settings.health.enabledRules.${rule}`),
      ])
    ) as VaultSettings['health']['enabledRules'],
    weakEntropyBits: requireNumber(source.weakEntropyBits, 'settings.health.weakEntropyBits'),
    expiringWithinDays: requireNumber(source.expiringWithinDays, 'settings.health.expiringWithinDays'),
  };
}

function parseSettings(raw: unknown): VaultSettings {
  const source = requireObject(raw, 'settings');
  return {
    health: parseHealthSettings(source.health),
    historyEnabledByDefault: requireBoolean(
      source.historyEnabledByDefault,
      'settings.historyEnabledByDefault'
    ),
    historyMaxVersions: requireNullableNumber(
      source.historyMaxVersions,
      'settings.historyMaxVersions'
    ),
    auditPrivacyLevel: requireMember(
      source.auditPrivacyLevel,
      'settings.auditPrivacyLevel',
      AUDIT_PRIVACY_LEVELS
    ),
    passwordAgeWarningDays: requireNumber(
      source.passwordAgeWarningDays,
      'settings.passwordAgeWarningDays'
    ),
    trashRetentionDays: requireNullableNumber(
      source.trashRetentionDays,
      'settings.trashRetentionDays'
    ),
  };
}

function parseFolder(raw: unknown, path: string): Folder {
  const source = requireObject(raw, path);
  return {
    id: requireString(source.id, `${path}.id`),
    name: requireString(source.name, `${path}.name`),
    parentId: requireNullableString(source.parentId, `${path}.parentId`),
    order: requireNumber(source.order, `${path}.order`),
  };
}

function parseTag(raw: unknown, path: string): Tag {
  const source = requireObject(raw, path);
  return {
    id: requireString(source.id, `${path}.id`),
    name: requireString(source.name, `${path}.name`),
    colour: requireString(source.colour, `${path}.colour`),
  };
}
