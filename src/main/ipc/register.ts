// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import {
  dialog,
  ipcMain,
  type BrowserWindow,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import { CHANNELS, EVENTS, type IpcResult, type SettingsView } from '@shared/ipc/api.js';
import {
  requireCredentialEdit,
  requireCredentialInput,
} from '@shared/ipc/credential-validation.js';
import { requireExportPlan, requireExportPreviewRequest } from '@shared/ipc/export-validation.js';
import { requireGeneratorOptions } from '@shared/ipc/generator-validation.js';
import {
  requireMachineSettingsPatch,
  requireVaultSettingsPatch,
} from '@shared/ipc/settings-validation.js';
import {
  IpcValidationError,
  requireHealthOptions,
  requireHistoryPoint,
  requireId,
  requireListOptions,
  requireNonEmptyString,
  requireSecretRef,
  requireString,
  requireVaultPath,
  requireFolderDeletePolicy,
  requireIndex,
  requireNullableId,
  requireVersionedField,
  requireGeneration,
  requireTagColour,
  requireVersionNumber,
} from '@shared/ipc/validation.js';
import type { ExportFormatDescriptor } from '@shared/model/export.js';
import {
  matchesPlaintextConfirmation,
  PLAINTEXT_CONFIRMATION_PHRASE,
  type ExportOutcome,
} from '@shared/model/export-plan.js';
import type { AttachmentPreview, PreviewableAttachmentKind } from '@shared/model/attachment.js';
import type { ColumnMapping } from '@shared/model/import.js';
import type { ConflictChoice } from '@shared/model/sync.js';
import type { ImportDuplicateAction } from '@shared/model/import-plan.js';
import { VaultError } from '../crypto/errors.js';
import {
  EXPORT_FORMATS,
  findExportFormat,
  previewExport,
  runExport,
  type ExportRequest,
} from '../export/index.js';
import { reportOf } from '../export/types.js';
import { createThemeIpcHandlers } from '../theme/index.js';
import {
  createBaseSnapshotStore,
  MergeSessionStore,
  serialiseSnapshot,
  snapshotIsSafeToStore,
} from '../sync/index.js';
import { parseVaultDocument } from '../vault/vault-service.js';
import { createElectronImportFilePicker } from '../import-service/file-picker.js';
import {
  createVaultImportAccess,
  ImportService,
  ImportServiceError,
} from '../import-service/index.js';
import {
  estimateEntropyBits,
  GENERATOR_DEFAULTS,
  GENERATOR_LIMITS,
  generatePassword,
  GeneratorConfigurationError,
} from '../generator/generator.js';
import type { OriginCapture } from '../history/origin.js';
import { OrganisationError } from '../organisation/errors.js';
import { RateLimitExceededError } from '../vault/secret-broker.js';
import type { SessionController } from '../session/session-controller.js';

/**
 * Registers every IPC handler.
 *
 * Three properties this file exists to guarantee:
 *
 * **1. Every handler validates its arguments before touching the vault.** The renderer is
 * semi-trusted (decision D13), and type annotations are erased at runtime.
 *
 * **2. No error ever crosses the boundary raw.** `toFailure` converts everything into a
 * structured result with a scrubbed message. An unhandled throw in an `ipcMain.handle`
 * serialises the error's message and stack straight into the renderer, and a stack carries
 * absolute filesystem paths — a small but free information leak, on every error, forever.
 *
 * **3. Handlers return results, never throw.** The renderer gets a discriminated union it
 * has to look at, rather than a rejected promise it might not catch.
 */

/**
 * A conflict-id → side map, validated key by key.
 *
 * The values decide which half of a disagreement survives, so an unrecognised one must be
 * refused rather than defaulted: defaulting would silently pick a side, which is the
 * last-writer-wins behaviour the whole engine exists to prevent. Keys are not checked against
 * the report — the engine ignores an id it does not know, and refusing here would mean a
 * resolver holding a stale selection could never make progress.
 */
function requireConflictChoices(
  channel: string,
  value: unknown
): Readonly<Record<string, ConflictChoice>> {
  const raw = requireRecord(channel, value, 'choices');
  const choices: Record<string, ConflictChoice> = {};
  for (const [id, side] of Object.entries(raw)) {
    if (side !== 'ours' && side !== 'theirs') {
      throw new IpcValidationError(channel, `choices["${id}"] must be "ours" or "theirs"`);
    }
    choices[id] = side;
  }
  return choices;
}

