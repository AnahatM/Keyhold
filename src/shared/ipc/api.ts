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
import type { BreachAvailability, BreachReport } from '../model/breach.js';
import type { RecoveryReport } from '../model/recovery.js';
import type { TotpCodeView } from '../model/totp.js';
import type { CredentialType } from '../model/credential.js';
import type { MirrorStatusView } from '../model/settings-plan.js';
import type { HealthRuleId, HealthThresholds, VaultHealthReport } from '../model/health.js';
import type { FieldDiffProjection, HistoryPointRef } from '../model/history.js';
import type { PasswordStrength } from '../model/strength.js';
import type { Folder, Tag, VaultLockedInfo, VaultSummary } from '../model/vault-document.js';
import type { MenuCommandId } from '../model/menu-commands.js';
import type { KdfProgressView } from '../model/kdf-progress.js';
import type { VaultChangedExternally } from '../model/vault-change.js';
import type { KdfCost, SettingsSnapshot } from '../model/settings-plan.js';
import type { ActivityEntry, ActivitySnapshot } from '../model/activity.js';
import type { SavedSearch } from '../model/saved-search.js';
import type { SiteRule } from '../model/site-rules.js';
import type { AttachmentAddView, AttachmentAudit, AttachmentPreview } from '../model/attachment.js';
import type { ExportFormatDescriptor } from '../model/export.js';
import {
  EXPORT_CHANNELS,
  type ExportOutcome,
  type ExportPlan,
  type ExportPreview,
  type ExportPreviewRequest,
} from '../model/export-plan.js';
import type { ImporterApi } from '../model/import-plan.js';
import { SYNC_CHANNELS, type SyncApi } from '../model/sync-plan.js';
import { THEME_CHANNELS, THEME_EVENTS, type ThemeApi } from '../theme/theme-channels.js';
import { IMPORT_CHANNELS, IMPORT_EVENTS } from '../model/import-plan.js';

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
  /**
   * Subscribes to native menu and tray commands the main process could not handle itself.
   *
   * Returns an unsubscribe function, the same shape as `session.onStatusChanged`. There is
   * no general `on(channel, fn)` here and never will be: that would be the receive-side
   * equivalent of exposing `invoke`, letting the renderer attach to any event the main
   * process ever emits, including ones added later by someone who never read this file.
   */
  onMenuCommand: (listener: (command: MenuCommandId) => void) => () => void;
  /**
   * Subscribes to the vault file changing on disk underneath the open vault.
   *
   * Same shape as the others: one fixed channel, an unsubscribe returned, the
   * `IpcRendererEvent` hidden.
   */
  onVaultChangedExternally: (listener: (change: VaultChangedExternally) => void) => () => void;
  /**
   * Subscribes to the Argon2 progress estimate, for every derivation this session runs.
   *
   * Same shape as the others. Pushed rather than polled because the renderer has no way to
   * know a derivation started — it made one call and is waiting on one promise.
   */
  onKdfProgress: (listener: (progress: KdfProgressView) => void) => () => void;
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
  /**
   * Re-reads the open vault from disk, keeping the key.
   *
   * The response to `onVaultChangedExternally`. Fails with `UNSAVED_CHANGES` when there are
   * edits only in memory — a reload is a read that destroys, and there is no undo for a
   * record that was never written — and with `DIFFERENT_VAULT` when the file at this path is
   * no longer the vault that was opened.
   */
  reload: () => Promise<IpcResult<VaultSummary>>;
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
  /**
   * What kind of record this is. Defaults to `login`.
   *
   * Optional on the way in so every existing caller keeps working, and defaulted in one place
   * — `credential-ops.ts` — rather than at each call site. A record's type only decides which
   * fields the editor leads with and which icon the list draws; it never changes what is
   * stored, what is secret, or how anything is merged.
   */
  readonly type?: CredentialType;
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

/**
 * The one check that leaves the machine.
 *
 * Two channels and no third, deliberately. There is no "check this one password" channel:
 * a single-record check is one request for one answer, while a sweep shares one range lookup
 * between every password whose hash starts the same way — so the per-record version would
 * make *more* requests to somebody else's free service to answer less. The sweep's report
 * carries a per-record result, which is what a per-record UI renders.
 *
 * There is also no channel that turns the check **on**. That is `settings.updateVault`,
 * because the opt-in is a vault setting like any other and a second way to set it would be a
 * second place for the default to be wrong. What this API does is *report* whether it is on,
 * and why not — see `BreachAvailability`.
 */
