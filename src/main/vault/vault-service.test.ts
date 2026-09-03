// SPDX-License-Identifier: GPL-3.0-or-later
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Credential } from '@shared/model/credential.js';
import { emptyVaultDocument } from '@shared/model/vault-document.js';
import { VaultError } from '../crypto/errors.js';
import { readVaultFile } from './atomic-write.js';
import { readPreamble } from '../format/container.js';
import { newKdfParams } from '../crypto/kdf.js';
import { bodyDigest, newHeader, parseHeader, serialiseHeader } from '../format/header.js';
import { parseVaultDocument, serialiseVaultDocument, VaultService } from './vault-service.js';

/**
 * Vault lifecycle.
 *
 * The two properties that matter most here are not "can it save and load" but:
 *
 *  - **locking actually locks** — the key is destroyed, the document is gone, and every
 *    outstanding secret grant is revoked. A lock that only changes a UI flag is a lie.
 *  - **nothing that answers the renderer ever returns secret material**, no matter how it
 *    is asked.
 */

let dir: string;
let vaultPath: string;
let service: VaultService;

const PASSWORD = 'a-perfectly-reasonable-master-password';

/**
 * The OWASP floor — the weakest cost the validator accepts.
 *
 * Argon2 is slow by design, and these tests exercise the vault lifecycle, not the KDF's
 * strength. The strength of the defaults is tested directly in `crypto.test.ts`.
 */
const FAST_KDF = { memoryKib: 19_456, iterations: 2, parallelism: 1 } as const;

const create = async (): Promise<void> => {
  await service.createVault({ path: vaultPath, password: PASSWORD, kdf: FAST_KDF });
};

function record(id: string, overrides: Partial<Credential> = {}): Credential {
  return {
    id,
    type: 'login',
    title: `Record ${id}`,
    favorite: false,
    folderId: null,
    tags: [],
    icon: { kind: 'auto' },
    fields: {
      username: `user-${id}`,
      email: `${id}@example.com`,
      password: `password-for-${id}`,
      urls: [`https://${id}.example.com`],
      securityQuestions: [{ id: `q-${id}`, question: 'Pet name?', answer: `answer-for-${id}` }],
      notes: `notes-for-${id}`,
      custom: [
        {
          id: `c-${id}`,
          label: 'API key',
          type: 'password',
          value: `apikey-for-${id}`,
          hidden: false,
          order: 0,
        },
      ],
    },
    attachments: [],
    meta: {
      createdAt: 1,
      updatedAt: 1,
      passwordUpdatedAt: 1,
      lastUsedAt: null,
      useCount: 0,
      expiresAt: null,
      rotationIntervalDays: null,
      createdOrigin: { action: 'create' as const },
    },
    history: { enabled: true, maxVersions: 10, versions: [] },
    trashedAt: null,
    ...overrides,
  };
}

async function withRecords(...records: Credential[]): Promise<void> {
  service.replaceDocument({ ...emptyVaultDocument(), records });
  await service.save();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'keyhold-vault-'));
  vaultPath = join(dir, 'test.keep');
  service = new VaultService('test-device');
});

afterEach(async () => {
  service.lock();
  await rm(dir, { recursive: true, force: true });
});

describe('creating and opening', () => {
  it('creates a vault, writes it, and leaves it unlocked', async () => {
    const summary = await service.createVault({
      path: vaultPath,
      password: PASSWORD,
      kdf: FAST_KDF,
    });

    expect(service.state).toBe('unlocked');
    expect(summary.recordCount).toBe(0);
    expect(summary.displayName).toBe('test');
    expect((await readVaultFile(vaultPath)).length).toBeGreaterThan(0);
  });

  it('round-trips records through a save and a fresh unlock', async () => {
    await create();
    await withRecords(record('a'), record('b'));

    const reopened = new VaultService('test-device');
    const summary = await reopened.unlock(vaultPath, PASSWORD);

    expect(summary.recordCount).toBe(2);
    expect(reopened.listProjections().map((p) => p.id)).toEqual(['a', 'b']);
    reopened.lock();
  });

  it('rejects the wrong password with a recoverable error', async () => {
    await create();
    service.lock();

    const error = await service.unlock(vaultPath, 'wrong').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).code).toBe('WRONG_PASSWORD');
    expect((error as VaultError).isRecoverable).toBe(true);
  });

  it('leaves nothing unlocked after a failed unlock', async () => {
    await create();
    service.lock();
    await service.unlock(vaultPath, 'wrong').catch(() => undefined);
    expect(service.state).toBe('closed');
  });

  it('reports what it can without the password', async () => {
    await create();
    const info = await VaultService.inspect(vaultPath);

    expect(info.vaultId).toMatch(/^[0-9a-f-]{36}$/);
    expect(info.kdfMemoryKib).toBeGreaterThan(0);
    expect(info.hasOrphanedTemp).toBe(false);
    // The unlock screen needs the cost to warn about a slow open, and nothing else.
    expect(info).not.toHaveProperty('records');
  });

  it('increments the generation counter on every save', async () => {
    await create();
    const first = service.summary().generation;
    await service.save();
    expect(service.summary().generation).toBe(first + 1);
  });
});

