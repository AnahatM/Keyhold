// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { COMMANDS } from './command-registry.js';
import { combo, comboId } from './key-combo.js';
import {
  findShortcutConflicts,
  scopesOverlap,
  SHORTCUT_BY_ID,
  SHORTCUT_SCOPES,
  SHORTCUTS,
  shortcutById,
  shortcutsInScope,
  SCOPE_DESCRIPTIONS,
  SCOPE_LABELS,
  type ShortcutDefinition,
} from './shortcut-registry.js';

/**
 * The registry's guards.
 *
 * The conflict check is the one that matters. Two commands claiming one combination is not
 * a subtle bug — one of them silently never runs, and which one depends on the order of a
 * table someone reorders while adding an entry. It is also exactly the kind of thing a
 * human reviewer misses in a fifteen-row table, which is why it is a test.
 */

describe('the shortcut table has no conflicts', () => {
  it('claims no combination twice', () => {
    expect(findShortcutConflicts()).toEqual([]);
  });

  /**
   * Proves the check can actually fail.
   *
   * A guard that has never been seen to fail is a guard nobody should trust: `findConflicts`
   * returning `[]` for a genuinely conflicting table would pass the test above forever.
   */
  it('detects a duplicate combination in the same scope', () => {
    const clash: readonly ShortcutDefinition[] = [
      ...SHORTCUTS,
      {
        id: 'vault.save',
        combo: combo('k', { mod: true }),
        description: 'A second claim on the palette key',
        scope: 'global',
        whenLocked: false,
        whileTyping: false,
        whileOverlay: false,
      },
    ];

    const conflicts = findShortcutConflicts(clash);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.comboId).toBe('mod+k');
    expect(conflicts[0]?.ids).toContain('palette.open');
  });

  it('does not report a combination shared by two scopes that cannot both be live', () => {
    const shared: readonly ShortcutDefinition[] = [
      {
        id: 'credential.edit',
        combo: combo('Enter'),
        description: 'In the list',
        scope: 'list',
        whenLocked: false,
        whileTyping: false,
        whileOverlay: false,
      },
      {
        id: 'editor.save',
        combo: combo('Enter'),
        description: 'In the editor',
        scope: 'editor',
        whenLocked: false,
        whileTyping: false,
        whileOverlay: false,
      },
    ];

    expect(findShortcutConflicts(shared)).toEqual([]);
  });

  it('does report one shared with a global shortcut, which is always live', () => {
    const shared: readonly ShortcutDefinition[] = [
      {
        id: 'palette.open',
        combo: combo('k', { mod: true }),
        description: 'Everywhere',
        scope: 'global',
        whenLocked: false,
        whileTyping: false,
        whileOverlay: false,
      },
      {
        id: 'credential.edit',
        combo: combo('k', { mod: true }),
        description: 'In the list',
        scope: 'list',
        whenLocked: false,
        whileTyping: false,
        whileOverlay: false,
      },
    ];

    expect(findShortcutConflicts(shared)).toHaveLength(1);
  });

  it('groups three claimants on one combination into a single report', () => {
    const three: readonly ShortcutDefinition[] = ['palette.open', 'vault.save', 'vault.lock'].map(
      (id) => ({
        id: id as ShortcutDefinition['id'],
        combo: combo('j', { mod: true }),
        description: id,
        scope: 'global' as const,
        whenLocked: false,
        whileTyping: false,
        whileOverlay: false,
      })
    );

    const conflicts = findShortcutConflicts(three);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.ids).toHaveLength(3);
  });
});

describe('scopesOverlap', () => {
  it('treats global as overlapping everything', () => {
    for (const scope of SHORTCUT_SCOPES) {
      expect(scopesOverlap('global', scope)).toBe(true);
      expect(scopesOverlap(scope, 'global')).toBe(true);
    }
  });

  it('treats two different view scopes as disjoint', () => {
    expect(scopesOverlap('list', 'editor')).toBe(false);
    expect(scopesOverlap('list', 'list')).toBe(true);
  });
});