/**
 * One-time codes for `otp-secret` custom fields.
 *
 * One channel: the seed stays in main and the code is fetched per look, the same shape as
 * `credentials.revealSecret`. There is deliberately no "give me every code in the vault"
 * channel — that would put a live authentication factor for every account in one renderer
 * message, which is the opposite of the per-reveal design.
 */
export interface TotpApi {
  /** `null` when the record, the field, or its `otp-secret` type is not there. */
  code: (credentialId: string, fieldId: string) => Promise<IpcResult<TotpCodeView | null>>;
}

/**
 * Diagnostics for a vault that will not open.
 *
 * Reads the container **without a password**, so it answers on a file nobody can unlock —
 * which is the whole situation it exists for. The report carries no user content: no secret,
 * no record title, no folder name, and no path beyond a basename, which is what makes it
 * safe to attach to a bug report.
 *
 * Neither diagnose channel takes a path. `diagnose` uses the open vault's; `diagnoseFile`
 * opens a dialog in the main process and the user picks. A path travelling renderer → main
 * would be attacker-controlled if the renderer were ever compromised.
 */
export interface RecoveryApi {
  /** Diagnoses the currently open vault. Fails when none is open. */
  diagnose: () => Promise<IpcResult<RecoveryReport>>;
  /** Opens a file dialog and diagnoses whatever is chosen. `null` when cancelled. */
  diagnoseFile: () => Promise<IpcResult<RecoveryReport | null>>;
  /**
   * Writes the most recent report to a file the user picks. Returns its basename, or `null`
   * when the dialog was dismissed.
   *
   * Takes **no argument**: the main process keeps the last report it produced and renders
   * that. Accepting one back from the renderer would mean validating a large nested structure
   * at the boundary and then writing renderer-supplied text into a file the user believes
   * Keyhold wrote.
   */
  saveReport: () => Promise<IpcResult<string | null>>;
}

