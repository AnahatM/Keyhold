// SPDX-License-Identifier: GPL-3.0-or-later
import { useId } from 'react';
import type { ConflictSide } from '@shared/model/sync.js';
import { Icon } from '../components/Icon.js';
import { describeSide } from './conflict-language.js';

/**
 * One side of one conflict, as something a person can choose.
 *
 * ## What it renders, and what it refuses to
 *
 * A `ConflictSide` is a closed union of five shapes and this component handles all five:
 *
 *  - `value` — the value, formatted. Titles, usernames, dates, tags, folder names: things the
 *    safe projection already puts on the vault list.
 *  - `secret` — a mask of exactly `length` dots, **and the length in words**. The dots alone are
 *    not an accessible name, so a screen reader gets "Hidden — 18 characters" and a sighted user
 *    gets both. The length is the entire content of the side; there is nothing else to show and
 *    nothing else is fetched.
 *  - `questions` — the prompts and whether each is answered. Never an answer.
 *  - `custom` — the labels, the types and whether each holds a value. **Never the value**, even
 *    for a field the model does not classify as secret: this screen lists many records at once,
 *    and a custom field's contents are the user's data whether or not a flag says so.
 *  - `absent` — "Not in this file", which is a different fact from "empty" and must not render
 *    the same way. Confusing the two is how a merge deletes something.
 *
 * ## Why a native radio
 *
 * Arrow-key navigation, `aria-checked`, the browser's own focus behaviour and grouping by `name`
 * all come free and all work in a screen reader's forms mode. A pair of `<button>`s with
 * `aria-pressed` would reimplement three of those badly. The input is visually hidden and the
 * label is the card, which is the standard way to keep the semantics while styling the target.
 *
 * Selection is never carried by colour alone (WCAG 1.4.1): a chosen card gains a tick, the word
 * "Keeping", and a heavier border, on top of the accent tint.
 */

export interface ConflictSideCardProps {
  readonly side: ConflictSide;
  /** The property, so a timestamp or a trash flag reads as itself rather than as a number. */
  readonly field: string | null;
  /** The column heading — "This device" / "The other file". */
  readonly heading: string;
  /** Shared across the two cards of one conflict; this is what groups the radio. */
  readonly groupName: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChoose: () => void;
}

export function ConflictSideCard({
  side,
  field,
  heading,
  groupName,
  checked,
  disabled,
  onChoose,
}: ConflictSideCardProps): React.JSX.Element {
  const inputId = useId();
  const summary = describeSide(side, field);

  return (
    <div className={`kh-side${checked ? ' kh-side--chosen' : ''}`}>
      <input
        id={inputId}
        className="kh-side__input kh-visually-hidden"
        type="radio"
        name={groupName}
        checked={checked}
        disabled={disabled}
        onChange={onChoose}
      />
      <label className="kh-side__label" htmlFor={inputId}>
        <span className="kh-side__heading">
          {/*
            The wrapper survives where other `aria-hidden` glyph spans did not, because here it
            is a layout box rather than an accessibility one: `.kh-side__tick` holds a fixed 1em
            whether or not this side is the chosen one, so ticking a card does not shove its own
            heading sideways. Its `aria-hidden` is gone — `Icon` already hides itself, and an
            empty span announces nothing.
          */}
          <span className="kh-side__tick">{checked && <Icon name="check" size="sm" />}</span>
          {heading}
          {checked && <span className="kh-visually-hidden"> — keeping this</span>}
        </span>
        <SideBody summary={summary} />
      </label>
    </div>
  );
}

function SideBody({
  summary,
}: {
  readonly summary: ReturnType<typeof describeSide>;
}): React.JSX.Element {
  if (summary.kind === 'secret' && summary.maskLength !== null) {
    return (
      <span className="kh-side__body">
        <span className="kh-side__mask" aria-hidden="true">
          {/* A fixed glyph repeated `length` times. The length is already the whole of what
              crosses the bridge, so drawing it honestly costs nothing and a mask of the wrong
              width would be a small lie on a screen whose only currency is trust. */}
          {'•'.repeat(Math.min(summary.maskLength, MAX_MASK_DOTS))}
          {summary.maskLength > MAX_MASK_DOTS ? '…' : ''}
        </span>
        <span className="kh-side__meta">{summary.text}</span>
      </span>
    );
  }

  if (summary.entries.length > 0) {
    return (
      <span className="kh-side__body">
        <span className="kh-side__meta">{summary.text}</span>
        <ul className="kh-side__entries">
          {summary.entries.map((entry) => (
            <li key={entry.key} className="kh-side__entry">
              <span className="kh-side__entry-label">{entry.label}</span>
              <span className="kh-side__entry-detail">{entry.detail}</span>
            </li>
          ))}
        </ul>
      </span>
    );
  }

  return (
    <span className="kh-side__body">
      <span className={summary.absent ? 'kh-side__absent' : 'kh-side__value'}>{summary.text}</span>
      {summary.hidden && <span className="kh-side__meta">Contents are not shown here.</span>}
    </span>
  );
}

/**
 * A cap on the drawn mask, not on the reported length.
 *
 * A 4,000-character note would otherwise draw four thousand dots and reflow the row. The number
 * itself is still stated in words beside it, so nothing is hidden — only the drawing is bounded.
 */
const MAX_MASK_DOTS = 24;
