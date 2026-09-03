// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SAVED_SEARCH_MAX } from '@shared/model/saved-search.js';
import { OrganisationError } from '../organisation/errors.js';
import { parseVaultDocument, VaultService } from './vault-service.js';

/**
 * Saved searches, from the operations through to the bytes on disk.
 *
 * The roadmap held this line open on one question — where they persist — and the answer is
 * what most of this file checks. They live on `VaultDocument`, inside the encrypted body, so
 * the properties that matter are that they **survive a save and reopen**, that they are
 * **inside the ciphertext** rather than beside it, and that a vault written before they
 * existed still opens.
 */

let dir: string;
let vaultPath: string;
let service: VaultService;

const PASSWORD = 'a-perfectly-reasonable-master-password';
const FAST_KDF = { memoryKib: 19_456, iterations: 2, parallelism: 1 } as const;

/** The parser takes the decompressed body bytes, not a string. */
function encode(document: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(document));
}

async function create(): Promise<void> {
  await service.createVault({ path: vaultPath, password: PASSWORD, kdf: FAST_KDF });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'keyhold-searches-'));
  vaultPath = join(dir, 'test.keep');
  service = new VaultService('test-device');
});

afterEach(async () => {
  service.lock();
  await rm(dir, { recursive: true, force: true });
});

describe('creating', () => {
  it('saves a query under a name and lists it back', async () => {
    await create();
    const saved = service.createSavedSearch({ name: 'Weak', query: 'is:weak' });

    expect(saved.name).toBe('Weak');
    expect(service.savedSearches().map((entry) => entry.id)).toEqual([saved.id]);
  });

  it('appends rather than inserting, so the list does not reshuffle', async () => {
    await create();
    service.createSavedSearch({ name: 'First', query: 'is:weak' });
    service.createSavedSearch({ name: 'Second', query: 'is:reused' });

    expect(service.savedSearches().map((entry) => entry.name)).toEqual(['First', 'Second']);
  });

  it('refuses a duplicate name, whatever its case', async () => {
    await create();
    service.createSavedSearch({ name: 'Banking', query: 'is:weak' });

    // Two rows reading "Banking" is a state with no way out: neither says which is which, and
    // renaming one means guessing which one you are looking at.
    expect(() => service.createSavedSearch({ name: 'banking', query: 'is:reused' })).toThrow(
      OrganisationError
    );
  });

  it('refuses an empty query', async () => {
    await create();
    expect(() => service.createSavedSearch({ name: 'Everything', query: '   ' })).toThrow(
      OrganisationError
    );
  });

  it('refuses past the cap', async () => {
    await create();
    for (let index = 0; index < SAVED_SEARCH_MAX; index += 1) {
      service.createSavedSearch({
        name: `Search ${String(index)}`,
        query: `tag:t${String(index)}`,
      });
    }

    expect(() => service.createSavedSearch({ name: 'One more', query: 'is:weak' })).toThrow(
      OrganisationError
    );
    expect(service.savedSearches()).toHaveLength(SAVED_SEARCH_MAX);
  });

  it('marks the vault dirty, so the change reaches the file', async () => {
    await create();
    await service.save();
    expect(service.hasUnsavedChanges).toBe(false);

    service.createSavedSearch({ name: 'Weak', query: 'is:weak' });
    // Without this the shortcut exists until the app closes and then does not, which is the
    // worst version of "did that save?".
    expect(service.hasUnsavedChanges).toBe(true);
  });
});

