// SPDX-License-Identifier: GPL-3.0-or-later
import { basename } from 'node:path';
import {
  dialog,
  ipcMain,
  type BrowserWindow,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import { CHANNELS, EVENTS, type IpcResult } from '@shared/ipc/api.js';
import {
  requireCredentialEdit,
  requireCredentialInput,
} from '@shared/ipc/credential-validation.js';
import {
  IpcValidationError,
  requireId,
  requireListOptions,
  requireNonEmptyString,
  requireSecretRef,
  requireString,
  requireVaultPath,
} from '@shared/ipc/validation.js';
import { VaultError } from '../crypto/errors.js';
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
  readonly getWindow: () => BrowserWindow | null;
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
