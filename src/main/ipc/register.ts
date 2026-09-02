// SPDX-License-Identifier: GPL-3.0-or-later
import { ipcMain } from 'electron';
import { CHANNELS, type IpcResult } from '@shared/ipc/api.js';
import {
  IpcValidationError,
  requireId,
  requireListOptions,
  requireNonEmptyString,
  requireSecretRef,
  requireVaultPath,
} from '@shared/ipc/validation.js';
import { VaultError } from '../crypto/errors.js';
import { RateLimitExceededError } from '../vault/secret-broker.js';
import { VaultService } from '../vault/vault-service.js';

/**
 * Registers every IPC handler.
 *
 * Three properties this file exists to guarantee:
 *
 * **1. Every handler validates its arguments before touching the vault.** The renderer is
 * semi-trusted (decision D13) and the type annotations are erased at runtime.
 *
 * **2. No error ever crosses the boundary raw.** `toFailure` converts everything into a
 * structured result with a scrubbed message. An unhandled throw in an `ipcMain.handle`
 * serialises the error's `message` and `stack` straight into the renderer, and a stack
 * carries absolute filesystem paths — which is a small but free information leak, on
 * every single error, forever.
 *
 * **3. Handlers return results, never throw.** The renderer gets a discriminated union it
 * has to look at, rather than a rejected promise it might not catch.
 */

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

  // Anything else is a bug. Report that it happened, and deliberately NOT what it was:
  // an arbitrary error message may contain a path, a filename, or — from a crypto library
  // — a fragment of the data being processed.
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
      // Logged at `error` level with the real cause, which stays in this process. Only the
      // scrubbed version crosses the bridge.
      console.error(`[ipc] ${channel} failed:`, error);
      return toFailure(error);
    }
  });
}

export interface IpcContext {
  readonly vault: VaultService;
  readonly appVersion: string;
}

export function registerIpcHandlers(context: IpcContext): void {
  const { vault } = context;

  // ── app ────────────────────────────────────────────────────────────────────
  handle(CHANNELS.appGetVersion, () => context.appVersion);
  handle(CHANNELS.appGetPlatform, () => process.platform);

  // ── vault ──────────────────────────────────────────────────────────────────
  handle(CHANNELS.vaultInspect, async (path) =>
    VaultService.inspect(requireVaultPath(CHANNELS.vaultInspect, path))
  );

  handle(CHANNELS.vaultCreate, async (path, password) =>
    vault.createVault({
      path: requireVaultPath(CHANNELS.vaultCreate, path),
      password: requireNonEmptyString(CHANNELS.vaultCreate, password, 'password'),
    })
  );

  handle(CHANNELS.vaultUnlock, async (path, password) =>
    vault.unlock(
      requireVaultPath(CHANNELS.vaultUnlock, path),
      requireNonEmptyString(CHANNELS.vaultUnlock, password, 'password')
    )
  );

  handle(CHANNELS.vaultLock, () => {
    vault.lock();
    return null;
  });

  handle(CHANNELS.vaultSave, async () => vault.save());

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
}

/** Removes every handler. Used on quit so nothing answers during teardown. */
export function unregisterIpcHandlers(): void {
  for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler(channel);
}
