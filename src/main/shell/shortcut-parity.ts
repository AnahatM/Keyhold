// SPDX-License-Identifier: GPL-3.0-or-later
import type { MenuShortcutBinding } from './menu-model.js';
import { menuCommand } from './menu-commands.js';

/**
 * Proof that the native menu and the renderer's shortcut table say the same thing.
 *
 * Hard rule 8 wants one list. There cannot literally be one here: the menu is built in the
 * main process from Electron accelerator strings, the in-app handler matches DOM key events
 * in the renderer, and the two halves are separate TypeScript programs on purpose — the
 * renderer is forbidden from importing `@main/*` by lint, because that is where the keys
 * live. So the duplication is structural and unavoidable, and the answer is a guard instead
 * of a merge: this file compares the two tables entry by entry, and the wiring test fails
 * the build when they disagree.
 *
 * The failure this prevents is the quiet one. A menu that claims `Ctrl+S` while the
 * renderer binds `Ctrl+Shift+S` still works from the menu and still works from the keyboard
 * — it just teaches the user a shortcut that does nothing, and nothing in the app can
 * notice, because a label that lies cannot throw.
 *
 * Everything here is pure and takes plain data. It never imports the renderer; the caller
 * hands it the renderer's table, which is what lets the guard live in the one place that is
 * allowed to see both (`tests/renderer/`).
 */

/**
 * The renderer's `KeyCombo`, structurally.
 *
 * Declared rather than imported for the reason above. Structural typing means the
 * renderer's real `KeyCombo` is assignable to this with no adapter, so the guard test does
 * not have to translate anything and cannot translate it wrongly.
 */
export interface AcceleratorCombo {
  /** A normalised `KeyboardEvent.key`: single characters lower-cased, named keys as spelled. */
  readonly key: string;
  /** Command on macOS, Control elsewhere — Electron's `CmdOrCtrl`. */
  readonly mod: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

/** One entry of the renderer's shortcut registry, structurally. */
export interface RendererShortcut {
  readonly id: string;
  readonly combo: AcceleratorCombo;
  /** Whether the renderer lets this fire while the vault is locked. */
  readonly whenLocked: boolean;
}

/**
 * DOM key names that Electron spells differently.
 *
 * Only the differences. A key absent from this map is passed through, so a binding on a key
 * nobody thought of behaves rather than silently producing an accelerator Electron ignores.
 */
const ELECTRON_KEY_NAMES: Readonly<Record<string, string>> = {
  Escape: 'Esc',
  Enter: 'Return',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ' ': 'Space',
};

/**
 * A DOM key combination in Electron's accelerator spelling.
 *
 * Modifier order is Electron's own (`CmdOrCtrl+Alt+Shift+Key`) rather than a display
 * convention — this string is parsed by Electron, not read by a person. The human-facing
 * labels are `formatCombo`'s job in the renderer, and the two are deliberately different
 * functions with different outputs for the same input.
 */
export function acceleratorFromCombo(combo: AcceleratorCombo): string {
  const parts: string[] = [];
  if (combo.mod) parts.push('CmdOrCtrl');
  if (combo.alt) parts.push('Alt');
  if (combo.shift) parts.push('Shift');

  const mapped = ELECTRON_KEY_NAMES[combo.key];
  parts.push(mapped ?? (combo.key.length === 1 ? combo.key.toUpperCase() : combo.key));

  return parts.join('+');
}

export type ShortcutDriftKind =
  /** The menu names a shortcut id the renderer's registry does not contain. */
  | 'unknown-shortcut'
  /** Both know the id, and the key combination differs. */
  | 'accelerator-mismatch'
  /**
   * The two disagree about whether it may run while the vault is locked.
   *
   * The security-relevant one. A menu item enabled over a locked vault whose renderer
   * shortcut refuses to fire is a door that looks open; the reverse is worse.
   */
  | 'locked-state-mismatch';

export interface ShortcutDrift {
  readonly kind: ShortcutDriftKind;
  readonly shortcutId: string;
  readonly detail: string;
}

/**
 * Every disagreement between the menu table and the renderer's registry.
 *
 * Returns an empty array when they agree, so the guard test reads
 * `expect(findShortcutDrift(...)).toEqual([])` and prints the actual disagreement when it
 * fails rather than `expected true to be false`.
 */
export function findShortcutDrift(
  bindings: readonly MenuShortcutBinding[],
  shortcuts: readonly RendererShortcut[]
): readonly ShortcutDrift[] {
  const registry = new Map(shortcuts.map((shortcut) => [shortcut.id, shortcut]));
  const drift: ShortcutDrift[] = [];

  for (const binding of bindings) {
    const shortcut = registry.get(binding.shortcutId);

    if (shortcut === undefined) {
      drift.push({
        kind: 'unknown-shortcut',
        shortcutId: binding.shortcutId,
        detail: `menu command "${binding.command}" names shortcut "${binding.shortcutId}", which is not in the renderer's registry`,
      });
      continue;
    }

    const expected = acceleratorFromCombo(shortcut.combo);
    if (expected !== binding.accelerator) {
      drift.push({
        kind: 'accelerator-mismatch',
        shortcutId: binding.shortcutId,
        detail: `menu declares "${binding.accelerator}", renderer binds "${expected}"`,
      });
    }

    // The catalogue's `needsUnlockedVault` and the registry's `whenLocked` are two spellings
    // of one fact and must be exact opposites. Comparing them here is what stops the menu
    // offering something over a locked vault that the renderer would refuse to run.
    const menuAllowsLocked = !menuCommand(binding.command).needsUnlockedVault;
    if (menuAllowsLocked !== shortcut.whenLocked) {
      drift.push({
        kind: 'locked-state-mismatch',
        shortcutId: binding.shortcutId,
        detail: `menu ${menuAllowsLocked ? 'allows' : 'blocks'} this while locked, renderer ${shortcut.whenLocked ? 'allows' : 'blocks'} it`,
      });
    }
  }

  return drift;
}
