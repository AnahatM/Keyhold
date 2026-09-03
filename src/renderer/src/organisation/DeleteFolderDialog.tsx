// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { Button } from '../components/Button.js';
import { Modal } from '../chrome/index.js';
import type { FolderDeletionImpact } from './folder-counts.js';
import type { FolderDeletionPolicy } from './gateway.js';

/**
 * Deleting a folder — which asks what happens to the contents, rather than deciding.
 *
 * ## Why this is a dialog with a choice and not a confirm
 *
 * A folder delete that silently unfiles the records inside it is data loss that looks like a
 * UI glitch: nothing warns, nothing fails, and forty records quietly leave the structure the
 * user built. A folder delete that silently moves them up is a different surprise. There is
 * no correct default, so the question gets asked — with the actual numbers, and with the
 * destination named, so the answer is informed rather than guessed.
 *
 * ## Subfolders are never deleted, under either policy
 *
 * They are reparented, and the dialog says so. Cascading a delete through a subtree is the
 * one operation here that could destroy structure with no undo, and hard rule 6 rules it
 * out. A user who wants the subtree gone deletes it a folder at a time and means it.
 *
 * ## Records themselves are never touched
 *
 * Deleting a folder changes where records are filed. It never trashes them and never purges
 * them. That is stated in the dialog because it is the fear the dialog exists to answer.
 */

export interface DeleteFolderDialogProps {
  readonly open: boolean;
  readonly folderName: string;
  readonly impact: FolderDeletionImpact | null;
  readonly busy: boolean;
  readonly onConfirm: (policy: FolderDeletionPolicy) => void;
  readonly onCancel: () => void;
}

export function DeleteFolderDialog({
  open,
  folderName,
  impact,
  busy,
  onConfirm,
  onCancel,
}: DeleteFolderDialogProps): React.JSX.Element | null {
  const [policy, setPolicy] = useState<FolderDeletionPolicy>('reparent');

  if (!open || impact === null) return null;

  const destination = impact.parentName === null ? 'no folder' : `“${impact.parentName}”`;
  const affected = impact.directRecords;
  const empty = affected === 0 && impact.directSubfolders === 0;

  return (
    <Modal
      open={open}
      title={`Delete “${folderName}”`}
      description={
        empty
          ? 'This folder is empty.'
          : 'The folder goes; nothing inside it is deleted. Choose where its records land.'
      }
      onClose={onCancel}
      size="sm"
      closeOnBackdropClick={false}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={() => {
              onConfirm(policy);
            }}
          >
            Delete folder
          </Button>
        </>
      }
    >
      <ul className="kh-delete-folder__facts">
        <li>
          {affected} record{affected === 1 ? '' : 's'} filed directly here
          {impact.descendantRecords > 0
            ? `, and ${impact.descendantRecords} more in its subfolders`
            : ''}
          .
        </li>
        {impact.directSubfolders > 0 && (
          <li>
            {policy === 'reparent' ? (
              <>
                {impact.directSubfolders} subfolder{impact.directSubfolders === 1 ? '' : 's'} will
                move to {destination}, with everything inside{' '}
                {impact.directSubfolders === 1 ? 'it' : 'them'}.
              </>
            ) : (
              <>
                {impact.directSubfolders} subfolder{impact.directSubfolders === 1 ? '' : 's'} will
                be <strong>removed</strong> along with this one.
              </>
            )}
          </li>
        )}
        <li>No record is trashed or deleted by this.</li>
      </ul>

      {/* Shown whenever there is anything inside at all — not only when records are filed
          *directly* here. The choice decides whether the subfolders survive, so a folder
          holding only subfolders still needs it asked. */}
      {(affected > 0 || impact.directSubfolders > 0) && (
        <fieldset className="kh-delete-folder__policy">
          <legend>What happens to this folder&rsquo;s contents</legend>

          <label className="kh-delete-folder__option">
            <input
              type="radio"
              name="kh-delete-policy"
              checked={policy === 'reparent'}
              onChange={() => {
                setPolicy('reparent');
              }}
            />
            <span>
              <strong>Keep the contents, move them to {destination}</strong>
              <span className="kh-panel__hint">
                Only this folder goes. Its records and its subfolders rise one level, and the
                structure inside them is untouched.
              </span>
            </span>
          </label>

          <label className="kh-delete-folder__option">
            <input
              type="radio"
              name="kh-delete-policy"
              checked={policy === 'unfile'}
              onChange={() => {
                setPolicy('unfile');
              }}
            />
            <span>
              <strong>Delete this whole branch</strong>
              <span className="kh-panel__hint">
                This folder <em>and every folder inside it</em> are removed. The records survive,
                filed nowhere — they appear under Unfiled and under All items, as always. No record
                is deleted.
              </span>
            </span>
          </label>
        </fieldset>
      )}
    </Modal>
  );
}
