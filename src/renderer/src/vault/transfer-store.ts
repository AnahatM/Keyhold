// SPDX-License-Identifier: GPL-3.0-or-later
import { create } from 'zustand';
import { useSession } from './session-store.js';

/**
 * Which transfer flow is open — importing, exporting, or neither.
 *
 * ## Why a store rather than `useState` in the vault screen
 *
 * Three surfaces open these: the native File menu, the command palette, and (eventually) a
 * button. The first two live *above* the vault screen — the menu bridge is mounted at the
 * root and the palette is global — so a `useState` in `VaultScreen` would have to be
 * prop-drilled up through every component in between, or reached with a callback registered
 * on mount. The tool views already made this decision for the same reason; this is the same
 * shape and is kept deliberately identical rather than solved a second way.
 *
 * ## Why one store for two flows rather than two booleans
 *
 * They are mutually exclusive by nature and by consequence. Both are modal, both take over
 * the window, and both act on the whole vault — an export dialog opening over a
 * half-finished import wizard would be a plaintext file written from a vault mid-mutation,
 * which is not a state worth being able to represent. A single `active` field makes that
 * unrepresentable rather than merely discouraged.
 *
 * ## What closing means
 *
 * Closing is not cancelling. `ImportWizard` discards its held source on every exit path of
 * its own accord — the bytes it holds are a plaintext dump of every password the user has —
 * so this store only has to stop rendering it. Putting the discard here as well would be a
 * second place that knows about the wizard's lifecycle, and the one that gets forgotten.
 */

export type TransferFlow = 'import' | 'export';

interface TransferState {
  readonly active: TransferFlow | null;
  open: (flow: TransferFlow) => void;
  close: () => void;
}

export const useTransfer = create<TransferState>((set) => ({
  active: null,
  open: (flow) => {
    set({ active: flow });
  },
  close: () => {
    set({ active: null });
  },
}));

/**
 * Closes whatever is open when the vault locks.
 *
 * A subscription rather than an effect, for the reason `watchLockForToolViews` gives: an
 * effect body that calls `setState` runs during render, and this has to run on a transition
 * nobody is rendering for.
 *
 * The reason it must run at all is sharper than tidiness. An import wizard left open across
 * a lock is holding a decrypted file and a plan built against a vault whose key is gone, and
 * an export dialog is one confirmation away from writing a readable copy of a vault that is
 * no longer unlocked. Both must be gone before the lock screen appears.
 */
export function watchLockForTransfers(): () => void {
  return useSession.subscribe((state, previous) => {
    const wasUnlocked = previous.status?.state === 'unlocked';
    const isUnlocked = state.status?.state === 'unlocked';
    if (wasUnlocked && !isUnlocked) useTransfer.getState().close();
  });
}
