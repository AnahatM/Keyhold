// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { flattenGroups, groupPaletteItems, RECENT_GROUP_LABEL } from './palette-groups.js';
import { commandKey, searchPalette, type PaletteSearchInput } from './palette-search.js';
import { command, projection } from './test-fixtures.js';

const lock = command({ id: 'vault.lock', title: 'Lock the vault', section: 'Vault' });
const gotoTrash = command({ id: 'nav.trash', title: 'Go to Trash', section: 'Navigate' });
const help = command({ id: 'help.shortcuts', title: 'Keyboard shortcuts', section: 'Help' });

function input(overrides: Partial<PaletteSearchInput> = {}): PaletteSearchInput {
  return {
    commands: [lock, gotoTrash, help],
    credentials: [projection({ id: 'r1', title: 'GitHub' })],
    recentKeys: [],
    ...overrides,
  };
}

describe('with nothing typed', () => {
  it('groups by section, in registry order', () => {
    const { items } = searchPalette('', input());
    const groups = groupPaletteItems(items, { queryIsEmpty: true, recentKeys: [] });
    expect(groups.map((group) => group.label)).toEqual(['Vault', 'Navigate', 'Help']);
  });

  it('puts a Recent group above the sections', () => {
    const recentKeys = [commandKey('nav.trash')];
    const { items } = searchPalette('', input({ recentKeys }));
    const groups = groupPaletteItems(items, { queryIsEmpty: true, recentKeys });

    expect(groups[0]?.label).toBe(RECENT_GROUP_LABEL);
    expect(groups[0]?.items.map((item) => item.key)).toEqual(recentKeys);
    // And it is not listed twice.
    expect(groups.some((group) => group.label === 'Navigate')).toBe(false);
  });

  it('omits a section with nothing in it', () => {
    const { items } = searchPalette('', input({ commands: [help] }));
    const groups = groupPaletteItems(items, { queryIsEmpty: true, recentKeys: [] });
    expect(groups.map((group) => group.label)).toEqual(['Help']);
  });

  it('gives every group a distinct id, since they label the ARIA groups', () => {
    const recentKeys = [commandKey('vault.lock')];
    const { items } = searchPalette('', input({ recentKeys }));
    const groups = groupPaletteItems(items, { queryIsEmpty: true, recentKeys });
    expect(new Set(groups.map((group) => group.id)).size).toBe(groups.length);
  });
});

describe('with something typed', () => {
  it('collapses to one ranked list rather than fighting the ranking', () => {
    const { items, query } = searchPalette('o', input());
    const groups = groupPaletteItems(items, { queryIsEmpty: query.isEmpty, recentKeys: [] });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe(`Results (${items.length})`);
  });

  it('returns no groups at all when nothing matched', () => {
    expect(groupPaletteItems([], { queryIsEmpty: false, recentKeys: [] })).toEqual([]);
  });
});

describe('flattenGroups', () => {
  /**
   * Keyboard order must equal display order.
   *
   * The palette walks the flattened list with the arrow keys and indexes
   * `aria-activedescendant` into it. Flattening the *ungrouped* results instead is how a
   * grouped listbox ends up navigating in an order that does not match what is on screen.
   */
  it('produces exactly the rows the groups display, in that order', () => {
    const recentKeys = [commandKey('help.shortcuts')];
    const { items } = searchPalette('', input({ recentKeys }));
    const groups = groupPaletteItems(items, { queryIsEmpty: true, recentKeys });
    const flat = flattenGroups(groups);

    expect(flat.map((item) => item.key)).toEqual(
      groups.flatMap((group) => group.items.map((item) => item.key))
    );
    expect(flat).toHaveLength(items.length);
    expect(flat[0]?.key).toBe(commandKey('help.shortcuts'));
  });

  it('loses nothing', () => {
    const { items } = searchPalette('', input());
    const groups = groupPaletteItems(items, { queryIsEmpty: true, recentKeys: [] });
    expect(new Set(flattenGroups(groups).map((item) => item.key))).toEqual(
      new Set(items.map((item) => item.key))
    );
  });
});
