// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Where the highlight goes when an arrow key is pressed.
 *
 * Extracted from the palette because it is the part with edge cases — an empty list, a
 * single row, the wrap at each end — and none of them need a DOM to assert. The component
 * keeps only the parts that genuinely do.
 *
 * **The list wraps.** Down from the last row returns to the first. In a palette this is
 * right: the list is short, the user is holding a key, and stopping dead at the bottom
 * reads as the palette having frozen. (A long document list is the opposite case and
 * should clamp — hence this being a function with a name rather than a rule assumed
 * everywhere.)
 */

export type NavigationKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

export const NAVIGATION_KEYS: readonly NavigationKey[] = ['ArrowDown', 'ArrowUp', 'Home', 'End'];

export function isNavigationKey(key: string): key is NavigationKey {
  return (NAVIGATION_KEYS as readonly string[]).includes(key);
}

/**
 * The next highlighted index, or `-1` when there is nothing to highlight.
 *
 * `current` is clamped rather than trusted: it is derived from a search that has just
 * re-run, so it can point past the end of a list that shrank on the last keystroke. An
 * out-of-range index would highlight nothing and make Enter do nothing, with no visible
 * cause.
 */
export function nextIndex(current: number, count: number, key: NavigationKey): number {
  if (count <= 0) return -1;

  const from = Math.min(Math.max(current, 0), count - 1);

  switch (key) {
    case 'ArrowDown':
      return (from + 1) % count;
    case 'ArrowUp':
      return (from - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
  }
}

/**
 * The index a key should highlight, given the key that was highlighted before the search
 * re-ran.
 *
 * The palette tracks the **key** of the active row, not its index. A query changing
 * reorders and shortens the list, so an index means a different row from one keystroke to
 * the next — the highlight would appear to crawl through the results as the user types.
 * Tracking the key means the highlight stays on the row the user was looking at for as long
 * as that row survives, and falls back to the top when it does not.
 *
 * This also removes the reset-on-change effect entirely: there is nothing to synchronise,
 * so there is no `setState` in an effect body to get wrong.
 */
export function resolveActiveIndex(keys: readonly string[], activeKey: string | null): number {
  if (keys.length === 0) return -1;
  if (activeKey === null) return 0;
  const found = keys.indexOf(activeKey);
  return found === -1 ? 0 : found;
}
