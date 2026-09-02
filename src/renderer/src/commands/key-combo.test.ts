// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  combo,
  combosEqual,
  describeCombo,
  formatCombo,
  matchesEvent,
  normaliseKey,
  type KeyEventLike,
} from './key-combo.js';
import { SHORTCUTS } from './shortcut-registry.js';

function event(overrides: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key: 'k', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...overrides };
}

describe('normaliseKey', () => {
  it('lower-cases single characters so Shift+A matches a table entry written as "a"', () => {
    expect(normaliseKey('A')).toBe('a');
    expect(normaliseKey('/')).toBe('/');
  });

  it('leaves named keys alone', () => {
    expect(normaliseKey('Escape')).toBe('Escape');
    expect(normaliseKey('ArrowDown')).toBe('ArrowDown');
  });
});

describe('matchesEvent — mod means Command on macOS and Control elsewhere', () => {
  const target = combo('k', { mod: true });

  it('matches Command+K on darwin', () => {
    expect(matchesEvent(target, event({ metaKey: true }), 'darwin')).toBe(true);
    expect(matchesEvent(target, event({ ctrlKey: true }), 'darwin')).toBe(false);
  });

  it('matches Control+K on win32', () => {
    expect(matchesEvent(target, event({ ctrlKey: true }), 'win32')).toBe(true);
    expect(matchesEvent(target, event({ metaKey: true }), 'win32')).toBe(false);
  });

  it('matches Control+K on linux', () => {
    expect(matchesEvent(target, event({ ctrlKey: true }), 'linux')).toBe(true);
  });

  /**
   * The superset case.
   *
   * A handler that only checks the modifiers it wants fires on every combination
   * containing them — so Command+Control+K, which belongs to the OS or to another app,
   * would trigger the palette. Every modifier is checked, including the absent ones.
   */
  it('refuses a combination that carries the other platform accelerator too', () => {
    expect(matchesEvent(target, event({ metaKey: true, ctrlKey: true }), 'darwin')).toBe(false);
    expect(matchesEvent(target, event({ metaKey: true, ctrlKey: true }), 'win32')).toBe(false);
  });

  it('refuses a combination with an extra Shift or Alt', () => {
    expect(matchesEvent(target, event({ ctrlKey: true, shiftKey: true }), 'win32')).toBe(false);
    expect(matchesEvent(target, event({ ctrlKey: true, altKey: true }), 'win32')).toBe(false);
  });

  it('matches Shift combinations even though the browser reports an upper-case key', () => {
    const shifted = combo('t', { mod: true, shift: true });
    expect(matchesEvent(shifted, event({ key: 'T', ctrlKey: true, shiftKey: true }), 'win32')).toBe(
      true
    );
  });

  it('refuses a bare key when the combination wants an accelerator', () => {
    expect(matchesEvent(target, event(), 'win32')).toBe(false);
  });

  it('matches a bare named key', () => {
    expect(matchesEvent(combo('Escape'), event({ key: 'Escape' }), 'darwin')).toBe(true);
  });
});

describe('formatCombo — platform-correct labels', () => {
  it('draws ⌘K on macOS and Ctrl+K on Windows', () => {
    const target = combo('k', { mod: true });
    expect(formatCombo(target, 'darwin')).toBe('⌘K');
    expect(formatCombo(target, 'win32')).toBe('Ctrl+K');
    expect(formatCombo(target, 'linux')).toBe('Ctrl+K');
  });

  it('orders modifiers the way each platform does', () => {
    const target = combo('t', { mod: true, shift: true, alt: true });
    // Apple: Control, Option, Shift, Command.
    expect(formatCombo(target, 'darwin')).toBe('⌥⇧⌘T');
    expect(formatCombo(target, 'win32')).toBe('Ctrl+Alt+Shift+T');
  });

  it('uses the platform spelling for named keys', () => {
    expect(formatCombo(combo('Backspace', { mod: true }), 'darwin')).toBe('⌘⌫');
    expect(formatCombo(combo('Backspace', { mod: true }), 'win32')).toBe('Ctrl+Backspace');
    expect(formatCombo(combo('Escape'), 'win32')).toBe('Esc');
  });

  it('renders a punctuation key as itself', () => {
    expect(formatCombo(combo('/', { mod: true }), 'darwin')).toBe('⌘/');
    expect(formatCombo(combo('/', { mod: true }), 'win32')).toBe('Ctrl+/');
  });
});

describe('describeCombo — the spoken form', () => {
  it('spells out the modifiers a screen reader cannot pronounce', () => {
    const target = combo('k', { mod: true });
    expect(describeCombo(target, 'darwin')).toBe('Command K');
    expect(describeCombo(target, 'win32')).toBe('Control K');
  });

  it('names the Mac modifier keys correctly', () => {
    const target = combo('t', { mod: true, alt: true, shift: true });
    expect(describeCombo(target, 'darwin')).toBe('Command Option Shift T');
    expect(describeCombo(target, 'win32')).toBe('Control Alt Shift T');
  });

  /**
   * No glyph reaches the accessible name.
   *
   * `⌘` is announced as nothing useful, or as "place of interest sign". If a symbol leaks
   * into `describeCombo` the visible and spoken labels have quietly become one label again.
   */
  it('contains no symbol for any shortcut in the real table, on either platform', () => {
    for (const shortcut of SHORTCUTS) {
      for (const platform of ['darwin', 'win32'] as const) {
        expect(describeCombo(shortcut.combo, platform), shortcut.id).not.toMatch(/[⌘⌥⇧⌫⌦↩]/u);
      }
    }
  });
});

describe('every shortcut in the table renders on both platforms', () => {
  it('produces a non-empty, distinct label for each entry', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const labels = SHORTCUTS.map((shortcut) => formatCombo(shortcut.combo, platform));
      for (const label of labels) expect(label).not.toBe('');
      // Distinct labels follow from the conflict guard, but a formatting bug that collapsed
      // two combinations to one string would make the help sheet lie without conflicting.
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
});

describe('combosEqual', () => {
  it('ignores how the key was capitalised at the call site', () => {
    expect(combosEqual(combo('K', { mod: true }), combo('k', { mod: true }))).toBe(true);
    expect(combosEqual(combo('k', { mod: true }), combo('k', { mod: true, shift: true }))).toBe(
      false
    );
  });
});
