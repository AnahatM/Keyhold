// SPDX-License-Identifier: GPL-3.0-or-later
import type { CredentialProjection, SecretRef } from '../model/credential.js';
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

  credentialsList: 'kh:credentials:list',
  credentialsGet: 'kh:credentials:get',
  credentialsRevealSecret: 'kh:credentials:reveal-secret',
  credentialsDeepSearch: 'kh:credentials:deep-search',
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

/** Every channel name, for the allow-list check in the main process. */
export const ALL_CHANNELS: readonly ChannelName[] = Object.values(CHANNELS);
