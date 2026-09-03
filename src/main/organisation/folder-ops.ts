// SPDX-License-Identifier: GPL-3.0-or-later
import type { FolderDeletePolicy } from '@shared/model/organisation.js';
import { FOLDER_PATH_SEPARATOR, normaliseFolderPath } from '@shared/model/import.js';
import type { Folder, VaultDocument } from '@shared/model/vault-document.js';
import { collectDescendantFolderIds } from '@shared/search/filter.js';
import { folderCycle, folderTooDeep, invalidName, noSuchFolder, tooManyFolders } from './errors.js';
import {
  childrenOf,
  findFolder,
  folderDepth,
  normaliseFolderOrder,
  subtreeHeight,
} from './folder-tree.js';

/**
 * Folder operations, as **pure functions over a document** — the sibling of
 * `vault/credential-ops.ts`, and deliberately built to the same discipline.
 *
 * Nothing here touches a key, a file, or a clock it did not receive. The rules about what a
 * folder tree may look like are the part most likely to acquire a subtle bug — a cycle, a
 * silently orphaned record, an ordering that drifts — and keeping them free of I/O is what
 * lets every one of them be tested directly rather than through an unlocked vault.
 *
 * `VaultService` composes these and marks itself dirty; it does not reimplement them.
 *
 * Everything returns a **new** document. Mutating in place would make undo — which every
 * destructive action in this app offers — a matter of carefully reversing each field,
 * rather than simply keeping the previous value. Deleting a folder is exactly such an
 * action, and "undo" for it is the document that went in.
 */

// ── Limits, and why they are where they are ──────────────────────────────────

/**
 * A name is a sidebar label, not a document. 200 characters is already far past the point
 * where it stops being readable in a tree; the cap exists so one pasted paragraph cannot
 * become a folder name that breaks every path derived from it.
 */
export const MAX_FOLDER_NAME_LENGTH = 200;

/**
 * Nesting depth, counting a root as 1.
 *
 * Sixteen is chosen against what real exports contain — LastPass and 1Password trees
 * essentially never pass five — with enough headroom that nobody hits it by organising
 * carefully. It is a limit rather than no limit because depth is what makes the tree walks
 * super-linear and the sidebar indentation unusable, and because an import from a corrupt
 * source could otherwise nest a thousand deep and be impossible to navigate back out of.
 * Past this point the honest answer is a tag, which cuts across the tree instead.
 */
export const MAX_FOLDER_DEPTH = 16;

/**
 * The whole tree is rendered in the sidebar and every operation here is at least linear in
 * it, so the count is bounded. Two thousand folders is far more than a person maintains by
 * hand; a vault that wants more has a tagging problem, not a foldering one.
 */
export const MAX_FOLDERS = 2_000;

// The delete policies and their meaning live in `@shared/model/organisation.ts`, because the
// dialog that asks the user to choose one is in the renderer and briefly had its own list
// with a different name *and* different semantics. See that file.
export { FOLDER_DELETE_POLICIES, type FolderDeletePolicy } from '@shared/model/organisation.js';

/**
 * The context the folder and tag operations need: an id source, and nothing else.
 *
 * Narrower than `OpsContext` on purpose — folders carry no timestamps and read no settings,
 * so demanding a clock would be asking a caller to supply something that cannot affect the
 * result. `OpsContext` is structurally assignable to this, so `VaultService` passes the one
 * it already builds and there is no second context type to keep in step.
 */
export interface OrganisationContext {
  /** UUID v7 — time-sortable, so creation order is free. */
  readonly newId: () => string;
}

// ── Names ────────────────────────────────────────────────────────────────────

/**
 * Trimmed, and nothing else.
 *
 * No case folding, no whitespace collapsing, no character substitution: the name is the
 * user's, and an operation that quietly rewrites it is editing their data. Trimming is the
 * one exception, because a trailing space is invisible and would make two identical-looking
 * folders resolve differently by path.
 */
export function normaliseFolderName(raw: string): string {
  return raw.trim();
}

/**
 * Rejects a name a folder cannot have.
 *
 * The separator ban is load-bearing rather than fussy. `folderPath` and `findFolderByPath`
 * are inverses of each other, and they stay inverses only while no name contains `/` or
 * `\` — a folder called `Work/Clients` would produce a path indistinguishable from two
 * nested folders, and the import commit stage would then file records under a folder that
 * does not exist. Control characters go for the reason they go everywhere else in this
 * codebase: a NUL in a name is never a name, it is someone probing a parser.
 */
