// SPDX-License-Identifier: GPL-3.0-or-later
import type { ConflictChoice, MergeConflict } from '@shared/model/sync.js';
import { Badge } from '../components/Feedback.js';
import { Icon } from '../components/Icon.js';
import {
  CONFLICT_KIND_MEANINGS,
  CONFLICT_KIND_SYMBOLS,
  conflictQuestion,
  describeSide,
  fieldLabel,
  hidesValue,
} from './conflict-language.js';
import type { TargetName } from './merge-targets.js';
import { SIDE_HEADINGS, showsAncestor } from './merge-mode.js';
import { ConflictSideCard } from './ConflictSideCard.js';
import { effectiveChoice, statusOf, type Selections } from './resolution-state.js';
import type { MergeMode } from '@shared/model/sync.js';

/**
 * One conflict: what disagreed, the two answers, and which one is currently winning.
 *
 * ## The row is a question, not a diff
 *
 * A diff shows two things and lets you read them. This shows two things and *requires an answer*,
 * so the whole row is one `<fieldset>` whose legend is the question spelled out —
 * "Which password should GitHub keep?" — because a screen-reader user meets the radio group
 * before they meet the surrounding headings, and "This device / The other file" on its own is
 * not a question.
 *
 * ## The three states a row can be in
 *
 * `'needs-choice'` shows two unselected cards. `'chosen'` shows the winner ticked and a
 * "change your mind" control, because nothing is written until the whole merge is applied and an
 * answer given by mistake has to be takeable back. `'auto'` — settled by a policy rule — shows
 * what the rule decided and *why*, and still offers both cards: the engine reads
 * `MergeOptions.resolutions` for these, so a user who disagrees with "the longer retention wins"
 * is entitled to say so.
 *
 * `'combined'` shows no cards at all. Both sides contributed and there is nothing to choose;
 * rendering two radios there would be offering a control that cannot change anything.
 *
 * ## The ancestor column
 *
 * Shown only in three-way mode, where `base` is real. In two-way mode it is always `null` and a
 * column of dashes would read as "we agreed on nothing", which is a different and untrue claim.
 */

export interface ConflictRowProps {
  readonly conflict: MergeConflict;
  readonly target: TargetName;
  readonly mode: MergeMode;
  readonly selections: Selections;
  readonly disabled: boolean;
  readonly onPick: (conflictId: string, choice: ConflictChoice | null) => void;
}

export function ConflictRow({
  conflict,
  target,
  mode,
  selections,
  disabled,
  onPick,
}: ConflictRowProps): React.JSX.Element {
  const status = statusOf(conflict, selections);
  const chosen = effectiveChoice(conflict, selections);
  const question = conflictQuestion(conflict, target);
  const property = fieldLabel(conflict);
  const hidden = hidesValue(conflict);

  return (
    <fieldset
      className={`kh-conflict kh-conflict--${status}`}
      data-conflict-id={conflict.id}
      data-status={status}
      disabled={disabled}
    >
      <legend className="kh-visually-hidden">{question}</legend>

      <div className="kh-conflict__head">
        {/*
          The wrapping `<span aria-hidden>` is gone rather than kept around the icon: `Icon` is
          unconditionally hidden from assistive tech, and `.kh-conflict__symbol` carries nothing
          but the muted colour, which `className` passes straight through.
        */}
        <Icon name={CONFLICT_KIND_SYMBOLS[conflict.kind]} className="kh-conflict__symbol" />
        <span className="kh-conflict__property">{property}</span>
        {hidden && (
          <Badge tone="warning" symbol="hide">
            Value hidden
          </Badge>
        )}
        {status === 'auto' && (
          <Badge tone="info" symbol="settings">
            Settled for you
          </Badge>
        )}
        {/*
          `'combined'` gets no icon, and that is the deliberate half of the rule in `Badge`'s
          own doc comment. The set has no shape meaning "both sides contributed", and reaching
          for the nearest one — a tick, a pair of squares — would say something subtly untrue
          about a row that is a statement rather than an answered question. "Both kept" beside a
          neutral tone already carries it.
        */}
        {status === 'combined' && <Badge tone="neutral">Both kept</Badge>}
        {status === 'needs-choice' && (
          <Badge tone="warning" symbol="warning">
            Needs you
          </Badge>
        )}
      </div>

      <p className="kh-conflict__meaning">{CONFLICT_KIND_MEANINGS[conflict.kind]}</p>

      {status === 'combined' ? (
        <CombinedSummary conflict={conflict} />
      ) : (
        <>
          <div className="kh-conflict__sides">
            <ConflictSideCard
              side={conflict.ours}
              field={conflict.field}
              heading={SIDE_HEADINGS.ours}
              groupName={conflict.id}
              checked={chosen === 'ours'}
              disabled={disabled}
              onChoose={() => {
                onPick(conflict.id, 'ours');
              }}
            />
            <ConflictSideCard
              side={conflict.theirs}
              field={conflict.field}
              heading={SIDE_HEADINGS.theirs}
              groupName={conflict.id}
              checked={chosen === 'theirs'}
              disabled={disabled}
              onChoose={() => {
                onPick(conflict.id, 'theirs');
              }}
            />
          </div>

          {showsAncestor(mode) && conflict.base !== null && (
            <p className="kh-conflict__base">
              <span className="kh-conflict__base-heading">{SIDE_HEADINGS.base}: </span>
              {describeSide(conflict.base, conflict.field).text}
            </p>
          )}

          {status === 'chosen' && (
            <div className="kh-conflict__undo">
              <button
                type="button"
                className="kh-conflict__undo-button"
                disabled={disabled}
                onClick={() => {
                  onPick(conflict.id, null);
                }}
              >
                Undo this answer
              </button>
              <span className="kh-conflict__undo-note">
                Nothing is written until the whole merge is applied.
              </span>
            </div>
          )}
        </>
      )}
    </fieldset>
  );
}

/**
 * The one conflict shape with no question in it.
 *
 * Reported rather than hidden — the merge did something to this record and the report exists so
 * that a merge is never silent — but reported as a fact, not as a choice.
 */
function CombinedSummary({ conflict }: { readonly conflict: MergeConflict }): React.JSX.Element {
  const ours = describeSide(conflict.ours, conflict.field);
  const theirs = describeSide(conflict.theirs, conflict.field);
  return (
    <p className="kh-conflict__combined">
      Both files contributed, and both were kept — {SIDE_HEADINGS.ours.toLowerCase()} had{' '}
      {ours.text.toLowerCase()}, {SIDE_HEADINGS.theirs.toLowerCase()} had{' '}
      {theirs.text.toLowerCase()}. There is nothing to choose between them.
    </p>
  );
}
