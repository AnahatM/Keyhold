// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Credential, CustomField } from '@shared/model/credential.js';
import { DEFAULT_VAULT_SETTINGS, emptyVaultDocument } from '@shared/model/vault-document.js';
import { VaultError } from '../crypto/errors.js';
import {
  addCredential,
  applyPatch,
  buildCredential,
  duplicateCredential,
  normaliseTags,
  purgeExpiredTrash,
  recordUse,
  restoreCredential,
  sortCustomFields,
  trashCredential,
  type OpsContext,
} from './credential-ops.js';

/**
 * Credential operations.
 *
 * These are pure functions over a document, which is what makes them worth testing
 * directly: the rules about what a valid record is, what a change means, and what deletion
 * does are the part most likely to acquire a subtle bug, and none of them need a key or a
 * file to exercise.
 */

let nextId = 0;
const context = (now = 1_700_000_000_000): OpsContext => ({
  newId: () => `id-${++nextId}`,
  now: () => now,
  settings: DEFAULT_VAULT_SETTINGS,
});

const field = (overrides: Partial<CustomField> = {}): CustomField => ({
  id: 'f1',
  label: 'API key',
  type: 'password',
  value: 'secret',
  hidden: false,
  order: 0,
  ...overrides,
});

describe('building a record', () => {
  it('fills in sensible defaults', () => {
    const credential = buildCredential({ title: 'GitHub' }, context());

    expect(credential.type).toBe('login');
    expect(credential.trashedAt).toBeNull();
    expect(credential.meta.useCount).toBe(0);
    expect(credential.meta.createdAt).toBe(credential.meta.updatedAt);
    // Set on creation so a brand-new password is not immediately "old".
    expect(credential.meta.passwordUpdatedAt).toBe(credential.meta.createdAt);
  });

  it('takes the history default from vault settings, and records it on the record', () => {
    // Recorded rather than read from settings at display time: changing the default later
    // must not silently start or stop recording history for records that already exist.
    const enabled = buildCredential({ title: 'A' }, context());
    expect(enabled.history.enabled).toBe(DEFAULT_VAULT_SETTINGS.historyEnabledByDefault);

    const disabled = buildCredential(
      { title: 'B' },
      { ...context(), settings: { ...DEFAULT_VAULT_SETTINGS, historyEnabledByDefault: false } }
    );
    expect(disabled.history.enabled).toBe(false);
  });

  it('trims the title and drops empty URLs', () => {
    const credential = buildCredential(
      { title: '  GitHub  ', urls: ['https://github.com', '', '   '] },
      context()
    );
    expect(credential.title).toBe('GitHub');
    expect(credential.fields.urls).toEqual(['https://github.com']);
  });

  it('rejects a record that would bloat the vault', () => {
    expect(() => buildCredential({ title: 'x'.repeat(500) }, context())).toThrow(VaultError);
    expect(() =>
      buildCredential(
        { title: 'A', urls: Array.from({ length: 40 }, (_, i) => `https://${i}.com`) },
        context()
      )
    ).toThrow(VaultError);
  });

  it('rejects duplicate custom-field ids', () => {
    // Not cosmetic: the reveal path addresses fields BY ID, so a duplicate would silently
    // hand back the wrong value. A correctness bug with a security shape.
    expect(() =>
      buildCredential(
        { title: 'A', custom: [field({ id: 'same' }), field({ id: 'same', label: 'Other' })] },
        context()
      )
    ).toThrow(/share an id/);
  });

  it('rejects an unknown custom-field type', () => {
    expect(() =>
      buildCredential(
        { title: 'A', custom: [field({ type: 'quantum' as CustomField['type'] })] },
        context()
      )
    ).toThrow(/unknown custom field type/);
  });
});

describe('tags', () => {
  it('de-duplicates case-insensitively but keeps the first spelling', () => {
    expect(normaliseTags(['Work', 'work', 'WORK', 'personal'])).toEqual(['Work', 'personal']);
  });

  it('trims and drops empties', () => {
    expect(normaliseTags(['  dev  ', '', '   ', 'ops'])).toEqual(['dev', 'ops']);
  });
});