describe('the table is internally consistent', () => {
  it('has a unique id per entry', () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('indexes every entry', () => {
    expect(SHORTCUT_BY_ID.size).toBe(SHORTCUTS.length);
    for (const shortcut of SHORTCUTS) {
      expect(shortcutById(shortcut.id)).toBe(shortcut);
    }
  });

  it('throws on an id that is not in the table', () => {
    // Cast: the whole point is to reach the runtime guard the type normally prevents.
    expect(() => shortcutById('nope' as never)).toThrow(/Unknown shortcut id/u);
  });

  it('assigns every entry a scope that has a heading and a description', () => {
    for (const shortcut of SHORTCUTS) {
      expect(SHORTCUT_SCOPES).toContain(shortcut.scope);
      expect(SCOPE_LABELS[shortcut.scope]).toBeTruthy();
      expect(SCOPE_DESCRIPTIONS[shortcut.scope]).toBeTruthy();
    }
  });

  it('partitions the table across the scopes with nothing lost', () => {
    const total = SHORTCUT_SCOPES.reduce((sum, scope) => sum + shortcutsInScope(scope).length, 0);
    expect(total).toBe(SHORTCUTS.length);
  });

  it('gives every entry a description written for a human', () => {
    for (const shortcut of SHORTCUTS) {
      // Not an id, not empty, not a key name. The help sheet prints these verbatim.
      expect(shortcut.description.length).toBeGreaterThan(6);
      expect(shortcut.description).not.toContain('.');
    }
  });

  /**
   * The security default, asserted rather than trusted.
   *
   * Every exception costs a line here. Someone adding `whenLocked: true` to a shortcut that
   * touches the vault has to come and change this list, which is the moment the question
   * "should this really work while locked?" gets asked.
   */
  it('lets almost nothing fire while the vault is locked', () => {
    const whileLocked = SHORTCUTS.filter((shortcut) => shortcut.whenLocked).map(
      (shortcut) => shortcut.id
    );
    expect(whileLocked).toEqual(['shortcuts.help']);
  });

  it('keeps Backspace out of a field someone is typing into', () => {
    expect(shortcutById('credential.trash').whileTyping).toBe(false);
  });

  it('gives every combination an accelerator, except the editor Escape', () => {
    for (const shortcut of SHORTCUTS) {
      if (shortcut.combo.key === 'Escape') continue;
      // A bare letter as a global shortcut would fire on ordinary typing the instant a
      // `whileTyping` exception were added to it.
      expect(shortcut.combo.mod, shortcut.id).toBe(true);
    }
  });
});

describe('the command registry references the shortcut table, never its own copy', () => {
  it('names only shortcut ids that exist', () => {
    for (const definition of COMMANDS) {
      if (definition.shortcutId === undefined) continue;
      expect(SHORTCUT_BY_ID.has(definition.shortcutId), definition.id).toBe(true);
    }
  });

  it('has a unique id per command', () => {
    const ids = COMMANDS.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * No command restates a key combination in its own text.
   *
   * This is hard rule 8 as a test. A title or keyword reading "Ctrl+L" would be a second
   * copy of the binding, and the copy in prose is the one that never gets updated.
   */
  it('never writes a key combination into a title or a keyword', () => {
    const looksLikeACombo = /\b(ctrl|cmd|command|⌘|alt|option|meta)\b|[⌘⌥⇧]/iu;
    for (const definition of COMMANDS) {
      expect(looksLikeACombo.test(definition.title), definition.id).toBe(false);
      for (const keyword of definition.keywords) {
        expect(looksLikeACombo.test(keyword), `${definition.id}: ${keyword}`).toBe(false);
      }
    }
  });

  it('does not expose any command that reveals or copies a secret', () => {
    // The palette navigates and triggers. See `command-registry.ts` for why.
    const forbidden = /\b(reveal|copy password|show password|unmask)\b/iu;
    for (const definition of COMMANDS) {
      expect(forbidden.test(definition.title), definition.id).toBe(false);
      // Keywords are matched too — a command reachable by typing "reveal" is reachable,
      // whatever its title says.
      for (const keyword of definition.keywords) {
        expect(forbidden.test(keyword), `${definition.id}: ${keyword}`).toBe(false);
      }
    }

    /*
     * Widened to `string` on purpose, and this is the whole point of the assertion.
     *
     * `CommandId` does not contain `credential.copyPassword` — that is the property being
     * guarded. Comparing a `CommandId` against that literal is therefore a comparison the
     * compiler knows can never be true, so it is not a test: it passes because the types
     * cannot meet, not because the table is safe. Read as `string`, it fails the moment
     * someone adds the id to the union *and* the table, which is the change worth catching.
     */
    const ids: readonly string[] = COMMANDS.map((definition) => definition.id);
    expect(ids).not.toContain('credential.copyPassword');
  });
});

describe('comboId', () => {
  it('is stable and order-independent of how the combo was written', () => {
    expect(comboId(combo('K', { mod: true }))).toBe('mod+k');
    expect(comboId(combo('k', { mod: true, shift: true }))).toBe('mod+shift+k');
    expect(comboId(combo('Escape'))).toBe('Escape');
  });
});
