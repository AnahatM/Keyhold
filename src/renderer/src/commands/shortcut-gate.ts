// SPDX-License-Identifier: GPL-3.0-or-later

import type { ShortcutDefinition, ShortcutScope } from './shortcut-registry.js';

/**
 * The decision "may this shortcut fire, right now?", as a pure function.
 *
 * Split out of the `keydown` hook deliberately. Everything that decides whether a
 * destructive shortcut runs lives here, in code with no DOM, no React and no store, so the
 * whole truth table can be asserted directly rather than driven through a synthetic key
 * event and inferred from whether a spy was called. The hook keeps only the parts that
 * genuinely need the DOM: reading the event and removing the listener.
 *
 * Order matters and is deliberate — locked, then overlay, then typing, then scope. The
 * cheapest and most consequential checks come first, and the read is "a locked vault beats
 * everything else", which is the sentence the security posture actually claims.
 */

export interface ShortcutEnvironment {
  /** The vault is locked, or there is no vault at all. */
  readonly locked: boolean;
  /** A modal, confirm, palette or help sheet is open. */
  readonly overlayOpen: boolean;
  /** A text field, textarea, select or contenteditable is taking the keystrokes. */
  readonly typing: boolean;
  /** Which scopes the current view puts in play. `global` is always among them. */
  readonly scopes: readonly ShortcutScope[];
}

/**
 * Whether a shortcut is allowed to fire in this environment.
 *
 * Every gate is a plain `&&` of a flag the table states explicitly, rather than anything
 * inferred: a reviewer reading a table row can tell exactly when that row fires, without
 * reading this file at all. That is the property that makes the table trustworthy.
 */
export function canFire(shortcut: ShortcutDefinition, env: ShortcutEnvironment): boolean {
  if (env.locked && !shortcut.whenLocked) return false;
  if (env.overlayOpen && !shortcut.whileOverlay) return false;
  if (env.typing && !shortcut.whileTyping) return false;
  return env.scopes.includes(shortcut.scope);
}

/**
 * The scopes a view puts in play.
 *
 * `global` is unconditional; it is the definition of the scope. Kept here rather than
 * assembled at the call site so there is one answer to "what is active" instead of one per
 * screen that mounts the hook.
 */
export function activeScopes(options: {
  readonly hasSelection: boolean;
  readonly editing: boolean;
}): readonly ShortcutScope[] {
  const scopes: ShortcutScope[] = ['global'];
  if (options.editing) {
    scopes.push('editor');
  } else if (options.hasSelection) {
    // Not both: while the editor is open, the list's destructive shortcuts are aimed at a
    // record the user is in the middle of changing.
    scopes.push('list');
  }
  return scopes;
}