/** A plain object, for the two import payloads that are maps rather than fixed shapes. */
function requireRecord(channel: string, value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new IpcValidationError(channel, `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * A column mapping, shape-checked only.
 *
 * The targets are not validated against the field list here, because the parser already
 * ignores a target it does not recognise — and a mapping is the one payload where being
 * strict is worse than being permissive: it is assembled from a *user's* CSV header row, and
 * refusing the whole import because one column was named something unexpected is exactly the
 * failure the mapping step exists to let them fix.
 */
function requireColumnMapping(channel: string, value: unknown): ColumnMapping {
  const raw = requireRecord(channel, value, 'mapping');
  return {
    ...raw,
    columns: requireRecord(channel, raw.columns, 'mapping.columns'),
  } as ColumnMapping;
}

/** The tags the wizard offers to stamp on everything it imports. Absent means none. */
function requireTagList(channel: string, value: unknown): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new IpcValidationError(channel, 'extraTags must be an array of tag names');
  }
  return value.map((tag, index) => requireNonEmptyString(channel, tag, `extraTags[${index}]`));
}

/**
 * The viewer kind for a stored MIME type, or `null` when nothing should render it.
 *
 * Derived from the type the sniffing engine stored, so a `.pdf` that is really a ZIP is
 * offered as neither. Deliberately narrow — `text/*` covers plain text and nothing else,
 * because `text/html` is text that executes.
 */
function previewKindFor(mime: string): PreviewableAttachmentKind | null {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/plain') return 'text';
  return null;
}

/**
 * The name the save dialog opens on.
 *
 * Dated, because what a person most often has is several of these and no memory of which is
 * which. Not timed: a second-resolution name is noise, and two exports in one day are
 * exactly the case the OS's own "(1)" already handles.
 *
 * The extension comes from the registry and is never written out here -- rule 8, and the
 * specific failure it prevents is a parcel saved as `.keep`, which is the one file-name
 * mistake in this app a person could not recover from by renaming, because they would then
 * try to open it as their vault.
 */
function defaultExportFileName(descriptor: ExportFormatDescriptor): string {
  const date = new Date().toISOString().slice(0, 10);
  return `keyhold-export-${date}${descriptor.extension}`;
}

/**
 * The claimed type for a file, from its extension.
 *
 * Only a claim: `src/main/attachments/sniff.ts` reads the leading bytes and the **detected**
 * type is what gets stored. This exists so a mismatch can be reported — "you called this a
 * PDF and it is a PNG" — which needs something to have been claimed in the first place.
 */
function lookupMime(path: string): string {
  const types: Readonly<Record<string, string>> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.txt': 'text/plain',
    '.md': 'text/plain',
    '.csv': 'text/plain',
  };
  return types[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function toFailure(error: unknown): IpcResult<never> {
  if (error instanceof VaultError) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      recoverable: error.isRecoverable,
    };
  }
  if (error instanceof RateLimitExceededError) {
    return { ok: false, code: 'RATE_LIMITED', message: error.message, recoverable: false };
  }
  if (error instanceof IpcValidationError) {
    return { ok: false, code: 'INVALID_REQUEST', message: error.message, recoverable: false };
  }
  // An over-restrictive generator configuration. Its message is written for a user, names
  // only the character class at fault, and deliberately never echoes their exclusion string
  // back — so it is safe to surface verbatim, and useless if it is not.
  if (error instanceof GeneratorConfigurationError) {
    return { ok: false, code: 'INVALID_REQUEST', message: error.message, recoverable: true };
  }
  // A folder or tag operation the user can simply retry differently: a name that is only
  // whitespace, a move that would nest a folder inside itself, a depth limit. Its message
  // names the rule, never the user's text, so it is safe to surface and useless if it is not.
  if (error instanceof OrganisationError) {
    return { ok: false, code: error.code, message: error.message, recoverable: true };
  }

  // An import refusal. Its message names the failure and, at most, a position in the file —
  // never a cell, never a column's contents, never a title — so it is safe to surface
  // verbatim and useless if it is not. Without this branch the wizard never sees
  // `import/stale-plan` or `import/stale-undo` by name, and both degrade into the generic
  // error slot, losing the one thing that made them worth distinguishing.
  if (error instanceof ImportServiceError) {
    return { ok: false, code: error.code, message: error.message, recoverable: error.recoverable };
  }

  // Anything else is a bug. Report that it happened, and deliberately NOT what it was: an
  // arbitrary error message may contain a path, a filename, or — from a crypto library — a
  // fragment of the data being processed.
  return {
    ok: false,
    code: 'INTERNAL',
    message: 'Something went wrong inside Keyhold. Your vault was not modified.',
    recoverable: false,
  };
}

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

/** Wraps a handler so validation and errors are handled identically everywhere. */
function handle<T>(channel: string, run: (...args: unknown[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<IpcResult<T>> => {
    try {
      return ok(await run(...args));
    } catch (error) {
      // Logged with the real cause, which stays in this process. Only the scrubbed version
      // crosses the bridge.
      console.error(`[ipc] ${channel} failed:`, error);
      return toFailure(error);
    }
  });
}

export interface IpcContext {
  readonly session: SessionController;
  readonly appVersion: string;
  /**
   * Where machine-scoped state lives — `app.getPath('userData')` in production.
   *
   * Passed in rather than read from `electron` here, so the whole IPC layer stays testable
   * without an Electron runtime, which is the same reason `getWindow` is a function.
   */
  readonly userDataPath: string;
  readonly getWindow: () => BrowserWindow | null;
  /**
   * The provenance source, for the settings screen's "what network am I on?" check.
   *
   * Optional because a headless or test embedding has no reason to probe the machine, and
   * the channel degrades to "not detected" rather than failing.
   */
  readonly originCapture?: OriginCapture | undefined;
}

export function registerIpcHandlers(context: IpcContext): void {
  const { session } = context;
  const vault = session.vault;

  // ── app ────────────────────────────────────────────────────────────────────
  handle(CHANNELS.appGetVersion, () => context.appVersion);
  handle(CHANNELS.appGetPlatform, () => process.platform);

  // ── session ────────────────────────────────────────────────────────────────
  handle(CHANNELS.sessionStatus, () => session.status());

  /**
   * File dialogs are opened by the MAIN process, never given a renderer-supplied path.
   *
   * A path the renderer chose would be attacker-controlled if the renderer were ever
   * compromised; a path the user picked in an OS dialog is a genuine act of consent, and
   * the OS — not us — decides what they were allowed to reach.
   */
  handle(CHANNELS.sessionChooseVaultToOpen, async () => {
    // Modal to the window when there is one. `showOpenDialog` has separate overloads for
    // with/without a parent, so the branch is real rather than a null-check formality —
    // a parented dialog is modal and cannot be lost behind the app window.
    const window = context.getWindow();
    const options: OpenDialogOptions = {
      title: 'Open a Keyhold vault',
      filters: [
        { name: 'Keyhold vault', extensions: ['keep'] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    };
    const result =
      window === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(window, options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle(CHANNELS.sessionChooseVaultLocation, async (suggestedName) => {
    const window = context.getWindow();
    const name =
      typeof suggestedName === 'string' && suggestedName !== '' ? suggestedName : 'vault';
    const options: SaveDialogOptions = {
      title: 'Create a Keyhold vault',
      defaultPath: `${basename(name)}.keep`,
      filters: [{ name: 'Keyhold vault', extensions: ['keep'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    const result =
      window === null
        ? await dialog.showSaveDialog(options)
        : await dialog.showSaveDialog(window, options);
    return result.canceled ? null : result.filePath;
  });

  handle(CHANNELS.sessionEstimateStrength, async (password) =>
    // Not `requireNonEmptyString`: an empty field is a normal state while typing, and the
    // estimator returns an explicit "not judged yet" result for it.
    session.estimateStrength(requireString(CHANNELS.sessionEstimateStrength, password, 'password'))
  );

  handle(CHANNELS.sessionCopySecret, async (ref) =>
    session.copySecret(requireSecretRef(CHANNELS.sessionCopySecret, ref))
  );

  handle(CHANNELS.sessionClearClipboard, async () => session.clearClipboard());

  handle(CHANNELS.sessionEnrolQuickUnlock, () => {
    session.enrolQuickUnlock();
    return null;
  });

  handle(CHANNELS.sessionRevokeQuickUnlock, () => {
    session.revokeQuickUnlock();
    return null;
  });

  handle(CHANNELS.sessionUnlockWithQuickUnlock, async (path) =>
    session.unlockWithQuickUnlock(requireVaultPath(CHANNELS.sessionUnlockWithQuickUnlock, path))
  );

  handle(CHANNELS.sessionForgetVault, (path) => {
    session.forgetVault(requireVaultPath(CHANNELS.sessionForgetVault, path));
    return null;
  });

  // ── vault ──────────────────────────────────────────────────────────────────
  handle(CHANNELS.vaultInspect, async (path) =>
    session.inspect(requireVaultPath(CHANNELS.vaultInspect, path))
  );

  handle(CHANNELS.vaultCreate, async (path, password) =>
    session.createVault(
      requireVaultPath(CHANNELS.vaultCreate, path),
      requireNonEmptyString(CHANNELS.vaultCreate, password, 'password')
    )
  );

  handle(CHANNELS.vaultUnlock, async (path, password) =>
    session.unlock(
      requireVaultPath(CHANNELS.vaultUnlock, path),
      requireNonEmptyString(CHANNELS.vaultUnlock, password, 'password')
    )
  );

  handle(CHANNELS.vaultLock, () => {
    session.lock('manual');
    return null;
  });

  handle(CHANNELS.vaultSave, async () => session.save());
  handle(CHANNELS.vaultSummary, () => (vault.state === 'unlocked' ? vault.summary() : null));
  handle(CHANNELS.vaultHasUnsavedChanges, () => vault.hasUnsavedChanges);

  // ── credentials ────────────────────────────────────────────────────────────
  handle(CHANNELS.credentialsList, (options) =>
    vault.listProjections(requireListOptions(CHANNELS.credentialsList, options))
  );

  handle(CHANNELS.credentialsGet, (credentialId) =>
    vault.getProjection(requireId(CHANNELS.credentialsGet, credentialId, 'credentialId'))
  );

  handle(CHANNELS.credentialsRevealSecret, (ref) =>
    vault.revealSecret(requireSecretRef(CHANNELS.credentialsRevealSecret, ref))
  );

  handle(CHANNELS.credentialsDeepSearch, (query) =>
    vault.deepSearch(requireNonEmptyString(CHANNELS.credentialsDeepSearch, query, 'query'))
  );

  handle(CHANNELS.credentialsCreate, (input) =>
    vault.createCredential(requireCredentialInput(CHANNELS.credentialsCreate, input))
  );

  handle(CHANNELS.credentialsUpdate, (credentialId, edit) => {
    const id = requireId(CHANNELS.credentialsUpdate, credentialId, 'credentialId');
    const parsed = requireCredentialEdit(CHANNELS.credentialsUpdate, edit);

    // The IPC shape is flat because it is easier to send; the ops layer takes a nested
    // patch because that is the shape of the record. Translating here keeps the awkwardness
    // in one place rather than in every caller.
    const result = vault.updateCredential(id, {
      ...(parsed.title === undefined ? {} : { title: parsed.title }),
      ...(parsed.favorite === undefined ? {} : { favorite: parsed.favorite }),
      ...(parsed.folderId === undefined ? {} : { folderId: parsed.folderId }),
      ...(parsed.tags === undefined ? {} : { tags: parsed.tags }),
      ...(parsed.icon === undefined ? {} : { icon: parsed.icon }),
      fields: {
        ...(parsed.username === undefined ? {} : { username: parsed.username }),
        ...(parsed.email === undefined ? {} : { email: parsed.email }),
        ...(parsed.password === undefined ? {} : { password: parsed.password }),
        ...(parsed.urls === undefined ? {} : { urls: parsed.urls }),
        ...(parsed.notes === undefined ? {} : { notes: parsed.notes }),
        ...(parsed.securityQuestions === undefined
          ? {}
          : { securityQuestions: parsed.securityQuestions }),
        ...(parsed.custom === undefined ? {} : { custom: parsed.custom }),
      },
      meta: {
        ...(parsed.expiresAt === undefined ? {} : { expiresAt: parsed.expiresAt }),
        ...(parsed.rotationIntervalDays === undefined
          ? {}
          : { rotationIntervalDays: parsed.rotationIntervalDays }),
      },
      ...(parsed.historyEnabled === undefined
        ? {}
        : { history: { enabled: parsed.historyEnabled } }),
    });

    return result === null
      ? null
      : { projection: result.projection, changedFields: [...result.changedFields] };
  });

  handle(CHANNELS.credentialsDuplicate, (credentialId) =>
    vault.duplicateCredential(
      requireId(CHANNELS.credentialsDuplicate, credentialId, 'credentialId')
    )
  );

  handle(CHANNELS.credentialsTrash, (credentialId) =>
    vault.trashCredential(requireId(CHANNELS.credentialsTrash, credentialId, 'credentialId'))
  );

  handle(CHANNELS.credentialsRestore, (credentialId) =>
    vault.restoreCredential(requireId(CHANNELS.credentialsRestore, credentialId, 'credentialId'))
  );

  handle(CHANNELS.credentialsPurge, (credentialId) =>
    vault.purgeCredential(requireId(CHANNELS.credentialsPurge, credentialId, 'credentialId'))
  );

  handle(CHANNELS.credentialsMarkUsed, (credentialId) => {
    vault.markUsed(requireId(CHANNELS.credentialsMarkUsed, credentialId, 'credentialId'));
    return null;
  });
  // ── generator ──────────────────────────────────────────────────────────────
  //
  // The only channels that need no open vault: generation is pure, and a user choosing a
  // password before they have unlocked anything is a reasonable thing to do.
  //
  // These return the generated password in plaintext, which is a deliberate, bounded
  // exception to decision D13 rather than an oversight. The renderer has to render it —
  // that is the entire feature — and what crosses is one value the user just asked to see,
  // which is not yet stored anywhere and has no account attached to it. That is a different
  // proposition from holding a vault's worth of secrets, which is what D13 is about.

  handle(CHANNELS.generatorGenerate, (options) =>
    generatePassword(requireGeneratorOptions(CHANNELS.generatorGenerate, options))
  );

  /**
   * Entropy for a configuration, without producing a password.
   *
   * So a slider can show the strength of what it is *about* to make. Generating on every
   * drag would put a stream of discarded passwords through the bridge for no reason.
   */
  handle(CHANNELS.generatorEstimate, (options) =>
    estimateEntropyBits(requireGeneratorOptions(CHANNELS.generatorEstimate, options))
  );

  /**
   * The bounds and defaults, read across the contract rather than restated in the UI.
   *
   * A slider with `min={8}` typed into it is a second list, and it disagrees with the
   * engine the first time either changes.
   */
  handle(CHANNELS.generatorLimits, () => ({
    limits: GENERATOR_LIMITS,
    defaults: GENERATOR_DEFAULTS,
  }));

  // ── health ─────────────────────────────────────────────────────────────────

  handle(CHANNELS.healthAnalyse, (options) =>
    vault.analyseHealth(requireHealthOptions(CHANNELS.healthAnalyse, options))
  );

  // ── history ────────────────────────────────────────────────────────────────

  handle(CHANNELS.historyDiff, (credentialId, versionNumber) =>
    vault.diffVersionProjection(
      requireId(CHANNELS.historyDiff, credentialId, 'credentialId'),
      requireVersionNumber(CHANNELS.historyDiff, versionNumber, 'versionNumber')
    )
  );

  handle(CHANNELS.historyCompare, (credentialId, from, to) =>
    vault.compareVersionsProjection(
      requireId(CHANNELS.historyCompare, credentialId, 'credentialId'),
      requireHistoryPoint(CHANNELS.historyCompare, from, 'from'),
      requireHistoryPoint(CHANNELS.historyCompare, to, 'to')
    )
  );

  handle(CHANNELS.historyRestoreVersion, (credentialId, versionNumber) =>
    vault.restoreVersion(
      requireId(CHANNELS.historyRestoreVersion, credentialId, 'credentialId'),
      requireVersionNumber(CHANNELS.historyRestoreVersion, versionNumber, 'versionNumber')
    )
  );

  handle(CHANNELS.historyRestoreField, (credentialId, versionNumber, field) =>
    vault.restoreField(
      requireId(CHANNELS.historyRestoreField, credentialId, 'credentialId'),
      requireVersionNumber(CHANNELS.historyRestoreField, versionNumber, 'versionNumber'),
      requireVersionedField(CHANNELS.historyRestoreField, field)
    )
  );

  handle(CHANNELS.historyClear, (credentialId) =>
    vault.clearHistory(requireId(CHANNELS.historyClear, credentialId, 'credentialId'))
  );

  // ── import ─────────────────────────────────────────────────────────────────
  //
  // The main process owns the file, start to finish. `chooseFile` opens the dialog, reads
  // the bytes and keeps them here; the renderer gets an opaque id and never learns the path
  // or sees a byte. That file is, at that moment, a plaintext dump of every password the
  // user has — putting it in the renderer would be the single largest secret exposure in
  // the app, from the one screen where the user is being asked to trust us with all of it.
  //
  // `discard` is not politeness. It is how those bytes stop existing: the service zeroes
  // them rather than dropping the reference. The wizard calls it on every exit — finish,
  // cancel, or unmount — and the vault calls `discardAll` on lock.

  const importer = new ImportService({
    vault: createVaultImportAccess(vault, (action) =>
      // The vault's *current* privacy level, read per change rather than captured once: the
      // user can move it mid-import, and the records written afterwards must honour the
      // setting they have now. Degrades to the verb alone when no capture is wired, which
      // records less than it could and never more.
      context.originCapture === undefined
        ? { action }
        : context.originCapture.capture(action, vault.settings().auditPrivacyLevel)
    ),
    picker: createElectronImportFilePicker(context.getWindow),
    onProgress: (progress) => {
      // Fire-and-forget to whichever window exists. A progress event that cannot be
      // delivered is not worth failing an import over.
      context.getWindow()?.webContents.send(EVENTS.importProgress, progress);
    },
  });

  // An undo means nothing against a vault whose key has been destroyed, and a held batch
  // carries pre-merge copies of records out of it. Registered as a lock observer rather
  // than called from `session.lock()`, so nothing has to remember this exists.
  session.onLock(() => {
    importer.discardAll();
  });

  handle(CHANNELS.importerFormats, () => importer.formats());

  handle(CHANNELS.importerChooseFile, () => importer.chooseFile());

  handle(CHANNELS.importerPreview, (raw) => {
    const channel = CHANNELS.importerPreview;
    const request = requireRecord(channel, raw, 'request');
    return importer.preview({
      sourceId: requireId(channel, request.sourceId, 'sourceId'),
      formatId: requireNonEmptyString(channel, request.formatId, 'formatId'),
      ...(request.mapping === undefined
        ? {}
        : { mapping: requireColumnMapping(channel, request.mapping) }),
      sampleSize: requireIndex(channel, request.sampleSize, 'sampleSize'),
    });
  });

  handle(CHANNELS.importerCommit, (raw) => {
    const channel = CHANNELS.importerCommit;
    const request = requireRecord(channel, raw, 'request');
    return importer.commit({
      planId: requireId(channel, request.planId, 'planId'),
      // Shape-checked, values not: the service narrows every entry to a real action and
      // falls back to `skip`, so a malformed map imports nothing rather than being refused.
      // Refusing here would mean a renderer bug presents as "your file is bad".
      duplicateActions: requireRecord(
        channel,
        request.duplicateActions ?? {},
        'duplicateActions'
      ) as Record<string, ImportDuplicateAction>,
      extraTags: requireTagList(channel, request.extraTags),
    });
  });

  handle(CHANNELS.importerUndo, (raw) => {
    const channel = CHANNELS.importerUndo;
    const request = requireRecord(channel, raw, 'request');
    return importer.undo({
      batchId: requireId(channel, request.batchId, 'batchId'),
      // `requireGeneration`, not `requireIndex`: a generation counts saves over the life of
      // a vault and passes 10,000. See the note on that validator.
      expectedVaultGeneration: requireGeneration(
        channel,
        request.expectedVaultGeneration,
        'expectedVaultGeneration'
      ),
    });
  });

  handle(CHANNELS.importerDiscard, (sourceId) => {
    importer.discard(requireId(CHANNELS.importerDiscard, sourceId, 'sourceId'));
    return null;
  });

  // ── sync ───────────────────────────────────────────────────────────────────
  //
  // Merging another copy of this vault. Four handlers and no path in either direction: the
  // file dialog opens here, the other copy is read and decrypted here, and the renderer is
  // handed a plan id, a report of lengths, and a backup filename.
  //
  // `prepare` is where the mandatory pre-merge backup is taken — before the user has seen a
  // single conflict, so the copy that lets them walk away exists by the time they are looking
  // at four hundred of them.

  handle(CHANNELS.syncPrepare, async () => {
    const ours = vault.documentUnsafe();
    const summary = vault.summary();

    const window = context.getWindow();
    const options: OpenDialogOptions = {
      title: 'Merge another copy of this vault',
      filters: [
        { name: 'Keyhold vault', extensions: ['keep'] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    };
    const chosen =
      window === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(window, options);
    const otherPath = chosen.canceled ? undefined : chosen.filePaths[0];
    if (otherPath === undefined) return null;

    // The same master password opens both, because a merge is between two copies of *one*
    // vault. Reading the other one with the open vault's key is what makes that structural
    // rather than a thing we hope is true — a genuinely different vault fails to decrypt.
    const theirs = await vault.readOtherCopyUnsafe(otherPath);

    // The ancestor, if this device has merged before. Absent degrades to a two-way merge,
    // which asks far more questions and is honest about it — never guesses.
    const base = snapshots.read(summary.vaultId);

    return await merges.prepare({
      vaultPath: summary.path,
      ours,
      theirs: theirs.document,
      base: base === null ? null : parseVaultDocument(base),
    });
  });

  handle(CHANNELS.syncResolve, (raw) => {
    const channel = CHANNELS.syncResolve;
    const request = requireRecord(channel, raw, 'request');
    return merges.resolve(
      requireId(channel, request.planId, 'planId'),
      requireConflictChoices(channel, request.choices)
    );
  });

  handle(CHANNELS.syncCommit, async (planId) => {
    const id = requireId(CHANNELS.syncCommit, planId, 'planId');
    const { document, result } = merges.commit(id);

    // Replace the document, then save through the ordinary path — which brackets the write
    // for the watcher, rotates the backups and stamps the header, all of which a merge needs
    // exactly as much as an edit does.
    vault.replaceDocument(document);
    const saved = await vault.save();

    // The ancestor is stored only now, and only because the write succeeded. A snapshot
    // describing a state no file ever held would make the *next* merge read the user's real
    // edits as changes away from something that never existed.
    if (snapshotIsSafeToStore({ mergedWasWritten: true, unresolvedConflicts: 0 })) {
      snapshots.write(saved.vaultId, serialiseSnapshot(document));
    }

    merges.discard(id);
    return result;
  });

  handle(CHANNELS.syncDiscard, (planId) => {
    merges.discard(requireId(CHANNELS.syncDiscard, planId, 'planId'));
    return null;
  });

  // ── themes ─────────────────────────────────────────────────────────────────
  //
  // Three handlers and no path in either direction: the dialogs open in `theme-ipc.ts`, the
  // file is parsed there, and the renderer is handed a projection rather than the file's own
  // text. A `.keeptheme` used to be the one file in the app that moved through the browser —
  // an `<input type="file">` and an `<a download>` — which made it the exception to the rule
  // the vault, attachment, import and export paths all follow, and the only untrusted file
  // parsed inside the renderer.

  const themeFiles = createThemeIpcHandlers({ getWindow: context.getWindow });

  // The ancestor store and the in-progress merge, constructed here because both belong to
  // the app's lifetime rather than to a vault: the snapshots outlive any one open vault, and
  // the merge session must be droppable on lock from a place that can see the session.
  const snapshots = createBaseSnapshotStore(context.userDataPath);
  const merges = new MergeSessionStore({ now: Date.now });
  session.onLock(() => {
    // A held merge is a decrypted copy of another whole vault. A lock means nothing derived
    // from any vault is still in memory, and that includes the one being merged in.
    merges.discardAll();
  });

  handle(CHANNELS.themeImport, () => themeFiles.importTheme());
  handle(CHANNELS.themeExport, (raw) => themeFiles.exportTheme(raw));
  handle(CHANNELS.themeTakeOpened, () => themeFiles.takeOpenedTheme());

  // ── export ─────────────────────────────────────────────────────────────────
  //
  // Three handlers, no path in either direction, and no channel that returns bytes. The
  // save dialog opens here, the file is written here, and the renderer learns only where it
  // landed. See `EXPORT_CHANNELS` for why that is the whole surface.

  handle(CHANNELS.exportFormats, () => EXPORT_FORMATS);

  handle(CHANNELS.exportPreview, (raw) => {
    const request = requireExportPreviewRequest(CHANNELS.exportPreview, raw);
    return previewExport(vault.documentUnsafe(), {
      format: request.format,
      scope: request.scope,
      now: Date.now(),
      // The chunks, so a parcel preview can say honestly how many attachments would ride
      // along. Only their ids are read; nothing about them crosses the bridge.
      attachments: vault.attachmentChunksUnsafe(),
    });
  });

  handle(CHANNELS.exportRun, async (raw): Promise<ExportOutcome> => {
    const plan = requireExportPlan(CHANNELS.exportRun, raw);

    const descriptor = findExportFormat(plan.format);
    if (descriptor === null) {
      throw new IpcValidationError(CHANNELS.exportRun, `unknown export format: ${plan.format}`);
    }

    // The registry decides whether a format is encrypted; the plan only *claims* it. A plan
    // whose claim disagrees is either a bug or a renderer trying to walk a plaintext dump
    // past the confirmation, and neither should get a best guess.
    if (descriptor.encrypted !== (plan.kind === 'encrypted')) {
      throw new IpcValidationError(
        CHANNELS.exportRun,
        `plan claims ${plan.kind} for ${plan.format}, which the registry does not agree with`
      );
    }

    // THE gate. Checked here, on the raw text the user typed, by the one matcher -- never on
    // a boolean the renderer computed, which would make this exactly as strong as the
    // renderer. Reported as an outcome rather than thrown: the dialog needs to say "that is
    // not the phrase", which is something the user can act on, not an error.
    if (plan.kind === 'plaintext' && !matchesPlaintextConfirmation(plan.confirmation)) {
      return {
        status: 'failed',
        code: 'CONFIRMATION_REQUIRED',
        message: `Type ${PLAINTEXT_CONFIRMATION_PHRASE} exactly to write a readable copy of your vault.`,
      };
    }

    const document = vault.documentUnsafe();
    const scope = {
      includeTrashed: plan.scope.includeTrashed,
      ...(plan.scope.recordIds === null ? {} : { recordIds: plan.scope.recordIds }),
    };

    const window = context.getWindow();
    const options: SaveDialogOptions = {
      title: descriptor.encrypted ? 'Save encrypted parcel' : 'Export vault',
      defaultPath: defaultExportFileName(descriptor),
      filters: [
        { name: descriptor.name, extensions: [descriptor.extension.replace(/^\./, '')] },
        { name: 'All files', extensions: ['*'] },
      ],
      // macOS only, and exactly right for this dialog: the file about to be written is a
      // copy of the vault, and the OS should be the one asking before it replaces something
      // already there.
      properties: ['showOverwriteConfirmation'],
    };
    const chosen =
      window === null
        ? await dialog.showSaveDialog(options)
        : await dialog.showSaveDialog(window, options);

    // Not a failure. Dismissing a save dialog is the system working, and reporting it as an
    // error is how people learn to ignore export errors.
    // `filePath` is typed non-optional but is the empty string on a dismissed dialog on
    // some platforms, so both are treated as the cancel they are.
    if (chosen.canceled || chosen.filePath.length === 0) return { status: 'cancelled' };

    // Built by naming each format rather than spreading `plan.format` into one options bag.
    // `ExportRequest` is a discriminated union precisely so that "a parcel with no
    // passphrase" cannot be constructed, and a spread would widen the discriminant and hand
    // that guarantee straight back.
    //
    // Branched on `plan.kind` first, so the passphrase is reachable only on the branch that
    // is typed as having one -- rather than on a format switch, where it would have to be
    // fished back out with a check the compiler already knows is dead.
    const request: ExportRequest = ((): ExportRequest => {
      const now = Date.now();
      if (plan.kind === 'encrypted') {
        return {
          format: 'keyhold-parcel',
          ...scope,
          now,
          password: plan.secretPassphrase,
          attachments: vault.attachmentChunksUnsafe(),
          // The vault's own cost parameters. A parcel derived under weaker settings than the
          // vault it came from would be the easier of the two to attack, which is not a
          // trade-off anyone chose by clicking "export".
          kdf: vault.kdfParams(),
        };
      }
      switch (plan.format) {
        case 'keyhold-json':
          return { format: 'keyhold-json', ...scope, now };
        // The two flat formats carry no timestamped envelope, so they take no `now`.
        case 'keyhold-csv':
          return { format: 'keyhold-csv', ...scope };
        case 'compatible-csv':
          return { format: 'compatible-csv', ...scope };
        case 'keyhold-parcel':
          // Refused twice already -- by the validator, and by the registry cross-check.
          // Thrown rather than sealed under an empty passphrase, because that would be a
          // file that looks encrypted and is not, and "unreachable" is a claim that expires.
          throw new IpcValidationError(CHANNELS.exportRun, 'a parcel requires a passphrase');
      }
    })();

    const output = await runExport(document, request);

    const bytes = output.containsSecrets ? output.secretBytes : output.bytes;
    try {
      // `mode` 0o600 on the readable formats: that file is the vault in the clear, and on a
      // shared machine the default umask would hand it to every other account. It is a
      // no-op on Windows, where the ACL comes from the directory -- which is why the dialog,
      // and not this code, chose the directory.
      await writeFile(chosen.filePath, bytes, output.containsSecrets ? { mode: 0o600 } : {});
      return {
        status: 'written',
        report: reportOf(output),
        location: {
          fileName: basename(chosen.filePath),
          directory: dirname(chosen.filePath),
          byteLength: bytes.byteLength,
        },
      };
    } finally {
      // The one reference we control, dropped. A readable export is a complete copy of every
      // password in scope; leaving it in a buffer past the write buys nothing.
      if (output.containsSecrets) output.secretBytes.fill(0);
    }
  });

  // ── attachments ────────────────────────────────────────────────────────────
  //
  // The renderer names no path, in either direction. Both dialogs are opened here and both
  // the read and the write happen here, for the same reason vault paths work this way: a
  // path the renderer chose would be attacker-controlled if the renderer were ever
  // compromised, while a path the user picked in an OS dialog is a genuine act of consent.
  //
  // The bytes never cross the bridge. An attachment can be tens of megabytes and can be a
  // photograph of a passport, and the two things a user does with one — look at it, save it
  // — can both happen in this process.

  handle(CHANNELS.attachmentsAdd, async (credentialId) => {
    const id = requireId(CHANNELS.attachmentsAdd, credentialId, 'credentialId');

    const window = context.getWindow();
    const options: OpenDialogOptions = {
      title: 'Attach a file',
      properties: ['openFile'],
    };
    const chosen =
      window === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(window, options);
    const path = chosen.canceled ? undefined : chosen.filePaths[0];
    if (path === undefined) return null;

    // Read here, not in the renderer. The size is checked by the attachment engine against
    // the vault's own cap; reading first is unavoidable, and `readFile` on a file the user
    // just chose is bounded by their own filesystem rather than by anything we control.
    const bytes = await readFile(path);
    return vault.addAttachment(id, {
      name: basename(path),
      mime: lookupMime(path),
      bytes,
    });
  });

  handle(CHANNELS.attachmentsRemove, (credentialId, attachmentId) =>
    vault.removeAttachment(
      requireId(CHANNELS.attachmentsRemove, credentialId, 'credentialId'),
      requireId(CHANNELS.attachmentsRemove, attachmentId, 'attachmentId')
    )
  );

  handle(CHANNELS.attachmentsSave, async (credentialId, attachmentId) => {
    const id = requireId(CHANNELS.attachmentsSave, credentialId, 'credentialId');
    const attachment = requireId(CHANNELS.attachmentsSave, attachmentId, 'attachmentId');

    const bytes = vault.readAttachment(id, attachment);
    if (bytes === null) return null;

    const window = context.getWindow();
    const projection = vault.getProjection(id);
    const suggested =
      projection?.attachments.find((entry) => entry.id === attachment)?.name ?? 'attachment';
    const options: SaveDialogOptions = {
      title: 'Save attachment',
      // `basename` again, on a name that has already been sanitised once when it was stored.
      // Twice, because this is the only point where it becomes a path.
      defaultPath: basename(suggested),
    };
    const chosen =
      window === null
        ? await dialog.showSaveDialog(options)
        : await dialog.showSaveDialog(window, options);
    // `filePath` is typed non-optional, so `canceled` is the only cancellation signal there
    // is — checking both would read as belt and braces while actually being dead code.
    if (chosen.canceled) return null;

    await writeFile(chosen.filePath, bytes);
    // The basename only. The directory is the user's business and does not need to travel
    // back into a renderer that never chose it.
    return basename(chosen.filePath);
  });

  handle(CHANNELS.attachmentsPreview, (credentialId, attachmentId) => {
    const id = requireId(CHANNELS.attachmentsPreview, credentialId, 'credentialId');
    const attachment = requireId(CHANNELS.attachmentsPreview, attachmentId, 'attachmentId');

    const projection = vault.getProjection(id);
    const meta = projection?.attachments.find((entry) => entry.id === attachment);
    if (meta === undefined) return null;

    // The stored type, which is the **detected** one — `addAttachment` writes what the bytes
    // are, not what the caller claimed. Refused here rather than in the renderer: a renderer
    // deciding for itself which types are safe to display would be the renderer choosing its
    // own attack surface, and the claim it would decide on is the attacker's to write.
    const kind = previewKindFor(meta.mime);
    if (kind === null) return null;

    // Last, because this is the call that takes a broker grant. Refusing an unpreviewable
    // type above means a viewer that repeatedly asks for a ZIP cannot burn the rate limit
    // that protects passwords.
    const bytes = vault.readAttachment(id, attachment);
    if (bytes === null) return null;

    return { name: meta.name, mime: meta.mime, kind, bytes } satisfies AttachmentPreview;
  });

  handle(CHANNELS.attachmentsAudit, () => vault.auditAttachments());

  // ── settings ───────────────────────────────────────────────────────────────
  //
  // Two scopes, and keeping them apart is the whole point. Machine settings live in app
  // preferences and stay on this computer; vault settings live inside the encrypted body and
  // travel with the file. Mixing them would mean copying a vault to a second machine either
  // silently changed that machine's behaviour or silently failed to carry a choice the user
  // thought they had made.

  const settingsView = (): SettingsView => {
    const status = session.status();
    const open = status.state === 'unlocked';
    // `mechanism` is deliberately not carried across. The renderer renders `description`
    // verbatim precisely so it cannot restate the mechanism in its own words — Touch ID is a
    // biometric gate and Windows DPAPI is not, and a renderer holding the enum is a renderer
    // that will eventually write `mechanism === 'touch-id' ? 'Touch ID' : 'biometrics'`.
    const { available, promptsForBiometrics, description, enrolledForThisVault } =
      status.quickUnlock;
    return {
      machine: session.machineSettings(),
      vault: open ? vault.settings() : null,
      vaultPath: status.vault?.path ?? null,
      // The file name, not the path. The screen shows it as a label, and a label is not a
      // place to put a directory tree the user did not ask to see.
      vaultDisplayName: status.vault === null ? null : basename(status.vault.path),
      kdf: open ? vault.kdfParams() : null,
      quickUnlock: { available, enrolled: enrolledForThisVault, promptsForBiometrics, description },
      historyVersionCount: open ? vault.historyVersionCount() : 0,
    };
  };

  handle(CHANNELS.settingsRead, () => settingsView());

  handle(CHANNELS.settingsUpdateMachine, (patch) => {
    session.updateMachineSettings(
      requireMachineSettingsPatch(CHANNELS.settingsUpdateMachine, patch)
    );
    return settingsView();
  });

  handle(CHANNELS.settingsUpdateVault, (patch) => {
    vault.updateSettings(requireVaultSettingsPatch(CHANNELS.settingsUpdateVault, patch));
    return settingsView();
  });

  /**
   * Clears every record's history at once.
   *
   * Returns the count so the UI can say what it cost. Deliberately **not** itself versioned,
   * for the same reason the per-record version is not: recording "all history was cleared,
   * from DESKTOP-A, at 14:02" would defeat the point of the button.
   */
  handle(CHANNELS.settingsClearAllHistory, () => vault.clearAllHistory());

  // ── folders and tags ───────────────────────────────────────────────────────
  //
  // Every operation answers with the whole snapshot rather than a patch. Folders are a tree
  // with sibling ordering and a tag rename rewrites every record carrying it, so a partial
  // reply would leave the renderer reconstructing state this process already computed — and
  // the two would drift. These lists are small; the round trip is not the cost to optimise.

  handle(CHANNELS.organisationList, () => vault.organisation());

  handle(CHANNELS.foldersCreate, (name, parentId) => {
    vault.createFolder({
      name: requireNonEmptyString(CHANNELS.foldersCreate, name, 'name'),
      parentId: requireNullableId(CHANNELS.foldersCreate, parentId, 'parentId'),
    });
    return vault.organisation();
  });

  handle(CHANNELS.foldersRename, (folderId, name) => {
    vault.renameFolder(
      requireId(CHANNELS.foldersRename, folderId, 'folderId'),
      requireNonEmptyString(CHANNELS.foldersRename, name, 'name')
    );
    return vault.organisation();
  });

  handle(CHANNELS.foldersMove, (folderId, parentId, index) => {
    vault.moveFolder(
      requireId(CHANNELS.foldersMove, folderId, 'folderId'),
      requireNullableId(CHANNELS.foldersMove, parentId, 'parentId'),
      index === undefined ? undefined : requireIndex(CHANNELS.foldersMove, index, 'index')
    );
    return vault.organisation();
  });

  handle(CHANNELS.foldersDelete, (folderId, policy) => {
    const { movedRecords } = vault.deleteFolder(
      requireId(CHANNELS.foldersDelete, folderId, 'folderId'),
      requireFolderDeletePolicy(CHANNELS.foldersDelete, policy)
    );
    return { snapshot: vault.organisation(), affectedRecords: movedRecords };
  });

  handle(CHANNELS.tagsCreate, (name, colour) => {
    vault.createTag({
      name: requireNonEmptyString(CHANNELS.tagsCreate, name, 'name'),
      colour: requireString(CHANNELS.tagsCreate, colour, 'colour'),
    });
    return vault.organisation();
  });

  handle(CHANNELS.tagsRename, (tagId, name) => {
    const { updatedRecords } = vault.renameTag(
      requireId(CHANNELS.tagsRename, tagId, 'tagId'),
      requireNonEmptyString(CHANNELS.tagsRename, name, 'name')
    );
    return { snapshot: vault.organisation(), affectedRecords: updatedRecords };
  });

  handle(CHANNELS.tagsSetColour, (tagId, colour) => {
    vault.setTagColour(
      requireId(CHANNELS.tagsSetColour, tagId, 'tagId'),
      requireTagColour(CHANNELS.tagsSetColour, colour)
    );
    return vault.organisation();
  });

  handle(CHANNELS.tagsDelete, (tagId) => {
    const { updatedRecords } = vault.deleteTag(requireId(CHANNELS.tagsDelete, tagId, 'tagId'));
    return { snapshot: vault.organisation(), affectedRecords: updatedRecords };
  });

  /**
   * What network the app thinks it is on.
   *
   * For the settings screen, so the audit-privacy choice can be made against the actual
   * string that would be recorded rather than against a guess. This is the one place a
   * probe is awaited, because here the user asked and is watching a spinner — on the save
   * path it is never awaited at all.
   */
  handle(CHANNELS.historyNetworkName, async () => {
    const capture = context.originCapture;
    return capture === undefined ? null : await capture.refreshNetwork();
  });
}
/**
 * Tells the renderer the session changed underneath it.
 *
 * Needed because auto-lock is initiated by the main process, not by anything the renderer
 * did. Without this the UI keeps rendering an unlocked vault that is no longer open, and
 * the first sign of trouble is every action failing.
 */
export function notifySessionChanged(window: BrowserWindow | null): void {
  if (window === null || window.isDestroyed()) return;
  window.webContents.send(EVENTS.sessionChanged);
}

/** Removes every handler. Used on quit so nothing answers during teardown. */
export function unregisterIpcHandlers(): void {
  for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler(channel);
}