describe('custom field ordering', () => {
  it('sorts by order and renumbers contiguously', () => {
    const sorted = sortCustomFields([
      field({ id: 'c', order: 9 }),
      field({ id: 'a', order: 1 }),
      field({ id: 'b', order: 5 }),
    ]);

    expect(sorted.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    // Renumbered, so a later drag-and-drop does not have to reason about gaps.
    expect(sorted.map((f) => f.order)).toEqual([0, 1, 2]);
  });
});

describe('applying a patch', () => {
  const base = (): Credential => buildCredential({ title: 'GitHub', password: 'old' }, context());

  it('reports exactly which fields changed', () => {
    const { changedFields } = applyPatch(base(), { title: 'GitLab' }, context(2_000));
    expect(changedFields).toEqual(['title']);
  });

  it('returns an EMPTY change list for a no-op, so the caller can skip the save', () => {
    // Without this, opening a record and closing it would bump updatedAt, create a history
    // version, and dirty the vault — for no user-visible change at all.
    const credential = base();
    const result = applyPatch(credential, { title: credential.title }, context(2_000));

    expect(result.changedFields).toEqual([]);
    expect(result.credential).toBe(credential);
  });

  it('does not treat a whitespace-only title edit as a change', () => {
    const credential = base();
    expect(applyPatch(credential, { title: '  GitHub  ' }, context(2_000)).changedFields).toEqual(
      []
    );
  });

  it('moves passwordUpdatedAt only when the password actually changes', () => {
    // The health dashboard asks "how old is this PASSWORD". Renaming a record must not make
    // an ancient password look freshly rotated.
    const credential = base();
    const original = credential.meta.passwordUpdatedAt;

    const renamed = applyPatch(credential, { title: 'Renamed' }, context(9_000)).credential;
    expect(renamed.meta.passwordUpdatedAt).toBe(original);
    expect(renamed.meta.updatedAt).toBe(9_000);

    const rotated = applyPatch(
      credential,
      { fields: { password: 'new' } },
      context(9_000)
    ).credential;
    expect(rotated.meta.passwordUpdatedAt).toBe(9_000);
  });

  it('detects a change in every field it claims to track', () => {
    const credential = base();
    const cases: [string, Parameters<typeof applyPatch>[1]][] = [
      ['favorite', { favorite: true }],
      ['folderId', { folderId: 'folder-1' }],
      ['tags', { tags: ['work'] }],
      ['icon', { icon: { kind: 'emoji', value: '🔑' } }],
      ['username', { fields: { username: 'anahat' } }],
      ['email', { fields: { email: 'a@example.com' } }],
      ['password', { fields: { password: 'different' } }],
      ['urls', { fields: { urls: ['https://example.com'] } }],
      ['notes', { fields: { notes: 'a note' } }],
      ['custom', { fields: { custom: [field()] } }],
      [
        'securityQuestions',
        { fields: { securityQuestions: [{ id: 'q1', question: 'Pet?', answer: 'Rex' }] } },
      ],
      ['historyEnabled', { history: { enabled: !credential.history.enabled } }],
      ['expiresAt', { meta: { expiresAt: 123 } }],
      ['rotationIntervalDays', { meta: { rotationIntervalDays: 90 } }],
    ];

    for (const [name, patch] of cases) {
      const { changedFields } = applyPatch(credential, patch, context(2_000));
      expect(changedFields, `${name} should be reported as changed`).toContain(name);
    }
  });

  it('validates the result, not just the input', () => {
    expect(() => applyPatch(base(), { title: 'x'.repeat(500) }, context(2_000))).toThrow(
      VaultError
    );
  });
});

describe('duplicating', () => {
  it('regenerates every id, not just the record id', () => {
    // Sharing field ids with the original would make the two records' fields
    // indistinguishable to the reveal path, which addresses them by id.
    const original = buildCredential(
      {
        title: 'GitHub',
        custom: [field({ id: 'f1' })],
        securityQuestions: [{ id: 'q1', question: 'Pet?', answer: 'Rex' }],
      },
      context()
    );

    const copy = duplicateCredential(original, context());

    expect(copy.id).not.toBe(original.id);
    expect(copy.fields.custom[0]?.id).not.toBe('f1');
    expect(copy.fields.securityQuestions[0]?.id).not.toBe('q1');
  });

  it('keeps the values but marks the title as a copy', () => {
    const original = buildCredential({ title: 'GitHub', password: 'hunter2' }, context());
    const copy = duplicateCredential(original, context());

    expect(copy.title).toBe('GitHub (copy)');
    expect(copy.fields.password).toBe('hunter2');
  });

  it('does not carry over history — it belongs to the original record past', () => {
    const original = {
      ...buildCredential({ title: 'A' }, context()),
      history: {
        enabled: true,
        maxVersions: 10,
        versions: [
          {
            versionNumber: 1,
            savedAt: 1,
            changedFields: ['password' as const],
            snapshot: { password: 'old' },
            origin: { action: 'update' as const },
          },
        ],
      },
    };

    expect(duplicateCredential(original, context()).history.versions).toEqual([]);
  });

  it('does not carry over attachments', () => {
    // Duplicating a 20 MB PDF because someone wanted a second login is not what they asked
    // for, and the chunks belong to the original.
    const original = {
      ...buildCredential({ title: 'A' }, context()),
      attachments: [
        {
          id: 'a'.repeat(32),
          name: 'x.pdf',
          mime: 'application/pdf',
          size: 1,
          sha256: 'b',
          addedAt: 1,
        },
      ],
    };
    expect(duplicateCredential(original, context()).attachments).toEqual([]);
  });

  it('resets usage counters', () => {
    const used = recordUse(buildCredential({ title: 'A' }, context()), 5_000);
    const copy = duplicateCredential(used, context());

    expect(copy.meta.useCount).toBe(0);
    expect(copy.meta.lastUsedAt).toBeNull();
  });
});

describe('trash', () => {
  const withRecord = (credential: Credential) => addCredential(emptyVaultDocument(), credential);

  it('marks rather than removes, so the record can come back', () => {
    const credential = buildCredential({ title: 'A' }, context());
    const document = trashCredential(withRecord(credential), credential.id, 5_000);

    expect(document.records).toHaveLength(1);
    expect(document.records[0]?.trashedAt).toBe(5_000);
  });

  it('leaves a tombstone, which is what stops sync resurrecting a deletion', () => {
    // The load-bearing reason for a soft delete. A hard delete merged with a device that
    // still has the record faithfully brings it back.
    const credential = buildCredential({ title: 'A' }, context());
    const document = trashCredential(withRecord(credential), credential.id, 5_000);

    expect(document.records.some((record) => record.id === credential.id)).toBe(true);
  });

  it('restores', () => {
    const credential = buildCredential({ title: 'A' }, context());
    const trashed = trashCredential(withRecord(credential), credential.id, 5_000);
    const restored = restoreCredential(trashed, credential.id);

    expect(restored.records[0]?.trashedAt).toBeNull();
  });

  it('is idempotent in both directions', () => {
    const credential = buildCredential({ title: 'A' }, context());
    const document = withRecord(credential);

    const trashed = trashCredential(document, credential.id, 5_000);
    expect(trashCredential(trashed, credential.id, 9_000).records[0]?.trashedAt).toBe(5_000);
    expect(restoreCredential(document, credential.id)).toBe(document);
  });

  it('throws for an unknown id rather than silently doing nothing', () => {
    expect(() => trashCredential(emptyVaultDocument(), 'nope', 1)).toThrow(VaultError);
  });
});

describe('trash retention', () => {
  const documentWith = (trashedAt: number | null) => {
    const credential = { ...buildCredential({ title: 'A' }, context()), trashedAt };
    return addCredential(emptyVaultDocument(), credential);
  };

  const DAY = 24 * 60 * 60 * 1000;

  it('keeps a record inside the window', () => {
    const now = 100 * DAY;
    const document = documentWith(now - 29 * DAY);
    expect(purgeExpiredTrash(document, now).records).toHaveLength(1);
  });

  it('purges a record past the window', () => {
    const now = 100 * DAY;
    const document = documentWith(now - 31 * DAY);
    expect(purgeExpiredTrash(document, now).records).toHaveLength(0);
  });

  it('never touches a live record, however old', () => {
    const now = 10_000 * DAY;
    expect(purgeExpiredTrash(documentWith(null), now).records).toHaveLength(1);
  });

  it('keeps everything when retention is disabled', () => {
    const now = 100 * DAY;
    const base = documentWith(now - 3650 * DAY);
    const document = {
      ...base,
      settings: { ...base.settings, trashRetentionDays: null },
    };
    expect(purgeExpiredTrash(document, now).records).toHaveLength(1);
  });
});
