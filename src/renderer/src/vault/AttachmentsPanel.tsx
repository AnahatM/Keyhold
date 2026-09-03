// SPDX-License-Identifier: GPL-3.0-or-later
import type { AttachmentMeta } from '@shared/model/credential.js';
import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { formatBytes } from '../activity/vault-statistics.js';
import {
  IDLE_DROP_ZONE,
  dropZoneLabel,
  reduceDropZone,
  summariseDrag,
  type DropZoneRules,
  type DropZoneState,
} from './attachment-drop.js';
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
 *
 * ## A drop cannot carry the file, and says so rather than pretending
 *
 * The panel is a drop target, and releasing a file on it does **not** attach that file. It
 * cannot. A drop hands the renderer either the bytes (`File.arrayBuffer()`) or a filesystem
 * path (`webUtils.getPathForFile()`), and there is no third option — the browser gives the
 * window the file precisely because it assumes the window is allowed to read it. Sending
 * either onwards would mean the renderer choosing which file the main process reads and
 * encrypts, and `src/main/ipc/register.ts` refuses that in as many words: a path the renderer
 * picked is attacker-controlled if the renderer is ever compromised; a path a person picked
 * in an OS dialog is consent.
 *
 * So the drop is treated as an *intent* and answered with a sentence saying why one more
 * click is needed, plus the click itself — the same main-process dialog the "Attach a file"
 * button opens, unchanged. Silently opening that dialog on release would be smoother and
 * would also be a small lie: the dialog would come up on the wrong folder with the wrong file
 * unselected, and the user would be left to work out why. A gesture that cannot do what it
 * looks like it does is better named than papered over.
 *
 * The consequence is worth stating because it is not obvious. Attachment preview returns real
 * bytes to the renderer for images, PDFs and plain text. An add-by-path channel next to it
 * would compose into an arbitrary-file-read primitive — a compromised renderer attaches
 * `~/.ssh/id_rsa.pub` or a photo from Documents, then previews it back. Two individually
 * defensible channels, one that is not. Which is why the shortest path here is a dialog and
 * not a new channel.
 *
 * `attachment-drop.ts` holds every part of this that is decidable without the file: whether
 * the drag carries files at all, how many, and the enter/over/leave/drop bookkeeping that
 * keeps the target lit when the pointer crosses a child.
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
  const [dropZone, setDropZone] = useState<DropZoneState>(IDLE_DROP_ZONE);

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
        //
        // `durationMs`, not `duration`. It was `duration` until now — a key `ToastInput` does
        // not have, so the toast took the default lifetime and slid away mid-sentence. The
        // spread is why nothing caught it: excess-property checking applies to object
        // literals assigned directly, and a literal spread into another object is exempt, so
        // the misspelling type-checked cleanly and silently did nothing.
        ...(notes.length === 0 ? {} : { durationMs: null }),
      });
    });
  };

  /**
   * The pending "choose a file" toast, so it can be taken away with the record it belongs to.
   *
   * Its action attaches to whichever `credentialId` was on screen when the drop happened. A
   * toast outliving that record means a button that quietly files a passport scan against the
   * wrong login — silent, plausible, and only discovered later. `toast` is memoised by its
   * provider, so this cleanup fires on a record change and on unmount, and not on every
   * render.
   */
  const dropPromptId = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (dropPromptId.current !== null) {
        toast.dismiss(dropPromptId.current);
        dropPromptId.current = null;
      }
    },
    [credentialId, toast]
  );

  // Recomputed every render, and read inside the handlers below — which are recreated with
  // it, so a drag in flight when the record is trashed sees the refusal on its next event.
  const rules: DropZoneRules = readOnly
    ? { accepting: false, refusal: 'read-only' }
    : busy
      ? { accepting: false, refusal: 'busy' }
      : { accepting: true };

  /**
   * `preventDefault` on every file drag, accepted or refused.
   *
   * Not only to mark this a drop target. An unhandled file drop anywhere in an Electron
   * window makes the window *navigate to the file* — the renderer replaced by a `file://`
   * page, the vault UI gone, and no way back short of a reload. Refusing a drop therefore
   * still means swallowing the event, and "refusing" is a state that draws rather than a
   * branch that returns early.
   */
  const dragHandlers = {
    onDragEnter: (event: ReactDragEvent<HTMLElement>): void => {
      const drag = summariseDrag(event.dataTransfer);
      if (!drag.hasFiles) return;
      event.preventDefault();
      setDropZone((current) => reduceDropZone(current, { type: 'enter', drag }, rules));
    },
    onDragOver: (event: ReactDragEvent<HTMLElement>): void => {
      const drag = summariseDrag(event.dataTransfer);
      if (!drag.hasFiles) return;
      event.preventDefault();
      // The cursor. `copy` because nothing is moved off the user's disk — the original file
      // stays where it is, and `move` would say otherwise.
      event.dataTransfer.dropEffect = rules.accepting ? 'copy' : 'none';
      setDropZone((current) => reduceDropZone(current, { type: 'over', drag }, rules));
    },
    onDragLeave: (): void => {
      setDropZone((current) => reduceDropZone(current, { type: 'leave' }, rules));
    },
    onDrop: (event: ReactDragEvent<HTMLElement>): void => {
      const drag = summariseDrag(event.dataTransfer);
      if (!drag.hasFiles) return;
      event.preventDefault();
      setDropZone((current) => reduceDropZone(current, { type: 'drop' }, rules));
      if (!rules.accepting) return;

      // Nothing about the dropped file is read, named or forwarded — not `files`, not
      // `items[i].getAsFile()`, not `webUtils.getPathForFile`. The count comes from `items`
      // metadata and is the only thing this branch knows.
      dropPromptId.current = toast.warning('Keyhold cannot take a file straight from a drop', {
        description:
          'Files are read in the background process that holds the vault key, never in this window — so the file has to be picked in a dialog. One click.',
        dedupeKey: 'attachment-drop',
        action: { label: 'Choose a file', onAct: add },
      });
    },
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
    <section className="kh-attachments" aria-labelledby="kh-attachments-heading" {...dragHandlers}>
      {/*
        Drawn only while a file drag is over the panel, and `aria-hidden` because it is
        feedback for a gesture that needs a pointer. A screen-reader user reaches attachments
        through the "Attach a file" button, which is the same destination and is already
        labelled; announcing a drop target they cannot aim at would be noise. The refusal
        reasons it shows — trashed, busy — are both visible elsewhere in the panel.
      */}
      {dropZone.status !== 'idle' && (
        <div
          aria-hidden="true"
          className={`kh-attachments__dropzone kh-attachments__dropzone--${dropZone.status}`}
        >
          <span className="kh-attachments__dropzone-label">{dropZoneLabel(dropZone)}</span>
        </div>
      )}

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