describe('locking really locks', () => {
  it('drops the document and refuses every read afterwards', async () => {
    await create();
    await withRecords(record('a'));

    service.lock();

    expect(service.state).toBe('closed');
    expect(() => service.listProjections()).toThrow(/No vault is open/);
    expect(() => service.summary()).toThrow(/No vault is open/);
    expect(() => service.deepSearch('anything')).toThrow(/No vault is open/);
    expect(() => service.revealSecret({ kind: 'password', credentialId: 'a' })).toThrow(
      /No vault is open/
    );
  });

  it('revokes every outstanding secret grant', async () => {
    await create();
    await withRecords(record('a'));

    service.revealSecret({ kind: 'password', credentialId: 'a' });
    expect(service.broker.activeGrants()).toHaveLength(1);

    service.lock();
    expect(service.broker.activeGrants()).toHaveLength(0);
  });

  it('is idempotent, so quit handlers cannot fail by double-locking', async () => {
    await create();
    service.lock();
    expect(() => {
      service.lock();
      service.lock();
    }).not.toThrow();
  });

  it('does not save — an unattended auto-lock must never commit a half-finished edit', async () => {
    await create();
    const before = service.summary().generation;

    service.replaceDocument({ ...emptyVaultDocument(), records: [record('unsaved')] });
    service.lock();

    const reopened = new VaultService('test-device');
    await reopened.unlock(vaultPath, PASSWORD);
    expect(reopened.summary().generation).toBe(before);
    expect(reopened.listProjections()).toHaveLength(0);
    reopened.lock();
  });
});

describe('reads never return secret material', () => {
  beforeEach(async () => {
    await create();
    await withRecords(record('a'), record('b'));
  });

  it('listProjections carries no password, note, answer or secret custom value', () => {
    const serialised = JSON.stringify(service.listProjections());
    expect(serialised).not.toContain('password-for-a');
    expect(serialised).not.toContain('notes-for-a');
    expect(serialised).not.toContain('answer-for-a');
    expect(serialised).not.toContain('apikey-for-a');
  });

  it('getProjection carries none either', () => {
    expect(JSON.stringify(service.getProjection('a'))).not.toContain('password-for-a');
  });

  it('summary carries none either', () => {
    expect(JSON.stringify(service.summary())).not.toContain('password-for-a');
  });

  it('hides trashed records by default and shows them on request', async () => {
    await withRecords(record('a'), record('b', { trashedAt: Date.now() }));

    expect(service.listProjections().map((p) => p.id)).toEqual(['a']);
    expect(service.listProjections({ includeTrashed: true }).map((p) => p.id)).toEqual(['a', 'b']);
    expect(service.summary().trashedCount).toBe(1);
  });
});

