// SPDX-License-Identifier: GPL-3.0-or-later
import type { MergeCommitResult } from '@shared/model/sync-plan.js';
import type { MergeMode } from '@shared/model/sync.js';
import { Button } from '../components/Button.js';
import { EmptyState } from '../components/Feedback.js';

/**
 * What happened, once it has actually happened.
 *
 * A merge that ends by simply closing leaves the user with a vault that changed and no account
 * of how. This is the account: what was written, how many disagreements they settled, where the
 * safety copy is if they now think they got one wrong.
 *
 * The last line is the one worth having. A two-way merge stores its result as the new base
 * snapshot, which is what makes the *next* merge three-way — the difference between four hundred
 * questions and four. Somebody who has just answered four hundred deserves to be told that.
 */

export interface MergeAppliedPanelProps {
  readonly result: MergeCommitResult;
  readonly mode: MergeMode;
  readonly onClose: () => void;
}

export function MergeAppliedPanel({
  result,
  mode,
  onClose,
}: MergeAppliedPanelProps): React.JSX.Element {
  return (
    <div className="kh-merge-done">
      <EmptyState
        icon="✓"
        title="The merge has been applied"
        description={`${countOf(result.recordsMerged, 'record')} in your vault, ${countOf(result.conflictsResolved, 'disagreement')} settled${result.attachmentsImported > 0 ? `, ${countOf(result.attachmentsImported, 'attachment')} copied across` : ''}.`}
        action={
          <Button variant="primary" onClick={onClose}>
            Back to the vault
          </Button>
        }
      />
      <p className="kh-merge-done__backup">
        The copy taken before the merge is still there, as{' '}
        <span className="kh-merge-done__backup-name">{result.backupFileName}</span>. If something
        looks wrong, that file is the version you started with.
      </p>
      {mode === 'two-way' && (
        <p className="kh-merge-done__next">
          Keyhold has remembered where these two files now agree. The next merge between them will
          be able to tell an edit from an old copy, so it will ask far fewer questions.
        </p>
      )}
    </div>
  );
}

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
