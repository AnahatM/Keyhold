// SPDX-License-Identifier: GPL-3.0-or-later
import type { CredentialProjection, SecretRef } from '../model/credential.js';
import type { PasswordStrength } from '../model/strength.js';
import type { VaultLockedInfo, VaultSummary } from '../model/vault-document.js';

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
}

/**
 * The complete surface exposed on `window.keyhold`.
 *
 * Grows one namespace per phase: `history` (Phase 6), `generator` (Phase 8),
 * `importExport` (Phases 10–11), `sync` (Phase 12), `health` (Phase 13),
 * `settings` (Phase 14).
 */
export interface KeyholdApi {
  app: AppApi;
  session: SessionApi;
  vault: VaultApi;
  credentials: CredentialsApi;
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
} as const;

/** Every channel name, for the allow-list check in the main process. */
export const ALL_CHANNELS: readonly ChannelName[] = Object.values(CHANNELS);
