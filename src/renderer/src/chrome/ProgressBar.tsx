// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useId, useState } from 'react';
import { progressFillPercent, progressValueText, SLOW_OPERATION_MS } from './progress.js';
import './chrome.css';

/**
 * Determinate and indeterminate progress.
 *
 * The reason this exists as its own component rather than a `<progress>` element is the
 * *honesty* requirement, which matters more here than in most apps.
 *
 * Unlocking a Keyhold vault runs Argon2id, and Argon2id takes seconds **on purpose** —
 * that is the whole defence against an offline guessing attack. But a window that sits
 * still for three seconds is indistinguishable from a hung one, and a user who concludes
 * the app has hung force-quits it, potentially mid-write. So:
 *
 * - a determinate bar is used wherever a real fraction exists (KDF passes, import rows,
 *   export records, merge candidates) — a moving number is the only proof of life that
 *   cannot be faked by an animation;
 * - an indeterminate bar says what it is doing in words, and after
 *   {@link SLOW_OPERATION_MS} adds a second line explaining that the wait is deliberate;
 * - **reduced motion does not mean a still bar with no other signal.** At
 *   `--kh-motion-scale: 0` the sweep freezes, so the stylesheet falls back to a filled
 *   track. Something visible, plus the text, plus `aria-busy`.
 */

export type ProgressTone = 'accent' | 'success' | 'warning' | 'danger';

export interface ProgressBarProps {
  /** What is happening. "Unlocking your vault", not "Loading". */
  readonly label: string;
  /** Omit for an indeterminate bar. */
  readonly value?: number;
  readonly max?: number;
  /** Plural noun for the spoken value: "credentials", "rows", "files". */
  readonly unit?: string;
  readonly labelHidden?: boolean;
  /** A line under the bar, shown immediately. */
  readonly note?: string;
  /**
   * A line shown only once the operation has run past {@link SLOW_OPERATION_MS}.
   *
   * Use it to explain a wait rather than to apologise for it: "Argon2id is deliberately
   * slow — this is what makes a stolen vault file expensive to attack."
   */
  readonly slowNote?: string;
  readonly tone?: ProgressTone;
}

export function ProgressBar({
  label,
  value,
  max = 100,
  unit,
  labelHidden = false,
  note,
  slowNote,
  tone = 'accent',
}: ProgressBarProps): React.JSX.Element {
  const labelId = useId();
  const indeterminate = value === undefined;

  const [slow, setSlow] = useState(false);

  // One timeout that flips a flag once — not a ticking clock. Nothing here counts, so
  // nothing here needs to tick, and there is exactly one timer to clear on unmount.
  useEffect(() => {
    if (slowNote === undefined) return;
    const timer = window.setTimeout(() => {
      setSlow(true);
    }, SLOW_OPERATION_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [slowNote]);

  const fill = indeterminate ? 100 : progressFillPercent(value, max);

  return (
    <div className="kh-progress">
      <p className={labelHidden ? 'kh-visually-hidden' : 'kh-progress__label'} id={labelId}>
        {label}
        {!indeterminate && !labelHidden && (
          <span className="kh-progress__value" aria-hidden="true">
            {progressValueText(value, max, unit)}
          </span>
        )}
      </p>

      <div
        className={`kh-progress__track kh-progress__track--${tone}`}
        role="progressbar"
        aria-labelledby={labelId}
        // An indeterminate bar omits valuenow entirely. Reporting 0 would be a lie a screen
        // reader repeats as "0 percent" for the whole operation, which reads as stuck.
        aria-valuenow={indeterminate ? undefined : value}
        aria-valuemin={indeterminate ? undefined : 0}
        aria-valuemax={indeterminate ? undefined : max}
        // Without this, `aria-valuenow` is announced as a bare number: "3" tells nobody
        // that three of four hundred and seventeen credentials have been imported.
        aria-valuetext={indeterminate ? undefined : progressValueText(value, max, unit)}
        aria-busy={indeterminate || undefined}
      >
        <div
          className={`kh-progress__fill${indeterminate ? ' kh-progress__fill--indeterminate' : ''}`}
          style={{ width: `${fill}%` }}
        />
      </div>

      {note !== undefined && <p className="kh-progress__note">{note}</p>}
      {slow && slowNote !== undefined && (
        // Polite, not assertive: this is reassurance arriving mid-operation, and it must not
        // cut across whatever the user was already having read to them.
        <p className="kh-progress__note kh-progress__note--slow" aria-live="polite">
          {slowNote}
        </p>
      )}
    </div>
  );
}
