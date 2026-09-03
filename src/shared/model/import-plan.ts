// SPDX-License-Identifier: GPL-3.0-or-later
import { isCustomFieldValueSecret, type CustomFieldType } from './credential.js';
import { importFolderPath, type ColumnMapping, type ImportFormatDescriptor } from './import.js';
import type { ImportWarning } from './import.js';
import type { IpcResult } from '../ipc/api.js';

/**
 * The **import plan** — the contract between the import wizard and whatever runs the parsers.
 *
 * `import.ts` next door owns the parser vocabulary (warnings, column targets, folder
 * placeholders). This file owns the *transaction*: how a file is chosen, previewed,
 * deduplicated, committed and undone, and precisely how little of a file full of plaintext
 * credentials is allowed to reach the renderer while that happens.
 *
 * Like `import.ts`, it lives in `@shared` because both sides need every shape here, so it
 * must compile in a browser: types, constants and pure functions only, and **no Node
 * import, ever**.
 *
 * ## The four rules this file exists to enforce
 *
 * **1. A preview cannot commit.** `preview` is a pure read that writes nothing and mints an
 * {@link ImportPlanId}; `commit` accepts *only* a plan id plus the user's duplicate
 * decisions. There is no shape the renderer can hand to `commit` that describes data — it
 * can only point at a parse the main process already performed and is still holding. So the
 * commit is, by construction, the same records the user was shown.
 *
 * **2. The preview runs the commit's code.** Parsers are pure functions from a string to
 * records (`src/main/import/types.ts`), and the preview is that output *projected*, not
 * recomputed. The renderer is given no material with which to compute a different answer —
 * see {@link previewRecord}, which is the single definition of that projection and is used
 * by the main process to build the preview, not reimplemented on either side.
 *
 * **3. No secret crosses that does not need to.** {@link ImportRecordPreview} carries
 * exactly what `CredentialProjection` carries: titles, usernames, emails, urls, folders,
 * tags, and *facts about* secrets (`hasPassword`, `passwordLength`) rather than the secrets.
 * An imported password never reaches the renderer at any point in the wizard, and neither do
 * notes, security answers, TOTP seeds or hidden custom values. This is decision D13 applied
 * to the one screen where the temptation to break it is strongest.
 *
 * **4. Nothing is hidden.** Every warning the engine produced crosses intact, and warnings
 * never quote a value — that invariant is the parsers' (`src/main/import/warnings.test.ts`)
 * and this layer must not weaken it by adding a "sample of the offending row".
 *
 * ## Channel names live here, and are folded into `CHANNELS`
 *
 * Rule 8 says one list. {@link IMPORT_CHANNELS} is the canonical spelling of the import
 * channels, declared beside the payloads they carry; `src/shared/ipc/api.ts` spreads it into
 * `CHANNELS` (`...IMPORT_CHANNELS`) so there is still exactly one list at every point of
 * use, and `ALL_CHANNELS` picks them up for the allow-list automatically.
 */

// ── Opaque handles ───────────────────────────────────────────────────────────

/**
 * A file the user chose, held by the main process.
 *
 * The renderer never sees the path or the bytes — only this token. A path in the renderer
 * would be an attacker-controlled string if the renderer were ever compromised (the same
 * reasoning as `session.chooseVaultToOpen`), and the bytes are a file full of plaintext
 * passwords.
 */
export type ImportSourceId = string;

/**
 * One parse of one source under one format and mapping.
 *
 * Minted by `preview`, consumed by `commit`. It is the entire reason a preview cannot turn
 * into a commit by accident: committing requires a token that only a completed preview
 * produces.
 */
export type ImportPlanId = string;

/** One committed import, for the undo that follows it. */
export type ImportBatchId = string;

// ── Choosing a file ──────────────────────────────────────────────────────────

