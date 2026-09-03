// SPDX-License-Identifier: GPL-3.0-or-later

import { useId } from 'react';
import { useToolView } from './tool-view-store.js';
import { TOOL_VIEWS } from './tool-views.js';

/**
 * The sidebar's Tools section — the visible way into a tool view.
 *
 * A palette command and a menu item are both invisible until you know they are there, and
 * three finished screens reachable only by people who already know they exist are barely
 * more reachable than three screens nobody mounted. So the same four destinations get a
 * permanent row in the sidebar, below the folders and above the lock control, which is where
 * every other credential manager puts its generator and its health report.
 *
 * It reuses `.kh-sidebar__item` rather than growing a set of near-identical classes: this is
 * the same kind of control as a smart view, and it should not look like a different one.
 *
 * `aria-current` marks the open view — and the row is also the way back out of it, because
 * `toggle` closes a view that is already open. Nothing here is colour-alone: the current row
 * is announced by `aria-current`, and the whole main region has changed besides.
 */
export function ToolNav(): React.JSX.Element {
  const active = useToolView((state) => state.active);
  const toggle = useToolView((state) => state.toggle);
  const groupId = useId();

  return (
    <nav className="kh-sidebar__nav kh-tools-nav" aria-labelledby={groupId}>
      <h2 className="kh-sidebar__group" id={groupId}>
        Tools
      </h2>

      <ul className="kh-tools-nav__list">
        {TOOL_VIEWS.map((view) => (
          <li key={view.id}>
            <button
              type="button"
              className="kh-sidebar__item"
              aria-current={view.id === active}
              // The summary is the row's description rather than a `title` attribute: a
              // native tooltip is mouse-only and never reaches a keyboard or a screen
              // reader, which are the users a nav row most needs to explain itself to.
              aria-describedby={`${groupId}-${view.id}`}
              onClick={() => {
                toggle(view.id);
              }}
            >
              <span className="kh-sidebar__item-label">{view.title}</span>
            </button>
            <span className="kh-visually-hidden" id={`${groupId}-${view.id}`}>
              {view.summary}
            </span>
          </li>
        ))}
      </ul>
    </nav>
  );
}
