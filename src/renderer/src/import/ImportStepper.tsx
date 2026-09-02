// SPDX-License-Identifier: GPL-3.0-or-later
import { IMPORT_STOP_LABELS, type ImportStepStop } from './wizard-machine.js';
import './import.css';

/**
 * The step indicator.
 *
 * An ordered list, because that is what it is: a sequence with a position in it. Screen
 * readers announce "list, 4 items, item 2" for free, which is most of the information the
 * indicator carries visually.
 *
 * Three details that are the whole reason this is a component rather than a row of `<span>`s:
 *
 * - **`aria-current="step"`** on the active item. Without it the current position is carried
 *   only by a colour and a weight, and a screen-reader user gets a list of four labels with
 *   no indication of where they are.
 * - **Never colour alone** (WCAG 1.4.1). A completed step shows a tick, a pending one shows
 *   its number, and each carries a visually-hidden word saying which it is — so the state
 *   survives greyscale, low vision, and a screen reader.
 * - **The list is the truth.** It is passed in from `visibleStops`, so a flow that skips the
 *   mapping step shows four stops and numbers them one to four, rather than showing a fifth
 *   that never lights up.
 */
export function ImportStepper({
  stops,
  current,
}: {
  readonly stops: readonly ImportStepStop[];
  readonly current: ImportStepStop;
}): React.JSX.Element {
  const currentIndex = stops.indexOf(current);

  return (
    <ol className="kh-import-steps" aria-label="Import steps">
      {stops.map((stop, index) => {
        const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo';
        return (
          <li
            key={stop}
            className={`kh-import-steps__item kh-import-steps__item--${state}`}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className="kh-import-steps__marker" aria-hidden="true">
              {state === 'done' ? '✓' : index + 1}
            </span>
            <span className="kh-import-steps__label">
              {IMPORT_STOP_LABELS[stop]}
              <span className="kh-visually-hidden">
                {state === 'done'
                  ? ' — done'
                  : state === 'current'
                    ? ' — current step'
                    : ' — to do'}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