/**
 * What the renderer learns when the user picks a file.
 *
 * The **basename only**. The wizard has no use for the directory, and a full path is the
 * kind of thing that ends up in a screenshot attached to a bug report — so it is not sent,
 * rather than sent and carefully not rendered.
 */
export interface ImportSource {
  readonly sourceId: ImportSourceId;
  readonly fileName: string;
  /** Lower-case, with the leading dot. `''` when the name has no extension. */
  readonly extension: string;
  readonly sizeBytes: number;
  /**
   * The registry's suggestion, or `null` when nothing claimed the file.
   *
   * A suggestion, never a decision: two products ship the same columns, and a renamed file
   * carries no evidence at all. The wizard shows this pre-selected and lets the user change
   * it — see `detectFormat` in `src/main/import/index.ts`.
   */
  readonly detectedFormatId: string | null;
  /** Every format that claimed the file, best first. Drives the "did you mean…" list. */
  readonly candidateFormatIds: readonly string[];
  /** The header row as written, for the mapping UI to label its rows with. `[]` for JSON. */
  readonly columns: readonly string[];
  /** The registry's guessed mapping, pre-filling the dropdowns. `null` when not columnar. */
  readonly inferredMapping: ColumnMapping | null;
}

// ── Previewing ───────────────────────────────────────────────────────────────

export interface ImportPreviewRequest {
  readonly sourceId: ImportSourceId;
  readonly formatId: string;
  /** Required for a format whose descriptor says `needsMapping`; ignored for the rest. */
  readonly mapping?: ColumnMapping;
  /**
   * How many mapped records to send back as the on-screen sample.
   *
   * A cap rather than "all of them" because the sample is shown while the user is still
   * editing dropdowns: a 40,000-row export would otherwise ship 40,000 projections over IPC
   * on every keystroke, and the user reads five rows.
   */
  readonly sampleSize: number;
}

/** How many rows the mapping step shows. One number, read by the UI and by the request. */
export const IMPORT_SAMPLE_SIZE = 5;

/**
 * The dry run.
 *
 * Everything the wizard needs to tell the user what *would* happen, and nothing it needs to
 * make it happen — that is `commit`'s job, and it takes only {@link planId}.
 */
export interface ImportPreview {
  readonly planId: ImportPlanId;
  readonly sourceId: ImportSourceId;
  readonly formatId: string;
  /** Every record the parse produced, duplicates included. */
  readonly recordCount: number;
  /** Records matching nothing in the vault and nothing earlier in the file. */
  readonly newRecordCount: number;
  /** The first {@link ImportPreviewRequest.sampleSize} records, as they will be mapped. */
  readonly sample: readonly ImportRecordPreview[];
  /** Every warning, ungrouped and unabridged. The wizard groups them; it never truncates. */
  readonly warnings: readonly ImportWarning[];
  readonly folders: readonly ImportFolderPlan[];
  readonly duplicates: readonly ImportDuplicateGroup[];
}

export interface ImportFolderPlan {
  /** `/`-separated, ancestors listed separately, parents before children. */
  readonly path: string;
  /** False when the vault already has a folder at this path, so nothing is created. */
  readonly willCreate: boolean;
  readonly recordCount: number;
}

// ── The safe projection of a parsed record ───────────────────────────────────

/**
 * A custom field as the wizard sees it: label, type, and the value only when it is not
 * secret. Mirrors `CustomFieldProjection` field for field, deliberately.
 */
export interface ImportCustomFieldPreview {
  readonly label: string;
  readonly type: CustomFieldType;
  /** Absent when the value is secret. Never `null` for "empty" — read `hasValue`. */
  readonly value?: string;
  readonly hasValue: boolean;
  readonly isSecret: boolean;
}

/**
 * One parsed record, as the renderer is allowed to see it.
 *
 * **This is the safe projection for import, and it is a security boundary.** The file being
 * previewed is a plaintext dump of somebody's entire password vault; if any of it is going
 * to leak, it leaks here. So the shape is the same shape `CredentialProjection` uses — the
 * facts that let a table be rendered, and nothing an attacker could use.
 */
