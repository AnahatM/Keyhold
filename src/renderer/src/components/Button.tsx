// SPDX-License-Identifier: GPL-3.0-or-later
import type { ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from './Icon.js';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /**
   * A leading icon, by name.
   *
   * This used to be a `ReactNode`, and `ReactNode` accepts a `string` — so `icon="close"`
   * typechecked at four call sites and rendered the **word** "close" where an ✕ belonged.
   * The modal's close button had read that way for some time; no test could see it and a
   * screenshot of an unrelated feature is what found it.
   *
   * Narrowed to the name rather than widened to a union, because `IconName | ReactNode`
   * collapses back to `ReactNode` and would have accepted the bug again. Every node call
   * site was `<Icon name="..." />` anyway, so nothing was lost. Decorative — the label, or
   * `iconOnlyLabel`, carries the meaning.
   */
  readonly icon?: IconName;
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
      {loading ? (
        <span className="kh-button__spinner" aria-hidden="true" />
      ) : (
        icon !== undefined && <Icon name={icon} />
      )}
      {children !== undefined && <span className="kh-button__label">{children}</span>}
    </button>
  );
}
