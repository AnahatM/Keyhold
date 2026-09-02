// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReactNode } from 'react';
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
  readonly icon?: ReactNode;
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
      {icon !== undefined && (
        <div className="kh-empty__icon" aria-hidden="true">
          {icon}
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
      <div className="kh-empty__icon" aria-hidden="true">
        ⚠
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
   * A symbol shown alongside the colour.
   *
   * Status must never be carried by colour alone (WCAG 1.4.1). For the health dashboard
   * in particular — where the whole point is flagging problems — a colour-only signal
   * would be invisible to a colour-blind user.
   */
  readonly symbol?: string;
}

export function Badge({ tone = 'neutral', symbol, children }: BadgeProps): React.JSX.Element {
  return (
    <span className={`kh-badge kh-badge--${tone}`}>
      {symbol !== undefined && (
        <span className="kh-badge__symbol" aria-hidden="true">
          {symbol}
        </span>
      )}
      {children}
    </span>
  );
}