export interface ImportRecordPreview {
  /** Position in the parse, 0-based. The stable handle for a record across preview calls. */
  readonly index: number;
  readonly title: string;
  readonly username: string;
  readonly email: string;
  readonly urls: readonly string[];
  readonly tags: readonly string[];
  /** The folder this record will land in, resolved from its `import-folder:` placeholder. */
  readonly folderPath: string | null;
  readonly favorite: boolean;
  readonly hasPassword: boolean;
  /** So a mask renders at the right width. Not the password. */
  readonly passwordLength: number;
  readonly hasNotes: boolean;
  readonly notesLength: number;
  readonly custom: readonly ImportCustomFieldPreview[];
}

/**
 * Compile-time check that no secret core field was ever added to the preview.
 *
 * The property test in the renderer catches a secret that *flows* here; this catches one
 * that is merely *declared* here, which is the change a reviewer is most likely to wave
 * through — `notes?: string` looks harmless next to `title: string`.
 */
type _NoSecretsInRecordPreview =
  Extract<keyof ImportRecordPreview, 'password' | 'notes' | 'securityQuestions'> extends never
    ? true
    : ['A secret field was added to ImportRecordPreview — it must never cross to the renderer'];
export const _noSecretsInRecordPreview: _NoSecretsInRecordPreview = true;

/**
 * The parser output this module projects from.
 *
 * Declared structurally rather than importing `NewCredentialInput`, because that type lives
 * in `src/main/vault/credential-ops.ts` and `@shared` must not reach into the main process.
 * `NewCredentialInput` is assignable to it, so the main process passes parser output
 * straight in and the two cannot drift without a type error.
 */
export interface ParsedCustomFieldLike {
  readonly label: string;
  readonly type: CustomFieldType;
  readonly value: string;
  readonly hidden: boolean;
}

export interface ParsedRecordLike {
  readonly title: string;
  readonly username?: string | undefined;
  readonly email?: string | undefined;
  readonly password?: string | undefined;
  readonly urls?: readonly string[] | undefined;
  readonly notes?: string | undefined;
  readonly custom?: readonly ParsedCustomFieldLike[] | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly folderId?: string | null | undefined;
  readonly favorite?: boolean | undefined;
}

/**
 * **The** projection from a parsed record to what the renderer may hold.
 *
 * One function, called by the main process while building a preview, so there is no second
 * definition of "what the import wizard is allowed to see" — and so the renderer's own guard
 * test can push real passwords through the real projection rather than through a
 * reimplementation of it that might be more careful than the original.
 *
 * Secret custom values are decided by `isCustomFieldValueSecret`, which is the codebase's
 * single definition of a secret custom field. Restating "password, pin and otp-secret are
 * secret" here would be the second list that eventually disagrees.
 */
export function previewRecord(record: ParsedRecordLike, index: number): ImportRecordPreview {
  const password = record.password ?? '';
  const notes = record.notes ?? '';
  const folderId = record.folderId ?? null;

  return {
    index,
    title: record.title,
    username: record.username ?? '',
    email: record.email ?? '',
    urls: [...(record.urls ?? [])],
    tags: [...(record.tags ?? [])],
    folderPath: folderId === null ? null : importFolderPath(folderId),
    favorite: record.favorite ?? false,
    hasPassword: password !== '',
    passwordLength: password.length,
    hasNotes: notes !== '',
    notesLength: notes.length,
    custom: (record.custom ?? []).map(previewCustomField),
  };
}

export function previewCustomField(field: ParsedCustomFieldLike): ImportCustomFieldPreview {
  const isSecret = isCustomFieldValueSecret(field);
  return {
    label: field.label,
    type: field.type,
    // Spread rather than `value: isSecret ? undefined : field.value`, because
    // `exactOptionalPropertyTypes` makes the explicit `undefined` unassignable — and
    // because an absent key cannot be read by accident, where a present `undefined` can.
    ...(isSecret ? {} : { value: field.value }),
    hasValue: field.value !== '',
    isSecret,
  };
}

