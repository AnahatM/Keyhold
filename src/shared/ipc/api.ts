// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  CredentialProjection,
  CustomFieldType,
  SecretRef,
  SecurityQuestion,
  VersionedField,
} from '../model/credential.js';
import type {
  GeneratedPassword,
  GeneratorDefaults,
  GeneratorLimitName,
  GeneratorOptions,
  GeneratorRange,
} from '../model/generator.js';
import type { HealthRuleId, HealthThresholds, VaultHealthReport } from '../model/health.js';
import type { FieldDiffProjection, HistoryPointRef } from '../model/history.js';
import type { PasswordStrength } from '../model/strength.js';
import type { Folder, Tag, VaultLockedInfo, VaultSummary } from '../model/vault-document.js';
import type { SettingsSnapshot } from '../model/settings-plan.js';
import type { AttachmentAddView, AttachmentAudit } from '../model/attachment.js';
import type { ExportFormatDescriptor } from '../model/export.js';
import type { ImportFormatDescriptor } from '../model/import.js';
import {
  EXPORT_CHANNELS,
  type ExportOutcome,
  type ExportPlan,
  type ExportPreview,
  type ExportPreviewRequest,
} from '../model/export-plan.js';
import {
  IMPORT_CHANNELS,
  IMPORT_EVENTS,
  type ImportCommitRequest,
  type ImportCommitResult,
  type ImportPreview,
  type ImportPreviewRequest,
  type ImportSource,
  type ImportUndoRequest,
  type ImportUndoResult,
} from '../model/import-plan.js';

/**
 * The IPC contract — one source of truth for what the renderer can ask the main process
 * to do.
 *
 * Both sides import from here: the preload builds this shape, the renderer consumes it,
 * and the main process implements handlers against it. Keeping it in one file is the "no
 * second list" rule applied to the most dangerous list in the codebase.
 *
 * ## Two standing rules for anything added here
 *
 * **1. No method may return secret material as part of bulk data.** Everything that lists
 * or searches returns projections or ids. Secrets come back one at a time from
 * `credentials.revealSecret`, addressed by a closed `SecretRef` union — a free-form path
 * string would let the renderer ask for anything and force the main process to decide
 * safety by parsing. That is decision D13, and it is the difference between "a bug leaked
 * a password" and "a bug leaked every password".
 *
 * **2. Every payload is validated at runtime, on both sides.** TypeScript is erased at
 * runtime and proves nothing about what actually arrived over IPC. See `validation.ts`.
 *
 * Channel naming: `kh:<domain>:<action>`.
 */

/**
 * Spelled out rather than aliased to `NodeJS.Platform`, because `@shared` is imported by
 * the renderer, which has no Node types by design. Shared code must type-check in both
 * environments.
 */
export type Platform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd';

/**
 * How a failure reaches the renderer.
 *
 * A structured code rather than a raw `Error`: an Error crossing IPC arrives as a bare
 * message with a useless stack, and the message is exactly the thing that must not carry
 * a secret or a full filesystem path. The renderer switches on `code` and renders its own
 * copy; `message` is a fallback, already scrubbed.
 */
export interface IpcFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  /** True when retrying with different input could work — a wrong password, chiefly. */
  readonly recoverable: boolean;
}

export interface IpcSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export type IpcResult<T> = IpcSuccess<T> | IpcFailure;

export interface AppApi {
  getVersion: () => Promise<string>;
  getPlatform: () => Promise<Platform>;
}

/**
 * The clipboard's state, as the renderer sees it.
 *
 * Carries an absolute deadline as well as a duration, so a ticking countdown can be
 * derived by subtraction rather than mirrored into component state and decremented.
 */
export interface ClipboardView {
  readonly hasSecret: boolean;
  readonly clearsInMs: number | null;
  readonly clearsAt: number | null;
}

