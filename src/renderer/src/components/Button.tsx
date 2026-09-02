// SPDX-License-Identifier: GPL-3.0-or-later
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Renders a leading icon. Decorative — the label carries the meaning. */
  readonly icon?: ReactNode;
  /**
   * Required when the button has no visible text.
   *
   * An icon-only button with no accessible name is announced as "button" and nothing
   * else, which makes it unusable with a screen reader. Making this a distinct prop is a
   * prompt at the call site rather than a rule someone has to remember.
   */
  readonly iconOnlyLabel?: string;
  readonly loading?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconOnlyLabel,
  loading = false,
  children,
  className,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): React.JSX.Element {
  const classes = ['kh-button', `kh-button--${variant}`, `kh-button--${size}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled === true || loading}
      aria-label={iconOnlyLabel}
      // Announced to assistive tech while a long operation runs, so a user who cannot see
      // the spinner still knows the button is working rather than broken.
      aria-busy={loading || undefined}
    >
      {loading ? <span className="kh-button__spinner" aria-hidden="true" /> : icon}
      {children !== undefined && <span className="kh-button__label">{children}</span>}
    </button>
  );
}
