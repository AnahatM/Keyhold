// SPDX-License-Identifier: GPL-3.0-or-later
import type { AttachmentMeta } from '@shared/model/credential.js';
import { useState } from 'react';
import { formatBytes } from '../activity/vault-statistics.js';
import { addNotes } from './attachment-notes.js';
import { AttachmentViewer } from './AttachmentViewer.js';
import { ConfirmDialog, useToast } from '../chrome/index.js';
import { Button } from '../components/Button.js';

/**
 * The files attached to a record.
 *
 * ## No bytes cross the bridge, and nothing here needs them to
 *
 * Every operation is a command sent to the main process, which owns the file end to end:
 * `add` opens the OS file dialog, reads the bytes and encrypts them; `save` decrypts one
 * chunk and writes it to a path the user picked in a save dialog; `remove` drops a
 * reference. The renderer sends an id and receives metadata — a name, a size, a type, a
 * digest — and never a byte of content.
 *
 * That is not a limitation being worked around. An attachment is secret material: it is as
 * likely to be a photograph of a passport as a licence key, and decision D13 puts secret
 * material in the main process. A "download" button that pulled the bytes into the renderer
 * to hand them to an `<a download>` would be the single largest secret exposure in the app,
 * and it would look like a convenience.
 *
 * **In-app preview is deliberately not here.** Rendering an image or a PDF *does* require
 * the bytes in the renderer, so it is a real decision rather than more of the same wiring —
 * it belongs in the decision log with a broker grant and a TTL, the way revealing a password
 * already works. Until that is written, "Save a copy" is the honest answer: it puts the file
 * where the user's own viewer can open it, and says plainly that is what it does.
 *
 * ## What the engine reports, this says
 *
 * `addAttachment` returns three findings the UI is the only place that can act on:
 * deduplication, a sanitised filename, and a claimed type that disagrees with the bytes.
 * Reporting them is the whole point of computing them — an `invoice.pdf.exe` renamed
 * silently is a rename the user never learns about, and a mime mismatch nobody sees is a
 * check that may as well not run.
 */

export interface AttachmentsPanelProps {
  readonly credentialId: string;
  readonly attachments: readonly AttachmentMeta[];
  /** Refreshes the record after a change. The projection is stale the moment one lands. */
  readonly onChanged: () => void;
  /** Trashed records are read-only, so their attachments are too. */
  readonly readOnly?: boolean;
}

export function AttachmentsPanel({
  credentialId,
  attachments,
  onChanged,
  readOnly = false,
}: AttachmentsPanelProps): React.JSX.Element {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<AttachmentMeta | null>(null);
  const [viewing, setViewing] = useState<AttachmentMeta | null>(null);

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  const add = (): void => {
    void run(async () => {
      const result = await window.keyhold.attachments.add(credentialId);
      if (!result.ok) throw new Error(result.message);
      // `null` is the user dismissing the file dialog. Not an error, and not worth a toast:
      // they know they cancelled.
      if (result.value === null) return;

      onChanged();

      // Title, then the findings as a description. One long sentence would bury the part
      // that matters — "the name hides a second extension" reads very differently at the
      // start of a line than trailing a success message.
      const notes = addNotes(result.value);
      toast.success(`Attached ${result.value.meta.name}`, {
        ...(notes.length === 0 ? {} : { description: notes.join(' ') }),
        // Findings need reading, so they stay until dismissed. A bare success does not.
        ...(notes.length === 0 ? {} : { duration: null }),
      });
    });
  };

  const save = (attachment: AttachmentMeta): void => {
    void run(async () => {
      const result = await window.keyhold.attachments.save(credentialId, attachment.id);
      if (!result.ok) throw new Error(result.message);
      if (result.value === null) return;
      // The file name, not the path. Where they put it is their business, and echoing a
      // directory back into the renderer is a habit worth not starting.
      toast.success(`Saved ${result.value}.`);
    });
  };

  const remove = (attachment: AttachmentMeta): void => {
    void run(async () => {
      const result = await window.keyhold.attachments.remove(credentialId, attachment.id);
      if (!result.ok) throw new Error(result.message);
      onChanged();
      toast.success(`Removed ${attachment.name}.`);
    });
  };

  return (
    <section className="kh-attachments" aria-labelledby="kh-attachments-heading">
      <div className="kh-attachments__header">
        <h3 className="kh-attachments__heading" id="kh-attachments-heading">
          Attachments
        </h3>
        {!readOnly && (
          <Button variant="secondary" onClick={add} disabled={busy}>
            Attach a file
          </Button>
        )}
      </div>

      {attachments.length === 0 ? (
        <p className="kh-attachments__empty">
          Nothing attached. Files are encrypted inside the vault alongside everything else, and
          never leave this computer.
        </p>
      ) : (
        <ul className="kh-attachments__list">
          {attachments.map((attachment) => (
            <li className="kh-attachments__item" key={attachment.id}>
              <div className="kh-attachments__file">
                {/* `title` as well as the visible name: a long filename is truncated by CSS,
                    and the whole point of a filename is being able to read it. */}
                <span className="kh-attachments__name" title={attachment.name}>
                  {attachment.name}
                </span>
                <span className="kh-attachments__meta">
                  {formatBytes(attachment.size)} · {attachment.mime}
                </span>
              </div>
              <div className="kh-attachments__actions">
                {/* Offered for every file, not only the previewable kinds. The main process
                    decides what will render, and hiding the button for the rest would mean
                    the renderer keeping its own opinion about which types are safe — the
                    second list, in the one place it must not exist. The viewer says plainly
                    when it cannot show something. */}
                <Button
                  variant="ghost"
                  onClick={() => {
                    setViewing(attachment);
                  }}
                  disabled={busy}
                >
                  View
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    save(attachment);
                  }}
                  disabled={busy}
                >
                  Save a copy
                </Button>
                {!readOnly && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setPendingRemove(attachment);
                    }}
                    disabled={busy}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {viewing !== null && (
        <AttachmentViewer
          open
          credentialId={credentialId}
          attachmentId={viewing.id}
          onClose={() => {
            setViewing(null);
          }}
        />
      )}

      <ConfirmDialog
        open={pendingRemove !== null}
        title="Remove this attachment?"
        message={
          pendingRemove === null ? '' : `“${pendingRemove.name}” will be taken off this record.`
        }
        /* The file survives while another record still attaches it — chunks are shared and
           reference-counted — so promising deletion would be a lie in the common case. */
        consequence="The file is removed from the vault unless another record also has it. This is not undoable from the Trash."
        confirmLabel="Remove"
        destructive
        busy={busy}
        onCancel={() => {
          setPendingRemove(null);
        }}
        onConfirm={() => {
          const attachment = pendingRemove;
          setPendingRemove(null);
          if (attachment !== null) remove(attachment);
        }}
      />
    </section>
  );
}
