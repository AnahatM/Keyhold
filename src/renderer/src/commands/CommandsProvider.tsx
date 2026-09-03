// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useMemo } from 'react';
import { useToast } from '../chrome/index.js';
import { useCredentials } from '../vault/credential-store.js';
import { unwrap, useSession } from '../vault/session-store.js';
import { TOOL_VIEWS, useToolView } from '../shell/index.js';
import { useTransfer } from '../vault/transfer-store.js';
import { CommandPalette } from './CommandPalette.js';
import { resolveCommands, type CommandHandlers } from './command-registry.js';
import { anyOverlayOpen, loadPlatform, usePaletteStore } from './palette-store.js';
import { watchLockForRecents } from './recent-commands.js';
import { activeScopes } from './shortcut-gate.js';
import { ShortcutsHelp } from './ShortcutsHelp.js';
import type { ShortcutId } from './shortcut-registry.js';
import { useShortcuts, type ShortcutHandlers } from './use-shortcuts.js';

/**
 * Mounts the whole command system: the key listener, the palette and the shortcuts sheet.
 *
 * One component, mounted once, high enough in the tree to survive a screen change — the
 * same reason `ClearToastsOnLock` is a component. Screens unmount as the session moves
 * between welcome, unlock and vault, and a `keydown` listener that unmounts with them is a
 * shortcut that works only on some screens for reasons nobody can see.
 *
 * ## It derives what it can and is given the rest
 *
 * Most handlers come straight from the two stores, because the stores are the public API
 * for those actions and reaching around them would be a second way to trash a record.
 * Two are not derivable — focusing the search box and collapsing the sidebar are owned by
 * the views that render them — so they arrive as optional props. A handler that is not
 * supplied is not bound, the shortcut is not listed on the help sheet, and the key is left
 * alone for the browser. Nothing is ever advertised and dead.
 */

export interface CommandsProviderProps {
  /** Puts the caret in the credential list's search box. Owned by the list. */
  readonly focusSearch?: (() => void) | undefined;
  /** Collapses or expands the sidebar. Owned by the vault screen's layout state. */
  readonly toggleSidebar?: (() => void) | undefined;
  /**
   * Turns the whole system off.
   *
   * Hard rule 7 — every feature ships a setting. The prop exists now so the preference has
   * somewhere to land the moment there is a settings store to hold it; until then the
   * default is on, which is what a user expects of a keyboard shortcut.
   */
  readonly enabled?: boolean;
}