describe('revealing one secret at a time', () => {
  beforeEach(async () => {
    await create();
    await withRecords(record('a'));
  });

  it('returns each kind of secret when asked specifically', () => {
    expect(service.revealSecret({ kind: 'password', credentialId: 'a' })).toBe('password-for-a');
    expect(service.revealSecret({ kind: 'notes', credentialId: 'a' })).toBe('notes-for-a');
    expect(
      service.revealSecret({ kind: 'security-answer', credentialId: 'a', questionId: 'q-a' })
    ).toBe('answer-for-a');
    expect(service.revealSecret({ kind: 'custom-value', credentialId: 'a', fieldId: 'c-a' })).toBe(
      'apikey-for-a'
    );
  });

  it('records a grant for each reveal, so the activity log has something to show', () => {
    service.revealSecret({ kind: 'password', credentialId: 'a' });
    service.revealSecret({ kind: 'notes', credentialId: 'a' });
    expect(service.broker.activeGrants()).toHaveLength(2);
  });

  it('returns null rather than throwing for something that does not exist', () => {
    // "Missing" and "forbidden" must look the same to the caller, or the error type
    // becomes a small enumeration oracle.
    expect(service.revealSecret({ kind: 'password', credentialId: 'nope' })).toBeNull();
    expect(
      service.revealSecret({ kind: 'security-answer', credentialId: 'a', questionId: 'nope' })
    ).toBeNull();
    expect(
      service.revealSecret({ kind: 'custom-value', credentialId: 'a', fieldId: 'nope' })
    ).toBeNull();
  });
});

describe('deep search', () => {
  beforeEach(async () => {
    await create();
    await withRecords(
      record('a', {
        fields: { ...record('a').fields, notes: 'the recovery phrase is aardvark' },
      }),
      record('b')
    );
  });

  it('finds matches inside notes, which the renderer cannot see', () => {
    expect(service.deepSearch('aardvark')).toEqual(['a']);
  });

  it('searches inside security answers', () => {
    expect(service.deepSearch('answer-for-b')).toEqual(['b']);
  });

  it('returns ids only — never the matching text', () => {
    const results = service.deepSearch('aardvark');
    expect(JSON.stringify(results)).not.toContain('aardvark');
    expect(JSON.stringify(results)).not.toContain('recovery phrase');
  });

  it('is case-insensitive and ignores an empty query', () => {
    expect(service.deepSearch('AARDVARK')).toEqual(['a']);
    expect(service.deepSearch('   ')).toEqual([]);
  });

  it('skips trashed records', async () => {
    await withRecords(
      record('a', {
        fields: { ...record('a').fields, notes: 'aardvark' },
        trashedAt: Date.now(),
      })
    );
    expect(service.deepSearch('aardvark')).toEqual([]);
  });
});

describe('document parsing', () => {
  it('rejects a document version newer than this build supports', () => {
    const body = new Uint8Array(
      Buffer.from(JSON.stringify({ documentVersion: 99, records: [] }), 'utf8')
    );
    expect(() => parseVaultDocument(body)).toThrow(/newer than the supported/);
  });

  it('rejects a body that is not JSON, or not an object', () => {
    expect(() => parseVaultDocument(new Uint8Array(Buffer.from('nope')))).toThrow(/not valid JSON/);
    expect(() => parseVaultDocument(new Uint8Array(Buffer.from('[]')))).toThrow(/not an object/);
  });

  it('fills in optional collections rather than failing on an older document', () => {
    const body = new Uint8Array(
      Buffer.from(JSON.stringify({ documentVersion: 1, records: [] }), 'utf8')
    );
    const document = parseVaultDocument(body);
    expect(document.folders).toEqual([]);
    expect(document.tags).toEqual([]);
    expect(document.settings.auditPrivacyLevel).toBe('device');
  });
});

/**
 * Saving while a save is in flight.
 *
 * An audit found `save()` was a read-modify-write across an `await`: it snapshotted the open
 * vault, awaited the file write, then reassigned `this.#open` from that stale snapshot with
 * `dirty: false`. Anything that changed during the write was reverted in memory *and* marked
 * as saved — so it would never be written again. The record simply disappeared on the next
 * refresh, with no error anywhere.
 *
 * Every mutator here is synchronous, so the only window is that `await`. These two tests
 * are the whole reason the save queue exists; deleting either of them makes the queue look
 * like unnecessary machinery.
 */