/** Mirrors `SessionStatus` in the main process, minus anything the renderer must not hold. */
export interface SessionStatusView {
  readonly state: 'no-vault' | 'locked' | 'unlocked';
  readonly vault: VaultSummary | null;
  readonly pendingVault: VaultLockedInfo | null;
  readonly throttle: {
    failedAttempts: number;
    lockedForMs: number;
    /** Absolute epoch ms, or 0. The renderer derives a live countdown from this. */
    lockedUntil: number;
    nextDelayMs: number;
  };
  readonly clipboard: ClipboardView;
  readonly quickUnlock: {
    available: boolean;
    mechanism: string;
    promptsForBiometrics: boolean;
    description: string;
    enrolledForThisVault: boolean;
  };
  readonly recentVaults: readonly {
    path: string;
    displayName: string;
    vaultId: string;
    lastOpenedAt: number;
  }[];
  readonly lastLockReason: string | null;
  readonly hasUnsavedChanges: boolean;
}

export interface SessionApi {
  status: () => Promise<IpcResult<SessionStatusView>>;
  /**
   * Opens a native file dialog and returns the chosen path.
   *
   * The dialog is opened by the MAIN process, not the renderer: a renderer-supplied path
   * would be attacker-controlled if the renderer were ever compromised, whereas a path the
   * user picked in an OS dialog is a genuine act of consent. `null` means they cancelled.
   */
  chooseVaultToOpen: () => Promise<IpcResult<string | null>>;
  chooseVaultLocation: (suggestedName?: string) => Promise<IpcResult<string | null>>;
  /** Estimates master-password strength. The password never leaves the main process. */
  estimateStrength: (password: string) => Promise<IpcResult<PasswordStrength>>;
  /** Reveals a secret and copies it, with the configured auto-clear. */
  copySecret: (ref: SecretRef) => Promise<IpcResult<ClipboardView | null>>;
  clearClipboard: () => Promise<IpcResult<ClipboardView>>;
  enrolQuickUnlock: () => Promise<IpcResult<null>>;
  revokeQuickUnlock: () => Promise<IpcResult<null>>;
  unlockWithQuickUnlock: (path: string) => Promise<IpcResult<VaultSummary | null>>;
  forgetVault: (path: string) => Promise<IpcResult<null>>;
  /** Fires whenever the session changes underneath the renderer — an auto-lock, chiefly. */
  onStatusChanged: (listener: () => void) => () => void;
}

export interface VaultApi {
  /** What can be known about a vault file without the password. */
  inspect: (path: string) => Promise<IpcResult<VaultLockedInfo>>;
  create: (path: string, password: string) => Promise<IpcResult<VaultSummary>>;
  unlock: (path: string, password: string) => Promise<IpcResult<VaultSummary>>;
  lock: () => Promise<IpcResult<null>>;
  save: () => Promise<IpcResult<VaultSummary>>;
  summary: () => Promise<IpcResult<VaultSummary | null>>;
  hasUnsavedChanges: () => Promise<IpcResult<boolean>>;
}

/**
 * What the renderer may send when creating or editing a record.
 *
 * Secret values travel INBOUND here — that is unavoidable, since the user typed them — but
 * they never travel back out except one at a time through `revealSecret`. The asymmetry is
 * the point: writing a secret is an explicit user action, reading one in bulk is not.
 */
export interface CustomFieldInput {
  readonly id: string;
  readonly label: string;
  readonly type: CustomFieldType;
  readonly value: string;
  readonly hidden: boolean;
  readonly order: number;
}

export interface CredentialInput {
  readonly title: string;
  readonly username?: string;
  readonly email?: string;
  readonly password?: string;
  readonly urls?: readonly string[];
  readonly notes?: string;
  readonly securityQuestions?: readonly SecurityQuestion[];
  readonly custom?: readonly CustomFieldInput[];
  readonly tags?: readonly string[];
  readonly folderId?: string | null;
  readonly favorite?: boolean;
}

export interface CredentialEdit extends Partial<CredentialInput> {
  readonly icon?: { kind: 'auto' | 'letter' | 'emoji' | 'custom'; value?: string };
  readonly expiresAt?: number | null;
  readonly rotationIntervalDays?: number | null;
  readonly historyEnabled?: boolean;
}