export interface BreachApi {
  /** Whether a check can run, and which switch to change if not. Polled, never pushed. */
  availability: () => Promise<IpcResult<BreachAvailability>>;
  /**
   * Sweeps the open vault.
   *
   * Slow by design — the client paces itself so it is not abusing a free service — so the
   * caller must expect this to take seconds on a real vault and show that it is working.
   * Returns a report containing no secret material: a hit count is reduced to a band before
   * it crosses, and no hash, prefix or suffix exists on this side of the bridge at all.
   */
  run: () => Promise<IpcResult<BreachReport>>;
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
  /**
   * Writes one credential's audit trail to a file the user picks.
   *
   * **Provenance, not passwords** — decision D27. Every secret is a length, because the export
   * is built from the same safe projection the renderer receives and every field is named on
   * the way out rather than copied. That is why this needs no type-to-confirm and no shred
   * reminder, unlike the full export, which really does write plaintext.
   *
   * Returns the chosen file's **name**, never its path, or `null` when the dialog was
   * dismissed. The dialog opens and the file is written in the main process.
   */
  exportHistory: (credentialId: string) => Promise<IpcResult<string | null>>;
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
/**
 * What this session has done.
 *
 * One channel, and a poll rather than a push. The log is a bounded in-memory ring the main
 * process appends to on nearly every action, so an event per entry would be a stream of IPC
 * traffic to feed a panel that is usually closed — and the panel is a thing people open to
 * answer a question, not a feed they watch.
 *
 * The payload carries no secret material and no record titles: `ActivityEntry` has no field
 * that could hold either, which is stated and guarded in `@shared/model/activity.ts`. It
 * carries record *ids*, and only when the vault's own audit-privacy level allows them.
 */
export interface ActivityApi {
  read: () => Promise<IpcResult<ActivityView>>;
}

/**
 * The snapshot plus the notice from the last lock.
 *
 * The lock entry is the one thing the log does not store — `locked()` clears the ring and
 * returns the notice — so without carrying it separately a renderer reading the log after a
 * lock would find an empty list and no way to say why the vault closed.
 */
export interface ActivityView {
  readonly snapshot: ActivitySnapshot;
  readonly lastLock: ActivityEntry | null;
}

/**
 * Saved searches — named queries stored in the vault.
 *
 * Every method answers with the **whole list**, never with just the entry it touched. The
 * list is small and hard-capped, and a renderer that has to splice a returned entry into its
 * own copy is a renderer that will eventually splice it wrong — an ordering bug that shows
 * up as a shortcut appearing in the wrong place and nowhere else. The folder and tag channels
 * settled this the same way for the same reason.
 *
 * Nothing here carries secret material. A query is text the user typed into the search box,
 * and the search box has never had access to secrets — `deepSearch` runs in the main process
 * precisely so it does not.
 */
export interface SavedSearchApi {
  read: () => Promise<IpcResult<readonly SavedSearch[]>>;
  create: (name: string, query: string) => Promise<IpcResult<readonly SavedSearch[]>>;
  update: (
    searchId: string,
    patch: { readonly name?: string; readonly query?: string }
  ) => Promise<IpcResult<readonly SavedSearch[]>>;
  remove: (searchId: string) => Promise<IpcResult<readonly SavedSearch[]>>;
}

/**
 * Per-site generator rules — what a particular site will accept.
 *
 * The whole rule crosses the bridge, unlike anything under a credential's `fields`. A rule
 * holds a host, a partial generator config and a note the user wrote about the site; none of
 * that is secret material, and the renderer needs all of it to generate a password that the
 * site will take and to say *why* the result was shorter than usual.
 *
 * `set` is an upsert keyed by host, so the renderer never has to know whether a rule already
 * exists — see `VaultService.setSiteRule`.
 */
export interface SiteRuleApi {
  read: () => Promise<IpcResult<readonly SiteRule[]>>;
  set: (
    url: string,
    options: Record<string, unknown>,
    note?: string
  ) => Promise<IpcResult<readonly SiteRule[]>>;
  remove: (host: string) => Promise<IpcResult<readonly SiteRule[]>>;
}

export interface SettingsApi {
  read: () => Promise<IpcResult<SettingsView>>;
  updateMachine: (patch: Record<string, unknown>) => Promise<IpcResult<SettingsView>>;
  updateVault: (patch: Record<string, unknown>) => Promise<IpcResult<SettingsView>>;
  /**
   * Opens a folder dialog and sets the off-machine backup destination.
   *
   * Takes no path, like every other dialog in the app: a path travelling renderer → main
   * would be attacker-controlled if the renderer were ever compromised. Returns the updated
   * settings, or `null` when the dialog was dismissed.
   */
  chooseMirrorDirectory: () => Promise<IpcResult<SettingsView | null>>;
  /** What happened to the most recent off-machine copy. Polled, never pushed. */
  mirrorStatus: () => Promise<IpcResult<MirrorStatusView | null>>;
  /** Returns how many versions were removed, so the UI can say what it cost. */
  clearAllHistory: () => Promise<IpcResult<number>>;
  /**
   * Re-wraps the data key under a new master password.
   *
   * Both secrets cross the bridge, which is the one direction that is safe: a password
   * typed by the user is already in the renderer, and the alternative — a main-process
   * prompt window — would be a second place that collects master passwords. Neither is
   * stored, neither is logged, and nothing about either comes back.
   *
   * Returns nothing on purpose. The only thing this changes that the screen renders is the
   * KDF salt, which is not shown; answering with a snapshot would imply there is something
   * to look at. The `null` also means a mistaken `console.log` of the result cannot print
   * anything about the vault's keys.
   */
  changeMasterPassword: (currentSecret: string, nextSecret: string) => Promise<IpcResult<null>>;
  /**
   * Re-derives the key-encryption key at a new Argon2 cost, under the same password.
   *
   * Needs the current password because the cost lives in the header the password derives
   * against: there is no way to raise it without deriving once at the old cost to prove the
   * password, and once at the new one to store it.
   */
  rekey: (currentSecret: string, cost: KdfCost) => Promise<IpcResult<SettingsView>>;
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
  /**
   * The bytes of one attachment, for an in-app viewer.
   *
   * **The one channel here that hands over content**, and it is a deliberate exception
   * rather than a gap. `SecretRef` has carried an `'attachment'` kind since the broker was
   * written, and `readAttachment` has always gone through it — one item per request, rate
   * limited, every grant dropped on lock, and the digest verified before the bytes are
   * returned. This exposes the door that was already built rather than opening a new one.
   *
   * `null` when the record or attachment is gone, or when the detected kind is not one a
   * viewer will render. The refusal is the main process's to make: a renderer that decided
   * for itself which types are safe to display would be the renderer choosing its own
   * attack surface.
   */
  preview: (
    credentialId: string,
    attachmentId: string
  ) => Promise<IpcResult<AttachmentPreview | null>>;
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
 * Importing — the namespace declared in `@shared/model/import-plan.ts`, beside its payloads.
 *
 * Re-exported rather than restated. It was briefly written out here in full, and the two
 * copies had already diverged by the time anything used both: this one was missing
 * `onProgress`, so the wizard's progress subscription would not have compiled against the
 * bridge it is handed. Exactly what the model file's own comment warned about — "one line
 * rather than a second copy of nine signatures".
 */
export type { ImporterApi };

/**
 * Themes — the namespace declared in `@shared/theme/theme-channels.ts`, beside its payloads.
 *
 * Re-exported rather than restated, for the reason `ImporterApi` is: it was written out here
 * once, the two copies diverged before anything used both, and the divergence was a method
 * the preload never exposed.
 */
export type { ThemeApi };

/**
 * Merging another copy of this vault — the namespace declared in
 * `@shared/model/sync-plan.ts`, beside its payloads.
 *
 * Re-exported rather than restated. Nothing in it can be made to hand over a credential:
 * the report carries lengths, the choice is a side by name, and the merge re-runs in main.
 */
export type { SyncApi };

export interface KeyholdApi {
  app: AppApi;
  session: SessionApi;
  vault: VaultApi;
  credentials: CredentialsApi;
  generator: GeneratorApi;
  health: HealthApi;
  breach: BreachApi;
  totp: TotpApi;
  recovery: RecoveryApi;
  history: HistoryApi;
  organisation: OrganisationApi;
  settings: SettingsApi;
  activity: ActivityApi;
  searches: SavedSearchApi;
  siteRules: SiteRuleApi;
  attachments: AttachmentsApi;
  exporter: ExporterApi;
  importer: ImporterApi;
  theme: ThemeApi;
  sync: SyncApi;
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
  vaultReload: 'kh:vault:reload',

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

