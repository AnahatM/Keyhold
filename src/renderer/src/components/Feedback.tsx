// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';
import './Feedback.css';

/**
 * The three states every view must handle: nothing yet, loading, and broken.
 *
 * They live together because they are one decision, not three. A view that ships with a
 * list but no empty state is a view that shows a blank rectangle the first time someone
 * opens it — which is the single most common way an otherwise finished app feels
 * unfinished.
 */

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export interface EmptyStateProps {
  /**
   * A name from the icon set, not arbitrary markup.
   *
   * Narrowed from `ReactNode` deliberately. As a `ReactNode` this slot accepted anything —
   * and what it actually received was emoji, which meant an empty state rendered in the OS
   * emoji font, at a colour the theme could not reach, and read aloud by a screen reader on
   * top of the heading directly beneath it. A union of names makes the wrong thing
   * unrepresentable rather than merely discouraged, and it is why every caller of this
   * component had to be revisited when the type changed — which was the point.
   */
  readonly icon?: IconName;
  readonly title: string;
  /** Say what to do next, not just that there is nothing. */
  readonly description?: string;
  readonly action?: ReactNode;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: EmptyStateProps): React.JSX.Element {
  return (
    <div className="kh-empty">
      {/*
        The wrapper stays because `.kh-empty__icon` is where the size and the subdued colour
        live, and `.kh-empty-state--success .kh-empty__icon` reaches through it to tint the
        one empty state that is good news. It no longer carries `aria-hidden`: `Icon` is
        hidden from assistive tech, and a second declaration of the same fact is a thing that
        can later disagree with itself.
      */}
      {icon !== undefined && (
        <div className="kh-empty__icon">
          <Icon name={icon} size="lg" />
        </div>
      )}
      <h2 className="kh-empty__title">{title}</h2>
      {description !== undefined && <p className="kh-empty__description">{description}</p>}
      {action !== undefined && <div className="kh-empty__action">{action}</div>}
    </div>
  );
}

export interface ErrorStateProps {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
}

export function ErrorState({ title, description, action }: ErrorStateProps): React.JSX.Element {
  return (
    // `role="alert"` so the failure is announced when it appears rather than sitting
    // silently on screen for a screen-reader user.
    <div className="kh-empty kh-empty--error" role="alert">
      <div className="kh-empty__icon">
        <Icon name="warning" size="lg" />
      </div>
      <h2 className="kh-empty__title">{title}</h2>
      {description !== undefined && <p className="kh-empty__description">{description}</p>}
      {action !== undefined && <div className="kh-empty__action">{action}</div>}
    </div>
  );
}

/**
 * A skeleton placeholder.
 *
 * Preferred over a spinner for list content because it reserves the right amount of space,
 * so nothing jumps when the real content lands — the layout-shift problem, solved by not
 * creating it.
 */
export function Skeleton({
  width = '100%',
  height = '1em',
  radius = 'var(--kh-radius-sm)',
}: {
  readonly width?: string;
  readonly height?: string;
  readonly radius?: string;
}): React.JSX.Element {
  return (
    <span
      className="kh-skeleton"
      style={{ width, height, borderRadius: radius }}
      aria-hidden="true"
    />
  );
}

export interface LoadingStateProps {
  /** Announced to assistive tech. Say what is loading, not just "loading". */
  readonly label: string;
  readonly rows?: number;
}

export function LoadingState({ label, rows = 5 }: LoadingStateProps): React.JSX.Element {
  return (
    <div className="kh-loading" aria-busy="true" aria-live="polite">
      <span className="kh-visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="kh-loading__row">
          <Skeleton width="60%" height="0.9em" />
          <Skeleton width="35%" height="0.75em" />
        </div>
      ))}
    </div>
  );
}

export interface BadgeProps {
  readonly tone?: StatusTone;
  readonly children: ReactNode;
  /**
   * A shape shown alongside the colour — a name from the icon set, not a glyph.
   *
   * Status must never be carried by colour alone (WCAG 1.4.1). For the health dashboard
   * in particular — where the whole point is flagging problems — a colour-only signal
   * would be invisible to a colour-blind user.
   *
   * **Still optional, and deliberately so.** Several badges were carrying a decorative
   * bullet in this slot: a mark that says "there is something here" beside a label that has
   * already said what. There is no bullet in the icon set and one was not added, because an
   * icon that means nothing in particular is how a small, consistent set starts looking
   * arbitrary — every subsequent slot then gets filled with the nearest available shape
   * rather than the right one. A badge whose label and tone already carry the meaning is a
   * complete badge; omit the icon there and keep the set honest.
   */
  readonly symbol?: IconName;
}

export function Badge({ tone = 'neutral', symbol, children }: BadgeProps): React.JSX.Element {
  return (
    // No `kh-badge__symbol` wrapper: it existed only to hide the glyph from assistive tech,
    // which `Icon` now does itself, and `.kh-badge`'s own flex gap already spaces the pair.
    <span className={`kh-badge kh-badge--${tone}`}>
      {symbol !== undefined && <Icon name={symbol} size="sm" />}
      {children}
    </span>
  );
}
