// SPDX-License-Identifier: GPL-3.0-or-later

import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import {
  defaultTooltipGroup,
  TOOLTIP_CLOSE_DELAY_MS,
  type TooltipGroup,
} from './tooltip-timing.js';
import './chrome.css';

/**
 * A tooltip that a keyboard user can actually reach.
 *
 * The failure this component exists to avoid is a one-liner: a tooltip bound only to
 * `mouseenter` is *invisible* to anyone navigating by keyboard, which usually means the
 * only explanation of an icon-only button is unreachable by the people most reliant on it.
 * So focus opens it, with no delay — see `tooltip-timing.ts` for the full timing rules.
 *
 * Three more things WCAG 2.2 SC 1.4.13 requires of content shown on hover, all handled:
 *
 * - **Dismissible** — Escape closes it without moving focus.
 * - **Hoverable** — a grace period on leave lets the pointer travel onto the tooltip.
 * - **Persistent** — it stays until the pointer or focus leaves, never on a timer.
 *
 * The description relationship is real `aria-describedby`, cloned onto the child, so a
 * screen reader reads the label as part of the control rather than as a stray box. A
 * `title` attribute would be simpler and is the usual shortcut; it is also invisible to
 * touch, unstyleable, and announced inconsistently.
 */

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

/** The gap between trigger and tooltip, and the margin kept from the window edge. */
const OFFSET_PX = 8;
const VIEWPORT_MARGIN_PX = 8;

export interface TooltipProps {
  /** The description. A short phrase — a tooltip is not a place for a paragraph. */
  readonly label: string;
  readonly placement?: TooltipPlacement;
  /** Share a warm-up window with other tooltips. Defaults to the app-wide group. */
  readonly group?: TooltipGroup;
  /**
   * Exactly one element, and it must be focusable.
   *
   * Wrapping a `<span>` would produce a tooltip only a mouse can reach, which is the whole
   * thing this component exists to prevent — so wrap the button, not its label.
   */
  readonly children: ReactElement<{ readonly 'aria-describedby'?: string | undefined }>;
}

interface Position {
  readonly top: number;
  readonly left: number;
}

function computePosition(anchor: DOMRect, tooltip: DOMRect, placement: TooltipPlacement): Position {
  const centreX = anchor.left + anchor.width / 2 - tooltip.width / 2;
  const centreY = anchor.top + anchor.height / 2 - tooltip.height / 2;

  const raw: Position = {
    top:
      placement === 'top'
        ? anchor.top - tooltip.height - OFFSET_PX
        : placement === 'bottom'
          ? anchor.bottom + OFFSET_PX
          : centreY,
    left:
      placement === 'left'
        ? anchor.left - tooltip.width - OFFSET_PX
        : placement === 'right'
          ? anchor.right + OFFSET_PX
          : centreX,
  };

  // Clamped to the window. A tooltip on the last button of a right-hand pane would
  // otherwise render half off-screen, which is exactly where icon-only buttons live.
  const maxLeft = window.innerWidth - tooltip.width - VIEWPORT_MARGIN_PX;
  const maxTop = window.innerHeight - tooltip.height - VIEWPORT_MARGIN_PX;
  return {
    top: Math.min(Math.max(VIEWPORT_MARGIN_PX, raw.top), Math.max(VIEWPORT_MARGIN_PX, maxTop)),
    left: Math.min(Math.max(VIEWPORT_MARGIN_PX, raw.left), Math.max(VIEWPORT_MARGIN_PX, maxLeft)),
  };
}

export function Tooltip({
  label,
  placement = 'top',
  group = defaultTooltipGroup,
  children,
}: TooltipProps): React.JSX.Element {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);

  const clearTimers = useCallback((): void => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  // Every timer this component starts is cleared here. A tooltip whose open timer survives
  // unmount fires `setOpen` on a dead component and, worse, leaves a box on screen with no
  // trigger under it.
  useEffect(() => clearTimers, [clearTimers]);

  const requestOpen = useCallback(
    (trigger: 'pointer' | 'focus'): void => {
      clearTimers();
      const delay = group.openDelayMs(trigger, Date.now());
      if (delay === 0) {
        setOpen(true);
        return;
      }
      openTimer.current = window.setTimeout(() => {
        setOpen(true);
      }, delay);
    },
    [clearTimers, group]
  );

  const requestClose = useCallback(
    (immediate: boolean): void => {
      clearTimers();
      const close = (): void => {
        setOpen(false);
        setPosition(null);
        group.noteClosed(Date.now());
      };
      if (immediate) {
        close();
        return;
      }
      closeTimer.current = window.setTimeout(close, TOOLTIP_CLOSE_DELAY_MS);
    },
    [clearTimers, group]
  );

  /*
   * Position is measured, not derived — it needs both boxes' real sizes, which only exist
   * after layout. A layout effect (rather than a plain effect) means the value is committed
   * before the browser paints, so the tooltip never flashes at the wrong coordinates.
   * Until it has a position it renders hidden but laid out, so there is something to
   * measure.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const tooltip = tooltipRef.current;
    if (anchor === null || tooltip === null) return;
    setPosition(
      computePosition(anchor.getBoundingClientRect(), tooltip.getBoundingClientRect(), placement)
    );
    // `label` is deliberately not a dependency: it is a static string at every call
    // site, and re-measuring on it would only matter for a tooltip whose text changes
    // while it is already open.
  }, [open, placement]);

  // Escape dismisses without moving focus — SC 1.4.13. On the document rather than the
  // trigger, because the pointer can open a tooltip while focus is somewhere else entirely.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') requestClose(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, requestClose]);

  const describedBy = [children.props['aria-describedby'], open ? id : null]
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join(' ');

  return (
    <>
      <span
        ref={anchorRef}
        className="kh-tooltip__anchor"
        onPointerEnter={() => {
          requestOpen('pointer');
        }}
        onPointerLeave={() => {
          requestClose(false);
        }}
        // A press means the user has decided; leaving the explanation up just covers the
        // result of what they pressed.
        onPointerDown={() => {
          requestClose(true);
        }}
        onFocus={() => {
          requestOpen('focus');
        }}
        onBlur={() => {
          requestClose(true);
        }}
      >
        {cloneElement(children, {
          'aria-describedby': describedBy === '' ? undefined : describedBy,
        })}
      </span>

      {open &&
        createPortal(
          <div
            ref={tooltipRef}
            id={id}
            role="tooltip"
            className={`kh-tooltip kh-tooltip--${placement}`}
            style={{
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              visibility: position === null ? 'hidden' : 'visible',
            }}
            // Hoverable, per SC 1.4.13: the pointer can move onto the tooltip and it stays.
            onPointerEnter={() => {
              clearTimers();
            }}
            onPointerLeave={() => {
              requestClose(false);
            }}
          >
            {label}
          </div>,
          document.body
        )}
    </>
  );
}
