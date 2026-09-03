// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from '../components/Button.js';
import type { ToolViewDefinition } from './tool-views.js';
import './tool-view.css';

/**
 * The frame a tool view is mounted in: a bar with the way back, the page's heading, and the
 * tool underneath.
 *
 * ## The frame owns the `<h1>`, and focus lands on it
 *
 * Swapping the main region's contents is a navigation, and a navigation that leaves focus
 * where it was strands a screen-reader user on the page they just left — they press Tab and
 * arrive somewhere in the middle of a screen they were never told they were on. So the
 * heading is a real `<h1>`, it is `tabIndex={-1}`, and it takes focus whenever the view
 * changes. Tab from there walks the tool in order, and Shift+Tab reaches the Back button
 * immediately above it.
 *
 * The frame renders the title rather than each tool rendering its own because the four tools
 * were built as standalone screens and each brought a heading of its own; two page titles
 * stacked on top of each other reads as a bug. The three we own are mounted with their title
 * suppressed and keep their subtitle and their actions — see `VaultScreen.tsx`.
 *
 * ## Two ways back, one of them a key
 *
 * A visible "Back to vault" button, and Escape. Escape is handled on the container rather
 * than the document, so it only fires while focus is somewhere inside the tool — and a
 * dialog opened *within* a tool (the settings screen has several) stops the event at the
 * dialog, because `Modal` calls `stopPropagation` for exactly this case. Closing the
 * top-most thing is what Escape means everywhere else in the app.
 */

export interface ToolViewProps {
  readonly view: ToolViewDefinition;
  /** Returns to the three-pane vault. Wired to the store's `close` by the vault screen. */
  readonly onClose: () => void;
  readonly children: ReactNode;
}

export function ToolView({ view, onClose, children }: ToolViewProps): React.JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();

  // Focus, not state — an effect is the right place for it, and this one runs on the
  // view id so switching from Health to Help re-announces rather than silently swapping
  // the page out from under an unchanged focus position.
  useEffect(() => {
    headingRef.current?.focus();
  }, [view.id]);

  return (
    <section
      className="kh-tool"
      aria-labelledby={headingId}
      data-fills={view.fills || undefined}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="kh-tool__bar">
        <Button
          variant="ghost"
          size="sm"
          icon={<span aria-hidden="true">←</span>}
          onClick={onClose}
        >
          Back to vault
        </Button>

        <h1 className="kh-tool__title" id={headingId} tabIndex={-1} ref={headingRef}>
          {view.title}
        </h1>

        {/* A hint, not a control — the button beside it is the operable path, and this
            only tells a mouse user that the key exists. Hidden when the window is too
            narrow to hold it without squeezing the title. */}
        <p className="kh-tool__hint">
          Press <kbd className="kh-tool__key">Esc</kbd> to go back
        </p>
      </div>

      <div className="kh-tool__body">{children}</div>
    </section>
  );
}
