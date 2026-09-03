// SPDX-License-Identifier: GPL-3.0-or-later
import { TOOL_VIEWS, TOOL_VIEW_IDS } from '../shell/tool-views.js';
import { describe, expect, it } from 'vitest';
import { COMMANDS, COMMAND_BY_ID, COMMAND_SECTIONS, type CommandId } from './command-registry.js';

/**
 * Guard: every tool view is reachable from the palette, and stays reachable.
 *
 * Three surfaces open a tool view — the sidebar row, the palette, and eventually a native
 * menu item — and only one of them is a list a person writes by hand. So the palette
 * entries are generated from `TOOL_VIEWS` rather than typed out, and this asserts the
 * generation actually covers it.
 *
 * The failure this prevents is quiet and specific: someone adds a fifth tool, the sidebar
 * grows a row because it reads the table, and the palette does not because nobody
 * remembered a second list. Nobody notices, because the palette is the surface people reach
 * for when they have *forgotten* where something is — so the one moment it is missing is
 * the one moment it was needed.
 */

describe('tool view commands', () => {
  it('exist for every tool view, with no extras', () => {
    const fromViews = TOOL_VIEW_IDS.map((id) => `tools.${id}`).sort();
    const inPalette = COMMANDS.map((command) => command.id)
      .filter((id) => id.startsWith('tools.'))
      .sort();

    expect(inPalette).toEqual(fromViews);
  });

  it('carry the tool s own title, not a second wording of it', () => {
    // A palette row reading "Password generator" that lands on a page titled "Generate a
    // password" is the small drift nothing ever tests, and it is why the title is read from
    // the table rather than retyped.
    for (const view of TOOL_VIEWS) {
      expect(COMMAND_BY_ID.get(`tools.${view.id}` as CommandId)?.title).toBe(view.title);
    }
  });

  it('land in a real section', () => {
    for (const view of TOOL_VIEWS) {
      const command = COMMAND_BY_ID.get(`tools.${view.id}` as CommandId);
      expect(COMMAND_SECTIONS as readonly string[]).toContain(command?.section);
    }
  });

  it('never require a selection and are never destructive', () => {
    // Both load-bearing. A tool view answers a question that is not about a record, which is
    // why it is a region of the shell rather than a fourth pane — gating it on a selection
    // would hide "generate a password" behind having picked a login first. And a destructive
    // flag would put a confirmation in front of opening a page.
    for (const view of TOOL_VIEWS) {
      const command = COMMAND_BY_ID.get(`tools.${view.id}` as CommandId);
      expect(command?.requiresSelection).toBe(false);
      expect(command?.destructive).toBe(false);
    }
  });

  it('are searchable by words people type rather than the words on the page', () => {
    // The summary is written to be read by someone hovering a sidebar row. Keywords are
    // written to be matched: nobody types "eight offline checks over every record".
    const health = COMMAND_BY_ID.get('tools.health');
    expect(health?.keywords).toContain('reused');
    expect(health?.keywords).toContain('weak');

    const generator = COMMAND_BY_ID.get('tools.generator');
    expect(generator?.keywords).toContain('passphrase');
  });

  it('do not restate a shortcut, because none of them has one', () => {
    // If a tool view ever gets a key binding it must name a `shortcutId` and let the label
    // be read out of the shortcut table — hard rule 8. This asserts the current state so
    // that adding a binding is a deliberate edit here rather than a string typed inline.
    for (const view of TOOL_VIEWS) {
      expect(COMMAND_BY_ID.get(`tools.${view.id}` as CommandId)?.shortcutId).toBeUndefined();
    }
  });
});
