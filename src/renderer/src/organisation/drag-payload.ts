// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What is being dragged, expressed as custom MIME types.
 *
 * ## Why the kind is in the type and not in the data
 *
 * During `dragover` — the event that decides whether a drop is even allowed — the browser
 * refuses to hand over the dragged data. Only `dataTransfer.types` is readable, in
 * "protected mode", which exists so a page cannot read a file's contents just because a
 * cursor passed over it. A drop target that calls `getData()` in `dragover` therefore gets
 * an empty string and either rejects every drop or accepts every drop, including a file
 * dragged in from the desktop.
 *
 * So the *kind* lives in the MIME type, where `dragover` can see it, and the *id* lives in
 * the data, read once in `drop`. That is the whole reason these constants exist.
 *
 * The types are namespaced to Keyhold so a drag from another application — a file, a URL, a
 * text selection — can never be mistaken for a record.
 *
 * ## Nothing secret is ever put on a drag
 *
 * Only an id, which is already in the safe projection. A drag payload is readable by any
 * drop target in the window and is the sort of channel that quietly becomes a leak; there
 * is no reason to put anything else on it and there must never be one.
 */

export const CREDENTIAL_DRAG_TYPE = 'application/x-keyhold-credential-id';
export const FOLDER_DRAG_TYPE = 'application/x-keyhold-folder-id';

export type DragKind = 'credential' | 'folder';

const TYPE_BY_KIND: Readonly<Record<DragKind, string>> = {
  credential: CREDENTIAL_DRAG_TYPE,
  folder: FOLDER_DRAG_TYPE,
};

export function dragTypeFor(kind: DragKind): string {
  return TYPE_BY_KIND[kind];
}

/**
 * What kind of thing is on the drag, from `dataTransfer.types` alone.
 *
 * A folder wins if somehow both are present: a folder move restructures the tree and is the
 * more consequential of the two, so an ambiguous drag should not silently refile a record.
 */
export function dragKindFromTypes(types: readonly string[]): DragKind | null {
  if (types.includes(FOLDER_DRAG_TYPE)) return 'folder';
  if (types.includes(CREDENTIAL_DRAG_TYPE)) return 'credential';
  return null;
}

export interface DragPayload {
  readonly kind: DragKind;
  readonly id: string;
}

/** Reads the payload in `drop`, where the data is finally readable. */
export function readDragPayload(transfer: DataTransfer | null): DragPayload | null {
  if (transfer === null) return null;
  const kind = dragKindFromTypes([...transfer.types]);
  if (kind === null) return null;
  const id = transfer.getData(dragTypeFor(kind));
  return id === '' ? null : { kind, id };
}

/** Writes the payload in `dragstart`. */
export function writeDragPayload(transfer: DataTransfer | null, payload: DragPayload): void {
  if (transfer === null) return;
  transfer.setData(dragTypeFor(payload.kind), payload.id);
  transfer.effectAllowed = 'move';
}
