// SPDX-License-Identifier: GPL-3.0-or-later
import type { IpcResult } from '@shared/ipc/api.js';
import {
  EMPTY_SNAPSHOT,
  OrganisationError,
  ORGANISATION_UNAVAILABLE,
  type FolderDeletionPolicy,
  type FolderDeletionResult,
  type OrganisationGateway,
  type OrganisationSnapshot,
} from './gateway.js';
import type { TagColourToken } from './tag-colours.js';

/**
 * Binding the sidebar to the real vault, **without depending on a bridge that does not
 * exist yet**.
 *
 * The main-process folder and tag operations are being written in parallel and their IPC is
 * not registered. Rather than import a `window.keyhold.organisation` that would not compile,
 * this reads the bridge at call time and checks its shape. Two consequences, both
 * deliberate:
 *
 *   - The sidebar mounts and works **today**. Smart views, the tag list and every read-only
 *     surface run off the projections the renderer already holds; the folder tree renders
 *     empty and the mutating controls report that the vault cannot answer yet, instead of
 *     the whole pane throwing.
 *   - It lights up on its own the moment the bridge appears. Nothing here needs editing when
 *     the channels land — only the `KeyholdApi` type, so that the cast below can be deleted.
 *
 * ## The channels this needs
 *
 * Naming follows the project convention `kh:<domain>:<action>`, and every one returns the
 * whole `{ folders, tags }` snapshot for the reason given in `gateway.ts`:
 *
 *   kh:organisation:list              → { folders, tags }
 *   kh:organisation:create-folder     (name, parentId)          → snapshot
 *   kh:organisation:rename-folder     (folderId, name)          → snapshot
 *   kh:organisation:move-folder       (folderId, parentId)      → snapshot
 *   kh:organisation:delete-folder     (folderId, policy)        → { snapshot, outcome }
 *   kh:organisation:create-tag        (name, colour)            → snapshot
 *   kh:organisation:rename-tag        (tagId, name)             → snapshot
 *   kh:organisation:set-tag-colour    (tagId, colour)           → snapshot
 *   kh:organisation:delete-tag        (tagId)                   → snapshot
 *
 * Filing a record needs no new channel: `kh:credentials:update` already accepts `folderId`.
 *
 * ## The renderer never validates on the vault's behalf
 *
 * Blank names, cycles and depth limits are checked here only to give immediate feedback. The
 * main process must check them again and is the only authority — a renderer is a semi-trusted
 * zone (decision D13) and a UI-side check is a courtesy, never a guarantee.
 */

interface OrganisationBridge {
  list: () => Promise<IpcResult<OrganisationSnapshot>>;
  createFolder: (name: string, parentId: string | null) => Promise<IpcResult<OrganisationSnapshot>>;
  renameFolder: (folderId: string, name: string) => Promise<IpcResult<OrganisationSnapshot>>;
  moveFolder: (
    folderId: string,
    parentId: string | null
  ) => Promise<IpcResult<OrganisationSnapshot>>;
  deleteFolder: (
    folderId: string,
    policy: FolderDeletionPolicy
  ) => Promise<IpcResult<FolderDeletionResult>>;
  createTag: (name: string, colour: string) => Promise<IpcResult<OrganisationSnapshot>>;
  renameTag: (tagId: string, name: string) => Promise<IpcResult<OrganisationSnapshot>>;
  setTagColour: (tagId: string, colour: string) => Promise<IpcResult<OrganisationSnapshot>>;
  deleteTag: (tagId: string) => Promise<IpcResult<OrganisationSnapshot>>;
}

const BRIDGE_METHODS = [
  'list',
  'createFolder',
  'renameFolder',
  'moveFolder',
  'deleteFolder',
  'createTag',
  'renameTag',
  'setTagColour',
  'deleteTag',
] as const;

/**
 * The bridge, or `null` if it is absent or incomplete.
 *
 * Every method is checked, not just the object's presence: a half-registered bridge would
 * otherwise fail at the first click with an unhelpful "is not a function", and a partial
 * surface is exactly what a mid-migration build looks like.
 */
