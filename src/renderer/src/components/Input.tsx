// SPDX-License-Identifier: GPL-3.0-or-later
import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import './Input.css';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  /**
   * A ref onto the underlying `<input>`.
   *
   * Declared rather than reached for with `forwardRef`: in React 19 a ref is an ordinary prop,
   * so the existing `...rest` spread already delivers it to the element — the type was the only
   * thing missing. Needed by Ctrl+F, which has to focus this box from a shortcut handler
   * mounted above it.
   */
  readonly ref?: React.Ref<HTMLInputElement>;
  /**
   * Required, not optional.
   *
   * A placeholder is not a label: it vanishes the moment someone types, it is invisible to
   * many screen readers, and it fails WCAG 3.3.2. Making the label mandatory in the type
   * removes the decision from every call site.
   */
  readonly label: string;
  /** Hides the label visually while keeping it for assistive tech. */
  readonly labelHidden?: boolean;
  readonly hint?: string;
  readonly error?: string;
  readonly trailing?: ReactNode;
  /** Renders the value in the monospace secret face. */
  readonly secret?: boolean;
}

export function Input({
  label,
  labelHidden = false,
  hint,
  error,
  trailing,
  secret = false,
  className,
  ...rest
}: InputProps): React.JSX.Element {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  // Both are referenced so a screen reader reads the hint AND the error, in that order,
  // rather than the error replacing context the user still needs.
  const describedBy = [hint !== undefined ? hintId : null, error !== undefined ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={['kh-field', className].filter(Boolean).join(' ')}>
      <label htmlFor={id} className={labelHidden ? 'kh-visually-hidden' : 'kh-field__label'}>
        {label}
      </label>

      <div className={`kh-field__control${error !== undefined ? ' kh-field__control--error' : ''}`}>
        <input
          {...rest}
          id={id}
          className={`kh-field__input${secret ? ' kh-secret' : ''}`}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          aria-invalid={error !== undefined || undefined}
        />
        {trailing !== undefined && <div className="kh-field__trailing">{trailing}</div>}
      </div>

      {hint !== undefined && (
        <p id={hintId} className="kh-field__hint">
          {hint}
        </p>
      )}
      {error !== undefined && (
        // `role="alert"` so a validation failure is announced when it appears, rather than
        // only when the user happens to navigate back to the field.
        <p id={errorId} className="kh-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