  totpCode: 'kh:totp:code',

  recoveryDiagnose: 'kh:recovery:diagnose',
  recoveryDiagnoseFile: 'kh:recovery:diagnose-file',
  recoverySaveReport: 'kh:recovery:save-report',

  breachAvailability: 'kh:breach:availability',
  breachRun: 'kh:breach:run',

  historyDiff: 'kh:history:diff',
  historyCompare: 'kh:history:compare',
  historyRestoreVersion: 'kh:history:restore-version',
  historyRestoreField: 'kh:history:restore-field',
  historyClear: 'kh:history:clear',
  historyExport: 'kh:history:export',
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
  settingsChooseMirror: 'kh:settings:choose-mirror',
  settingsMirrorStatus: 'kh:settings:mirror-status',
  settingsClearAllHistory: 'kh:settings:clear-all-history',
  settingsChangeMasterPassword: 'kh:settings:change-master-password',
  settingsRekey: 'kh:settings:rekey',

  activityList: 'kh:activity:list',

  searchesList: 'kh:searches:list',
  searchesCreate: 'kh:searches:create',
  searchesUpdate: 'kh:searches:update',
  searchesDelete: 'kh:searches:delete',

  siteRulesList: 'kh:site-rules:list',
  siteRulesSet: 'kh:site-rules:set',
  siteRulesDelete: 'kh:site-rules:delete',

  attachmentsAdd: 'kh:attachments:add',
  attachmentsRemove: 'kh:attachments:remove',
  attachmentsSave: 'kh:attachments:save',
  attachmentsAudit: 'kh:attachments:audit',
  attachmentsPreview: 'kh:attachments:preview',

  // Spread, not restated. Both groups declare their names beside the payload types they
  // carry, and a name that exists in two places is a name that will disagree with itself.
  ...EXPORT_CHANNELS,
  ...IMPORT_CHANNELS,
  ...THEME_CHANNELS,
  ...SYNC_CHANNELS,
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
  /**
   * A native menu or tray item was chosen and the app cannot act on it in the main process.
   *
   * Pushed, not requested, because a menu click originates outside the renderer entirely.
   * The payload is a `MenuCommandId` and the preload refuses anything else — see
   * `@shared/model/menu-commands.ts` for why that list is shared rather than duplicated.
   */
  menuCommand: 'kh:event:menu-command',
  /**
   * The vault file on disk stopped matching the one we have open.
   *
   * Pushed, because nothing in the renderer could have asked: the change came from another
   * device, a cloud client, or the same app on another machine. The payload carries
   * generations and two booleans and **never a path** — the renderer has no use for one and
   * this is not the direction paths travel.
   */
  vaultChangedExternally: 'kh:event:vault-changed-externally',
  kdfProgress: 'kh:event:kdf-progress',
  ...IMPORT_EVENTS,
  ...THEME_EVENTS,
} as const;

/** Every channel name, for the allow-list check in the main process. */
export const ALL_CHANNELS: readonly ChannelName[] = Object.values(CHANNELS);
