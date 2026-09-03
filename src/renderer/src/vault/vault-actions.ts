// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * The two things only the vault screen can do, made reachable from outside it.
 *
 * `Ctrl+F` and `Ctrl+B` have been in the shortcut registry and the command palette since both
 * were written. `CommandsProvider` declares `focusSearch` and `toggleSidebar` as optional props
 * and is mounted in `App.tsx` without them — so both have been registered, listed, and silently
 * done nothing. A shortcut that is advertised and inert is worse than one that does not exist:
 * it gets pressed, nothing happens, and the user concludes the app is broken rather than that
 * the feature is missing.
 *
 * They cannot be supplied where the provider is mounted. Focusing the search box needs the
 * input's ref, which lives in `CredentialList`; collapsing the sidebar needs the state, which
 * lives in `VaultScreen`. Both are below the provider in the tree, so a prop would have to be
 * drilled *upwards*.
 *
 * A store, for the reason `transfer-store.ts` gives at length for the same situation, and
 * deliberately in the same shape rather than solved a second way. The palette and the menu
 * bridge are global; the things they act on are not.
 *
 * **Null means "no vault screen right now"**, which is a real state — the unlock screen has no
 * search box — and the palette already renders those commands as unavailable when their handler
 * is missing. So the absent case needs no special handling anywhere; it is the same absence the
 * provider's optional props already expressed.
 */

interface VaultActionsState {
  readonly focusSearch: (() => void) | null;
  readonly toggleSidebar: (() => void) | null;
}

export const useVaultActions = create<VaultActionsState>(() => ({
  focusSearch: null,
  toggleSidebar: null,
}));

/**
 * Registers one of the actions for as long as the component supplying it is mounted.
 *
 * Cleared on unmount, and that is the half worth stating: a stale callback left behind after
 * the vault screen goes would focus an input that no longer exists, from a palette that is
 * still open. The lock path is exactly that sequence.
 *
 * `useVaultActions.setState` rather than a hook setter, so this is a write to a store from an
 * effect rather than a React state update during one — the difference React's cascading-render
 * rule cares about.
 */
export function useRegisterVaultAction(
  name: keyof VaultActionsState,
  action: (() => void) | null
): void {
  useEffect(() => {
    useVaultActions.setState({ [name]: action } as Partial<VaultActionsState>);
    return () => {
      useVaultActions.setState({ [name]: null } as Partial<VaultActionsState>);
    };
  }, [name, action]);
}