function readBridge(): OrganisationBridge | null {
  const root: unknown = (globalThis as { keyhold?: unknown }).keyhold;
  if (typeof root !== 'object' || root === null) return null;

  const candidate: unknown = (root as Record<string, unknown>).organisation;
  if (typeof candidate !== 'object' || candidate === null) return null;

  const record = candidate as Record<string, unknown>;
  for (const method of BRIDGE_METHODS) {
    if (typeof record[method] !== 'function') return null;
  }
  return candidate as OrganisationBridge;
}

export function isOrganisationBridgeAvailable(): boolean {
  return readBridge() !== null;
}

function requireBridge(): OrganisationBridge {
  const bridge = readBridge();
  if (bridge === null) {
    throw new OrganisationError(
      ORGANISATION_UNAVAILABLE,
      'Folders and tags are not available in this build yet.'
    );
  }
  return bridge;
}

/** Turns an `IpcResult` failure into an `OrganisationError` the sidebar can render inline. */
function unwrapIpc<T>(result: IpcResult<T>): T {
  if (result.ok) return result.value;
  throw new OrganisationError(result.code, result.message);
}

/**
 * The real gateway.
 *
 * `load()` is the one method that degrades quietly: a vault with no organisation bridge has
 * no folders and no tags, which is exactly what an empty snapshot says. Every mutation
 * throws instead, because silently doing nothing when a user clicks "New folder" is worse
 * than an honest message.
 */
export function createIpcOrganisationGateway(): OrganisationGateway {
  return {
    async load(): Promise<OrganisationSnapshot> {
      const bridge = readBridge();
      if (bridge === null) return EMPTY_SNAPSHOT;
      return unwrapIpc(await bridge.list());
    },

    async createFolder(name: string, parentId: string | null): Promise<OrganisationSnapshot> {
      return unwrapIpc(await requireBridge().createFolder(name, parentId));
    },

    async renameFolder(folderId: string, name: string): Promise<OrganisationSnapshot> {
      return unwrapIpc(await requireBridge().renameFolder(folderId, name));
    },

    async moveFolder(folderId: string, parentId: string | null): Promise<OrganisationSnapshot> {
      return unwrapIpc(await requireBridge().moveFolder(folderId, parentId));
    },

    async deleteFolder(
      folderId: string,
      policy: FolderDeletionPolicy
    ): Promise<FolderDeletionResult> {
      return unwrapIpc(await requireBridge().deleteFolder(folderId, policy));
    },

    /**
     * Filing a record goes through the existing credential channel, not a new one.
     *
     * `kh:credentials:update` already accepts `folderId`, and routing through it means a
     * drag-to-file is versioned, origin-captured and undoable exactly like an edit made in
     * the editor. A second write path would be a second set of rules about what counts as a
     * change to a record.
     */
    async fileCredential(credentialId: string, folderId: string | null): Promise<void> {
      const result = await window.keyhold.credentials.update(credentialId, { folderId });
      const updated = unwrapIpc(result);
      // A no-op edit does not dirty the vault, so there is nothing to save — the same rule
      // `credential-store.ts` applies, for the same reason: saving anyway bumps the
      // generation counter on a file the user did not change.
      if (updated !== null && updated.changedFields.length > 0) {
        unwrapIpc(await window.keyhold.vault.save());
      }
    },

    async createTag(name: string, colour: TagColourToken): Promise<OrganisationSnapshot> {
      return unwrapIpc(await requireBridge().createTag(name, colour));
    },

    async renameTag(tagId: string, name: string): Promise<OrganisationSnapshot> {
      return unwrapIpc(await requireBridge().renameTag(tagId, name));
    },

    async setTagColour(tagId: string, colour: TagColourToken): Promise<OrganisationSnapshot> {
      return unwrapIpc(await requireBridge().setTagColour(tagId, colour));
    },

    async deleteTag(tagId: string): Promise<OrganisationSnapshot> {
      return unwrapIpc(await requireBridge().deleteTag(tagId));
    },
  };
}