export interface CredentialsApi {
  /** Every record, as safe projections. Never contains secret material. */
  list: (options?: { includeTrashed?: boolean }) => Promise<IpcResult<CredentialProjection[]>>;
  get: (credentialId: string) => Promise<IpcResult<CredentialProjection | null>>;
  /**
   * Resolves exactly one secret. Rate-limited and TTL-scoped by the broker.
   * The one deliberate hole in the D13 boundary.
   */
  revealSecret: (ref: SecretRef) => Promise<IpcResult<string | null>>;
  /**
   * Searches inside notes, security answers and hidden custom values — data the renderer
   * does not have — and returns only matching ids. The projections it already holds are
   * enough to render the results.
   */
  deepSearch: (query: string) => Promise<IpcResult<string[]>>;

  create: (input: CredentialInput) => Promise<IpcResult<CredentialProjection>>;
  /** Returns the projection and which fields actually changed; an empty list means no-op. */
  update: (
    credentialId: string,
    edit: CredentialEdit
  ) => Promise<IpcResult<{ projection: CredentialProjection; changedFields: string[] } | null>>;
  duplicate: (credentialId: string) => Promise<IpcResult<CredentialProjection | null>>;
  /** Soft delete — restorable from Trash, and a tombstone that sync will not resurrect. */
  trash: (credentialId: string) => Promise<IpcResult<boolean>>;
  restore: (credentialId: string) => Promise<IpcResult<boolean>>;
  /** Permanent. The only call here that actually loses data. */
  purge: (credentialId: string) => Promise<IpcResult<boolean>>;
  markUsed: (credentialId: string) => Promise<IpcResult<null>>;
}

/**
 * The complete surface exposed on `window.keyhold`.
 *
 * Grows one namespace per phase: `history` (Phase 6), `generator` (Phase 8),
 * `importExport` (Phases 10–11), `sync` (Phase 12), `health` (Phase 13),
 * `settings` (Phase 14).
 */
/**
 * Password generation.
 *
 * The one API here that needs no open vault, and the one that returns plaintext secret
 * material by design. See the note above the handlers in `src/main/ipc/register.ts`: the
 * renderer has to render a generated password, and one value the user just asked to see is
 * a different proposition from the vault's worth of secrets decision D13 is about.
 */
/**
 * The engine's own bounds and defaults, as sent to the UI.
 *
 * Typed from the engine's constants rather than restated, so a control cannot be built
 * against a stale copy of "length is 8 to 256". This is the whole reason the channel
 * exists — a slider with `min={8}` typed into it is a second list.
 */
export interface GeneratorLimitsView {
  readonly limits: Readonly<Record<GeneratorLimitName, GeneratorRange>>;
  readonly defaults: GeneratorDefaults;
}

export interface GeneratorApi {
  generate: (options: GeneratorOptions) => Promise<IpcResult<GeneratedPassword>>;
  /** The entropy a configuration *would* produce, without producing a password for it. */
  estimate: (options: GeneratorOptions) => Promise<IpcResult<number>>;
  /** Bounds and defaults, read across the contract so no control restates them. */
  limits: () => Promise<IpcResult<GeneratorLimitsView>>;
}

export interface HealthApi {
  /** The offline analysis. Contains no secret material by construction. */
  analyse: (options?: {
    enabledRules?: Partial<Record<HealthRuleId, boolean>>;
    thresholds?: Partial<HealthThresholds>;
  }) => Promise<IpcResult<VaultHealthReport>>;
}

