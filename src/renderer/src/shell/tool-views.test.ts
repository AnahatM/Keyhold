// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  TOOL_VIEWS,
  TOOL_VIEW_BY_ID,
  TOOL_VIEW_IDS,
  toolViewForMenuCommand,
} from './tool-views.js';

/**
 * The registry's guard — hard rule 9.
 *
 * A route table's failure mode is a duplicate: two rows opening the same view, or two views
 * claiming one menu command, so the second silently never fires. None of that shows up in a
 * screenshot and none of it throws, which is exactly why it is asserted here.
 */
describe('the tool view registry', () => {
  it('has one definition per id, and no extras', () => {
    expect(TOOL_VIEWS.map((view) => view.id)).toEqual([...TOOL_VIEW_IDS]);
    expect(TOOL_VIEW_BY_ID.size).toBe(TOOL_VIEW_IDS.length);
  });

  it('never reuses a menu command', () => {
    const menuCommandIds = TOOL_VIEWS.map((view) => view.menuCommandId);
    expect(new Set(menuCommandIds).size).toBe(menuCommandIds.length);
  });

  it('maps every menu command back to its view, and nothing else', () => {
    for (const view of TOOL_VIEWS) {
      expect(toolViewForMenuCommand(view.menuCommandId)).toBe(view.id);
    }
    expect(toolViewForMenuCommand('vault.lock')).toBeNull();
    expect(toolViewForMenuCommand('')).toBeNull();
  });

  it('gives every view a title and a summary to be announced by', () => {
    for (const view of TOOL_VIEWS) {
      expect(view.title.length).toBeGreaterThan(0);
      expect(view.summary.length).toBeGreaterThan(0);
    }
  });
});
