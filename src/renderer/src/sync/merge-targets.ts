// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Names for the things a merge report argues about.
 *
 * ## Why this is not part of the IPC contract
 *
 * A `MergeConflict` identifies its subject as `targetId` — a uuid — because a merge engine has
 * no business deciding what a record is called. A resolver rendering
 * `record:abc-123:field:password` is a resolver nobody can use, so the names have to come from
 * somewhere. The obvious move is to widen `SyncApi` and send them alongside the report; that
 * would be a second copy of data the renderer already holds, and hard rule 8 says no.
 *
 * The renderer already has the titles. It renders the vault list from `CredentialProjection`,
 * and the folder and tag names from the organisation store, and those are the *safe projection*
 * — no secret is involved in any of them.
 *
 * ## Why that is sufficient, and not a lucky accident
 *
 * **Every conflict target exists in our own document**, by construction:
 *
 *  - a `record-field`, `record-delete-vs-edit` or `record-history` conflict is produced by
 *    `mergeRecord(base, ours, theirs)`, which only runs when the record is on *both* sides;
 *  - a `folder` or `tag` conflict comes from `pick(...)`, which takes `mine` and `yours`;
 *  - a `setting` conflict is about a key every vault has.
 *
 * A record that exists only in the other file is a `'record-added'` **note**, not a conflict —
 * nothing about it is in dispute, so nothing about it needs naming to be answered. That is why
 * a lookup over our own vault is complete rather than merely usually complete.
 *
 * {@link nameTarget} still falls back rather than trusting the argument above absolutely: an
 * unnamed target renders as `Record 3f2ac1…`, which is answerable and impossible to mistake for
 * a title, instead of blank or as a raw id.
 */

export type MergeTargetKind = 'record' | 'folder' | 'tag' | 'setting';

/** The noun for a target kind, for a heading and for the fallback name. */
export const TARGET_KIND_NOUNS: Readonly<Record<MergeTargetKind, string>> = {
  record: 'Record',
  folder: 'Folder',
  tag: 'Tag',
  setting: 'Setting',
};

export interface TargetName {
  readonly name: string;
  /** A folder breadcrumb — `'Work / Cloud'`. Folder names only; never a value. */
  readonly path: string | null;
  /** True when nothing was found and the name is the id-derived fallback. */
  readonly isFallback: boolean;
}

/**
 * Everything the resolver needs to name a target, indexed once.
 *
 * Maps rather than arrays: a four-hundred-conflict report would otherwise be four hundred linear
 * scans of the vault list on every render, which is the kind of quadratic that only shows up in
 * exactly the case this screen was designed for.
 */
export interface MergeTargetNames {
  readonly records: ReadonlyMap<string, string>;
  readonly folders: ReadonlyMap<string, string>;
  readonly tags: ReadonlyMap<string, string>;
  /** Record id → folder breadcrumb. Optional; absent simply means no breadcrumb is shown. */
  readonly recordPaths: ReadonlyMap<string, string>;
}

const NO_NAMES: MergeTargetNames = {
  records: new Map(),
  folders: new Map(),
  tags: new Map(),
  recordPaths: new Map(),
};

/** For a resolver rendered before the vault list has loaded. Every target falls back. */
export function emptyTargetNames(): MergeTargetNames {
  return NO_NAMES;
}

/**
 * Structural inputs, so the caller can hand over `CredentialProjection[]`, `Folder[]` and
 * `Tag[]` straight from the stores without adapting them.
 *
 * Typed as the two fields actually read rather than as the model types, so this module does not
 * acquire an opinion about the shape of a credential — and so a test can build one in a line.
 */
export interface TargetNameInput {
  readonly records?: readonly { readonly id: string; readonly title: string }[] | undefined;
  readonly folders?:
    | readonly { readonly id: string; readonly name: string; readonly parentId: string | null }[]
    | undefined;
  readonly tags?: readonly { readonly id: string; readonly name: string }[] | undefined;
  /** Record id → folder id, for the breadcrumb. Usually the projection's own `folderId`. */
  readonly recordFolders?: readonly { readonly id: string; readonly folderId: string | null }[];
}

/** Builds the folder breadcrumb for a folder id, stopping at a cycle rather than hanging. */
function breadcrumb(
  folderId: string,
  byId: ReadonlyMap<string, { readonly name: string; readonly parentId: string | null }>
): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = folderId;
  // A merged folder tree can contain a cycle — the engine reports `'folder-cycle-broken'` when
  // it cuts one, which means the *unmerged* tree it started from had one. Walking it here
  // without a guard would hang the resolver on exactly the vault that most needs resolving.
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const folder = byId.get(cursor);
    if (folder === undefined) break;
    parts.unshift(folder.name);
    cursor = folder.parentId;
  }
  return parts.join(' / ');
}

export function targetNamesFrom(input: TargetNameInput): MergeTargetNames {
  const records = new Map<string, string>();
  for (const record of input.records ?? []) records.set(record.id, record.title);

  const folders = new Map<string, string>();
  const folderTree = new Map<string, { readonly name: string; readonly parentId: string | null }>();
  for (const folder of input.folders ?? []) {
    folders.set(folder.id, folder.name);
    folderTree.set(folder.id, { name: folder.name, parentId: folder.parentId });
  }

  const tags = new Map<string, string>();
  for (const tag of input.tags ?? []) tags.set(tag.id, tag.name);

  const recordPaths = new Map<string, string>();
  for (const record of input.recordFolders ?? input.records?.map(toFolderRef) ?? []) {
    if (record.folderId === null) continue;
    const path = breadcrumb(record.folderId, folderTree);
    if (path !== '') recordPaths.set(record.id, path);
  }

  return { records, folders, tags, recordPaths };
}

/** `CredentialProjection` carries `folderId`; the narrow input type does not promise it. */
function toFolderRef(record: { readonly id: string }): {
  readonly id: string;
  readonly folderId: string | null;
} {
  const folderId = (record as { readonly folderId?: string | null }).folderId;
  return { id: record.id, folderId: folderId ?? null };
}

/**
 * A short, recognisable stand-in when nothing named this target.
 *
 * Deliberately not the raw id and deliberately not blank. "Record 3f2ac1…" is enough to match
 * against a diagnostic and impossible to mistake for a title, and the row stays answerable.
 */
export function fallbackName(kind: MergeTargetKind, targetId: string): string {
  const short = targetId.length > 8 ? `${targetId.slice(0, 8)}…` : targetId;
  return `${TARGET_KIND_NOUNS[kind]} ${short}`;
}

function lookup(
  kind: MergeTargetKind,
  names: MergeTargetNames
): ReadonlyMap<string, string> | null {
  switch (kind) {
    case 'record':
      return names.records;
    case 'folder':
      return names.folders;
    case 'tag':
      return names.tags;
    // A setting has no id to look up — its key *is* its identity, and `fieldLabel` turns that
    // into English. Returning null here routes it to the caller's own naming rather than to a
    // map that could never hold it.
    case 'setting':
      return null;
  }
}

export function nameTarget(
  kind: MergeTargetKind,
  targetId: string,
  names: MergeTargetNames
): TargetName {
  const map = lookup(kind, names);
  const found = map?.get(targetId);
  // An untitled record is a real state in this app — a record can be saved with no title — and
  // rendering it as nothing would leave a heading-shaped hole. Blank counts as not found.
  if (found === undefined || found.trim() === '') {
    return { name: fallbackName(kind, targetId), path: null, isFallback: true };
  }
  const path = kind === 'record' ? (names.recordPaths.get(targetId) ?? null) : null;
  return { name: found, path, isFallback: false };
}