export interface HistoryApi {
  /** What one edit changed. Secret values cross only as lengths. */
  diff: (
    credentialId: string,
    versionNumber: number
  ) => Promise<IpcResult<FieldDiffProjection[] | null>>;
  compare: (
    credentialId: string,
    from: HistoryPointRef,
    to: HistoryPointRef
  ) => Promise<IpcResult<FieldDiffProjection[] | null>>;
  /** Puts the record back to the state before that edit, recording the restore itself. */
  restoreVersion: (
    credentialId: string,
    versionNumber: number
  ) => Promise<IpcResult<{ projection: CredentialProjection; changedFields: string[] } | null>>;
  restoreField: (
    credentialId: string,
    versionNumber: number,
    field: VersionedField
  ) => Promise<IpcResult<{ projection: CredentialProjection; changedFields: string[] } | null>>;
  /** Deliberately not itself versioned — see `VaultService.clearHistory`. */
  clear: (credentialId: string) => Promise<IpcResult<boolean>>;
  /**
   * The network name the app would record right now, for the settings screen.
   * `null` when it cannot be determined — which is a normal answer, not an error.
   */
  networkName: () => Promise<IpcResult<string | null>>;
}

/**
 * Folders and tags.
 *
 * Every operation returns the whole snapshot rather than a patch. Folders are a tree with
 * sibling ordering, and tags are renumbered and re-keyed across records — so a partial
 * update would leave the renderer reconstructing state the main process already computed,
 * and the two would eventually disagree. A vault's folder and tag lists are small; the
 * round trip is not the cost worth optimising.
 */
export interface OrganisationApi {
  list: () => Promise<IpcResult<OrganisationSnapshot>>;

  createFolder: (name: string, parentId: string | null) => Promise<IpcResult<OrganisationSnapshot>>;
  renameFolder: (folderId: string, name: string) => Promise<IpcResult<OrganisationSnapshot>>;
  /** `parentId: null` is the top level. Refused if it would create a cycle. */
  moveFolder: (
    folderId: string,
    parentId: string | null,
    index?: number
  ) => Promise<IpcResult<OrganisationSnapshot>>;
  /** The caller chooses what happens to the records; there is no "delete the contents". */
  deleteFolder: (
    folderId: string,
    policy: FolderDeletePolicyName
  ) => Promise<IpcResult<OrganisationDeleteResult>>;

  createTag: (name: string, colour: string) => Promise<IpcResult<OrganisationSnapshot>>;
  /** Renames the tag and every record carrying it. */
  renameTag: (tagId: string, name: string) => Promise<IpcResult<OrganisationDeleteResult>>;
  setTagColour: (tagId: string, colour: string) => Promise<IpcResult<OrganisationSnapshot>>;
  deleteTag: (tagId: string) => Promise<IpcResult<OrganisationDeleteResult>>;
}

export interface OrganisationSnapshot {
  readonly folders: readonly Folder[];
  readonly tags: readonly Tag[];
}

/** A snapshot plus how many records the operation touched, so the UI can say so. */
export interface OrganisationDeleteResult {
  readonly snapshot: OrganisationSnapshot;
  readonly affectedRecords: number;
}

export type FolderDeletePolicyName = 'reparent' | 'unfile';

/**
 * Settings.
 *
 * Two scopes, and the split is the whole point: `machine` settings live in app preferences
 * and stay on this computer, `vault` settings live inside the encrypted body and travel with
 * the file. A user who cannot tell which is which will be surprised by a security setting,
 * and being surprised by a security setting is the problem this screen exists to remove.
 *
 * Both updates are **merges**, so a caller sending one field cannot silently reset the rest
 * to whatever its own defaults happened to be.
 */
export interface SettingsApi {
  read: () => Promise<IpcResult<SettingsView>>;
  updateMachine: (patch: Record<string, unknown>) => Promise<IpcResult<SettingsView>>;
  updateVault: (patch: Record<string, unknown>) => Promise<IpcResult<SettingsView>>;
  /** Returns how many versions were removed, so the UI can say what it cost. */
  clearAllHistory: () => Promise<IpcResult<number>>;
}

/**
 * Everything the settings screen renders in one read. Contains no secret material.
 *
 * `SettingsSnapshot`, not a shape of its own. There were briefly two — this file described
 * what the channel returns, and `@shared/model/settings-plan.ts` described what the screen
 * consumes — and they had already drifted: the screen's version carried the vault's display
 * name and the quick-unlock summary, and the channel's did not. So the screen could not have
 * been wired to the channel without either widening one or writing an adapter, and an
 * adapter between two descriptions of the same payload is the second list wearing a
 * function.
 *
 * The screen's shape wins because it is the one written against what a person needs to see.
 */
