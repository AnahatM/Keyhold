// SPDX-License-Identifier: GPL-3.0-or-later

import { dragKindFromTypes } from '../organisation/drag-payload.js';

/**
 * The drag-and-drop state for the attachments panel.
 *
 * ## What a drop can and cannot tell the main process
 *
 * Everything here stops at the point where a file's *content* would be needed, because that
 * is where decision D13 draws its line and this module is on the wrong side of it. A drop
 * event offers the renderer exactly two routes to a file's bytes: `File.arrayBuffer()`, which
 * reads them into the window; and `webUtils.getPathForFile()`, which yields a real filesystem
 * path the renderer could then hand to the main process. Both put the choice of *which file
 * gets read* in the renderer, and `src/main/ipc/register.ts` says plainly why that is refused
 * — a path the renderer chose is attacker-controlled if the renderer is ever compromised,
 * while a path the user picked in an OS dialog is a genuine act of consent.
 *
 * So this module deals only in the metadata a drag exposes anyway: whether files are on the
 * drag at all, how many, and where the pointer is. No name, no path, no byte. The panel
 * answers the release by saying why one more click is needed and offering it — the existing
 * main-process file dialog, the same consented path the "Attach a file" button uses, with no
 * boundary moved.
 *
 * ## Why `dragover` is so nearly useless, and what is left
 *
 * During `dragenter` and `dragover` the browser holds the drag in "protected mode": the data
 * is unreadable and `dataTransfer.files` is empty, precisely so a page cannot read a file
 * just because a cursor passed over it. What survives is `types` — which contains the literal
 * string `Files` when the drag carries OS files — and `items`, whose entries expose `kind`
 * and `type` but not content. Those two are the whole input to `summariseDrag`, and they are
 * enough to decide whether to light the target up.
 *
 * ## The nested-`dragleave` problem, which is the reason this is a reducer
 *
 * `dragenter` and `dragleave` both bubble. Moving the pointer from the panel onto a button
 * *inside* the panel fires `dragenter` on the button and then `dragleave` on the panel — both
 * of which reach the panel's handler. A boolean flag flipped by those two events therefore
 * switches off the moment the pointer crosses any child, and the drop target flickers its way
 * across the panel and is dark exactly where the user is aiming.
 *
 * The fix is a depth counter rather than a flag: `dragenter` increments, `dragleave`
 * decrements, and the zone is lit while the count is above zero. It works because the HTML
 * drag model fires `dragenter` on the new target *before* `dragleave` on the old one, so the
 * count goes 1 → 2 → 1 across a child boundary and never touches zero. `reduceDropZone` is a
 * plain function over that count so the sequence can be asserted, which a `useState` flag
 * inside a component never can.
 */

/** The `dataTransfer.types` entry present when a drag carries OS files. Not a MIME type. */
const FILES_TYPE = 'Files';

/** The `DataTransferItem.kind` for a file, as opposed to `'string'`. */
const FILE_ITEM_KIND = 'file';

/**
 * The part of a `DataTransferItem` this module is allowed to look at.
 *
 * Structural rather than the DOM type so the reducer can be tested without a jsdom
 * `DataTransfer` — but deliberately narrowed to `kind` alone. Widening it to `getAsFile` is
 * the change that would put bytes in the renderer, and a reviewer should have to add the
 * field to do it.
 */
export interface DraggedItemLike {
  readonly kind: string;
}

/** The part of a `DataTransfer` this module is allowed to look at. See above. */
export interface DragDataLike {
  readonly types: readonly string[];
  readonly items?: ArrayLike<DraggedItemLike> | null | undefined;
}

/** What a drag is carrying, as far as a protected-mode `dragover` may say. */
export interface DragSummary {
  readonly hasFiles: boolean;
  /**
   * How many files are on the drag, or `0` when the browser did not populate `items`.
   *
   * `0` alongside `hasFiles: true` is a real state, not a bug: some drags expose the `Files`
   * type without an item list. Copy must read correctly for it, which is why
   * `dropZoneLabel` treats "one" and "unknown" the same way.
   */
  readonly fileCount: number;
}

export const NO_FILES: DragSummary = { hasFiles: false, fileCount: 0 };

/**
 * What is on a drag, from the metadata `dragover` exposes.
 *
 * A Keyhold drag — a credential or a folder being refiled — is rejected outright rather than
 * merely failing the `Files` check. The two never co-occur today, but the attachments panel
 * sits inside the record detail while the folder tree is a drop target in the same window,
 * and "an internal drag is not a file" is the durable statement of intent. `dragKindFromTypes`
 * is imported rather than re-listed: the Keyhold drag types have one home.
 */
export function summariseDrag(transfer: DragDataLike | null | undefined): DragSummary {
  if (transfer === null || transfer === undefined) return NO_FILES;

  const types = [...transfer.types];
  if (dragKindFromTypes(types) !== null) return NO_FILES;
  if (!types.includes(FILES_TYPE)) return NO_FILES;

  return { hasFiles: true, fileCount: countFileItems(transfer.items) };
}

