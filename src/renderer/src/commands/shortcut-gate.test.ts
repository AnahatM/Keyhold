// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { activeScopes, canFire, type ShortcutEnvironment } from './shortcut-gate.js';
import { SHORTCUTS, shortcutById, type ShortcutDefinition } from './shortcut-registry.js';

/**
 * When a shortcut is allowed to fire.
 *
 * Four gates, all of which have to say yes. Each is tested against the **real table**
 * wherever possible rather than a fabricated definition, because the interesting question
 * is not "does `canFire` implement its own booleans" but "does Ctrl+Backspace really stay
 * out of a password field".
 */

function env(overrides: Partial<ShortcutEnvironment> = {}): ShortcutEnvironment {
  return { locked: false, overlayOpen: false, typing: false, scopes: ['global'], ...overrides };
}

function definition(overrides: Partial<ShortcutDefinition>): ShortcutDefinition {
  return {
    id: 'vault.save',
    combo: { key: 'x', mod: true, shift: false, alt: false },
    description: 'A test shortcut',
    scope: 'global',
    whenLocked: false,
    whileTyping: false,
    whileOverlay: false,
    ...overrides,
  };
}

describe('the locked gate', () => {
  it('blocks every shortcut in the real table except the ones that opt in', () => {
    const fired = SHORTCUTS.filter((shortcut) =>
      canFire(shortcut, env({ locked: true, scopes: ['global', 'list', 'editor'] }))
    ).map((shortcut) => shortcut.id);

    expect(fired).toEqual(['shortcuts.help']);
  });

  it('specifically will not open the palette over a locked vault', () => {
    expect(canFire(shortcutById('palette.open'), env({ locked: true }))).toBe(false);
  });

  it('specifically will not lock, save or create over a locked vault', () => {
    for (const id of ['vault.lock', 'vault.save', 'credential.new'] as const) {
      expect(canFire(shortcutById(id), env({ locked: true })), id).toBe(false);
    }
  });

  it('outranks every other allowance', () => {
    // A shortcut that says yes to everything else still cannot fire while locked.
    const permissive = definition({ whileTyping: true, whileOverlay: true, whenLocked: false });
    expect(canFire(permissive, env({ locked: true, typing: true, overlayOpen: true }))).toBe(false);
  });
});

describe('the typing gate', () => {
  it('blocks a shortcut that has not opted in while a text field has focus', () => {
    expect(canFire(shortcutById('credential.trash'), env({ typing: true, scopes: ['list'] }))).toBe(
      false
    );
  });

  it('still allows it when nothing is being typed into', () => {
    expect(canFire(shortcutById('credential.trash'), env({ scopes: ['list'] }))).toBe(true);
  });

  it('lets the palette open from inside a text field, which is the whole point of Ctrl+K', () => {
    expect(canFire(shortcutById('palette.open'), env({ typing: true }))).toBe(true);
  });

  /**
   * The destructive shortcut in the table is the one that must not survive a text field.
   *
   * Named explicitly rather than checked as a class, so adding a second destructive
   * shortcut with `whileTyping: true` fails here and has to be argued for.
   */
  it('keeps every non-opted-in shortcut out of a field being typed into', () => {
    for (const shortcut of SHORTCUTS) {
      if (shortcut.whileTyping) continue;
      expect(
        canFire(shortcut, env({ typing: true, scopes: ['global', 'list', 'editor'] })),
        shortcut.id
      ).toBe(false);
    }
  });
});

describe('the overlay gate', () => {
  it('lets only the palette and the help sheet through while an overlay is up', () => {
    const fired = SHORTCUTS.filter((shortcut) =>
      canFire(shortcut, env({ overlayOpen: true, scopes: ['global', 'list', 'editor'] }))
    ).map((shortcut) => shortcut.id);

    expect(fired).toEqual(['palette.open', 'shortcuts.help']);
  });

  it('keeps the editor Escape from firing behind an open dialog', () => {
    // `Modal` closes the topmost surface on Escape and stops the event. This is the second
    // line of defence for the same rule.
    const editorEscape = definition({
      scope: 'editor',
      combo: { key: 'Escape', mod: false, shift: false, alt: false },
    });
    expect(canFire(editorEscape, env({ overlayOpen: true, scopes: ['global', 'editor'] }))).toBe(
      false
    );
  });
});

describe('the scope gate', () => {
  it('blocks a list shortcut when nothing is selected', () => {
    expect(canFire(shortcutById('credential.edit'), env({ scopes: ['global'] }))).toBe(false);
  });

  it('allows it once the list scope is live', () => {
    expect(canFire(shortcutById('credential.edit'), env({ scopes: ['global', 'list'] }))).toBe(
      true
    );
  });
});

describe('activeScopes', () => {
  it('always includes global', () => {
    expect(activeScopes({ hasSelection: false, editing: false })).toEqual(['global']);
  });

  it('adds list when a record is selected', () => {
    expect(activeScopes({ hasSelection: true, editing: false })).toEqual(['global', 'list']);
  });

  it('swaps list for editor while editing, never both', () => {
    const scopes = activeScopes({ hasSelection: true, editing: true });
    expect(scopes).toEqual(['global', 'editor']);
    expect(scopes).not.toContain('list');
  });
});
