// SPDX-License-Identifier: GPL-3.0-or-later
import type { ImportDuplicateAction, ImportPreview } from '@shared/model/import-plan.js';
import { recordsToAdd, summariseDecisions } from './duplicate-decisions.js';
import { DuplicateGroupList } from './DuplicateGroupList.js';
import { RecordPreviewTable } from './RecordPreviewTable.js';
import { WarningList } from './WarningList.js';
import './import.css';
import { Icon } from '../components/Icon.js';

/**
 * Step four: the dry run.
 *
 * Nothing has been written when this renders, and nothing will be until the user presses the
 * button under it. That is the promise of hard rule 6 — *dry-run before every import* — and
 * it is only worth anything if the numbers on this screen are the numbers that happen. They
 * are: the preview is a projection of the parse the commit will use, not a second estimate.
 *
 * The headline is deliberately the *net* figure, after the duplicate decisions. "417 records
 * found" is a fact about the file; "**5** records will be added to your vault" is the answer
 * to the question the user actually has, and it changes live as they work through the groups.
 */
export function ReviewStep({
  preview,
  decisions,
  onDecision,
  onDecideAll,
}: {
  readonly preview: ImportPreview;
  readonly decisions: Readonly<Record<string, ImportDuplicateAction>>;
  readonly onDecision: (key: string, action: ImportDuplicateAction) => void;
  readonly onDecideAll: (action: ImportDuplicateAction) => void;
}): React.JSX.Element {
  const summary = summariseDecisions(preview.duplicates, decisions);
  const additions = recordsToAdd(preview.newRecordCount, preview.duplicates, decisions);
  const newFolders = preview.folders.filter((folder) => folder.willCreate);

  return (
    <div className="kh-import-step">
      {/*
       * A live region, because this number changes as the user works the duplicate list
       * further down the page — off screen, for a screen-reader user, unless it announces
       * itself. Polite: it is a running total, not an alert.
       */}
      <p className="kh-import-headline" role="status">
        <strong className="kh-import-headline__number">{additions}</strong>{' '}
        {additions === 1 ? 'record' : 'records'} will be added to your vault.
      </p>

      <dl className="kh-import-facts">
        <div>
          <dt>Found in the file</dt>
          <dd>{preview.recordCount}</dd>
        </div>
        <div>
          <dt>New to your vault</dt>
          <dd>{preview.newRecordCount}</dd>
        </div>
        <div>
          <dt>Duplicates</dt>
          <dd>{summary.duplicateRecordCount}</dd>
        </div>
        <div>
          <dt>Skipped</dt>
          <dd>{summary.skippedCount}</dd>
        </div>
        <div>
          <dt>Merged</dt>
          <dd>{summary.mergedCount}</dd>
        </div>
        <div>
          <dt>Folders created</dt>
          <dd>{newFolders.length}</dd>
        </div>
      </dl>

      {summary.replacesAPassword && (
        <p className="kh-import-note kh-import-note--danger" role="alert">
          <Icon name="warning" size="sm" />
          At least one merge would replace a password already in your vault. Check those groups
          before importing — an export can be older than the vault it is being merged into.
        </p>
      )}

      <section className="kh-import-section">
        <h4 className="kh-import-section__heading">Folders</h4>
        {preview.folders.length === 0 ? (
          <p className="kh-import-section__lead">
            No folders — every record lands at the top level of your vault.
          </p>
        ) : (
          <ul className="kh-import-folders">
            {preview.folders.map((folder) => (
              <li key={folder.path} className="kh-import-folders__item">
                <span className="kh-import-folders__path">{folder.path}</span>
                {/* Never colour alone: the state is a word, and the count is a number. */}
                <span className="kh-import-folders__state">
                  {folder.willCreate ? 'will be created' : 'already exists'}
                </span>
                <span className="kh-import-folders__count">
                  {folder.recordCount} {folder.recordCount === 1 ? 'record' : 'records'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <DuplicateGroupList
        groups={preview.duplicates}
        decisions={decisions}
        onDecision={onDecision}
        onDecideAll={onDecideAll}
      />

      <WarningList warnings={preview.warnings} />

      <section className="kh-import-section">
        <h4 className="kh-import-section__heading">A sample of what will be imported</h4>
        <RecordPreviewTable
          records={preview.sample}
          caption="The first records in the file. Passwords and notes are stored but never shown here."
        />
      </section>
    </div>
  );
}
