// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Credential } from '@shared/model/credential.js';
import { emptyVaultDocument } from '@shared/model/vault-document.js';
import { VaultError } from '../crypto/errors.js';
import { readVaultFile } from './atomic-write.js';
import { parseVaultDocument, VaultService } from './vault-service.js';

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
