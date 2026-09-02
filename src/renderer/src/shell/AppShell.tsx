// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import './AppShell.css';

/**
 * The three-pane shell: sidebar, list, detail.
 *
 * The pattern 1Password, Bitwarden and Apple Passwords all independently converged on
 * (decision D7), with both side panes collapsible.
 *
 * Two things it has to get right, neither of which is obvious from a screenshot:
 *
 * **It degrades rather than breaks.** Below the breakpoints the panes drop away in order —
 * three, then two, then one — instead of squeezing until nothing is readable. A
 * credential manager is often a narrow window parked beside whatever you are actually
 * doing, so the narrow case is a normal case, not an edge case.
 *
 * **Pane widths are draggable, and the drag is keyboard-operable.** A divider you can only
 * move with a mouse is a divider a keyboard user cannot move at all, so each one is a
 * proper `separator` with arrow-key handling.
 */

const MIN_PANE = 180;
const MAX_SIDEBAR = 420;
const MAX_LIST = 560;

/** Below this the detail pane overlays instead of sitting beside the list. */
const NARROW_BREAKPOINT = 900;
/** Below this the sidebar collapses too. */
const VERY_NARROW_BREAKPOINT = 680;

export interface AppShellProps {
  readonly sidebar: ReactNode;
  readonly list: ReactNode;
  readonly detail: ReactNode;
  readonly sidebarCollapsed?: boolean;
  readonly onSidebarCollapsedChange?: (collapsed: boolean) => void;
  /** True when a record is selected — decides what a narrow window shows. */
  readonly hasSelection?: boolean;
  readonly onBack?: () => void;
}

interface Widths {
  readonly sidebar: number;
  readonly list: number;
}

const STORAGE_KEY = 'keyhold.paneWidths';
const DEFAULT_WIDTHS: Widths = { sidebar: 240, list: 320 };

function readWidths(): Widths {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_WIDTHS;
    const parsed = JSON.parse(raw) as Partial<Widths>;
    return {
      sidebar: clamp(parsed.sidebar ?? DEFAULT_WIDTHS.sidebar, MIN_PANE, MAX_SIDEBAR),
      list: clamp(parsed.list ?? DEFAULT_WIDTHS.list, MIN_PANE, MAX_LIST),
    };
  } catch {
    return DEFAULT_WIDTHS;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function AppShell({
  sidebar,
  list,
  detail,
  sidebarCollapsed = false,
  onSidebarCollapsedChange,
  hasSelection = false,
  onBack,
}: AppShellProps): React.JSX.Element {
  const [widths, setWidths] = useState<Widths>(readWidths);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const dragging = useRef<'sidebar' | 'list' | null>(null);

  // Width is tracked in state rather than handled purely in CSS because the layout MODE
  // changes, not just the sizes — at narrow widths the detail pane stops being a column
  // and becomes the whole view, which media queries alone cannot express here.
  useEffect(() => {
    const onResize = (): void => {
      setViewportWidth(window.innerWidth);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const persist = useCallback((next: Widths) => {
    setWidths(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Losing pane widths is not worth surfacing.
    }
  }, []);

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      if (dragging.current === null) return;
      event.preventDefault();

      if (dragging.current === 'sidebar') {
        persist({ ...widths, sidebar: clamp(event.clientX, MIN_PANE, MAX_SIDEBAR) });
      } else {
        const offset = sidebarCollapsed ? 0 : widths.sidebar;
        persist({ ...widths, list: clamp(event.clientX - offset, MIN_PANE, MAX_LIST) });
      }
    };

    const onUp = (): void => {
      dragging.current = null;
      document.body.classList.remove('kh-resizing');
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [widths, sidebarCollapsed, persist]);

  const startDrag = useCallback((which: 'sidebar' | 'list'): void => {
    dragging.current = which;
    // Suppresses text selection and keeps the resize cursor for the whole drag, rather
    // than it flickering as the pointer crosses child elements.
    document.body.classList.add('kh-resizing');
  }, []);

  /** Arrow keys move a divider, so it is not mouse-only. */
  const onDividerKey =
    (which: 'sidebar' | 'list') =>
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const step = event.shiftKey ? 48 : 12;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();

      const delta = event.key === 'ArrowLeft' ? -step : step;
      if (which === 'sidebar') {
        persist({ ...widths, sidebar: clamp(widths.sidebar + delta, MIN_PANE, MAX_SIDEBAR) });
      } else {
        persist({ ...widths, list: clamp(widths.list + delta, MIN_PANE, MAX_LIST) });
      }
    };

  const narrow = viewportWidth < NARROW_BREAKPOINT;
  const veryNarrow = viewportWidth < VERY_NARROW_BREAKPOINT;
  const showSidebar = !sidebarCollapsed && !veryNarrow;
  // In a narrow window the list and the detail take turns rather than sharing.
  const showList = !narrow || !hasSelection;
  const showDetail = !narrow || hasSelection;

  return (
    <div
      className="kh-shell"
      data-narrow={narrow || undefined}
      style={{
        // Custom properties rather than inline width, so the CSS keeps ownership of the
        // grid and this only supplies the two numbers it cannot know.
        ['--kh-shell-sidebar' as string]: `${widths.sidebar}px`,
        ['--kh-shell-list' as string]: `${widths.list}px`,
      }}
    >
      <a className="kh-visually-hidden kh-skip-link" href="#kh-main">
        Skip to main content
      </a>

      {showSidebar && (
        <>
          <nav className="kh-shell__sidebar" aria-label="Vault navigation">
            {sidebar}
          </nav>
          <div
            className="kh-shell__divider"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the sidebar"
            aria-valuenow={widths.sidebar}
            aria-valuemin={MIN_PANE}
            aria-valuemax={MAX_SIDEBAR}
            tabIndex={0}
            onMouseDown={() => {
              startDrag('sidebar');
            }}
            onKeyDown={onDividerKey('sidebar')}
          />
        </>
      )}

      {showList && (
        <>
          <section className="kh-shell__list" aria-label="Credentials">
            {list}
          </section>
          {showDetail && (
            <div
              className="kh-shell__divider"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the credential list"
              aria-valuenow={widths.list}
              aria-valuemin={MIN_PANE}
              aria-valuemax={MAX_LIST}
              tabIndex={0}
              onMouseDown={() => {
                startDrag('list');
              }}
              onKeyDown={onDividerKey('list')}
            />
          )}
        </>
      )}

      {showDetail && (
        <main className="kh-shell__detail" id="kh-main" tabIndex={-1}>
          {narrow && hasSelection && onBack !== undefined && (
            <button type="button" className="kh-shell__back" onClick={onBack}>
              ← Back to list
            </button>
          )}
          {detail}
        </main>
      )}

      {sidebarCollapsed && !veryNarrow && onSidebarCollapsedChange !== undefined && (
        <button
          type="button"
          className="kh-shell__reveal"
          onClick={() => {
            onSidebarCollapsedChange(false);
          }}
          aria-label="Show the sidebar"
        >
          ›
        </button>
      )}
    </div>
  );
}