// ── Deduplication ────────────────────────────────────────────────────────────

/**
 * The fields the match rule reads. **All three are non-secret**, which is what lets the
 * rule be stated here, run in the main process, and tested from the renderer.
 */
export interface ImportMatchable {
  readonly title: string;
  readonly username?: string | undefined;
  readonly email?: string | undefined;
  readonly urls?: readonly string[] | undefined;
}

/**
 * Normalised title: trimmed, case-folded, internal whitespace collapsed.
 *
 * Case and spacing are exactly the things that differ between "Google" and "google " in two
 * exports of the same account, and neither difference means the accounts are different.
 */
export function importMatchTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The login identity: the username, or the email when there is no username.
 *
 * Username first because that is what the source actually stored; the parsers mirror an
 * email-shaped username into `email` as well (see `finishDraft`), so preferring `email`
 * would silently collapse two different accounts whose usernames merely happen to share a
 * mailbox.
 *
 * Known limit, stated rather than hidden: a vault record with username `alice` and email
 * `alice@x.com` will not match an imported record whose only identifier is `alice@x.com`.
 * Those become two records, which is the *safe* failure — the user sees an extra row and
 * can merge it, rather than losing one silently to a false match.
 */
export function importMatchIdentity(record: ImportMatchable): string {
  const username = (record.username ?? '').trim().toLowerCase();
  if (username !== '') return username;
  return (record.email ?? '').trim().toLowerCase();
}

/**
 * The host a URL points at, `www.` stripped — the match rule's third component.
 *
 * Behaviourally identical to `hostOf` in `src/main/import/mapping.ts`, and that function
 * should be re-pointed at this one so there is a single definition (rule 8). It is stated
 * here because the *matcher* is shared code and the main-process copy is unreachable from
 * `@shared`.
 */
export function importMatchHost(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === '') return null;

  // `android://<signing-hash>@com.example.app`, as Chrome and Bitwarden emit for app logins.
  // The package name is the identity; the hash is a certificate digest and varies by build,
  // so matching on the whole string would make every app login unique to its exporter.
  const android = /^android:\/\/[^@]*@(.+)$/i.exec(trimmed);
  if (android?.[1] !== undefined) return android[1].toLowerCase();

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const host = new URL(withScheme).hostname;
    return host === '' ? null : host.replace(/^www\./i, '');
  } catch {
    return null;
  }
}

/** The first URL that yields a host, or `''`. Order is the source's order — first is primary. */
export function importMatchSite(record: ImportMatchable): string {
  for (const url of record.urls ?? []) {
    const host = importMatchHost(url);
    if (host !== null) return host;
  }
  return '';
}

/**
 * **The match rule: title + login identity + host.**
 *
 * Why all three, and why not fewer:
 *
 * - *Title alone* over-matches badly. Five Google accounts are five records all titled
 *   "Google"; collapsing them would delete four accounts' worth of the user's data on an
 *   import they were told was safe.
 * - *Identity alone* over-matches worse. One email address is the login for forty sites.
 * - *Host alone* over-matches for the same reason as title: a household with three accounts
 *   on one site has three records.
 * - Any *pair* still fails one of the above: title+host misses nothing but merges the five
 *   Google accounts; identity+host merges a personal and a work login that share a mailbox.
 *
 * The triple is the smallest key that gets the case the wizard exists for exactly right —
 * **importing the same file twice must not produce two of everything** — while leaving
 * genuinely distinct accounts distinct. It reads only fields the user can see on screen,
 * which is what makes a duplicate group explainable rather than magic.
 *
 * A record with no identity and no host degrades to a title-only key. That is deliberate:
 * re-importing a file of title-and-password rows must still be caught, and the cost of a
 * false positive is bounded because the default action is `skip` and every group is listed
 * for the user to override.
 */
