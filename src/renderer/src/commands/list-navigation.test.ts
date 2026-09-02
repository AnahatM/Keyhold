// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { isNavigationKey, nextIndex, resolveActiveIndex } from './list-navigation.js';

describe('nextIndex', () => {
  it('moves down and up', () => {
    expect(nextIndex(0, 3, 'ArrowDown')).toBe(1);
    expect(nextIndex(1, 3, 'ArrowUp')).toBe(0);
  });

  it('wraps at both ends', () => {
    expect(nextIndex(2, 3, 'ArrowDown')).toBe(0);
    expect(nextIndex(0, 3, 'ArrowUp')).toBe(2);
  });

  it('jumps to the ends', () => {
    expect(nextIndex(1, 3, 'Home')).toBe(0);
    expect(nextIndex(1, 3, 'End')).toBe(2);
  });

  it('returns -1 for an empty list, whatever the key', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End'] as const) {
      expect(nextIndex(0, 0, key)).toBe(-1);
      expect(nextIndex(5, 0, key)).toBe(-1);
    }
  });

  it('stays put on a single-row list', () => {
    expect(nextIndex(0, 1, 'ArrowDown')).toBe(0);
    expect(nextIndex(0, 1, 'ArrowUp')).toBe(0);
  });

  /**
   * The list shrinks between keystrokes.
   *
   * An index left over from a longer list would otherwise send the highlight past the end,
   * where nothing is highlighted and Enter does nothing for no visible reason.
   */
  it('clamps an index left over from a longer list', () => {
    expect(nextIndex(99, 3, 'ArrowDown')).toBe(0);
    expect(nextIndex(99, 3, 'ArrowUp')).toBe(1);
    expect(nextIndex(-5, 3, 'ArrowDown')).toBe(1);
  });
});

describe('resolveActiveIndex', () => {
  const keys = ['a', 'b', 'c'];

  it('keeps the highlight on the same row when the list reorders', () => {
    expect(resolveActiveIndex(keys, 'c')).toBe(2);
    expect(resolveActiveIndex(['c', 'a', 'b'], 'c')).toBe(0);
  });

  it('falls back to the top when the highlighted row has gone', () => {
    expect(resolveActiveIndex(keys, 'zzz')).toBe(0);
  });

  it('starts at the top when nothing is highlighted yet', () => {
    expect(resolveActiveIndex(keys, null)).toBe(0);
  });

  it('returns -1 for an empty list', () => {
    expect(resolveActiveIndex([], 'a')).toBe(-1);
    expect(resolveActiveIndex([], null)).toBe(-1);
  });
});

describe('isNavigationKey', () => {
  it('recognises the four keys the palette handles', () => {
    expect(isNavigationKey('ArrowDown')).toBe(true);
    expect(isNavigationKey('End')).toBe(true);
  });

  it('leaves everything else alone, including Enter and Escape', () => {
    for (const key of ['Enter', 'Escape', 'a', 'Tab', 'PageDown']) {
      expect(isNavigationKey(key), key).toBe(false);
    }
  });
});
