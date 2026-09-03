// SPDX-License-Identifier: GPL-3.0-or-later
import type { MergeCommitResult, MergePreview } from '@shared/model/sync-plan.js';
import { Button } from '../components/Button.js';
import { EmptyState, ErrorState } from '../components/Feedback.js';
import { ConflictGroupCard } from './ConflictGroupCard.js';
import { MergeAppliedPanel } from './MergeAppliedPanel.js';
import { MergeModeBanner } from './MergeModeBanner.js';
import { MergeNotePanel } from './MergeNotePanel.js';
import { MergeProgressBar } from './MergeProgressBar.js';
import { MergeSweepBar } from './MergeSweepBar.js';
import type { MergeTargetNames } from './merge-targets.js';
import type { SyncGateway } from './sync-gateway.js';
import { useMergeResolver } from './use-merge-resolver.js';
import './sync.css';

/**
 * The screen where a user settles a merge.
 *
 * ## The one thing this screen must not do
 *
 * **Look applied while it is half-resolved.** The merged document is provisional while any
 * conflict is unresolved — the engine says so in `requiresResolution` — and a screen that
 * enabled its write button a moment early would commit one side of every unsettled disagreement
 * without asking. That is the last-writer-wins behaviour the whole engine exists to prevent,
 * arriving through the front door.
 *
 * So the footer is a state machine, not a button with a `disabled` attribute:
 *
 *  - `'answer'` — questions remain. The primary action is disabled and says how many.
 *  - `'recheck'` — every question is answered, but the merge has not been re-run with the
 *    answers. The primary action re-runs it. This step is visible on purpose: the document in
 *    the main process is still the previous one, and pretending otherwise is the bug.
 *  - `'apply'` — the engine has re-run and agrees nothing is left. Only now does anything write.
 *
 * ## Where the values are
 *
 * Nowhere on this screen, by design. A conflict side carries a kind and, for a secret, a length.
 * The user picks a side **by name**; the choice goes back as `'ours' | 'theirs'` and the merge is
 * re-run in the main process. Reading a value is a separate, deliberate act in the record's own
 * view, one item at a time, through the secret broker — `onOpenRecord` goes there and nothing in
 * this folder reveals anything itself. The reasoning is in `sync-gateway.ts`.
 */

export interface MergeResolverProps {
  readonly gateway: SyncGateway;
  /** The prepared merge. `prepare` opens a file dialog and takes the backup; that is not here. */
  readonly preview: MergePreview;
  /** Names for records, folders and tags, out of the vault list the app already holds. */
  readonly names: MergeTargetNames;
  /** Leaves the screen. Called on cancel and after a completed merge. */
  readonly onClose: () => void;
  readonly onApplied?: ((result: MergeCommitResult) => void) | undefined;
  /**
   * Opens a record in the vault, where a value can be revealed one at a time.
   *
   * Optional, and the resolver works without it. When it is supplied the link is offered per
   * record, never per field and never as a "reveal" — the deliberate act stays in the place the
   * app already governs it.
   */
  readonly onOpenRecord?: ((recordId: string) => void) | undefined;
}

