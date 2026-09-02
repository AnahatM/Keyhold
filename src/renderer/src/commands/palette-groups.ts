// SPDX-License-Identifier: GPL-3.0-or-later

import { COMMAND_SECTIONS } from './command-registry.js';
import type { PaletteItem } from './palette-search.js';

/**
 * How the results are divided into headed groups.
 *
 * Two different lists, because the user is asking two different questions:
 *
 * - **Nothing typed** — "what can I do?". Headings help: Recent, then Vault, Navigate,
 *   Record, Help. The list is short and the structure is the answer.
 * - **Something typed** — "where is this?". One flat list, ranked. Grouping here would
 *   fight the ranking: the best match would sit under whichever heading it belongs to
 *   rather than at the top, and the user would have to scan every group to find it. The
 *   heading says how many, which is the only thing they still need to know.
 *
 * Pure, so both shapes are asserted directly. The DOM consequence — `role="group"` inside
 * the listbox, one `aria-labelledby` per heading — is the component's business.
 */

export interface PaletteGroup {
  /** Stable within one render; used for the `role="group"` label association. */
  readonly id: string;
  readonly label: string;
  readonly items: readonly PaletteItem[];
}

export const RECENT_GROUP_LABEL = 'Recent';

export function groupPaletteItems(
  items: readonly PaletteItem[],
  options: { readonly queryIsEmpty: boolean; readonly recentKeys: readonly string[] }
): readonly PaletteGroup[] {
  if (items.length === 0) return [];

  if (!options.queryIsEmpty) {
    return [{ id: 'results', label: `Results (${items.length})`, items }];
  }

  const recentKeys = new Set(options.recentKeys);
  const groups: PaletteGroup[] = [];

  // Recents keep the order `searchPalette` put them in — most recent first — rather than
  // being re-sorted here. Re-sorting would make "recent" mean nothing.
  const recent = items.filter((item) => recentKeys.has(item.key));
  if (recent.length > 0) {
    groups.push({ id: 'recent', label: RECENT_GROUP_LABEL, items: recent });
  }

  for (const section of COMMAND_SECTIONS) {
    const inSection = items.filter(
      (item) =>
        !recentKeys.has(item.key) &&
        item.kind === 'command' &&
        item.command.definition.section === section
    );
    if (inSection.length > 0) {
      groups.push({ id: `section-${section.toLowerCase()}`, label: section, items: inSection });
    }
  }

  return groups;
}

/**
 * The flat key order the keyboard walks.
 *
 * Derived from the groups rather than from `items`, so what Down-arrow does next is always
 * what the eye sees next. Building it from the ungrouped list instead is the classic way a
 * grouped listbox ends up navigating in an order that does not match its own display.
 */
export function flattenGroups(groups: readonly PaletteGroup[]): readonly PaletteItem[] {
  return groups.flatMap((group) => group.items);
}
