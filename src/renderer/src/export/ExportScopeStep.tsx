// SPDX-License-Identifier: GPL-3.0-or-later

import { useId } from 'react';
import type { ExportPreview, ExportScope } from '@shared/model/export-plan.js';
import { Skeleton } from '../components/Feedback.js';
import { recordSentence, trashSentence, unknownSentence } from './export-presentation.js';
import type { ExportScopeMode } from './use-export-dialog.js';
import './export.css';

/**
 * Step two: how much of the vault goes into the file.
 *
 * ## The Trash is the part that matters
 *
 * A trashed record is one the user has already decided they do not want. Writing it into a
 * plaintext file they will mail to themselves is a real harm, and it is invisible — the
 * file has no Trash view, so nothing downstream will ever tell them it is in there.
 *
 * So the box starts unticked, and the count is stated **whichever way it is set**. Not
 * "warn when they are included": both directions are surprises. Someone handing a file to a
 * colleague needs to know twelve deleted records are in it; someone archiving their vault
 * needs to know twelve are missing from it. Only the first is usually warned about, and the
 * second is the one that loses data.
 *
 * The counts sit in a polite live region so that ticking the box announces the new number
 * rather than silently changing a sentence nobody is looking at.
 */
export interface ExportScopeStepProps {
  readonly scope: ExportScope;
  readonly mode: ExportScopeMode;
  /** How many records the credential list currently has selected. */
  readonly selectionCount: number;
  readonly preview: ExportPreview | null;
  readonly previewing: boolean;
  readonly onModeChange: (mode: ExportScopeMode) => void;
  readonly onIncludeTrashedChange: (include: boolean) => void;
  readonly describedById: string;
}

export function ExportScopeStep({
  scope,
  mode,
  selectionCount,
  preview,
  previewing,
  onModeChange,
  onIncludeTrashedChange,
  describedById,
}: ExportScopeStepProps): React.JSX.Element {
  const trashHintId = useId();
  const hasSelection = selectionCount > 0;

  return (
    <div className="kh-export-scope" aria-describedby={describedById}>
      <fieldset className="kh-export-scope__group">
        <legend className="kh-export-scope__legend">Records</legend>

        <label className="kh-export-choice">
          <input
            type="radio"
            name="kh-export-scope"
            checked={mode === 'vault'}
            onChange={() => {
              onModeChange('vault');
            }}
          />
          <span>
            <strong>The whole vault</strong>
            <small>Every record, and the full folder and tag structure.</small>
          </span>
        </label>

        <label className={`kh-export-choice${hasSelection ? '' : ' kh-export-choice--disabled'}`}>
          <input
            type="radio"
            name="kh-export-scope"
            checked={mode === 'selection'}
            disabled={!hasSelection}
            onChange={() => {
              onModeChange('selection');
            }}
          />
          <span>
            <strong>
              {hasSelection
                ? `Only the ${selectionCount} record${selectionCount === 1 ? '' : 's'} selected in the list`
                : 'Only the records selected in the list'}
            </strong>
            <small>
              {hasSelection
                ? 'Folders and tags are pruned to what these records actually use, so the file does not disclose the shape of the rest of your vault.'
                : 'Nothing is selected. Close this dialog, select some records, and reopen it.'}
            </small>
          </span>
        </label>
      </fieldset>

      <fieldset className="kh-export-scope__group">
        <legend className="kh-export-scope__legend">Trash</legend>

        <label className="kh-export-choice">
          <input
            type="checkbox"
            checked={scope.includeTrashed}
            aria-describedby={trashHintId}
            onChange={(event) => {
              onIncludeTrashedChange(event.target.checked);
            }}
          />
          <span>
            <strong>Include records I have moved to the Trash</strong>
            <small id={trashHintId}>
              Off unless you tick it. A record in the Trash is one you already decided you did not
              want, and an exported file has no Trash to keep it in.
            </small>
          </span>
        </label>
      </fieldset>

      {/*
       * Polite rather than assertive: these numbers change as a direct result of the user's
       * own click, so they are confirmation, not an interruption. Assertive here would cut
       * across the checkbox's own state announcement.
       */}
      <div className="kh-export-counts" aria-live="polite">
        {preview === null ? (
          previewing ? (
            <>
              <span className="kh-visually-hidden">Working out what would be exported</span>
              <Skeleton width="70%" />
              <Skeleton width="45%" />
            </>
          ) : (
            <p className="kh-export-counts__line">Choose a format to see what would be exported.</p>
          )
        ) : (
          <>
            <p className="kh-export-counts__line">{recordSentence(preview)}</p>
            <p className="kh-export-counts__line">{trashSentence(scope, preview)}</p>
            {unknownSentence(preview) !== null && (
              <p className="kh-export-counts__line kh-export-counts__line--warning">
                <span aria-hidden="true">⚠ </span>
                {unknownSentence(preview)}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
