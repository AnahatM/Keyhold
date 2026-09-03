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
 *
 * **It has a second mode.** Supply `main` and the list and detail step aside for it, leaving
 * the sidebar in place — that is how the tool views (health, generator, help, settings) are
 * shown. See the `main` prop for why they cannot live in the detail pane.
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
  /**
   * Takes over from the list and the detail for as long as it is supplied.
   *
   * The tool views — health, the generator, help, settings — are not about a record, and
   * none of them fits in a column sized for one. So they get the whole main region and the
   * two record panes step aside, exactly the way the detail pane already takes over from the
   * list in a narrow window. The sidebar deliberately stays: it holds the rows that opened
   * the tool and is therefore the most obvious way back out of it.
   *
   * Additive on purpose. The three-pane path below is untouched when this is `undefined`,
   * so nothing about the existing layout depends on a mode flag being read correctly.
   */
  readonly main?: ReactNode;
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
  main,
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
  const toolOpen = main !== undefined;
  // In a narrow window the list and the detail take turns rather than sharing. A tool view
  // takes precedence over both at every width — it *is* the main region while it is open.
  const showList = !toolOpen && (!narrow || !hasSelection);
  const showDetail = !toolOpen && (!narrow || hasSelection);

  return (
    <div
      className="kh-shell"
      data-narrow={narrow || undefined}
      data-tool={toolOpen || undefined}
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

      {/* The tool view. It carries `#kh-main` while it is open, so the skip link at the top
          of the shell lands on the thing that is actually the main content rather than on a
          detail pane that is not currently rendered. */}
      {toolOpen && (
        <main className="kh-shell__main" id="kh-main" tabIndex={-1}>
          {main}
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