export type SettingsView = SettingsSnapshot;

/**
 * Attachments.
 *
 * The renderer never names a path, in either direction. `add` opens a file dialog in the main
 * process and reads the bytes there; `save` opens a save dialog and writes them there. A path
 * chosen by the renderer would be attacker-controlled if the renderer were ever compromised,
 * and a path the user picked in an OS dialog is a genuine act of consent — the same rule that
 * governs opening a vault.
 *
 * **The bytes never cross this bridge.** There is deliberately no `read`: an attachment can be
 * tens of megabytes and can be a photograph of a passport, and moving it into the renderer
 * would put it in a process that must not hold secret material, to no end — the two things a
 * user does with an attachment are look at it and save it, and both can happen in main.
 */
export interface AttachmentsApi {
  /** Opens a file dialog, reads the file, and attaches it. `null` if the user cancelled. */
  add: (credentialId: string) => Promise<IpcResult<AttachmentAddView | null>>;
  remove: (credentialId: string, attachmentId: string) => Promise<IpcResult<boolean>>;
  /** Opens a save dialog and writes the file. Resolves to the basename written, or `null`. */
  save: (credentialId: string, attachmentId: string) => Promise<IpcResult<string | null>>;
  /** Orphans in both directions. Reported, never repaired. */
  audit: () => Promise<IpcResult<AttachmentAudit>>;
}

/**
 * Exporting.
 *
 * No channel hands bytes back. `run` writes the file itself, after opening the save dialog
 * itself, and returns only where it went -- see {@link EXPORT_CHANNELS} for why that is the
 * whole surface rather than a convenience.
 *
 * `preview` carries no passphrase and no confirmation by type, because a preview happens
 * before the user has been asked for either and a request shape that *could* carry a
 * passphrase is one that eventually does.
 */
export interface ExporterApi {
  formats: () => Promise<IpcResult<readonly ExportFormatDescriptor[]>>;
  preview: (request: ExportPreviewRequest) => Promise<IpcResult<ExportPreview>>;
  /** Opens the save dialog, writes the file, and reports the outcome. Cancelling is not an error. */
  run: (plan: ExportPlan) => Promise<IpcResult<ExportOutcome>>;
}

/**
 * Importing.
 *
 * The main process owns the file: `chooseFile` opens the dialog, reads the bytes and keeps
 * them, and hands back a descriptor with an opaque id. The renderer never learns the path
 * and never sees a byte of a file that is, at that moment, a plaintext dump of every
 * password the user has.
 *
 * `discard` is not optional politeness. It is how those bytes stop existing, and the wizard
 * calls it on every exit -- finish, cancel, or unmount.
 */
export interface ImporterApi {
  formats: () => Promise<IpcResult<readonly ImportFormatDescriptor[]>>;
  chooseFile: () => Promise<IpcResult<ImportSource | null>>;
  preview: (request: ImportPreviewRequest) => Promise<IpcResult<ImportPreview>>;
  commit: (request: ImportCommitRequest) => Promise<IpcResult<ImportCommitResult>>;
  undo: (request: ImportUndoRequest) => Promise<IpcResult<ImportUndoResult>>;
  discard: (sourceId: string) => Promise<IpcResult<null>>;
}

export interface KeyholdApi {
  app: AppApi;
  session: SessionApi;
  vault: VaultApi;
  credentials: CredentialsApi;
  generator: GeneratorApi;
  health: HealthApi;
  history: HistoryApi;
  organisation: OrganisationApi;
  settings: SettingsApi;
  attachments: AttachmentsApi;
  exporter: ExporterApi;
  importer: ImporterApi;
}