export function importMatchKey(record: ImportMatchable): string {
  // JSON rather than a joined string with a separator character. A separator has to be a
  // character no component can contain, and there is no such character in a *title* — a
  // user can and does put anything in one. JSON escapes the ambiguity away, and the key
  // stays printable, so a duplicate group is legible in a log or a bug report.
  return JSON.stringify([
    importMatchTitle(record.title),
    importMatchIdentity(record),
    importMatchSite(record),
  ]);
}

/** The three components of a key, for rendering "matched on…" without re-deriving them. */
export interface ImportMatchParts {
  readonly title: string;
  readonly identity: string;
  readonly host: string;
}

export function importMatchParts(record: ImportMatchable): ImportMatchParts {
  return {
    title: importMatchTitle(record.title),
    identity: importMatchIdentity(record),
    host: importMatchSite(record),
  };
}

// ── What to do about a duplicate ─────────────────────────────────────────────

/**
 * The three answers, and no fourth.
 *
 * `skip` is the default because it is the only one that cannot go wrong: it changes nothing
 * in the vault and adds nothing to it, and the records it passed over are named in the
 * result so the user can re-run with a different answer. `import-anyway` costs clutter;
 * `merge` can overwrite a current password with a stale one out of an old export, which is
 * the single most expensive mistake this screen can make.
 */
export const IMPORT_DUPLICATE_ACTIONS = ['skip', 'import-anyway', 'merge'] as const;
export type ImportDuplicateAction = (typeof IMPORT_DUPLICATE_ACTIONS)[number];

/** The safe answer, applied to any group the user did not touch. */
export const DEFAULT_DUPLICATE_ACTION: ImportDuplicateAction = 'skip';

/** Fields a merge can touch. Values never cross — only which field, and what would happen. */
export const IMPORT_MERGEABLE_FIELDS = [
  'password',
  'username',
  'email',
  'urls',
  'notes',
  'tags',
  'folder',
  'custom',
] as const;
export type ImportMergeableField = (typeof IMPORT_MERGEABLE_FIELDS)[number];

/**
 * What a merge would do to one field.
 *
 * `replaces` is the dangerous one and is the reason this exists: a user choosing "merge"
 * must be able to see, before committing, that it would replace a password they are
 * currently using with one out of a file of unknown age.
 */
export const IMPORT_MERGE_EFFECTS = ['fills-empty', 'replaces', 'adds', 'unchanged'] as const;
export type ImportMergeEffect = (typeof IMPORT_MERGE_EFFECTS)[number];

export interface ImportMergeField {
  readonly field: ImportMergeableField;
  readonly effect: ImportMergeEffect;
}

/** The existing vault record a group matched, as the renderer already holds it. */
export interface ImportDuplicateExisting {
  readonly credentialId: string;
  readonly title: string;
  readonly username: string;
  readonly email: string;
  readonly urls: readonly string[];
  readonly hasPassword: boolean;
  readonly passwordLength: number;
  readonly updatedAt: number;
}

/**
 * One cluster of records that the match rule considers the same account.
 *
 * `existing === null` means the cluster is entirely within the file — two rows of the same
 * export. Those are grouped too, because an export with a duplicated row imports two copies
 * on a vault that had none, and "importing twice must not double" has to hold for the file
 * as well as for the vault.
 */
export interface ImportDuplicateGroup {
  /** The match key. Also the id used in {@link ImportCommitRequest.duplicateActions}. */
  readonly key: string;
  readonly matchedOn: ImportMatchParts;
  readonly existing: ImportDuplicateExisting | null;
  /** Indices into the parse, in file order. At least one; at least two when `existing` is null. */
  readonly incoming: readonly ImportRecordPreview[];
  /** Only meaningful for `merge`; empty when nothing would change. */
  readonly mergeableFields: readonly ImportMergeField[];
}

