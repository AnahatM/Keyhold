// SPDX-License-Identifier: GPL-3.0-or-later
import { collectDescendantFolderIds } from '@shared/search/filter.js';
import type { Folder, Tag } from '@shared/model/vault-document.js';
import {
  OrganisationError,
  type FolderDeletionPolicy,
  type FolderDeletionResult,
  type OrganisationGateway,
  type OrganisationSnapshot,
} from './gateway.js';
import { resolveTagColour, type TagColourToken } from './tag-colours.js';

/**
 * An in-memory vault standing in for the main process.
 *
 * The real folder and tag operations live in `src/main/organisation/` and their IPC does not
 * exist yet, so this is what the sidebar's logic is developed and tested against. It is not
 * a stub that returns fixtures — it enforces the same rules the main process must enforce
 * (no cycles, no blank names, no unknown ids, contents reparented on delete), which makes it
 * a written specification of what the real implementation has to do as well as a test
 * double. When the IPC lands, the contract test that runs against this can be pointed at the
 * real thing.
 *
 * ## Ids are counted, never random
 *
 * `Math.random()` is banned outright in this codebase and a CSPRNG is not available in the
 * renderer by design. A counter is also simply better here: a fake whose ids change between
 * runs makes every failing assertion unreadable.
 */

let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

/** Resets the id counter, so a test file's ids do not depend on what ran before it. */
export function resetFakeGatewayIds(): void {
  sequence = 0;
}

export interface FakeVaultState {
  readonly folders: readonly Folder[];
  readonly tags: readonly Tag[];
  /** Which folder each record is filed in. Records not listed are unfiled. */
  readonly recordFolders: ReadonlyMap<string, string | null>;
  /** Which tags each record carries, so `deleteTag` can be observed to clean up. */
  readonly recordTags: ReadonlyMap<string, readonly string[]>;
}

export interface FakeGatewayOptions {
  readonly folders?: readonly Folder[];
  readonly tags?: readonly Tag[];
  readonly recordFolders?: ReadonlyMap<string, string | null>;
  readonly recordTags?: ReadonlyMap<string, readonly string[]>;
  /**
   * Makes every call reject with this code.
   *
   * The unhappy path is the one a UI most often gets wrong, and it is the hardest to reach
   * by hand — this is how the sidebar's error rendering gets exercised.
   */
  readonly failWith?: string;
}

function assertName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') {
    throw new OrganisationError('organisation/blank-name', 'A name cannot be empty.');
  }
  if (trimmed.includes('/')) {
    // The `/` is the folder-path separator in imports and exports; a name containing one
    // would round-trip as two folders. See `@shared/model/import.ts`.
    throw new OrganisationError('organisation/invalid-name', 'A name cannot contain “/”.');
  }
  return trimmed;
}

export class FakeOrganisationGateway implements OrganisationGateway {
  private folders: Folder[];
  private tags: Tag[];
  private readonly recordFolders: Map<string, string | null>;
  private readonly recordTags: Map<string, readonly string[]>;
  private readonly failWith: string | null;

  /** Every mutation that was applied, in order. Lets a test assert what the UI asked for. */
  readonly calls: string[] = [];

  constructor(options: FakeGatewayOptions = {}) {
    this.folders = [...(options.folders ?? [])];
    this.tags = [...(options.tags ?? [])];
    this.recordFolders = new Map(options.recordFolders ?? []);
    this.recordTags = new Map(options.recordTags ?? []);
    this.failWith = options.failWith ?? null;
  }

  state(): FakeVaultState {
    return {
      folders: [...this.folders],
      tags: [...this.tags],
      recordFolders: new Map(this.recordFolders),
      recordTags: new Map(this.recordTags),
    };
  }

  private guard(call: string): void {
    this.calls.push(call);
    if (this.failWith !== null) {
      throw new OrganisationError(this.failWith, 'The vault refused that change.');
    }
  }

  private snapshot(): OrganisationSnapshot {
    return { folders: [...this.folders], tags: [...this.tags] };
  }

  private requireFolder(folderId: string): Folder {
    const folder = this.folders.find((candidate) => candidate.id === folderId);
    if (folder === undefined) {
      throw new OrganisationError('organisation/no-such-folder', 'That folder no longer exists.');
    }
    return folder;
  }

  load(): Promise<OrganisationSnapshot> {
    this.guard('load');
    return Promise.resolve(this.snapshot());
  }

