// SPDX-License-Identifier: GPL-3.0-or-later
import type { ConflictChoice, MergeConflict, MergeMode } from '@shared/model/sync.js';
import { Badge } from '../components/Feedback.js';
import { describeSweep, type SweepPlan, type SweepScope } from './bulk-resolution.js';
import type { ConflictGroup } from './conflict-groups.js';
import { TARGET_KIND_NOUNS } from './merge-targets.js';
import { SIDE_HEADINGS } from './merge-mode.js';
import { ConflictRow } from './ConflictRow.js';
import type { Selections } from './resolution-state.js';

/**
 * Everything the merge is arguing about for one record, folder, tag or setting.
 *
 * ## Why the group is the unit
 *
 * Six rows about one credential are one decision about that credential. Scattered through four
 * hundred rows they are six unrelated problems, and the user answers them without ever knowing
 * they were about the same login. The heading names the thing — a title, not a uuid — and
 * carries its own remaining count, so a collapsed card is still an honest index entry rather
 * than a hidden pile.
 *
 * ## The bulk control, and why it lives here rather than at the top of the page
 *
 * This is the scope where sweeping is defensible: one named subject the user is looking at.
 * "Keep this device's version of GitHub" is a single judgement about a single credential, and
 * making somebody click six radios to express it is friction, not safety — so the sweep here may
 * touch hidden values, unlike the across-records one.
 *
 * It is still not the easy default. It appears only when the group has more than one unanswered
 * conflict, it names the count, both sides are offered symmetrically so neither reads as the
 * recommended one, and it never overwrites an answer already given. The reasoning in full is in
 * `bulk-resolution.ts`.
 */

export interface ConflictGroupCardProps {
  readonly group: ConflictGroup;
  readonly mode: MergeMode;
  readonly selections: Selections;
  readonly expanded: boolean;
  readonly disabled: boolean;
  readonly onToggle: (key: string) => void;
  readonly onPick: (conflictId: string, choice: ConflictChoice | null) => void;
  readonly onPreviewSweep: (
    conflicts: readonly MergeConflict[],
    scope: SweepScope,
    choice: ConflictChoice
  ) => SweepPlan;
  readonly onSweep: (plan: SweepPlan) => void;
  /** Opens the record in the vault, where a value can be revealed one at a time. */
  readonly onOpenRecord?: ((recordId: string) => void) | undefined;
}

export function ConflictGroupCard({
  group,
  mode,
  selections,
  expanded,
  disabled,
  onToggle,
  onPick,
  onPreviewSweep,
  onSweep,
  onOpenRecord,
}: ConflictGroupCardProps): React.JSX.Element {
  const bodyId = `kh-merge-group-${group.key}`;
  const showSweep = group.remaining > 1;

  return (
    <section className="kh-merge-group" aria-labelledby={`${bodyId}-heading`}>
      <h3 className="kh-merge-group__heading" id={`${bodyId}-heading`}>
        <button
          type="button"
          className="kh-merge-group__toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => {
            onToggle(group.key);
          }}
        >
          <span className="kh-merge-group__chevron" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
          <span className="kh-merge-group__kind">{TARGET_KIND_NOUNS[group.targetKind]}</span>
          <span className="kh-merge-group__name">{group.target.name}</span>
          {group.target.path !== null && (
            <span className="kh-merge-group__path">{group.target.path}</span>
          )}
        </button>
        <span className="kh-merge-group__counts">
          {group.remaining > 0 ? (
            <Badge tone="warning" symbol="?">
              {group.remaining} to answer
            </Badge>
          ) : (
            <Badge tone="success" symbol="✓">
              Answered
            </Badge>
          )}
          {group.hidden > 0 && (
            <Badge tone="neutral" symbol="◍">
              {group.hidden} hidden
            </Badge>
          )}
        </span>
      </h3>

      <div className="kh-merge-group__body" id={bodyId} hidden={!expanded}>
        {showSweep && (
          <div
            className="kh-merge-sweep"
            role="group"
            aria-label={`Answer all of ${group.target.name} at once`}
          >
            <span className="kh-merge-sweep__label">All {group.remaining} at once:</span>
            <SweepButton
              conflicts={group.conflicts}
              choice="ours"
              scope="one-target"
              disabled={disabled}
              onPreviewSweep={onPreviewSweep}
              onSweep={onSweep}
            />
            <SweepButton
              conflicts={group.conflicts}
              choice="theirs"
              scope="one-target"
              disabled={disabled}
              onPreviewSweep={onPreviewSweep}
              onSweep={onSweep}
            />
          </div>
        )}

        {group.targetKind === 'record' && onOpenRecord !== undefined && (
          <p className="kh-merge-group__inspect">
            <button
              type="button"
              className="kh-merge-group__inspect-button"
              onClick={() => {
                onOpenRecord(group.targetId);
              }}
            >
              Open {group.target.name} in the vault
            </button>
            <span className="kh-merge-group__inspect-note">
              Hidden values are revealed there, one at a time — never on this screen.
            </span>
          </p>
        )}

        <div className="kh-merge-group__rows">
          {group.conflicts.map((conflict) => (
            <ConflictRow
              key={conflict.id}
              conflict={conflict}
              target={group.target}
              mode={mode}
              selections={selections}
              disabled={disabled}
              onPick={onPick}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * One sweep button, which states what it will do before it is pressed.
 *
 * The plan is recomputed on every render rather than on click, because the label *is* the plan —
 * a button reading "Take this device for 6" that then answers 4 is a button nobody trusts twice.
 */
function SweepButton({
  conflicts,
  choice,
  scope,
  disabled,
  onPreviewSweep,
  onSweep,
}: {
  readonly conflicts: readonly MergeConflict[];
  readonly choice: ConflictChoice;
  readonly scope: SweepScope;
  readonly disabled: boolean;
  readonly onPreviewSweep: (
    conflicts: readonly MergeConflict[],
    scope: SweepScope,
    choice: ConflictChoice
  ) => SweepPlan;
  readonly onSweep: (plan: SweepPlan) => void;
}): React.JSX.Element {
  const plan = onPreviewSweep(conflicts, scope, choice);
  const heading = choice === 'ours' ? SIDE_HEADINGS.ours : SIDE_HEADINGS.theirs;

  return (
    <button
      type="button"
      className="kh-merge-sweep__button"
      disabled={disabled || plan.willSet.length === 0}
      title={describeSweep(plan)}
      onClick={() => {
        onSweep(plan);
      }}
    >
      Keep {heading.toLowerCase()}
      <span className="kh-merge-sweep__count"> ({plan.willSet.length})</span>
    </button>
  );
}
