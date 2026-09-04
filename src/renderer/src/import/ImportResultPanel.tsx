// SPDX-License-Identifier: GPL-3.0-or-later
import type { ImportCommitResult, ImportUndoResult } from '@shared/model/import-plan.js';
import { Button } from '../components/Button.js';
import { Icon } from '../components/Icon.js';
import { WarningList } from './WarningList.js';
import './import.css';

/**
 * Step five: what happened, and the way back.
 *
 * **Undo is the point of this screen.** An import that cannot be taken back is an import
 * people are afraid to run, and a password manager whose import people are afraid to run is a
 * password manager they do not move into. So the button is here, on the result, at the moment
 * the user is looking at the numbers and deciding whether they are the right numbers — not
 * buried in a history view they have to go and find.
 *
 * When undo is not possible the screen says so plainly instead of offering a control that
 * would fail. And once undo has run, its own result is shown: "removed 412 records" is the
 * confirmation that the escape hatch actually worked.
 */
export function ImportResultPanel({
  result,
  undoResult,
  busy,
  onUndo,
}: {
  readonly result: ImportCommitResult;
  readonly undoResult: ImportUndoResult | null;
  readonly busy: boolean;
  readonly onUndo: () => void;
}): React.JSX.Element {
  // Narrowed to a value rather than a boolean flag, so the branch below can read the
  // counts without TypeScript having to be told twice that it is not null.
  const undone = undoResult?.undone === true ? undoResult : null;

  return (
    <div className="kh-import-step">
      <p className="kh-import-headline" role="status">
        {undone !== null ? (
          <>
            <span aria-hidden="true">↩ </span>
            Import undone — {undone.removedCount}{' '}
            {undone.removedCount === 1 ? 'record was' : 'records were'} removed.
          </>
        ) : (
          <>
            <Icon name="check" />{' '}
            <strong className="kh-import-headline__number">{result.importedCount}</strong>{' '}
            {result.importedCount === 1 ? 'record' : 'records'} imported.
          </>
        )}
      </p>

      <dl className="kh-import-facts">
        <div>
          <dt>Imported</dt>
          <dd>{result.importedCount}</dd>
        </div>
        <div>
          <dt>Skipped as duplicates</dt>
          <dd>{result.skippedCount}</dd>
        </div>
        <div>
          <dt>Merged</dt>
          <dd>{result.mergedCount}</dd>
        </div>
        <div>
          <dt>Folders created</dt>
          <dd>{result.createdFolderPaths.length}</dd>
        </div>
      </dl>

      {result.createdFolderPaths.length > 0 && (
        <section className="kh-import-section">
          <h4 className="kh-import-section__heading">Folders created</h4>
          <ul className="kh-import-folders">
            {result.createdFolderPaths.map((path) => (
              <li key={path} className="kh-import-folders__item">
                <span className="kh-import-folders__path">{path}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.warnings.length > 0 && <WarningList warnings={result.warnings} />}

      {undone !== null ? null : result.undoable ? (
        <div className="kh-import-undo">
          <p className="kh-import-undo__lead">
            Not what you expected? This puts your vault back exactly as it was.
          </p>
          <Button variant="secondary" loading={busy} onClick={onUndo}>
            Undo this import
          </Button>
        </div>
      ) : (
        <p className="kh-import-note kh-import-note--warning">
          <Icon name="warning" /> This import cannot be undone automatically. The records are in
          your vault and can be removed by hand from the list.
        </p>
      )}

      <p className="kh-import-note kh-import-note--warning">
        <Icon name="warning" /> The file you imported is still a plaintext copy of every password in
        it. Delete it.
      </p>
    </div>
  );
}
