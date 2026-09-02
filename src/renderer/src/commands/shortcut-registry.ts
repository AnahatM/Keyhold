// SPDX-License-Identifier: GPL-3.0-or-later

import { combo, comboId, type KeyCombo } from './key-combo.js';

/**
 * **The** keyboard shortcut table.
 *
 * There is one list of shortcuts in Keyhold and this is it. The key handler matches
 * against it, the help sheet renders it, the palette's hint text reads its own entry out
 * of it, and the conflict guard proves no two entries claim the same combination. Hard
 * rule 8: three copies of "Ctrl+K opens the palette" is what this file exists to prevent,
 * and the failure mode of the copies is silent — the handler keeps working while the help
 * screen quietly tells the user about a shortcut that was renamed a year ago.
 *
 * ## The three booleans
 *
 * Each answers a distinct question about *when* a shortcut is allowed to fire, and each
 * defaults to the safe answer (`false`) so a new entry has to argue for its exception:
 *
 * - **`whenLocked`** — fires while the vault is locked. Almost nothing should: a locked
 *   vault is supposed to be locked, and a shortcut that reaches vault state through a
 *   closed door is a bug with a keyboard in front of it.
 * - **`whileTyping`** — fires while a text field has focus. This one is not a nicety.
 *   Someone typing a password into a field must not trigger "move to trash" because the
 *   password contained the letter the shortcut is bound to. Only accelerator combinations
 *   a text field would never consume get this.
 * - **`whileOverlay`** — fires while a modal, confirm or the palette is open. An overlay
 *   owns the keyboard; a background shortcut firing underneath it acts on a view the user
 *   cannot see.
 *
 * ## Scopes
 *
 * `global` is always live. `list` needs the credential list in view; `editor` needs the
 * editor open. Scope drives both when a shortcut fires and how the help sheet groups it —
 * one field, two readers, rather than a `category` string that could disagree with it.
 */

export const SHORTCUT_SCOPES = ['global', 'list', 'editor'] as const;

export type ShortcutScope = (typeof SHORTCUT_SCOPES)[number];

/** Section headings for the help sheet. Derived from scope, so they cannot disagree. */
export const SCOPE_LABELS: Readonly<Record<ShortcutScope, string>> = {
  global: 'Anywhere',
  list: 'In the credential list',
  editor: 'While editing',
};

export const SCOPE_DESCRIPTIONS: Readonly<Record<ShortcutScope, string>> = {
  global: 'Available on every screen of an unlocked vault, unless noted.',
  list: 'Available when a record is selected in the list.',
  editor: 'Available while a record is open for editing.',
};

export interface ShortcutDefinition {
  readonly id: ShortcutId;
  readonly combo: KeyCombo;
  /** Sentence case, imperative, and written for the user rather than for the code. */
  readonly description: string;
  readonly scope: ShortcutScope;
  readonly whenLocked: boolean;
  readonly whileTyping: boolean;
  readonly whileOverlay: boolean;
}

/**
 * Ids, spelled out as a union rather than inferred from the table.
 *
 * Inferring would be less typing and worse: a command referring to a shortcut id that does
 * not exist should be a compile error at the reference, not a runtime `undefined` at the
 * moment the help sheet tries to draw it.
 */
export type ShortcutId =
  | 'palette.open'
  | 'shortcuts.help'
  | 'search.focus'
  | 'vault.lock'
  | 'vault.save'
  | 'credential.new'
  | 'sidebar.toggle'
  | 'trash.toggle'
  | 'credential.edit'
  | 'credential.copyPassword'
  | 'credential.trash'
  | 'editor.save'
  | 'editor.cancel';

/**
 * The table.
 *
 * Ordered as the help sheet reads it — the two shortcuts that lead somewhere else first,
 * because a user who can find the palette and this sheet can find everything else.
 */
