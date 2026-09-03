// SPDX-License-Identifier: GPL-3.0-or-later
import type { AttachmentPreview } from '@shared/model/attachment.js';
import { useEffect, useState } from 'react';
import { Modal } from '../chrome/index.js';

/**
 * Looking at an attachment without writing it to disk.
 *
 * ## Why this is allowed to hold bytes when nothing else is
 *
 * `SecretRef` has carried an `'attachment'` kind since the broker was written, and
 * `readAttachment` has always gone through it — one item per request, rate limited, every
 * grant dropped on lock, digest verified before the bytes are returned. This is the door
 * that was already built, not a new one, and it is the same exception decision D13 already
 * makes for revealing a password.
 *
 * The alternative is worse, which is the actual argument. Without a viewer, someone who
 * wants to check which passport scan they attached has to save a decrypted copy to their
 * filesystem — permanently, in a folder with no protection, to answer a question that took
 * two seconds. A preview that lives for as long as a dialog is open is the smaller exposure
 * by a wide margin.
 *
 * ## The blob URL is the thing to be careful with
 *
 * `URL.createObjectURL` pins the bytes for the lifetime of the document, not the component.
 * A missed `revokeObjectURL` is a copy of the file kept alive until the window closes —
 * exactly the leak this viewer exists to avoid — so the revoke is in the effect's cleanup,
 * where React guarantees it runs on unmount and before every re-run.
 *
 * ## What it will not render
 *
 * The main process decides. `kh:attachments:preview` returns `null` for anything that is
 * not an image, a PDF or plain text, judged on the **sniffed** type rather than the claimed
 * one. This component never sees the bytes of an archive or an executable, so there is no
 * branch here that could be talked into rendering one.
 */

export interface AttachmentViewerProps {
  readonly open: boolean;
  readonly credentialId: string;
  readonly attachmentId: string;
  readonly onClose: () => void;
}

type ViewerState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly preview: AttachmentPreview;
      /** A blob URL for image and PDF. `null` for text, which is decoded instead. */
      readonly url: string | null;
      readonly text: string | null;
    }
  | { readonly status: 'unavailable' }
  | { readonly status: 'failed'; readonly message: string };

export function AttachmentViewer({
  open,
  credentialId,
  attachmentId,
  onClose,
}: AttachmentViewerProps): React.JSX.Element {
  const [state, setState] = useState<ViewerState>({ status: 'loading' });

  useEffect(() => {
    if (!open) return;

    /**
     * Cancellation state, in an object rather than two `let`s.
     *
     * TypeScript narrows a `let` assigned `true` and only reassigned inside a *later*
     * closure to the literal `true`, so every `if (!live)` below reads as dead code — the
     * lint rule says so, and the tempting fix is to delete the checks. They are load-bearing:
     * the cleanup sets this to false, and without them a preview that resolves after the
     * dialog closed calls `setState` on an unmounted component and leaks its blob URL.
     *
     * A property read is not narrowed the same way, so this keeps the checks honest instead
     * of silencing the rule that noticed them.
     */
    const run = { live: true, url: null as string | null };

    /**
     * Read through a call, not a property.
     *
     * Even on an object, TypeScript narrows `run.live` to `true` after the first check and
     * does not widen it again across an `await` — so a second check reads as dead code. A
     * function's return value is not narrowed, which keeps every check honest rather than
     * deleting the ones the compiler happens to have an opinion about.
     */
    const cancelled = (): boolean => !run.live;

    void (async () => {
      try {
        const result = await window.keyhold.attachments.preview(credentialId, attachmentId);
        if (cancelled()) return;
        if (!result.ok) {
          setState({ status: 'failed', message: result.message });
          return;
        }
        if (result.value === null) {
          setState({ status: 'unavailable' });
          return;
        }

        // Text is decoded here and never becomes a blob.
        //
        // The obvious shape — one blob URL for all three kinds, then `fetch(url).text()` —
        // does not work in this app and would have failed at runtime rather than in review:
        // the renderer's CSP is `connect-src 'none'`, which blocks `fetch` on a `blob:` URL
        // as readily as on an `https:` one. It would also have put the token `fetch` in a
        // renderer file, which the repo-wide no-network guard scans for and would rightly
        // have failed the build over.
        //
        // Decoding is what the fetch was going to do anyway, minus a round trip.
        if (result.value.kind === 'text') {
          const text = new TextDecoder().decode(result.value.bytes);
          setState({ status: 'ready', preview: result.value, url: null, text });
          return;
        }

        // `slice()` rather than handing the view straight to `Blob`: a `Uint8Array` may sit
        // on a `SharedArrayBuffer` as far as the types are concerned, and `BlobPart` will not
        // take one. The copy is what the Blob would make anyway. `type` is the **detected**
        // MIME, which is what makes the browser render it rather than offer a download.
        run.url = URL.createObjectURL(
          new Blob([result.value.bytes.slice().buffer], { type: result.value.mime })
        );
        if (cancelled()) {
          // Closed while the read was in flight. Revoke immediately rather than leaving it
          // to the cleanup, which has already run.
          URL.revokeObjectURL(run.url);
          run.url = null;
          return;
        }
        setState({ status: 'ready', preview: result.value, url: run.url, text: null });
      } catch (error) {
        if (cancelled()) return;
        setState({ status: 'failed', message: error instanceof Error ? error.message : 'Failed.' });
      }
    })();

    return () => {
      run.live = false;
      if (run.url !== null) URL.revokeObjectURL(run.url);
      // Back to loading, so reopening does not flash the previous file — which would be the
      // wrong attachment on screen, briefly, which is worse than a spinner.
      setState({ status: 'loading' });
    };
  }, [open, credentialId, attachmentId]);

  return (
    <Modal
      open={open}
      title={state.status === 'ready' ? state.preview.name : 'Attachment'}
      onClose={onClose}
    >
      <div className="kh-viewer">{body(state)}</div>
    </Modal>
  );
}

function body(state: ViewerState): React.JSX.Element {
  switch (state.status) {
    case 'loading':
      return <p className="kh-viewer__note">Decrypting…</p>;

    case 'unavailable':
      return (
        <p className="kh-viewer__note">
          Keyhold will not display this kind of file. Archives, documents and programs have no safe
          inline preview — use <strong>Save a copy</strong> and open it with whatever normally opens
          it.
        </p>
      );

    case 'failed':
      return <p className="kh-viewer__note kh-viewer__note--error">{state.message}</p>;

    case 'ready':
      switch (state.preview.kind) {
        case 'image':
          // `alt` is the filename: the only thing that can be said about an image nobody has
          // described, and better than an empty string, which announces nothing at all.
          return (
            <img className="kh-viewer__image" src={state.url ?? ''} alt={state.preview.name} />
          );
        case 'pdf':
          // An `<object>` rather than an `<iframe>`: no navigation, no script host, and the
          // fallback below is what a viewer-less platform shows instead of a blank rectangle.
          return (
            <object className="kh-viewer__pdf" data={state.url ?? ''} type="application/pdf">
              <p className="kh-viewer__note">
                This PDF cannot be shown here. Use <strong>Save a copy</strong> to open it.
              </p>
            </object>
          );
        case 'text':
          // `<pre>`, not markup. This is an untrusted file, and the reason plain text is
          // previewable while HTML is not is precisely that plain text stays text.
          return <pre className="kh-viewer__text">{state.text ?? ''}</pre>;
      }
  }
}