export function MergeResolver({
  gateway,
  preview,
  names,
  onClose,
  onApplied,
  onOpenRecord,
}: MergeResolverProps): React.JSX.Element {
  const resolver = useMergeResolver({ gateway, preview, names, onApplied });

  if (resolver.phase === 'applied' && resolver.result !== null) {
    return (
      <div className="kh-merge">
        <MergeAppliedPanel result={resolver.result} mode={resolver.report.mode} onClose={onClose} />
      </div>
    );
  }

  const visibleConflicts = resolver.visible.shown.flatMap((group) => group.conflicts);
  const nothingToSettle = resolver.summary.choosable === 0;

  return (
    <div className="kh-merge">
      <header className="kh-merge__header">
        <h1 className="kh-merge__title">Settle this merge</h1>
        <Button variant="ghost" onClick={onClose} disabled={resolver.busy}>
          Cancel
        </Button>
      </header>

      <MergeModeBanner report={resolver.report} backupFileName={resolver.backupFileName} />

      {resolver.error !== null && (
        <ErrorState
          title="The merge could not go ahead"
          description={resolver.error}
          action={
            <Button variant="secondary" onClick={resolver.dismissError}>
              Dismiss
            </Button>
          }
        />
      )}

      {resolver.lastCheck !== null && resolver.lastCheck.appeared > 0 && (
        <p className="kh-merge__check-note" role="status">
          Answering those changed the merge: {resolver.lastCheck.appeared} new{' '}
          {resolver.lastCheck.appeared === 1 ? 'question' : 'questions'} appeared. Keeping one
          file&rsquo;s version of a record can surface a disagreement inside it that the other
          version never had.
        </p>
      )}

      {nothingToSettle ? (
        <EmptyState
          icon="✓"
          title="Nothing to settle"
          description="The two files agree everywhere they both have something to say. Apply the merge to bring the rest across."
        />
      ) : (
        <>
          <MergeProgressBar
            report={resolver.report}
            summary={resolver.summary}
            filter={resolver.filter}
            counts={resolver.counts}
            onFilter={resolver.setFilter}
          />

          <MergeSweepBar
            conflicts={visibleConflicts}
            disabled={resolver.busy}
            onPreviewSweep={resolver.previewSweep}
            onSweep={resolver.sweep}
          />

          <div className="kh-merge__list-controls">
            <button type="button" className="kh-merge__link" onClick={resolver.expandAll}>
              Expand all
            </button>
            <button type="button" className="kh-merge__link" onClick={resolver.collapseAll}>
              Collapse all
            </button>
          </div>

          <div className="kh-merge__groups">
            {resolver.visible.shown.length === 0 ? (
              <EmptyState
                title="Nothing matches this filter"
                description="Switch back to Everything to see the rest of the merge."
              />
            ) : (
              resolver.visible.shown.map((group) => (
                <ConflictGroupCard
                  key={group.key}
                  group={group}
                  mode={resolver.report.mode}
                  selections={resolver.selections}
                  expanded={resolver.expanded.has(group.key)}
                  disabled={resolver.busy}
                  onToggle={resolver.toggleGroup}
                  onPick={resolver.pick}
                  onPreviewSweep={resolver.previewSweep}
                  onSweep={resolver.sweep}
                  onOpenRecord={onOpenRecord}
                />
              ))
            )}
          </div>

          {resolver.visible.hiddenGroups > 0 && (
            <button type="button" className="kh-merge__more" onClick={resolver.showMore}>
              Show {resolver.visible.hiddenGroups} more — {resolver.visible.hiddenConflicts}{' '}
              conflicts not on screen
            </button>
          )}
        </>
      )}

      <MergeNotePanel report={resolver.report} />

      <footer className="kh-merge__footer">
        <p className="kh-merge__gate" aria-live="polite">
          {footerNote(resolver.primary, resolver.summary.remaining)}
        </p>
        <div className="kh-merge__footer-actions">
          <Button variant="ghost" onClick={onClose} disabled={resolver.busy}>
            Cancel
          </Button>
          {resolver.primary === 'recheck' ? (
            <Button variant="secondary" onClick={resolver.recheck} loading={resolver.busy}>
              Check the merge
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={resolver.apply}
              loading={resolver.phase === 'applying'}
              disabled={resolver.primary !== 'apply' || resolver.busy}
            >
              Apply merge
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}

/**
 * The sentence under the footer buttons.
 *
 * It exists because a disabled button with no explanation is a dead end, and because the
 * `'recheck'` step is genuinely surprising the first time — "I answered everything, why is it
 * not applying" deserves an answer on screen rather than in a changelog.
 */
function footerNote(primary: 'answer' | 'recheck' | 'apply' | 'done', remaining: number): string {
  switch (primary) {
    case 'answer':
      return `Nothing is written until every disagreement is settled. ${remaining} still ${remaining === 1 ? 'needs' : 'need'} an answer.`;
    case 'recheck':
      return 'Every disagreement has an answer. Keyhold re-runs the merge with them before anything is written, because the result so far was built without them.';
    case 'apply':
      return 'The merge is settled. Applying it rewrites your vault; the copy taken beforehand stays where it is.';
    case 'done':
      return 'Applied.';
  }
}
