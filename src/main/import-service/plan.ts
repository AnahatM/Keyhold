// SPDX-License-Identifier: GPL-3.0-or-later
import type { Credential } from '@shared/model/credential.js';
import {
  countNewRecords,
  groupImportDuplicates,
  previewRecord,
  type ImportDuplicateExisting,
  type ImportDuplicateGroup,
  type ImportFolderPlan,
  type ImportPlanId,
  type ImportPreview,
  type ImportRecordPreview,
  type ImportSourceId,
} from '@shared/model/import-plan.js';
import { folderAncestors, importFolderPath, type ColumnMapping } from '@shared/model/import.js';
import type { VaultDocument } from '@shared/model/vault-document.js';
import { createGenericCsvParser, findParser, type ImportParser } from '../import/index.js';
import { findFolderByPath } from '../organisation/folder-tree.js';
import type { NewCredentialInput } from '../vault/credential-ops.js';
import { mappingRequired, unknownFormat, unreadableFile } from './errors.js';
import { planMerge, PREVIEW_MERGE_CONTEXT } from './merge.js';

/**
 * One parse of one file, held.
 *
 * ## The preview and the commit are the same parse
 *
 * This is the property the whole wizard rests on, and it is worth being precise about how it
 * is achieved, because there is a plausible-looking design that fails it. The plausible one
 * re-parses at commit time from the file the renderer names: it is simpler, it holds less
 * memory, and it is wrong, because between the two parses the file can change on disk, the
 * mapping can be edited, and a format can be re-detected — so the records committed are not
 * the records approved. A dry run that can disagree with the run is decoration.
 *
 * So a preview parses **once**, keeps the output here under a minted {@link ImportPlanId},
 * and the commit re-uses this object. `ImportCommitRequest` carries no records, no mapping
 * and no format precisely so that there is nothing the renderer could hand over that would
 * describe different data — it can only point at a parse this process already performed and
 * is still holding.
 *
 * `secretRecords` is the parse itself: passwords, notes, security answers and TOTP seeds.
 * `projections` is `previewRecord` run over it — the same function the renderer's own guard
 * test drives — and is the only half that is ever allowed to cross the bridge.
 */
export interface HeldImportPlan {
  readonly planId: ImportPlanId;
  readonly sourceId: ImportSourceId;
  readonly formatId: string;
  /** The parse, secrets and all. Never leaves this process, never enters a log. */
  readonly secretRecords: readonly NewCredentialInput[];
  readonly projections: readonly ImportRecordPreview[];
  readonly duplicates: readonly ImportDuplicateGroup[];
  /** Every folder path the parse needs, ancestors included. */
  readonly folderPaths: readonly string[];
  /** Exactly what was sent to the renderer, so a commit can be checked against it. */
  readonly preview: ImportPreview;
}

/**
 * A ceiling on the on-screen sample, independent of what the caller asks for.
 *
 * `IMPORT_SAMPLE_SIZE` is the number the wizard uses; this is the number that stops a
 * malformed or hostile request from asking for forty thousand projections on every keystroke
 * of the mapping screen.
 */
export const MAX_IMPORT_SAMPLE_SIZE = 200;

export type PlanProgress = (completed: number, total: number) => void;

export interface BuildPlanInput {
  readonly planId: ImportPlanId;
  readonly sourceId: ImportSourceId;
  readonly formatId: string;
  /** The decoded file. Held for the duration of this call and not beyond it. */
  readonly secretText: string;
  readonly mapping?: ColumnMapping | undefined;
  readonly sampleSize: number;
  readonly document: VaultDocument;
  readonly onMatchProgress?: PlanProgress | undefined;
}

export function buildImportPlan(input: BuildPlanInput): HeldImportPlan {
  const parser = resolveParser(input.formatId, input.mapping);

  let parsed;
  try {
    parsed = parser.parse(input.secretText);
  } catch {
    // The parser's own contract says it throws only when the file is not this format at all.
    // The cause is swallowed rather than wrapped because a parse failure's message is built
    // from the bytes it choked on — see `unreadableFile`.
    throw unreadableFile(parser.name);
  }

  const secretRecords = parsed.records;
  const projections = secretRecords.map((record, index) => previewRecord(record, index));
  input.onMatchProgress?.(0, projections.length);

  const existingById = new Map<string, Credential>();
  const existing: ImportDuplicateExisting[] = [];
  for (const record of input.document.records) {
    // Trashed records are not match candidates. A record the user deleted must not silently
    // swallow the incoming copy of itself — they would get neither the old one back nor the
    // new one, and the import would report a skip for a record they cannot see anywhere.
    if (record.trashedAt !== null) continue;
    existingById.set(record.id, record);
    existing.push(toDuplicateExisting(record));
  }

  const duplicates = groupImportDuplicates(projections, existing, (match, group) => {
    const target = existingById.get(match.credentialId);
    if (target === undefined) return [];
    return planMerge(target, incomingFor(secretRecords, group), PREVIEW_MERGE_CONTEXT).fields;
  });
  input.onMatchProgress?.(projections.length, projections.length);

  const folderPaths = collectFolderPaths(parsed.folders, projections);

  const preview: ImportPreview = {
    planId: input.planId,
    sourceId: input.sourceId,
    formatId: input.formatId,
    recordCount: projections.length,
    newRecordCount: countNewRecords(projections, duplicates),
    sample: projections.slice(0, clampSampleSize(input.sampleSize)),
    warnings: parsed.warnings,
    folders: planFolders(input.document, folderPaths, projections),
    duplicates,
  };

  return {
    planId: input.planId,
    sourceId: input.sourceId,
    formatId: input.formatId,
    secretRecords,
    projections,
    duplicates,
    folderPaths,
    preview,
  };
}