export const SHORTCUTS: readonly ShortcutDefinition[] = [
  {
    id: 'palette.open',
    combo: combo('k', { mod: true }),
    description: 'Open the command palette',
    scope: 'global',
    // The palette searches credentials. Opening it over a locked vault would either show
    // an empty shell or, worse, invite someone to add the credential list to it later.
    whenLocked: false,
    whileTyping: true,
    // True so the same combination closes it again, and so it can be opened from inside
    // its own text field — which is a text field, hence `whileTyping` above.
    whileOverlay: true,
  },
  {
    id: 'shortcuts.help',
    combo: combo('/', { mod: true }),
    description: 'Show keyboard shortcuts',
    scope: 'global',
    // Harmless while locked, and the one thing a confused user reaches for. A list of key
    // names discloses nothing about the vault.
    whenLocked: true,
    whileTyping: true,
    whileOverlay: true,
  },
  {
    id: 'search.focus',
    combo: combo('f', { mod: true }),
    description: 'Focus the search box',
    scope: 'global',
    whenLocked: false,
    whileTyping: true,
    whileOverlay: false,
  },
  {
    id: 'vault.lock',
    combo: combo('l', { mod: true }),
    description: 'Lock the vault',
    scope: 'global',
    // Already locked. Firing would be a no-op that still has to reach through the session.
    whenLocked: false,
    whileTyping: true,
    whileOverlay: false,
  },
  {
    id: 'vault.save',
    combo: combo('s', { mod: true }),
    description: 'Save the vault',
    scope: 'global',
    whenLocked: false,
    whileTyping: true,
    whileOverlay: false,
  },
  {
    id: 'credential.new',
    combo: combo('n', { mod: true }),
    description: 'New credential',
    scope: 'global',
    whenLocked: false,
    whileTyping: true,
    whileOverlay: false,
  },
  {
    id: 'sidebar.toggle',
    combo: combo('b', { mod: true }),
    description: 'Show or hide the sidebar',
    scope: 'global',
    whenLocked: false,
    whileTyping: true,
    whileOverlay: false,
  },
  {
    id: 'trash.toggle',
    combo: combo('t', { mod: true, shift: true }),
    description: 'Switch between all items and Trash',
    scope: 'global',
    whenLocked: false,
    whileTyping: true,
    whileOverlay: false,
  },
  {
    id: 'credential.edit',
    combo: combo('e', { mod: true }),
    description: 'Edit the selected record',
    scope: 'list',
    whenLocked: false,
    whileTyping: true,
    whileOverlay: false,
  },
  {
    id: 'credential.copyPassword',
    combo: combo('c', { mod: true, shift: true }),
    description: 'Copy the password of the selected record',
    scope: 'list',
    whenLocked: false,
    whileTyping: true,
    whileOverlay: false,
  },
  {
    id: 'credential.trash',
    combo: combo('Backspace', { mod: true }),
    description: 'Move the selected record to Trash',
    scope: 'list',
    whenLocked: false,
    // Backspace inside a text field deletes a character. Modifier or not, this one stays
    // out of a field someone is typing a password into.
    whileTyping: false,
    whileOverlay: false,
  },
  {
    id: 'editor.save',
    combo: combo('Enter', { mod: true }),
    description: 'Save changes',
    scope: 'editor',
    whenLocked: false,
    // The whole point: the editor is text fields, and this is how you leave one.
    whileTyping: true,
    whileOverlay: false,
  },
  {
    id: 'editor.cancel',
    combo: combo('Escape'),
    description: 'Discard changes and close the editor',
    scope: 'editor',
    whenLocked: false,
    whileTyping: true,
    // An overlay's own Escape closes the overlay. This must not also close the editor
    // behind it — see `Modal.tsx`, which stops the event for the same reason.
    whileOverlay: false,
  },
];

export const SHORTCUT_BY_ID: ReadonlyMap<ShortcutId, ShortcutDefinition> = new Map(
  SHORTCUTS.map((shortcut) => [shortcut.id, shortcut])
);

/**
 * Looks a shortcut up, or throws.
 *
 * Throwing rather than returning `undefined` because every id in the union is in the table
 * by construction, so a miss means the table and the union have drifted — a bug to
 * surface loudly at the first render, not a hint to render as a blank label.
 */
export function shortcutById(id: ShortcutId): ShortcutDefinition {
  const found = SHORTCUT_BY_ID.get(id);
  if (found === undefined) throw new Error(`Unknown shortcut id: ${id}`);
  return found;
}

export function shortcutsInScope(scope: ShortcutScope): readonly ShortcutDefinition[] {
  return SHORTCUTS.filter((shortcut) => shortcut.scope === scope);
}

/**
 * Whether two scopes can be live at the same instant.
 *
 * `global` overlaps everything, because it is always on. Two different non-global scopes
 * are treated as disjoint — the list and the editor are different views — which is what
 * lets `list` and `editor` reuse a combination without it being a conflict.
 */
export function scopesOverlap(a: ShortcutScope, b: ShortcutScope): boolean {
  return a === b || a === 'global' || b === 'global';
}

export interface ShortcutConflict {
  readonly comboId: string;
  readonly ids: readonly ShortcutId[];
}

/**
 * Every combination claimed twice where both claimants can be live at once.
 *
 * A guard, not a diagnostic: `shortcut-registry.test.ts` fails the build if this returns
 * anything. Two commands sharing a combination is not a subtle bug — one of them simply
 * never runs, and which one depends on table order, so it looks like the shortcut "does
 * not work sometimes".
 */
export function findShortcutConflicts(
  shortcuts: readonly ShortcutDefinition[] = SHORTCUTS
): readonly ShortcutConflict[] {
  const conflicts = new Map<string, ShortcutId[]>();

  for (let i = 0; i < shortcuts.length; i += 1) {
    for (let j = i + 1; j < shortcuts.length; j += 1) {
      const a = shortcuts[i];
      const b = shortcuts[j];
      // `noUncheckedIndexedAccess`: the bounds are ours, but the compiler cannot know it.
      if (a === undefined || b === undefined) continue;
      if (comboId(a.combo) !== comboId(b.combo)) continue;
      if (!scopesOverlap(a.scope, b.scope)) continue;

      const key = comboId(a.combo);
      const existing = conflicts.get(key);
      if (existing === undefined) {
        conflicts.set(key, [a.id, b.id]);
      } else {
        if (!existing.includes(a.id)) existing.push(a.id);
        if (!existing.includes(b.id)) existing.push(b.id);
      }
    }
  }

  return [...conflicts].map(([id, ids]) => ({ comboId: id, ids }));
}