export function CommandsProvider({
  focusSearch,
  toggleSidebar,
  enabled = true,
}: CommandsProviderProps): React.JSX.Element {
  const toast = useToast();

  const status = useSession((state) => state.status);
  const credentials = useSession((state) => state.credentials);
  const lock = useSession((state) => state.lock);

  const selectedId = useCredentials((state) => state.selectedId);
  const editing = useCredentials((state) => state.editing);
  const showTrash = useCredentials((state) => state.showTrash);
  const deepMatches = useCredentials((state) => state.deepMatches);
  const select = useCredentials((state) => state.select);
  const setEditing = useCredentials((state) => state.setEditing);
  const setShowTrash = useCredentials((state) => state.setShowTrash);
  const duplicate = useCredentials((state) => state.duplicate);
  const trash = useCredentials((state) => state.trash);
  const copy = useCredentials((state) => state.copy);

  const paletteOpen = usePaletteStore((state) => state.paletteOpen);
  const helpOpen = usePaletteStore((state) => state.helpOpen);
  const closePalette = usePaletteStore((state) => state.closePalette);
  const togglePalette = usePaletteStore((state) => state.togglePalette);
  const openHelp = usePaletteStore((state) => state.openHelp);
  const closeHelp = usePaletteStore((state) => state.closeHelp);
  const platform = usePaletteStore((state) => state.platform);

  const toggleTool = useToolView((state) => state.toggle);
  const openTransfer = useTransfer((state) => state.open);

  const locked = status?.state !== 'unlocked';
  const selected = credentials.find((credential) => credential.id === selectedId);

  // Fetched once per window, not per render — see `palette-store.ts`.
  useEffect(() => {
    void loadPlatform();
  }, []);

  // A subscription, not a comparison in an effect body: the recents list is a plaintext
  // record of someone's accounts and it dies with the lock.
  useEffect(() => watchLockForRecents(), []);

  const saveVault = useCallback(async (): Promise<void> => {
    try {
      unwrap(await window.keyhold.vault.save());
      toast.success('Vault saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The vault could not be saved.');
    }
  }, [toast]);

  const newCredential = useCallback((): void => {
    // Order matters: the editor decides it is creating rather than editing by the record
    // being `null`, so the selection has to be cleared first.
    select(null);
    setEditing(true);
  }, [select, setEditing]);

  /**
   * The command handlers, and the shortcut handlers, built once from one source.
   *
   * Deliberately one object per action rather than a command map and a separate shortcut
   * map: "Lock the vault" from the palette and Ctrl+L must do the identical thing, and two
   * maps is how they slowly stop doing so.
   */
  const actions = useMemo<CommandHandlers>(() => {
    return {
      'vault.lock': locked
        ? undefined
        : (): void => {
            void lock();
          },
      'vault.save': locked ? undefined : (): void => void saveVault(),
      'credential.new': locked ? undefined : newCredential,
      'credential.edit':
        selected === undefined
          ? undefined
          : (): void => {
              setEditing(true);
            },
      'credential.duplicate':
        selected === undefined
          ? undefined
          : (): void => {
              void duplicate(selected.id);
            },
      'credential.trash':
        selected === undefined
          ? undefined
          : (): void => {
              void trash(selected.id, selected.title);
            },
      'nav.allItems': locked
        ? undefined
        : (): void => {
            setShowTrash(false);
          },
      'nav.trash': locked
        ? undefined
        : (): void => {
            setShowTrash(!showTrash);
          },
      'nav.toggleSidebar': toggleSidebar,
      'search.focus': focusSearch,
      'help.shortcuts': openHelp,
      // All three need an open vault: one writes into it, one reads all of it, and the third
      // opens a second copy with this one's key.
      'vault.import': locked
        ? undefined
        : (): void => {
            openTransfer('import');
          },
      'vault.export': locked
        ? undefined
        : (): void => {
            openTransfer('export');
          },
      'vault.merge': locked
        ? undefined
        : (): void => {
            openTransfer('merge');
          },
      // Built from the same table the palette entries are, so a fifth tool view gets its
      // handler for free rather than becoming a row that does nothing when clicked — which
      // is the worse half of the failure a hand-written list produces.
      //
      // Health reads the vault, so it is unavailable while locked and the palette hides the
      // row rather than offering one that errors. The generator and the help viewer are
      // both usable with no vault open, and the settings screen renders its machine half
      // either way, so those three stay live.
      ...Object.fromEntries(
        TOOL_VIEWS.map((view) => [
          `tools.${view.id}`,
          view.id === 'health' && locked
            ? undefined
            : (): void => {
                toggleTool(view.id);
              },
        ])
      ),
    };
  }, [
    openTransfer,
    toggleTool,
    locked,
    lock,
    saveVault,
    newCredential,
    selected,
    setEditing,
    duplicate,
    trash,
    setShowTrash,
    showTrash,
    toggleSidebar,
    focusSearch,
    openHelp,
  ]);

  const commandHandlers: CommandHandlers = actions;

  /**
   * The shortcut half.
   *
   * Ids differ from command ids where the two systems genuinely name different things —
   * `trash.toggle` is a key, `nav.trash` is a menu entry — so the mapping is written out
   * once, here, rather than the two registries being forced to share an id space they do
   * not agree on.
   *
   * `credential.copyPassword` is the one action that touches a secret, and it does not
   * touch it here: `copy` sends a `SecretRef` over IPC and the main process does the
   * reveal, the clipboard write and the auto-clear. The renderer never sees the value —
   * decision D13 — which is exactly why this is safe as a shortcut and still absent from
   * the palette.
   */
  const shortcutHandlers: ShortcutHandlers = useMemo(() => {
    const handlers: ShortcutHandlers = {
      'palette.open': locked ? undefined : togglePalette,
      'shortcuts.help': openHelp,
      'search.focus': actions['search.focus'],
      'vault.lock': actions['vault.lock'],
      'vault.save': actions['vault.save'],
      'credential.new': actions['credential.new'],
      'sidebar.toggle': actions['nav.toggleSidebar'],
      'trash.toggle': actions['nav.trash'],
      'credential.edit': actions['credential.edit'],
      'credential.trash': actions['credential.trash'],
      'credential.copyPassword':
        selected?.hasPassword !== true
          ? undefined
          : (): void => {
              void copy({ kind: 'password', credentialId: selected.id }, selected.id);
            },
    };
    return handlers;
  }, [locked, togglePalette, openHelp, actions, selected, copy]);

  const boundIds = useMemo(
    () =>
      new Set(
        Object.entries(shortcutHandlers)
          .filter(([, handler]) => handler !== undefined)
          .map(([id]) => id as ShortcutId)
      ),
    [shortcutHandlers]
  );

  useShortcuts(shortcutHandlers, {
    locked,
    overlayOpen: anyOverlayOpen({ paletteOpen, helpOpen }),
    scopes: activeScopes({ hasSelection: selected !== undefined, editing }),
    platform,
    enabled,
  });

  const commands = useMemo(
    () => resolveCommands(commandHandlers, { hasSelection: selected !== undefined }),
    [commandHandlers, selected]
  );

  return (
    <>
      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        commands={commands}
        credentials={credentials}
        deepMatches={deepMatches ?? undefined}
        onSelectCredential={(credentialId) => {
          // Navigation only. The palette does not reveal and does not copy — see
          // `CommandPalette.tsx`.
          setShowTrash(false);
          select(credentialId);
        }}
      />
      <ShortcutsHelp open={helpOpen} onClose={closeHelp} boundIds={boundIds} />
    </>
  );
}