export function assertValidFolderName(name: string): string {
  if (name === '') throw invalidName('a folder needs a name');
  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    throw invalidName(`a folder name is limited to ${MAX_FOLDER_NAME_LENGTH} characters`);
  }
  if (name.includes(FOLDER_PATH_SEPARATOR) || name.includes('\\')) {
    throw invalidName('a folder name cannot contain a slash — nest folders instead');
  }
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is banned
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw invalidName('a folder name cannot contain control characters');
  }
  return name;
}

// ── Reading ──────────────────────────────────────────────────────────────────

export function findFolderIn(document: VaultDocument, folderId: string): Folder | null {
  return findFolder(document.folders, folderId);
}

function requireFolder(document: VaultDocument, folderId: string): Folder {
  const folder = findFolder(document.folders, folderId);
  if (folder === null) throw noSuchFolder();
  return folder;
}

/** Throws unless `parentId` is `null` or names a real folder. */
function requireParent(document: VaultDocument, parentId: string | null): void {
  if (parentId !== null) requireFolder(document, parentId);
}

// ── Writing ──────────────────────────────────────────────────────────────────

export interface FolderResult {
  readonly document: VaultDocument;
  readonly folder: Folder;
}

export interface NewFolderInput {
  readonly name: string;
  readonly parentId?: string | null | undefined;
  /** Position among its new siblings. Appended when omitted. */
  readonly index?: number | undefined;
}

/**
 * Replaces the folder list and renumbers every sibling group.
 *
 * The single door every mutation here goes through, so "renumber on every write" is a
 * property of the module rather than a thing each function has to remember.
 */
function withFolders(document: VaultDocument, folders: readonly Folder[]): VaultDocument {
  return { ...document, folders: normaliseFolderOrder(folders) };
}

/**
 * Splices `folder` into its parent's children at `index`, renumbering that group.
 *
 * Returns the folders *not* in that group untouched, followed by the group in its new
 * order. Order within the array does not matter — `normaliseFolderOrder` rewrites `order`
 * from the sort, not from the position — but doing the splice explicitly is what makes
 * "drop it between these two" mean the same thing on every call.
 */
function placeAmongSiblings(
  folders: readonly Folder[],
  folder: Folder,
  index: number | undefined
): readonly Folder[] {
  const siblings = childrenOf(folders, folder.parentId).filter((other) => other.id !== folder.id);
  const position =
    index === undefined ? siblings.length : Math.max(0, Math.min(index, siblings.length));

  const reordered = [...siblings.slice(0, position), folder, ...siblings.slice(position)].map(
    (sibling, order) => (sibling.order === order ? sibling : { ...sibling, order })
  );

  const others = folders.filter(
    (other) => other.parentId !== folder.parentId && other.id !== folder.id
  );
  return [...others, ...reordered];
}

/**
 * Creates a folder.
 *
 * **Duplicate sibling names are allowed.** That is a decision, not an oversight. A folder's
 * identity is its id; the name is a label, and paths are a convenience derived from it. If
 * uniqueness were enforced here, three things that must never fail would start failing: a
 * merge that brings in a same-named folder from another device, a restore from a backup
 * written before a rename, and an import whose source tree happens to collide. The
 * alternative — inventing `Work (2)` — puts a name in the user's vault that they never
 * chose and cannot easily find again.
 *
 * So the conflict is surfaced instead of prevented: `siblingNameConflict` lets the UI warn
 * before it commits, `integrity.ts` reports existing duplicates, and `findFolderByPath`
 * resolves them deterministically by lowest `(order, id)` so nothing depends on array luck.
 */
export function createFolder(
  document: VaultDocument,
  input: NewFolderInput,
  context: OrganisationContext
): FolderResult {
  if (document.folders.length >= MAX_FOLDERS) throw tooManyFolders(MAX_FOLDERS);

  const parentId = input.parentId ?? null;
  requireParent(document, parentId);

  const depth = parentId === null ? 1 : folderDepth(document.folders, parentId) + 1;
  if (depth > MAX_FOLDER_DEPTH) throw folderTooDeep(MAX_FOLDER_DEPTH);

  const folder: Folder = {
    id: context.newId(),
    name: assertValidFolderName(normaliseFolderName(input.name)),
    parentId,
    // Overwritten by the splice below; present because `Folder.order` is required and a
    // placeholder that never reaches the document is clearer than an assertion.
    order: 0,
  };

  return {
    document: withFolders(
      document,
      placeAmongSiblings([...document.folders, folder], folder, input.index)
    ),
    folder,
  };
}