/**
 * Builds the duplicate groups for a preview.
 *
 * Pure, and it reads only the projections — which is possible precisely because the match
 * rule is made of non-secret fields. That has three consequences worth the design:
 *
 * - The main process calls this rather than writing its own pass, so there is one grouping,
 *   not one for the preview and another for the commit.
 * - The renderer's tests can drive the real grouping without an Electron process.
 * - A user asking "why are these two the same record?" gets an answer built from three things
 *   they can see on screen.
 *
 * `mergeFields` is a callback because merge effects need the incoming *password* to say
 * whether a merge would replace one, and a password is the one thing this layer must not
 * hold. The main process supplies it; the renderer passes nothing and gets empty lists.
 */
export function groupImportDuplicates(
  incoming: readonly ImportRecordPreview[],
  existing: readonly ImportDuplicateExisting[],
  mergeFields: (
    existingRecord: ImportDuplicateExisting,
    group: readonly ImportRecordPreview[]
  ) => readonly ImportMergeField[] = () => []
): readonly ImportDuplicateGroup[] {
  const existingByKey = new Map<string, ImportDuplicateExisting>();
  for (const record of existing) {
    const key = importMatchKey(record);
    // First writer wins. A vault that already contains two records the rule considers
    // identical is a pre-existing condition, not something an import should try to fix.
    if (!existingByKey.has(key)) existingByKey.set(key, record);
  }

  // Insertion order is file order, which is what makes the emitted groups stable and the
  // "first row wins" rule in the within-file case mean the row the user would expect.
  const clusters = new Map<string, ImportRecordPreview[]>();
  for (const record of incoming) {
    const key = importMatchKey(record);
    const cluster = clusters.get(key);
    if (cluster === undefined) clusters.set(key, [record]);
    else cluster.push(record);
  }

  const groups: ImportDuplicateGroup[] = [];
  for (const [key, cluster] of clusters) {
    const match = existingByKey.get(key) ?? null;
    // A single row matching nothing is simply a new record, and listing it as a "group of
    // one" would bury the real duplicates in a list of everything.
    if (match === null && cluster.length < 2) continue;
    const first = cluster[0];
    if (first === undefined) continue;
    groups.push({
      key,
      matchedOn: importMatchParts(first),
      existing: match,
      incoming: cluster,
      mergeableFields: match === null ? [] : mergeFields(match, cluster),
    });
  }
  return groups;
}

/** Records that match nothing in the vault and nothing earlier in the file. */
export function countNewRecords(
  incoming: readonly ImportRecordPreview[],
  groups: readonly ImportDuplicateGroup[]
): number {
  const grouped = new Set<number>();
  for (const group of groups) {
    for (const record of group.incoming) grouped.add(record.index);
  }
  return incoming.filter((record) => !grouped.has(record.index)).length;
}

// ── Committing ───────────────────────────────────────────────────────────────

/**
 * The commit.
 *
 * Note what is *not* here: no records, no mapping, no format, no file. A commit points at a
 * plan the main process built and is still holding, and adds only the decisions the user
 * made on screen. The renderer cannot describe an import; it can only approve one.
 */
export interface ImportCommitRequest {
  readonly planId: ImportPlanId;
  /**
   * Match key → action. A key absent from this map takes {@link DEFAULT_DUPLICATE_ACTION},
   * so a malformed or partial map fails safe rather than importing duplicates.
   */
  readonly duplicateActions: Readonly<Record<string, ImportDuplicateAction>>;
  /** Applied to every imported record, so an import stays findable after the fact. */
  readonly extraTags?: readonly string[];
}

export interface ImportCommitResult {
  readonly batchId: ImportBatchId;
  readonly importedCount: number;
  readonly skippedCount: number;
  readonly mergedCount: number;
  readonly createdFolderPaths: readonly string[];
  /** Anything that came up during the write itself, on top of the preview's warnings. */
  readonly warnings: readonly ImportWarning[];
  /** The vault's save generation after the commit. `undo` refuses if this has moved on. */
  readonly vaultGeneration: number;
  /** False when the batch cannot be taken back — say so on screen rather than offering it. */
  readonly undoable: boolean;
}