describe('saving while a save is in flight', () => {
  it('does not discard a change that lands during the write', async () => {
    await create();
    service.createCredential({ title: 'Before' });

    // Start a save and let it reach its `await` before mutating, so the change genuinely
    // lands *inside* the file write. Mutating synchronously after `save()` would not test
    // this at all — the queue defers the first save by a microtask, so such a change is
    // simply included in it.
    const saving = service.save();
    await new Promise<void>((resolve) => setImmediate(resolve));
    service.createCredential({ title: 'Landed mid-write' });
    await saving;

    const titles = service.listProjections().map((record) => record.title);
    expect(titles).toContain('Landed mid-write');

    // And it must still be marked unsaved, or nothing will ever write it.
    expect(service.hasUnsavedChanges).toBe(true);

    await service.save();
    service.lock();
    await service.unlock(vaultPath, PASSWORD);
    expect(service.listProjections().map((r) => r.title)).toContain('Landed mid-write');
  });

  it('serialises two overlapping saves rather than racing on one temp file', async () => {
    await create();
    service.createCredential({ title: 'A' });

    // Both writers would otherwise open the same `<vault>.keep.tmp`, so one truncates the
    // other's bytes and the loser's rename clobbers the winner or fails into the cleanup.
    const [first, second] = await Promise.all([service.save(), service.save()]);
    expect(second.generation).toBeGreaterThan(first.generation);

    service.lock();
    await service.unlock(vaultPath, PASSWORD);
    expect(service.listProjections()).toHaveLength(1);
  });
});

describe('the content hash in the header', () => {
  /**
   * Guard: the hash actually describes the body.
   *
   * Written after an injection that failed nothing — replacing `bodyDigest(body)` with a
   * digest of unrelated bytes broke no test, so the field could have been garbage and the
   * suite would have stayed green. Sync's whole "do these two files differ" decision reads
   * it, and a wrong answer there either skips a merge and loses an edit or runs one for
   * nothing.
   */
  it('matches a digest of the document that was saved', async () => {
    await create();
    service.createCredential({ title: 'Bank' });
    await service.save();

    // `readPreamble` reads the header without a key, which is the same route sync takes and
    // the reason the header is plaintext at all. The body is re-derived from the document
    // the service holds rather than decrypted, so this asserts the writer's own arithmetic
    // rather than re-testing the container.
    const { header } = readPreamble(await readVaultFile(vaultPath));

    expect(header.contentHash).toBe(bodyDigest(serialiseVaultDocument(service.documentUnsafe())));
  });

  it('is omitted from the bytes entirely when absent, not written as null', () => {
    // The compatibility claim, asserted rather than reasoned.
    //
    // The header **is** the AAD, so its exact bytes are what the tag covers, and a vault
    // written before this field existed has to keep serialising to the bytes it was sealed
    // with. A `"contentHash": null` would be different bytes and would break the tag on every
    // one of them — a required field here would have broken every existing vault silently,
    // at the moment of opening it.
    const header = newHeader({
      vaultId: 'v',
      deviceId: 'd',
      kdf: newKdfParams(),
      // Base64, because `parseHeader` validates the shape of these — the point of the
      // test is the presence of one field, not the plausibility of the others.
      wrappedDek: { nonce: 'AAAA', ciphertext: 'AAAA', tag: 'AAAA' },
      now: 1,
    });

    const text = Buffer.from(serialiseHeader(header)).toString('utf8');
    expect(text).not.toContain('contentHash');
    expect(parseHeader(serialiseHeader(header)).contentHash).toBeUndefined();
  });

  it('is unchanged by a save that changes nothing', () => {
    // The property the feature exists for. A file written twice with no edit between must
    // compare `identical`, or every cloud-client touch becomes a resolver prompt for a vault
    // nobody changed — which is how people learn to dismiss the prompt that matters.
    const body = new Uint8Array(Buffer.from('{"a":1}', 'utf8'));
    expect(bodyDigest(body)).toBe(bodyDigest(new Uint8Array(Buffer.from('{"a":1}', 'utf8'))));
  });

  it('changes when the body does', () => {
    const before = bodyDigest(new Uint8Array(Buffer.from('{"a":1}', 'utf8')));
    const after = bodyDigest(new Uint8Array(Buffer.from('{"a":2}', 'utf8')));
    expect(before).not.toBe(after);
  });
});