  createFolder(name: string, parentId: string | null): Promise<OrganisationSnapshot> {
    this.guard(`createFolder(${name},${String(parentId)})`);
    const clean = assertName(name);
    if (parentId !== null) this.requireFolder(parentId);

    const siblings = this.folders.filter((folder) => folder.parentId === parentId);
    this.folders = [
      ...this.folders,
      { id: nextId('folder'), name: clean, parentId, order: siblings.length },
    ];
    return Promise.resolve(this.snapshot());
  }

  renameFolder(folderId: string, name: string): Promise<OrganisationSnapshot> {
    this.guard(`renameFolder(${folderId},${name})`);
    const clean = assertName(name);
    this.requireFolder(folderId);
    this.folders = this.folders.map((folder) =>
      folder.id === folderId ? { ...folder, name: clean } : folder
    );
    return Promise.resolve(this.snapshot());
  }

  moveFolder(folderId: string, parentId: string | null): Promise<OrganisationSnapshot> {
    this.guard(`moveFolder(${folderId},${String(parentId)})`);
    this.requireFolder(folderId);

    if (parentId !== null) {
      this.requireFolder(parentId);
      // The rule the whole cycle guard exists to keep: a folder may not be moved inside
      // itself. `collectDescendantFolderIds` includes the folder itself, so this covers
      // both "into itself" and "into its own child".
      if (collectDescendantFolderIds(this.folders, folderId).has(parentId)) {
        throw new OrganisationError(
          'organisation/cycle',
          'A folder cannot be moved inside itself.'
        );
      }
    }

    const siblings = this.folders.filter(
      (folder) => folder.parentId === parentId && folder.id !== folderId
    );
    this.folders = this.folders.map((folder) =>
      folder.id === folderId ? { ...folder, parentId, order: siblings.length } : folder
    );
    return Promise.resolve(this.snapshot());
  }

  deleteFolder(folderId: string, policy: FolderDeletionPolicy): Promise<FolderDeletionResult> {
    this.guard(`deleteFolder(${folderId},${policy})`);
    const folder = this.requireFolder(folderId);
    const parentId = folder.parentId;

    // Subfolders are reparented under **both** policies. Deleting them would destroy
    // structure the user did not ask to lose, and orphaning them would be the silent
    // data-shaped bug the cycle guard already has to clean up after.
    let subfoldersMoved = 0;
    this.folders = this.folders
      .filter((candidate) => candidate.id !== folderId)
      .map((candidate) => {
        if (candidate.parentId !== folderId) return candidate;
        subfoldersMoved += 1;
        return { ...candidate, parentId };
      });

    const destination = policy === 'reparent' ? parentId : null;
    let recordsMoved = 0;
    for (const [recordId, current] of this.recordFolders) {
      if (current !== folderId) continue;
      this.recordFolders.set(recordId, destination);
      recordsMoved += 1;
    }

    return Promise.resolve({
      snapshot: this.snapshot(),
      outcome: { recordsMoved, subfoldersMoved, movedTo: destination },
    });
  }

  fileCredential(credentialId: string, folderId: string | null): Promise<void> {
    this.guard(`fileCredential(${credentialId},${String(folderId)})`);
    if (folderId !== null) this.requireFolder(folderId);
    this.recordFolders.set(credentialId, folderId);
    return Promise.resolve();
  }

  createTag(name: string, colour: TagColourToken): Promise<OrganisationSnapshot> {
    this.guard(`createTag(${name},${colour})`);
    const clean = assertName(name);
    this.tags = [
      ...this.tags,
      { id: nextId('tag'), name: clean, colour: resolveTagColour(colour) },
    ];
    return Promise.resolve(this.snapshot());
  }

  renameTag(tagId: string, name: string): Promise<OrganisationSnapshot> {
    this.guard(`renameTag(${tagId},${name})`);
    const clean = assertName(name);
    this.tags = this.tags.map((tag) => (tag.id === tagId ? { ...tag, name: clean } : tag));
    return Promise.resolve(this.snapshot());
  }

  setTagColour(tagId: string, colour: TagColourToken): Promise<OrganisationSnapshot> {
    this.guard(`setTagColour(${tagId},${colour})`);
    this.tags = this.tags.map((tag) =>
      tag.id === tagId ? { ...tag, colour: resolveTagColour(colour) } : tag
    );
    return Promise.resolve(this.snapshot());
  }

  deleteTag(tagId: string): Promise<OrganisationSnapshot> {
    this.guard(`deleteTag(${tagId})`);
    this.tags = this.tags.filter((tag) => tag.id !== tagId);
    for (const [recordId, tagIds] of this.recordTags) {
      this.recordTags.set(
        recordId,
        tagIds.filter((id) => id !== tagId)
      );
    }
    return Promise.resolve(this.snapshot());
  }
}