/**
 * Undo.
 *
 * The generation guard is the point. Undo removes records by id; if the user edited one, or
 * anything else saved, in between, "remove what the import added" is no longer a safe
 * description of what would happen — so it is refused rather than guessed at.
 */
export interface ImportUndoRequest {
  readonly batchId: ImportBatchId;
  readonly expectedVaultGeneration: number;
}

export interface ImportUndoResult {
  readonly undone: boolean;
  /** Imported records removed. */
  readonly removedCount: number;
  /** Merged records put back to their pre-merge state. */
  readonly restoredCount: number;
  readonly removedFolderPaths: readonly string[];
}

// ── Progress ─────────────────────────────────────────────────────────────────

export const IMPORT_PROGRESS_PHASES = ['parsing', 'matching', 'writing', 'saving'] as const;
export type ImportProgressPhase = (typeof IMPORT_PROGRESS_PHASES)[number];

/**
 * A determinate progress tick.
 *
 * Determinate because an import of a large export takes real time and a still bar is
 * indistinguishable from a hang — the same argument as the Argon2 unlock, and the reason
 * `ProgressBar` exists in the shape it does.
 */
export interface ImportProgress {
  readonly planId: ImportPlanId;
  readonly phase: ImportProgressPhase;
  readonly completed: number;
  readonly total: number;
}

// ── The IPC surface ──────────────────────────────────────────────────────────

/**
 * The namespace the preload exposes as `window.keyhold.importer`.
 *
 * Declared here, beside its payloads, so that `src/shared/ipc/api.ts` adds one line
 * (`importer: ImporterApi`) rather than a second copy of nine signatures.
 */
export interface ImporterApi {
  /** The format registry, as descriptors. Never a parser. */
  formats: () => Promise<IpcResult<readonly ImportFormatDescriptor[]>>;
  /**
   * Opens a native file dialog, reads the chosen file, detects its format, and holds the
   * content in the main process.
   *
   * The dialog is the main process's, for the same reason as `chooseVaultToOpen`: a path
   * the user picked in an OS dialog is consent, a path the renderer supplied is not.
   * `null` means they cancelled.
   */
  chooseFile: () => Promise<IpcResult<ImportSource | null>>;
  /**
   * Opens another Keyhold vault — a `.keep`, or a `.keepx` parcel — as a source.
   *
   * Separate from `chooseFile` because of the passphrase, not because of the file type. A
   * credential must not travel through a method that every other format shares and none of
   * them can use, and it must not outlive the one decrypt it is for. See D30.
   *
   * The passphrase crosses the bridge, which is the safe direction: it is typed in the
   * renderer, so it is already there, and the alternative — a second password prompt owned by
   * the main process — would be another place in the app that collects passphrases. Nothing
   * about it comes back, and nothing stores it.
   *
   * `null` means the user cancelled the file dialog. A wrong passphrase is an error, not a
   * `null`: those are different answers and the screen says different things about them.
   */
  openVault: (secretPassphrase: string) => Promise<IpcResult<ImportSource | null>>;
  /** The dry run. Writes nothing, and mints the plan id a commit requires. */
  preview: (request: ImportPreviewRequest) => Promise<IpcResult<ImportPreview>>;
  commit: (request: ImportCommitRequest) => Promise<IpcResult<ImportCommitResult>>;
  undo: (request: ImportUndoRequest) => Promise<IpcResult<ImportUndoResult>>;
  /**
   * Drops the file content, every parse of it, and every plan derived from it.
   *
   * Called when the wizard closes, however it closes. A cancelled import must leave nothing
   * behind — not in the vault, and not in memory: the thing being held is a plaintext dump
   * of the user's passwords.
   */
  discard: (sourceId: ImportSourceId) => Promise<IpcResult<null>>;
  /** Subscribes to commit progress. Returns the unsubscribe. */
  onProgress: (listener: (progress: ImportProgress) => void) => () => void;
}