describe('reloading from disk after another device wrote the file', () => {
  /*
   * The response to what the watcher reports. There is no password prompt because there is
   * nothing to prove: the DEK belongs to the vault rather than to a session, so a second
   * `VaultService` unlocking the same file with the same password holds the same key and
   * writes a body this one can read.
   *
   * Fault injection performed:
   *  1. Deleting `if (open.dirty) throw unsavedChanges()` — fails "refuses while there are
   *     unsaved changes", and the record added in memory is silently gone.
   *  2. Deleting the `header.vaultId` comparison — fails "refuses a different vault at the
   *     same path"; the read then succeeds and this session holds somebody else's records.
   *  3. Deleting `this.#broker.revokeAll()` — fails "drops secret grants issued against the
   *     old document".
   */

  /** A second service over the same file, standing in for the other device. */
  const otherDevice = async (): Promise<VaultService> => {
    const other = new VaultService('other-device');
    await other.unlock(vaultPath, PASSWORD);
    return other;
  };

  it('picks up what the other device wrote, without a password', async () => {
    await create();
    await withRecords(record('rec-1', { title: 'Only mine' }));

    const other = await otherDevice();
    other.replaceDocument({
      ...emptyVaultDocument(),
      records: [record('rec-1', { title: 'Only mine' }), record('rec-2', { title: 'Theirs' })],
    });
    await other.save();
    other.lock();

    // Still the old story in memory, which is the whole situation.
    expect(service.documentUnsafe().records).toHaveLength(1);

    const summary = await service.reloadFromDisk();

    expect(summary.recordCount).toBe(2);
    expect(service.documentUnsafe().records.map((r) => r.title)).toEqual(['Only mine', 'Theirs']);
    // Freshly read, so nothing is owed to disk.
    expect(service.hasUnsavedChanges).toBe(false);
  });

  it('refuses while there are unsaved changes, rather than discarding them', async () => {
    await create();
    await withRecords(record('rec-1', { title: 'Saved' }));

    const other = await otherDevice();
    other.replaceDocument({
      ...emptyVaultDocument(),
      records: [record('rec-9', { title: 'Theirs' })],
    });
    await other.save();
    other.lock();

    // An edit that exists only in memory. A reload is a read that destroys: there is no undo
    // and no tombstone for a record that was never written.
    service.replaceDocument({
      ...emptyVaultDocument(),
      records: [record('rec-1', { title: 'Saved' }), record('rec-2', { title: 'Not saved yet' })],
    });
    expect(service.hasUnsavedChanges).toBe(true);

    const error = await service.reloadFromDisk().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).code).toBe('UNSAVED_CHANGES');
    // And the edit is still there — refusing has to mean keeping.
    expect(service.documentUnsafe().records.map((r) => r.title)).toContain('Not saved yet');
  });

  it('refuses a different vault at the same path', async () => {
    await create();
    await withRecords(record('rec-1'));
    service.lock();

    // Somebody else's vault, written over the path this session opened. Same password, so it
    // would decrypt — which is exactly why the id is what decides and not the key.
    const replacement = new VaultService('third-device');
    await replacement.createVault({ path: vaultPath, password: PASSWORD, kdf: FAST_KDF });
    replacement.lock();

    // Reopen the *original* by unlocking, then swap the file underneath again.
    const original = join(dir, 'original.keep');
    await service.unlock(vaultPath, PASSWORD);
    const openedId = service.summary().vaultId;

    const another = new VaultService('fourth-device');
    await another.createVault({ path: original, password: PASSWORD, kdf: FAST_KDF });
    another.lock();
    await copyFile(original, vaultPath);

    const error = await service.reloadFromDisk().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).code).toBe('DIFFERENT_VAULT');
    // Unchanged: the session still holds the vault it opened.
    expect(service.summary().vaultId).toBe(openedId);
  });

  it('drops secret grants issued against the old document', async () => {
    await create();
    await withRecords(record('rec-1', { title: 'Mine' }));

    // A grant against the document as it stands. After a reload the same id means a different
    // record or none at all, and a grant that outlived its document is a reveal nobody asked
    // for.
    const ref = { kind: 'password', credentialId: 'rec-1' } as const;
    expect(service.revealSecret(ref)).not.toBeNull();
    expect(service.broker.isGranted(ref)).toBe(true);

    const other = await otherDevice();
    other.replaceDocument({
      ...emptyVaultDocument(),
      records: [record('rec-1', { title: 'Mine' })],
    });
    await other.save();
    other.lock();

    await service.reloadFromDisk();

    expect(service.broker.isGranted(ref)).toBe(false);
  });
});
