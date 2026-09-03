// SPDX-License-Identifier: GPL-3.0-or-later
import { create } from 'zustand';
import type { IpcResult, SessionStatusView } from '@shared/ipc/api.js';
import type { CredentialProjection } from '@shared/model/credential.js';
import type { PasswordStrength } from '@shared/model/strength.js';

/**
 * The renderer's view of the session.
 *
 * Holds only what came back through the safe projection and the status endpoint — no keys,
 * no passwords, no secret material (decision D13). A password typed into a form lives in
 * component state for the moment it takes to send it, and is never stored here.
 *
 * **The main process is the source of truth.** Every mutation re-reads status rather than
 * predicting it locally: an auto-lock can happen at any instant for reasons the renderer
 * cannot see, and a UI that assumes it knows the lock state will confidently render an
 * unlocked vault that is already closed.
 */

/** Unwraps an `IpcResult`, turning a failure into a thrown error with its code attached. */
export class IpcError extends Error {
  readonly code: string;
  readonly recoverable: boolean;

  constructor(code: string, message: string, recoverable: boolean) {
    super(message);
    this.name = 'IpcError';
    this.code = code;
    this.recoverable = recoverable;
  }
}

export function unwrap<T>(result: IpcResult<T>): T {
  if (result.ok) return result.value;
  throw new IpcError(result.code, result.message, result.recoverable);
}

export type Screen = 'welcome' | 'create' | 'unlock' | 'vault';

interface SessionState {
  readonly status: SessionStatusView | null;
  readonly credentials: readonly CredentialProjection[];
  readonly screen: Screen;
  /** The vault the create/unlock screens are working on. */
  readonly workingPath: string | null;
  readonly busy: boolean;
  readonly error: string | null;

  refresh: () => Promise<void>;
  goTo: (screen: Screen, path?: string | null) => void;
  setError: (message: string | null) => void;

  chooseExistingVault: () => Promise<void>;
  chooseNewVaultLocation: () => Promise<void>;
  createVault: (password: string) => Promise<boolean>;
  unlockVault: (password: string) => Promise<boolean>;
  tryQuickUnlock: (path: string) => Promise<boolean>;
  lock: () => Promise<void>;
  /** Re-reads the open vault after another device wrote it. Throws if that would lose data. */
  reloadFromDisk: () => Promise<void>;
  forgetVault: (path: string) => Promise<void>;
  estimateStrength: (password: string) => Promise<PasswordStrength | null>;
}

/**
 * Chooses the screen from the session's own state.
 *
 * Derived rather than stored, so the UI cannot disagree with the main process about
 * whether a vault is open. When an auto-lock fires, the next refresh moves the screen on
 * its own — no separate "handle the lock event" path that could be forgotten.
 */
function screenFor(status: SessionStatusView | null): Screen {
  if (status === null) return 'welcome';
  if (status.state === 'unlocked') return 'vault';
  if (status.state === 'locked') return 'unlock';
  return 'welcome';
}

export const useSession = create<SessionState>((set, get) => ({
  status: null,
  credentials: [],
  screen: 'welcome',
  workingPath: null,
  busy: false,
  error: null,

  refresh: async () => {
    const status = unwrap(await window.keyhold.session.status());

    // The screen follows the session, EXCEPT while the user is deliberately mid-flow on a
    // create screen — moving them off it because no vault is open yet would be the app
    // fighting them.
    const current = get().screen;
    const nextScreen =
      current === 'create' && status.state !== 'unlocked' ? 'create' : screenFor(status);

    const credentials =
      status.state === 'unlocked' ? unwrap(await window.keyhold.credentials.list()) : [];

    set({ status, screen: nextScreen, credentials });
  },

  goTo: (screen, path) => {
    set({ screen, error: null, ...(path === undefined ? {} : { workingPath: path }) });
  },

  setError: (message) => {
    set({ error: message });
  },

  chooseExistingVault: async () => {
    const path = unwrap(await window.keyhold.session.chooseVaultToOpen());
    if (path === null) return;

    set({ busy: true, error: null });
    try {
      // Inspect first, so the unlock screen can show the vault's name, warn about a slow
      // Argon2 cost, and surface an interrupted write BEFORE a password is typed.
      unwrap(await window.keyhold.vault.inspect(path));
      set({ workingPath: path });
      await get().refresh();

      // Quick unlock, if enrolled, opens without a password. Failure is silent by design —
      // it means "type your password", which is what the screen already asks for.
      await get().tryQuickUnlock(path);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Could not open that vault.' });
    } finally {
      set({ busy: false });
    }
  },

  chooseNewVaultLocation: async () => {
    const path = unwrap(await window.keyhold.session.chooseVaultLocation('vault'));
    if (path === null) return;
    set({ workingPath: path, screen: 'create', error: null });
  },

  createVault: async (password) => {
    const path = get().workingPath;
    if (path === null) return false;

    set({ busy: true, error: null });
    try {
      unwrap(await window.keyhold.vault.create(path, password));
      await get().refresh();
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Could not create the vault.' });
      return false;
    } finally {
      set({ busy: false });
    }
  },

  unlockVault: async (password) => {
    const path = get().workingPath ?? get().status?.pendingVault?.path ?? null;
    if (path === null) return false;

    set({ busy: true, error: null });
    try {
      unwrap(await window.keyhold.vault.unlock(path, password));
      await get().refresh();
      return true;
    } catch (error) {
      // Refreshed even on failure, so the throttle countdown the screen renders is current.
      await get().refresh();
      set({ error: error instanceof Error ? error.message : 'Could not unlock the vault.' });
      return false;
    } finally {
      set({ busy: false });
    }
  },

  tryQuickUnlock: async (path) => {
    try {
      const summary = unwrap(await window.keyhold.session.unlockWithQuickUnlock(path));
      if (summary === null) return false;
      await get().refresh();
      return true;
    } catch {
      // Every failure means "fall back to the password", which is already on screen.
      return false;
    }
  },

  lock: async () => {
    unwrap(await window.keyhold.vault.lock());
    await get().refresh();
  },

  reloadFromDisk: async () => {
    // `unwrap` throws on a refusal, and that is the intended path: the main process refuses
    // an unsaved-changes reload and a different vault, and both are things the user has to be
    // told rather than states to fall back from. The caller's error boundary turns it into a
    // toast; swallowing it here would leave the screen showing the old document and no reason.
    unwrap(await window.keyhold.vault.reload());
    // The full refresh, not just the summary: a reload replaces the whole document, so the
    // credential list this store holds is stale in exactly the way `refresh` exists to fix.
    await get().refresh();
  },

  forgetVault: async (path) => {
    unwrap(await window.keyhold.session.forgetVault(path));
    await get().refresh();
  },

  estimateStrength: async (password) => {
    try {
      return unwrap(await window.keyhold.session.estimateStrength(password));
    } catch {
      // The meter is an aid, not a gate — the main process enforces the real minimum. A
      // failed estimate should never block someone from typing.
      return null;
    }
  },
}));

/**
 * Subscribes to main-process session changes.
 *
 * Called once at startup. Without it, an auto-lock leaves the UI rendering an unlocked
 * vault until the user clicks something and every action starts failing.
 */
export function watchSession(): () => void {
  return window.keyhold.session.onStatusChanged(() => {
    void useSession.getState().refresh();
  });
}