/**
 * The import channels.
 *
 * Spread into `CHANNELS` in `src/shared/ipc/api.ts` — `...IMPORT_CHANNELS` — so the
 * allow-list in the main process and the preload bridge both pick them up from the one list
 * they already read.
 */
/**
 * The refusal codes an import can come back with.
 *
 * Here rather than on either side, because both sides need the same strings and rule 8 says
 * they get them from one list. The main process raises them (`src/main/import-service/`);
 * the wizard reacts to two of them **by name** rather than by message
 * (`src/renderer/src/import/gateway.ts`), because "run the preview again" and "the vault
 * moved on" are specific answers that a generic error box cannot give.
 *
 * They were briefly declared twice, once on each side of the process boundary, with a test
 * that read one file as *text* and compared it against the other — which is a guard doing
 * the job a shared constant does for free, and a guard that only works while someone
 * remembers to keep it pointed at the right file.
 *
 * A message carrying one of these codes never contains a value out of the file being
 * imported. That file is a plaintext dump of somebody's entire vault, and these messages
 * are shown on screen, written into the import report, and pasted into bug reports. They
 * name the thing that went wrong and at most a position — never a cell, never a title.
 */
export const IMPORT_ERROR_CODES = {
  /** The plan was discarded, superseded, or never minted here. Re-preview and try again. */
  stalePlan: 'import/stale-plan',
  /** The vault moved on since the commit, so undo would not mean what it says. */
  staleUndo: 'import/stale-undo',
  /** No parser in the registry carries that id. */
  unknownFormat: 'import/unknown-format',
  /** A `needsMapping` format was previewed without one. */
  mappingRequired: 'import/mapping-required',
  /** The chosen file is larger than anything a credential export plausibly is. */
  fileTooLarge: 'import/file-too-large',
  /** The parser refused the file outright: an encrypted export, or JSON that is not JSON. */
  unreadableFile: 'import/unreadable-file',
} as const;

export type ImportErrorCode = (typeof IMPORT_ERROR_CODES)[keyof typeof IMPORT_ERROR_CODES];

export const IMPORT_CHANNELS = {
  importerFormats: 'kh:import:formats',
  importerChooseFile: 'kh:import:choose-file',
  importerOpenVault: 'kh:import:open-vault',
  importerPreview: 'kh:import:preview',
  importerCommit: 'kh:import:commit',
  importerUndo: 'kh:import:undo',
  importerDiscard: 'kh:import:discard',
} as const;

/** Main → renderer. Pushed, not requested, so it belongs with `EVENTS`, not `CHANNELS`. */
export const IMPORT_EVENTS = {
  importProgress: 'kh:event:import-progress',
} as const;

// ── Column targets that hold exactly one column ──────────────────────────────

/**
 * Targets that can hold one column's worth of value; the rest accumulate.
 *
 * Shared because two consumers need the same answer: `inferColumnMapping` uses it to decide
 * when a second `name` column must become a custom field, and the wizard's mapping validator
 * uses it to tell the user that two columns are both pointed at `password`. `isSingleValued`
 * in `src/main/import/generic-csv.ts` should be re-pointed at this array (rule 8).
 */
export const SINGLE_VALUED_IMPORT_TARGETS = [
  'title',
  'username',
  'email',
  'password',
  'folder',
  'favorite',
] as const;

export type SingleValuedImportTarget = (typeof SINGLE_VALUED_IMPORT_TARGETS)[number];

export function isSingleValuedImportTarget(target: string): target is SingleValuedImportTarget {
  return (SINGLE_VALUED_IMPORT_TARGETS as readonly string[]).includes(target);
}