/**
 * The parsed records behind a group's projections.
 *
 * `ImportRecordPreview.index` is documented as the stable handle for a record across preview
 * calls, and this is the one place that spends it — turning the renderer-safe half of a
 * record back into the half with the password in it, on the main process's side of the
 * bridge and nowhere else.
 */
export function incomingFor(
  secretRecords: readonly NewCredentialInput[],
  group: readonly ImportRecordPreview[]
): readonly NewCredentialInput[] {
  const records: NewCredentialInput[] = [];
  for (const projection of group) {
    const record = secretRecords[projection.index];
    if (record !== undefined) records.push(record);
  }
  return records;
}

function resolveParser(formatId: string, mapping: ColumnMapping | undefined): ImportParser {
  const parser = findParser(formatId);
  if (parser === null) throw unknownFormat();
  if (!parser.needsMapping) return parser;

  // The catch-all reads whatever the user pointed at whatever field, so without a mapping it
  // has no behaviour at all — refusing is the honest answer, not parsing with an empty one
  // and reporting that every column was dropped.
  if (mapping === undefined) throw mappingRequired();
  return createGenericCsvParser(mapping);
}

function clampSampleSize(requested: number): number {
  if (!Number.isInteger(requested) || requested <= 0) return 0;
  return Math.min(requested, MAX_IMPORT_SAMPLE_SIZE);
}

/** The vault side of a match. Exactly the fields `ImportDuplicateExisting` declares. */
export function toDuplicateExisting(record: Credential): ImportDuplicateExisting {
  return {
    credentialId: record.id,
    title: record.title,
    username: record.fields.username,
    email: record.fields.email,
    urls: [...record.fields.urls],
    hasPassword: record.fields.password !== '',
    passwordLength: record.fields.password.length,
    updatedAt: record.meta.updatedAt,
  };
}

/**
 * Every folder path this import touches, ancestors included, parents before children.
 *
 * Derived from the parse's own list **and** from the records' placeholders rather than
 * trusting either alone. `ImportResult.folders` is documented as complete and the parsers
 * make it so, but this is the stage that creates real folders in somebody's vault on the
 * strength of it — recomputing the union costs one pass and removes the possibility that a
 * twelfth parser added later files records under a path nothing asked to be created.
 *
 * A plain lexicographic sort is what puts parents before children: a path is a prefix of its
 * own descendants, and a prefix sorts first.
 */
export function collectFolderPaths(
  declared: readonly string[],
  projections: readonly ImportRecordPreview[]
): readonly string[] {
  const paths = new Set<string>();
  const add = (path: string | null): void => {
    if (path === null || path === '') return;
    for (const ancestor of folderAncestors(path)) paths.add(ancestor);
  };

  for (const path of declared) add(path);
  for (const projection of projections) add(projection.folderPath);

  return [...paths].sort();
}

/** The dry run's folder list: what exists, what would be created, and how full each is. */
export function planFolders(
  document: VaultDocument,
  paths: readonly string[],
  projections: readonly ImportRecordPreview[]
): readonly ImportFolderPlan[] {
  const counts = new Map<string, number>();
  for (const projection of projections) {
    const path = projection.folderPath;
    if (path === null) continue;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }

  return paths.map((path) => ({
    path,
    willCreate: findFolderByPath(document.folders, path) === null,
    // The records filed *at* this path, not in its subtree. A parent folder created only to
    // hold `Work/Clients` genuinely holds no records, and saying it holds nine would make
    // the count useless for the thing a user reads it for.
    recordCount: counts.get(path) ?? 0,
  }));
}

/** The placeholder path a parsed record carries, or `null` when it is filed nowhere. */
export function placeholderPathOf(record: NewCredentialInput): string | null {
  const folderId = record.folderId ?? null;
  return folderId === null ? null : importFolderPath(folderId);
}