export function renameFolder(
  document: VaultDocument,
  folderId: string,
  name: string
): VaultDocument {
  const folder = requireFolder(document, folderId);
  const renamed = assertValidFolderName(normaliseFolderName(name));
  if (renamed === folder.name) return document;

  return withFolders(
    document,
    document.folders.map((other) => (other.id === folderId ? { ...other, name: renamed } : other))
  );
}

/**
 * Moves a folder under a new parent, optionally at a given position.
 *
 * **The cycle check is the reason this function is not a one-line map.** A folder moved into
 * its own descendant detaches that whole subtree from the tree: it is still in the array,
 * still holding records, and unreachable from any root — so it vanishes from the sidebar and
 * its records vanish with it, while the file says nothing is wrong. The refusal is explicit
 * and typed rather than a silent no-op, because a drag that appears to do nothing is a bug
 * report nobody can write.
 *
 * Self-parenting is the degenerate case of the same check: `collectDescendantFolderIds`
 * includes the root it was asked about, so `move(x, x)` is caught by the same line.
 *
 * The depth check measures the **subtree being carried**, not just the folder being dragged.
 * Dropping a three-level branch one level below the limit is the case a naive check waves
 * through and only a user with a broken sidebar ever discovers.
 */
export function moveFolder(
  document: VaultDocument,
  folderId: string,
  parentId: string | null,
  options: { readonly index?: number | undefined } = {}
): VaultDocument {
  const folder = requireFolder(document, folderId);
  requireParent(document, parentId);

  if (parentId !== null && collectDescendantFolderIds(document.folders, folderId).has(parentId)) {
    throw folderCycle();
  }

  const parentDepth = parentId === null ? 0 : folderDepth(document.folders, parentId);
  if (parentDepth + subtreeHeight(document.folders, folderId) > MAX_FOLDER_DEPTH) {
    throw folderTooDeep(MAX_FOLDER_DEPTH);
  }

  const moved: Folder = { ...folder, parentId };
  const folders = document.folders.map((other) => (other.id === folderId ? moved : other));
  return withFolders(document, placeAmongSiblings(folders, moved, options.index));
}

/** Repositions a folder among its current siblings. A move that keeps the parent. */
export function reorderFolder(
  document: VaultDocument,
  folderId: string,
  index: number
): VaultDocument {
  const folder = requireFolder(document, folderId);
  return moveFolder(document, folderId, folder.parentId, { index });
}

/**
 * Deletes a folder under an explicitly chosen policy — see `FOLDER_DELETE_POLICIES`.
 *
 * No record is destroyed by either policy. Records move; they do not disappear. The failure
 * this guards against is the one that looks like nothing happened: a folder removed while
 * its records keep pointing at its id, leaving them filed nowhere, absent from every folder
 * view, and reachable only by search. That is data loss wearing a UI glitch's clothes, and
 * it is why the policy is a required argument.
 */
export function deleteFolder(
  document: VaultDocument,
  folderId: string,
  policy: FolderDeletePolicy
): VaultDocument {
  const folder = requireFolder(document, folderId);

  if (policy === 'reparent') {
    const folders = document.folders
      .filter((other) => other.id !== folderId)
      .map((other) =>
        other.parentId === folderId ? { ...other, parentId: folder.parentId } : other
      );

    const records = document.records.map((record) =>
      record.folderId === folderId ? { ...record, folderId: folder.parentId } : record
    );
    return withFolders({ ...document, records }, folders);
  }

  const removed = collectDescendantFolderIds(document.folders, folderId);
  const folders = document.folders.filter((other) => !removed.has(other.id));
  const records = document.records.map((record) =>
    record.folderId !== null && removed.has(record.folderId)
      ? { ...record, folderId: null }
      : record
  );
  return withFolders({ ...document, records }, folders);
}

// ── Paths ────────────────────────────────────────────────────────────────────

export interface FolderPathResult {
  readonly document: VaultDocument;
  /** `null` when the path named nothing — an empty string, or only separators. */
  readonly folder: Folder | null;
}

