// SPDX-License-Identifier: GPL-3.0-or-later

import type { Platform } from '@shared/ipc/api.js';

/**
 * Key combinations, as data.
 *
 * One shape, three consumers — the key handler that matches an event against it, the help
 * sheet that draws it, and the conflict guard that proves no two commands claim it. That
 * is the point of the file: a combination written as a string in a `keydown` handler and
 * again as `"Ctrl+K"` in a help table is two lists, and the second one goes stale silently
 * because nothing can fail when a label lies.
 *
 * ## `mod`, not `ctrl` and `meta`
 *
 * A combination carries one abstract accelerator flag. `mod` is Command on macOS and
 * Control everywhere else, resolved at match time from the platform the main process
 * reports. Storing the two separately would mean every entry in the table appearing twice,
 * once per platform, which is the same duplication problem one layer down.
 *
 * The other modifier is then required to be **absent**: on macOS, Control+Command+K must
 * not fire Command+K. A handler that ignores the modifiers it did not ask about will fire
 * on a superset of what the user pressed, which is how a shortcut steals a combination
 * that belongs to the OS.
 */

export interface KeyCombo {
  /**
   * A normalised `KeyboardEvent.key`. Single characters are lower-cased; named keys keep
   * their DOM spelling (`Escape`, `Enter`, `ArrowDown`, `Backspace`).
   */
  readonly key: string;
  /** Command on macOS, Control elsewhere. */
  readonly mod: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

/** Everything a combo needs except the key, so table entries stay one line. */
const NO_MODIFIERS = { mod: false, shift: false, alt: false } as const;

/**
 * Builds a combo without repeating the false flags at every call site.
 *
 * A table of fifteen entries each spelling out `shift: false, alt: false` is a table nobody
 * reads, and an unread table is one a duplicate slips into.
 */
export function combo(key: string, modifiers: Partial<Omit<KeyCombo, 'key'>> = {}): KeyCombo {
  return { ...NO_MODIFIERS, ...modifiers, key: normaliseKey(key) };
}

/**
 * Folds a `KeyboardEvent.key` to the spelling the table uses.
 *
 * Only single-character keys are lower-cased. Named keys are multi-character and are left
 * alone, so `Escape` does not become `escape` and stop matching the table — and the check
 * is on length rather than a list of names, so a key nobody thought of still behaves.
 *
 * Shift is compared separately, which is why the character is folded rather than trusted:
 * pressing Shift+A reports `key === 'A'`, and a table entry written as `a` with
 * `shift: true` must still match it.
 */
export function normaliseKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/**
 * A stable identity for a combination, used only for equality and conflict detection.
 *
 * Deliberately not the human label: `⌘K` and `Ctrl+K` are the same binding shown to two
 * users, and a conflict check keyed on the label would find no conflict on macOS between
 * two entries that collide on Windows.
 */
export function comboId(target: KeyCombo): string {
  return [target.mod ? 'mod' : '', target.shift ? 'shift' : '', target.alt ? 'alt' : '', target.key]
    .filter((part) => part !== '')
    .join('+');
}

export function combosEqual(a: KeyCombo, b: KeyCombo): boolean {
  return comboId(a) === comboId(b);
}

/** The subset of a `KeyboardEvent` matching needs. Narrow, so a test can build one. */
export interface KeyEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/**
 * Whether a key event is this combination, on this platform.
 *
 * Every modifier is checked, including the ones the combo does not want. See the file
 * header: matching a superset is how a shortcut fires on a combination the user meant for
 * something else.
 */
export function matchesEvent(target: KeyCombo, event: KeyEventLike, platform: Platform): boolean {
  const mac = platform === 'darwin';
  const accelerator = mac ? event.metaKey : event.ctrlKey;
  const foreign = mac ? event.ctrlKey : event.metaKey;

  return (
    normaliseKey(event.key) === target.key &&
    accelerator === target.mod &&
    !foreign &&
    event.shiftKey === target.shift &&
    event.altKey === target.alt
  );
}

/**
 * How a key is drawn.
 *
 * Symbols on macOS because that is what the platform's own menus use and a Mac user reads
 * `⌫` faster than `Backspace`; words on Windows for exactly the same reason in reverse.
 */
const MAC_KEY_SYMBOLS: Readonly<Record<string, string>> = {
  Escape: 'Esc',
  Enter: '↩',
  Backspace: '⌫',
  Delete: '⌦',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ' ': 'Space',
};

const KEY_WORDS: Readonly<Record<string, string>> = {
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ' ': 'Space',
};

function formatKey(key: string, mac: boolean): string {
  const mapped = mac ? MAC_KEY_SYMBOLS[key] : KEY_WORDS[key];
  if (mapped !== undefined) return mapped;
  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * The label a human reads: `⌘K` on macOS, `Ctrl+K` on Windows and Linux.
 *
 * Modifier order follows each platform's own convention rather than one arbitrary order
 * used everywhere — Apple's is Control, Option, Shift, Command, and Windows leads with
 * Ctrl. Getting this wrong is not a functional bug, which is precisely why it would never
 * be noticed and never be fixed.
 *
 * Pure, and platform is a parameter rather than a lookup, so the whole table can be
 * rendered for both platforms in a test without stubbing anything.
 */
export function formatCombo(target: KeyCombo, platform: Platform): string {
  const mac = platform === 'darwin';
  const key = formatKey(target.key, mac);

  if (mac) {
    return `${target.alt ? '⌥' : ''}${target.shift ? '⇧' : ''}${target.mod ? '⌘' : ''}${key}`;
  }

  const parts: string[] = [];
  if (target.mod) parts.push('Ctrl');
  if (target.alt) parts.push('Alt');
  if (target.shift) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/**
 * The same label, split for assistive tech.
 *
 * `⌘K` is announced by a screen reader as an unpronounceable glyph followed by a letter.
 * The visible label stays symbolic and this goes on `aria-label`, so both audiences get the
 * form they can actually use — and it is derived from the same combo, not typed twice.
 */
export function describeCombo(target: KeyCombo, platform: Platform): string {
  const parts: string[] = [];
  if (target.mod) parts.push(platform === 'darwin' ? 'Command' : 'Control');
  if (target.alt) parts.push(platform === 'darwin' ? 'Option' : 'Alt');
  if (target.shift) parts.push('Shift');
  parts.push(target.key.length === 1 ? target.key.toUpperCase() : target.key);
  return parts.join(' ');
}