describe('editing and deleting', () => {
  it('renames, and stamps the modification time the merge tie-breaks on', async () => {
    await create();
    const saved = service.createSavedSearch({ name: 'Weak', query: 'is:weak' });

    const updated = service.updateSavedSearch(saved.id, { name: 'Needs attention' });
    expect(updated.name).toBe('Needs attention');
    expect(updated.query).toBe('is:weak');
    // An update that left `updatedAt` alone would make the *older* edit win a later merge.
    expect(updated.updatedAt).toBeGreaterThanOrEqual(saved.updatedAt);
  });

  it('replaces the query without touching the name', async () => {
    await create();
    const saved = service.createSavedSearch({ name: 'Weak', query: 'is:weak' });

    const updated = service.updateSavedSearch(saved.id, { query: 'is:reused' });
    expect(updated.name).toBe('Weak');
    expect(updated.query).toBe('is:reused');
  });

  it('refuses a rename onto another search’s name, but allows renaming to itself', async () => {
    await create();
    const first = service.createSavedSearch({ name: 'Weak', query: 'is:weak' });
    service.createSavedSearch({ name: 'Reused', query: 'is:reused' });

    expect(() => service.updateSavedSearch(first.id, { name: 'Reused' })).toThrow(
      OrganisationError
    );
    // The `exceptId` half of the uniqueness check: re-saving a search under the name it
    // already has must not be a collision with itself.
    expect(service.updateSavedSearch(first.id, { name: 'Weak' }).name).toBe('Weak');
  });

  it('refuses an unknown id rather than silently doing nothing', async () => {
    await create();
    expect(() => service.updateSavedSearch('nope', { name: 'x' })).toThrow(OrganisationError);
  });

  it('deletes, and reports whether there was anything to delete', async () => {
    await create();
    const saved = service.createSavedSearch({ name: 'Weak', query: 'is:weak' });

    expect(service.deleteSavedSearch(saved.id)).toBe(true);
    expect(service.savedSearches()).toEqual([]);
    expect(service.deleteSavedSearch(saved.id)).toBe(false);
  });
});

describe('persistence', () => {
  it('survives a save, a lock and a reopen', async () => {
    await create();
    service.createSavedSearch({ name: 'Weak', query: 'is:weak' });
    service.createSavedSearch({ name: 'Banking', query: 'folder:Finance has:totp' });
    await service.save();
    service.lock();

    await service.unlock(vaultPath, PASSWORD);
    expect(service.savedSearches().map((entry) => entry.name)).toEqual(['Weak', 'Banking']);
    expect(service.savedSearches()[1]?.query).toBe('folder:Finance has:totp');
  });

  it('opens a vault written before saved searches existed', () => {
    // The whole reason no `documentVersion` bump was needed: the field is read additively,
    // exactly like `folders` and `tags`. A vault from an older build must not fail to open.
    const older = parseVaultDocument(
      encode({ documentVersion: 1, records: [], folders: [], tags: [] })
    );
    expect(older.savedSearches).toEqual([]);
  });

  it('drops an unusable entry rather than refusing the whole vault', () => {
    // The opposite of how a malformed *record* is treated, and deliberately. A record is the
    // user's data; a saved search is a shortcut they can rebuild in ten seconds, and refusing
    // to open a vault over a malformed bookmark would be a self-inflicted lockout.
    const document = parseVaultDocument(
      encode({
        documentVersion: 1,
        records: [],
        folders: [],
        tags: [],
        savedSearches: [
          { id: 'good', name: 'Weak', query: 'is:weak', order: 0, updatedAt: 1 },
          { id: 'bad', name: '', query: '', order: 0, updatedAt: 1 },
          'not even an object',
        ],
      })
    );

    expect(document.savedSearches.map((entry) => entry.id)).toEqual(['good']);
  });

  it('caps what it reads from a file, however many the file declares', () => {
    const many = Array.from({ length: SAVED_SEARCH_MAX + 50 }, (_unused, index) => ({
      id: `s${String(index)}`,
      name: `Search ${String(index)}`,
      query: 'is:weak',
      order: index,
      updatedAt: 1,
    }));

    const document = parseVaultDocument(
      encode({ documentVersion: 1, records: [], folders: [], tags: [], savedSearches: many })
    );
    expect(document.savedSearches).toHaveLength(SAVED_SEARCH_MAX);
  });

  it('stores them inside the ciphertext, never beside it', async () => {
    await create();
    service.createSavedSearch({ name: 'My offshore accounts', query: 'folder:Offshore' });
    await service.save();

    // The header is plaintext by design. A name the user chose appearing in it would be a
    // disclosure readable without the master password, from a file they may be syncing
    // through somebody else's cloud storage.
    const { readVaultFile } = await import('./atomic-write.js');
    const bytes = await readVaultFile(vaultPath);
    const asText = Buffer.from(bytes).toString('latin1');

    expect(asText).not.toContain('My offshore accounts');
    expect(asText).not.toContain('folder:Offshore');
  });
});