/**
 * The folder at `path`, creating every missing ancestor in order.
 *
 * **This is the operation the import commit stage needs**, and it is the one place where
 * getting it slightly wrong is expensive: a parser emits `import-folder:Work/Clients`
 * placeholders and this is what turns them into real ids. Three properties matter, and each
 * of them is a bug someone has shipped before:
 *
 *  1. **Reuse, do not duplicate.** `Work/Clients` and `Work/Suppliers` in the same import
 *     must produce one `Work`, and an import run twice must not double the tree.
 *  2. **Match case-insensitively, but never rewrite the existing name.** A vault with `Work`
 *     and an export with `work` mean the same folder. The vault's spelling wins — silently
 *     recasing a folder the user named is an edit they did not ask for.
 *  3. **Ancestors first, in order.** `A/B/C` creates `A`, then `A/B`, then `A/B/C`, so the
 *     tree is well-formed at every step and the sibling ordering is the path's own order
 *     rather than whatever the parser happened to emit first.
 *
 * A path that names nothing returns `folder: null` and the document untouched. That is the
 * correct answer for a source row with an empty group column, and the caller files the
 * record at the root rather than inventing a folder called nothing.
 */
export function findOrCreateFolderPath(
  document: VaultDocument,
  path: string,
  context: OrganisationContext
): FolderPathResult {
  const normalised = normaliseFolderPath(path);
  if (normalised === null) return { document, folder: null };

  const segments = normalised.split(FOLDER_PATH_SEPARATOR);
  if (segments.length > MAX_FOLDER_DEPTH) throw folderTooDeep(MAX_FOLDER_DEPTH);

  let current = document;
  let parentId: string | null = null;
  let folder: Folder | null = null;

  for (const segment of segments) {
    const key = segment.toLowerCase();
    // Lowest (order, id) wins when duplicate siblings exist, so an import run twice against
    // a vault that already has duplicates keeps resolving to the same folder.
    // Annotated because `parentId` is reassigned from the result below, and the inference
    // would otherwise be circular.
    const existing: Folder | null =
      childrenOf(current.folders, parentId).find((other) => other.name.toLowerCase() === key) ??
      null;

    if (existing !== null) {
      folder = existing;
      parentId = existing.id;
      continue;
    }

    const created = createFolder(current, { name: segment, parentId }, context);
    current = created.document;
    folder = created.folder;
    parentId = created.folder.id;
  }

  return { document: current, folder };
}

export interface FolderPathsResult {
  readonly document: VaultDocument;
  /**
   * Every path touched — the requested ones **and the ancestors created along the way** —
   * mapped to its folder id, keyed by the normalised path. Ancestors are included because
   * a parser emits a placeholder for `Work` as readily as for `Work/Clients`, and the
   * commit stage rewriting record ids needs both to resolve.
   */
  readonly folderIdByPath: ReadonlyMap<string, string>;
}

/**
 * `findOrCreateFolderPath` over a whole import's folder list, in one pass.
 *
 * Paths are sorted before creation so the resulting sibling order is the source's
 * alphabetical order rather than row order — two imports of the same data then produce the
 * same tree, which is what makes an import diffable and a dry-run meaningful.
 */
export function findOrCreateFolderPaths(
  document: VaultDocument,
  paths: readonly string[],
  context: OrganisationContext
): FolderPathsResult {
  const wanted = [
    ...new Set(paths.map(normaliseFolderPath).filter((path) => path !== null)),
  ].sort();

  let current = document;
  const folderIdByPath = new Map<string, string>();

  for (const path of wanted) {
    const result = findOrCreateFolderPath(current, path, context);
    current = result.document;
    if (result.folder === null) continue;

    // Record the ancestors too: creating `A/B/C` also settled `A` and `A/B`, and a second
    // lookup for those would be wasted work the commit stage should not have to do.
    const segments = path.split(FOLDER_PATH_SEPARATOR);
    let prefixId: string | null = null;
    for (let index = 0; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index + 1).join(FOLDER_PATH_SEPARATOR);
      const known = folderIdByPath.get(prefix);
      if (known !== undefined) {
        prefixId = known;
        continue;
      }
      const key = segments[index]?.toLowerCase() ?? '';
      const match: Folder | null =
        childrenOf(current.folders, prefixId).find((other) => other.name.toLowerCase() === key) ??
        null;
      if (match === null) break;
      folderIdByPath.set(prefix, match.id);
      prefixId = match.id;
    }
  }

  return { document: current, folderIdByPath };
}
