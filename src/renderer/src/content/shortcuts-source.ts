// SPDX-License-Identifier: GPL-3.0-or-later

import { SCOPE_DESCRIPTIONS, SCOPE_LABELS, SHORTCUTS, SHORTCUT_SCOPES } from '../commands/index.js';
import type { ContentFactRow } from './content-types.js';

/**
 * What the keyboard-shortcuts article is allowed to say, read from the shortcut registry.
 *
 * ## Why this page does not print the shortcut table
 *
 * It could — `SHORTCUTS` is right there — and it deliberately does not.
 *
 * `ShortcutsHelp` renders that table, and it takes a `boundIds` set: it shows only the
 * shortcuts that have a handler mounted at that moment, because a row for a key that does
 * nothing is exactly the lie a single registry exists to prevent. A static help article
 * cannot know which handlers are mounted, so a table drawn here would be the complete list
 * regardless of what actually fires — a strictly worse version of the sheet that already
 * exists, printed in the place a confused user is most likely to trust.
 *
 * It also could not render a key label correctly. The modifier is `⌘` or `Ctrl` depending
 * on the platform, which arrives asynchronously from the main process; the house rule is
 * to show no label rather than guess and be wrong for one frame.
 *
 * So this module exposes only what is true no matter what is mounted — the scopes, what
 * each means, and how many bindings the registry defines — and the article sends the reader
 * to the sheet for the keys themselves. Every value below still comes from the registry, so
 * a scope added or a binding removed changes this page in the same commit.
 */

/** One row per scope, straight from the registry's own labels. */
export const SHORTCUT_SCOPE_ROWS: readonly ContentFactRow[] = SHORTCUT_SCOPES.map((scope) => ({
  term: SCOPE_LABELS[scope],
  description: SCOPE_DESCRIPTIONS[scope],
}));

/** How many bindings the registry defines. Quoted in the article, guarded by its test. */
export const SHORTCUT_COUNT = SHORTCUTS.length;
