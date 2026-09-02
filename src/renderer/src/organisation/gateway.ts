// SPDX-License-Identifier: GPL-3.0-or-later
import type { Folder, Tag } from '@shared/model/vault-document.js';
import type { TagColourToken } from './tag-colours.js';

/**
 * The one thing the sidebar is allowed to ask the vault for.
 *
 * ## Why an interface rather than `window.keyhold.organisation`
 *
 * The main-process folder and tag operations are being written in parallel, and the IPC
 * channels for them do not exist yet. Coding directly against a bridge that is not there
 * would mean either blocking on it or writing something that has to be rewritten when it
 * lands. So the sidebar depends on this interface and nothing else: `ipc-gateway.ts` binds
 * it to the real bridge the moment the bridge appears, `fake-gateway.ts` binds it to an
 * in-memory vault for the tests, and neither the components nor the store know which they
 * have.
 *
 * The exact channels this needs are listed in `ipc-gateway.ts` and in the handover report.
 *
 * ## Every mutation returns the whole snapshot
 *
 * Not a patch, not a boolean. The main process is the source of truth for folder order and
 * parentage — it renormalises sibling `order` on every write — so a renderer that predicted
 * the result locally would render an order the file does not have, and the difference would
 * only show up after a reload. This mirrors how `session-store.ts` re-reads status after
 * every mutation rather than guessing.
 *
 * ## Nothing here touches secret material
 *
 * Folders and tags are metadata and are already in the safe projection (decision D13).
 * There is no operation on this interface that could return a password, a note body, or a
 * key, and there must never be one.
 */

export interface OrganisationSnapshot {
  readonly folders: readonly Folder[];
  readonly tags: readonly Tag[];
}

export const EMPTY_SNAPSHOT: OrganisationSnapshot = { folders: [], tags: [] };

/**
 * What happens to a deleted folder's contents.
 *
 * There is deliberately no "delete everything inside" option. Records go to the trash by
 * their own action, with undo; making a folder delete able to sweep records away silently
 * would be the one destructive path in the app with no recovery, and hard rule 6 says never
 * lose data.
 *
 * In **both** policies, subfolders are reparented rather than deleted. The choice the user
 * is being asked to make is only about the records.
 */
export type FolderDeletionPolicy =
  /** Records move up into the deleted folder's parent — or to no folder, if it was a root. */
  | 'reparent'
  /** Records become unfiled, wherever the folder sat. */
  | 'unfile-records';

export const FOLDER_DELETION_POLICIES: readonly FolderDeletionPolicy[] = [
  'reparent',
  'unfile-records',
];

export interface FolderDeletionOutcome {
  readonly recordsMoved: number;
  readonly subfoldersMoved: number;
  /** Where they went. `null` is the top level / no folder. */
  readonly movedTo: string | null;
}

export interface FolderDeletionResult {
  readonly snapshot: OrganisationSnapshot;
  readonly outcome: FolderDeletionOutcome;
}

export interface OrganisationGateway {
  /** Folders and tags as the vault currently holds them. */
  load(): Promise<OrganisationSnapshot>;

  createFolder(name: string, parentId: string | null): Promise<OrganisationSnapshot>;
  renameFolder(folderId: string, name: string): Promise<OrganisationSnapshot>;
  /** `parentId: null` is the top level. Refused if it would create a cycle. */
  moveFolder(folderId: string, parentId: string | null): Promise<OrganisationSnapshot>;
  deleteFolder(folderId: string, policy: FolderDeletionPolicy): Promise<FolderDeletionResult>;

  /** Files one record. `null` means no folder. */
  fileCredential(credentialId: string, folderId: string | null): Promise<void>;

  createTag(name: string, colour: TagColourToken): Promise<OrganisationSnapshot>;
  renameTag(tagId: string, name: string): Promise<OrganisationSnapshot>;
  setTagColour(tagId: string, colour: TagColourToken): Promise<OrganisationSnapshot>;
  /** Removes the tag from the vault and from every record carrying it. */
  deleteTag(tagId: string): Promise<OrganisationSnapshot>;
}

/**
 * The failure the UI must be able to render calmly.
 *
 * A folder operation can fail for reasons that are entirely normal — a name that is only
 * whitespace, a move that would nest a folder inside itself, a depth limit — and every one
 * of them is something to show next to the control, not something to crash on. The code is
 * carried so the UI can be specific without parsing a message.
 */
export class OrganisationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OrganisationError';
    this.code = code;
  }
}

/** The gateway exists but the vault cannot answer — no vault open, or the IPC is not wired. */
export const ORGANISATION_UNAVAILABLE = 'organisation/unavailable';