/** IPC channel names. Never build one by string concatenation at a call site. */
export const CHANNELS = {
  appGetVersion: 'kh:app:get-version',
  appGetPlatform: 'kh:app:get-platform',

  vaultInspect: 'kh:vault:inspect',
  vaultCreate: 'kh:vault:create',
  vaultUnlock: 'kh:vault:unlock',
  vaultLock: 'kh:vault:lock',
  vaultSave: 'kh:vault:save',
  vaultSummary: 'kh:vault:summary',
  vaultHasUnsavedChanges: 'kh:vault:has-unsaved-changes',

  sessionStatus: 'kh:session:status',
  sessionChooseVaultToOpen: 'kh:session:choose-vault-to-open',
  sessionChooseVaultLocation: 'kh:session:choose-vault-location',
  sessionEstimateStrength: 'kh:session:estimate-strength',
  sessionCopySecret: 'kh:session:copy-secret',
  sessionClearClipboard: 'kh:session:clear-clipboard',
  sessionEnrolQuickUnlock: 'kh:session:enrol-quick-unlock',
  sessionRevokeQuickUnlock: 'kh:session:revoke-quick-unlock',
  sessionUnlockWithQuickUnlock: 'kh:session:unlock-with-quick-unlock',
  sessionForgetVault: 'kh:session:forget-vault',

  credentialsList: 'kh:credentials:list',
  credentialsGet: 'kh:credentials:get',
  credentialsRevealSecret: 'kh:credentials:reveal-secret',
  credentialsDeepSearch: 'kh:credentials:deep-search',
  credentialsCreate: 'kh:credentials:create',
  credentialsUpdate: 'kh:credentials:update',
  credentialsDuplicate: 'kh:credentials:duplicate',
  credentialsTrash: 'kh:credentials:trash',
  credentialsRestore: 'kh:credentials:restore',
  credentialsPurge: 'kh:credentials:purge',
  credentialsMarkUsed: 'kh:credentials:mark-used',

  generatorGenerate: 'kh:generator:generate',
  generatorEstimate: 'kh:generator:estimate',
  generatorLimits: 'kh:generator:limits',

  healthAnalyse: 'kh:health:analyse',

  historyDiff: 'kh:history:diff',
  historyCompare: 'kh:history:compare',
  historyRestoreVersion: 'kh:history:restore-version',
  historyRestoreField: 'kh:history:restore-field',
  historyClear: 'kh:history:clear',
  historyNetworkName: 'kh:history:network-name',

  organisationList: 'kh:organisation:list',
  foldersCreate: 'kh:folders:create',
  foldersRename: 'kh:folders:rename',
  foldersMove: 'kh:folders:move',
  foldersDelete: 'kh:folders:delete',
  tagsCreate: 'kh:tags:create',
  tagsRename: 'kh:tags:rename',
  tagsSetColour: 'kh:tags:set-colour',
  tagsDelete: 'kh:tags:delete',

  settingsRead: 'kh:settings:read',
  settingsUpdateMachine: 'kh:settings:update-machine',
  settingsUpdateVault: 'kh:settings:update-vault',
  settingsClearAllHistory: 'kh:settings:clear-all-history',

  attachmentsAdd: 'kh:attachments:add',
  attachmentsRemove: 'kh:attachments:remove',
  attachmentsSave: 'kh:attachments:save',
  attachmentsAudit: 'kh:attachments:audit',

  // Spread, not restated. Both groups declare their names beside the payload types they
  // carry, and a name that exists in two places is a name that will disagree with itself.
  ...EXPORT_CHANNELS,
  ...IMPORT_CHANNELS,
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

/**
 * Main → renderer events.
 *
 * Separate from CHANNELS because the direction matters: these are pushed, not requested,
 * and the preload exposes only a subscribe function — never a general listener that would
 * let the renderer attach to any channel it liked.
 */
export const EVENTS = {
  sessionChanged: 'kh:event:session-changed',
  ...IMPORT_EVENTS,
} as const;

/** Every channel name, for the allow-list check in the main process. */
export const ALL_CHANNELS: readonly ChannelName[] = Object.values(CHANNELS);