function countFileItems(items: ArrayLike<DraggedItemLike> | null | undefined): number {
  if (items === null || items === undefined) return 0;

  // `Array.from` rather than iterating in place: a live `DataTransferItemList` is array-*like*
  // but not iterable, so `for...of` over it throws rather than reading zero items.
  return Array.from(items).filter((item) => item.kind === FILE_ITEM_KIND).length;
}

/**
 * `refusing` is a lit target that says no, and it is deliberate.
 *
 * Silently ignoring a drop onto a trashed record reads as the app being broken. Showing the
 * target and naming the reason costs one line of copy and answers the question the user was
 * about to ask.
 */
export type DropZoneStatus = 'idle' | 'ready' | 'refusing';

/** Why a drop is being refused. A closed set, so the copy for each lives in one place. */
export type DropRefusal = 'read-only' | 'busy';

export interface DropZoneState {
  /** The `dragenter`/`dragleave` nesting count. Lit while above zero. */
  readonly depth: number;
  readonly status: DropZoneStatus;
  readonly fileCount: number;
  readonly refusal: DropRefusal | null;
}

export const IDLE_DROP_ZONE: DropZoneState = {
  depth: 0,
  status: 'idle',
  fileCount: 0,
  refusal: null,
};

export type DropZoneEvent =
  | { readonly type: 'enter'; readonly drag: DragSummary }
  | { readonly type: 'over'; readonly drag: DragSummary }
  | { readonly type: 'leave' }
  | { readonly type: 'drop' };

/**
 * Whether the panel can take a file right now, and why not when it cannot.
 *
 * A discriminated union rather than a boolean plus a nullable reason, so "refused with no
 * reason given" is not a state anyone can construct.
 */
export type DropZoneRules =
  { readonly accepting: true } | { readonly accepting: false; readonly refusal: DropRefusal };

export function reduceDropZone(
  state: DropZoneState,
  event: DropZoneEvent,
  rules: DropZoneRules
): DropZoneState {
  switch (event.type) {
    case 'enter':
      return settle(state.depth + 1, event.drag, rules);

    /**
     * `dragover` never changes the depth — it fires continuously for as long as the pointer
     * is over the target and counting it would run the number to thousands. It floors the
     * depth at one instead, because it is the only drag event guaranteed to keep arriving:
     * a re-render that remounts the panel mid-drag swallows the `dragenter` that would
     * otherwise have lit it, and without this floor the zone stays dark under a live drag.
     */
    case 'over':
      return settle(Math.max(state.depth, 1), event.drag, rules);

    case 'leave': {
      // Floored at zero. An unmatched `dragleave` — the pointer leaving a child the panel
      // never saw entered — would otherwise drive the count negative, and the next real
      // enter would then have to climb back to one before the zone lit at all.
      const depth = Math.max(0, state.depth - 1);
      return depth === 0 ? IDLE_DROP_ZONE : { ...state, depth };
    }

    case 'drop':
      return IDLE_DROP_ZONE;
  }
}

function settle(depth: number, drag: DragSummary, rules: DropZoneRules): DropZoneState {
  // A drag with no files never lights the target and never holds it open, whatever the
  // depth says. Resetting rather than keeping the count means a text or link drag crossing
  // the panel cannot leave a stuck depth behind for the next file drag to inherit.
  if (!drag.hasFiles) return IDLE_DROP_ZONE;

  return rules.accepting
    ? { depth, status: 'ready', fileCount: drag.fileCount, refusal: null }
    : { depth, status: 'refusing', fileCount: drag.fileCount, refusal: rules.refusal };
}

/**
 * The sentence shown on the lit target. `''` when nothing is shown.
 *
 * "Release to attach" names the destination and says nothing about the mechanism. It has to:
 * the file cannot travel from the drop into the vault directly, and the panel answers the
 * release with a sentence explaining that and a button that opens the file dialog. If a
 * channel is ever added that carries a dropped file to main, this copy stays correct as
 * written and only the panel's drop handler changes.
 *
 * The multi-file wording is not a nicety. The add path takes one file per call, so a person
 * dropping four and getting one back has lost three without being told — the label is the
 * only place that expectation can be corrected while it can still be acted on.
 */
export function dropZoneLabel(state: DropZoneState): string {
  if (state.status === 'idle') return '';

  if (state.status === 'refusing') {
    return state.refusal === 'read-only'
      ? 'Attachments are read-only while a record is in the Trash'
      : 'Still finishing the last change';
  }

  // `0` is "the browser did not say", which reads the same as one to a user with one file
  // in hand and must not become "Release to attach 0 files".
  return state.fileCount > 1
    ? `Release to attach — one file at a time, so ${String(state.fileCount)} needs ${String(state.fileCount)} drops`
    : 'Release to attach';
}
