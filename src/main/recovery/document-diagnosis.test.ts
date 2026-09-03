// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  VERSIONED_FIELDS,
  type Credential,
  type CustomField,
  type SecurityQuestion,
} from '@shared/model/credential.js';
import {
  VAULT_DOCUMENT_VERSION,
  emptyVaultDocument,
  type Folder,
  type Tag,
  type VaultDocument,
} from '@shared/model/vault-document.js';
import { recordOf } from '../attachments/test-fixtures.js';
import { diagnoseDocument } from './document-diagnosis.js';
import { FIXTURE_NOW, chunkId } from './test-support.js';

/**
 * Integrity of a decrypted vault. Every state exercised here is reachable in the field — a
 * merge from two devices, a partial restore, an interrupted import, a hand-edited export, or
 * an older build with a bug — which is why none of them may be dismissed as impossible.
 *
 * The duplicate-field-id case gets the most attention because it is the one with teeth: the
 * reveal path addresses fields by id, so a duplicate hands back the *wrong secret*. That is a
 * correctness bug with a security shape, and a silent one.
 */

const DAY = 86_400_000;

function customField(id: string, overrides: Partial<CustomField> = {}): CustomField {
  return {
    id,
    label: 'Recovery code',
    type: 'text',
    value: 'v',
    hidden: false,
    order: 0,
    ...overrides,
  };
}

function question(id: string, overrides: Partial<SecurityQuestion> = {}): SecurityQuestion {
  return { id, question: 'First pet?', answer: 'a', ...overrides };
}

function withCustom(record: Credential, custom: readonly CustomField[]): Credential {
  return { ...record, fields: { ...record.fields, custom } };
}

function withQuestions(
  record: Credential,
  securityQuestions: readonly SecurityQuestion[]
): Credential {
  return { ...record, fields: { ...record.fields, securityQuestions } };
}

function documentWith(
  records: readonly Credential[],
  extra: Partial<Pick<VaultDocument, 'folders' | 'tags' | 'documentVersion'>> = {}
): VaultDocument {
  return { ...emptyVaultDocument(), records: [...records], ...extra };
}

function folder(id: string, parentId: string | null): Folder {
  return { id, name: `Folder ${id}`, parentId, order: 0 };
}

function tag(id: string, name: string): Tag {
  return { id, name, colour: 'tag-slate' };
}

const diagnose = (
  document: VaultDocument,
  now = FIXTURE_NOW
): ReturnType<typeof diagnoseDocument> => diagnoseDocument(document, { now });

const codes = (document: VaultDocument, now = FIXTURE_NOW): readonly string[] =>
  diagnose(document, now).issues.map((issue) => issue.code);

describe('a healthy document', () => {
  it('is reported healthy, with the counts it was asked about', () => {
    const document = documentWith([recordOf('r1'), recordOf('r2')]);
    const diagnosis = diagnose(document);

    expect(diagnosis.healthy).toBe(true);
    expect(diagnosis.issues).toEqual([]);
    expect(diagnosis.organisation).toEqual([]);
    expect(diagnosis.recordCount).toBe(2);
    expect(diagnosis.counts).toEqual({ critical: 0, warning: 0, info: 0 });
  });

  it('takes `now` as a parameter, so two runs over one document agree exactly', () => {
    const document = documentWith([recordOf('r1')]);
    expect(diagnose(document)).toEqual(diagnose(document));
    expect(diagnose(document).checkedAt).toBe(FIXTURE_NOW);
  });

  it('says the attachment reconciliation did not run when it was given no chunks', () => {
    const diagnosis = diagnose(documentWith([recordOf('r1')]));
    // `null` rather than an empty audit: "not checked" and "checked, nothing wrong" are
    // different answers and a report that conflates them is misleading.
    expect(diagnosis.attachments).toBeNull();
  });
});

describe('ids that collide', () => {
  it('finds two records sharing an id, and counts them', () => {
    const document = documentWith([recordOf('same'), recordOf('same'), recordOf('other')]);
    const issue = diagnose(document).issues.find((entry) => entry.code === 'duplicate-record-id');

    expect(issue?.subjectId).toBe('same');
    expect(issue?.detail).toBe('2 records share this id');
    expect(issue?.severity).toBe('critical');
  });

  it('finds two custom fields on ONE record sharing an id — the wrong-secret case', () => {
    // The reveal path asks for a field by id. With two answering to `dup`, revealing one
    // returns the other's value, and nothing about the UI says so.
    const record = withCustom(recordOf('r1'), [
      customField('dup', { label: 'Recovery code', value: 'first' }),
      customField('dup', { label: 'API token', value: 'second' }),
      customField('fine'),
    ]);
    const issue = diagnose(documentWith([record])).issues.find(
      (entry) => entry.code === 'duplicate-custom-field-id'
    );

    expect(issue?.severity).toBe('critical');
    expect(issue?.subject).toBe('field');
    expect(issue?.subjectId).toBe('dup');
    expect(issue?.credentialId).toBe('r1');
    // The labels are the user's own text and must not be quoted into a finding.
    expect(issue?.detail).not.toContain('Recovery code');
    expect(issue?.detail).not.toContain('API token');
  });

  it('finds duplicate security-question ids, which reveal the same way', () => {
    const record = withQuestions(recordOf('r1'), [question('q'), question('q'), question('ok')]);
    expect(codes(documentWith([record]))).toContain('duplicate-question-id');
  });

  it('reports every duplicate, not just the first', () => {
    const record = withCustom(recordOf('r1'), [
      customField('a'),
      customField('a'),
      customField('b'),
      customField('b'),
    ]);
    const found = diagnose(documentWith([record])).issues.filter(
      (issue) => issue.code === 'duplicate-custom-field-id'
    );
    // `assertValidCredential` stops at the first; a diagnosis must not, because a user
    // deciding whether to act needs the size of the problem.
    expect(found.map((issue) => issue.subjectId).sort()).toEqual(['a', 'b']);
  });

  it('does not confuse two records that each use the same field id separately', () => {
    // `field-1` on two different records is completely normal — ids are per record.
    const one = withCustom(recordOf('r1'), [customField('field-1')]);
    const two = withCustom(recordOf('r2'), [customField('field-1')]);
    expect(diagnose(documentWith([one, two])).issues).toEqual([]);
  });
});

describe('history that breaks its own rules', () => {
  const versioned = (
    record: Credential,
    versions: Credential['history']['versions']
  ): Credential => ({
    ...record,
    history: { enabled: true, maxVersions: null, versions },
  });

  it('catches version numbers that do not strictly ascend', () => {
    const record = versioned(recordOf('r1'), [
      {
        versionNumber: 2,
        savedAt: FIXTURE_NOW - DAY,
        changedFields: ['title'],
        snapshot: { title: 'a' },
        origin: { action: 'update' },
      },
      {
        versionNumber: 1,
        savedAt: FIXTURE_NOW,
        changedFields: ['title'],
        snapshot: { title: 'b' },
        origin: { action: 'update' },
      },
    ]);
    const issue = diagnose(documentWith([record])).issues.find(
      (entry) => entry.code === 'invalid-history'
    );

    expect(issue?.credentialId).toBe('r1');
    expect(issue?.detail).toContain('ascend');
  });

  it('catches a version snapshotting a field it does not list as changed', () => {
    const record = versioned(recordOf('r1'), [
      {
        versionNumber: 1,
        savedAt: FIXTURE_NOW - DAY,
        changedFields: ['title'],
        // `password` is snapshotted but not declared — a restore could write a value the
        // diff never showed the user.
        snapshot: { title: 'a', password: 'never-shown' },
        origin: { action: 'update' },
      },
    ]);
    const issue = diagnose(documentWith([record])).issues.find(
      (entry) => entry.code === 'invalid-history'
    );

    expect(issue).toBeDefined();
    // The invariant is named; the value behind it is not.
    expect(issue?.detail).not.toContain('never-shown');
  });

  it('never repeats an unknown snapshot key, which in a corrupt file could be anything', () => {
    const marker = 'SECRETNOTEFRAGMENT';
    const record = versioned(recordOf('r1'), [
      {
        versionNumber: 1,
        savedAt: FIXTURE_NOW - DAY,
        changedFields: ['title'],
        snapshot: {
          title: 'a',
          [marker]: 'x',
        } as Credential['history']['versions'][number]['snapshot'],
        origin: { action: 'update' },
      },
    ]);

    const diagnosis = diagnose(documentWith([record]));
    expect(diagnosis.issues.map((issue) => issue.code)).toContain('invalid-history');
    // In a corrupt document the offending key could be a fragment of a decrypted note. It is
    // never repeated — not scrubbed out of a borrowed message, which is what used to happen
    // here and what two different keys walked straight past. See `history-detail.ts`.
    expect(JSON.stringify(diagnosis)).not.toContain(marker);
  });
});

/**
 * The adversarial half of the history check.
 *
 * A snapshot key, a changed-field name and a version number all come out of the document, and
 * in the corrupt document this module exists to describe they can hold anything at all — the
 * module's own comment says the key "could be a fragment of a decrypted note". The report
 * these details end up in prints a sentence about carrying no secrets and is designed to be
 * pasted into a public issue tracker, so every one of these is a leak into a search engine.
 *
 * Each case below is a shape that walked past the previous defence, a quoted-run scrubber.
 */
describe('a snapshot key from a corrupt file, adversarially shaped', () => {
  type Version = Credential['history']['versions'][number];

  /** Distinctive, so a sweep over the whole diagnosis cannot miss it. */
  const NOTE_FRAGMENT = 'ZZNOTEFRAGMENTZZ';

  function documentWithVersions(versions: readonly Version[]): VaultDocument {
    return documentWith([
      {
        ...recordOf('r1'),
        history: { enabled: true, maxVersions: null, versions: [...versions] },
      },
    ]);
  }

  function documentWithSnapshotKey(key: string): VaultDocument {
    return documentWithVersions([
      {
        versionNumber: 1,
        savedAt: FIXTURE_NOW - DAY,
        changedFields: ['title'],
        snapshot: { title: 'a', [key]: 'x' },
        origin: { action: 'update' },
      },
    ]);
  }

  function historyDetailOf(document: VaultDocument): string {
    const issue = diagnose(document).issues.find((entry) => entry.code === 'invalid-history');
    expect(issue).toBeDefined();
    expect(issue?.detail).not.toBeNull();
    return issue?.detail ?? '';
  }

  /**
   * The structural assertion, not a keyword sweep.
   *
   * A detail may quote a field name, because those come from our own list. Anything else in
   * quotes came out of the document. An *odd* number of quote characters is the signature of
   * the truncation bypass: the closing quote was cut off, so no scanner can see a pair.
   */
  function expectOnlyKnownFieldNamesAreQuoted(detail: string): void {
    expect(detail.split('"').length % 2).toBe(1);
    for (const match of detail.matchAll(/"([^"]*)"/g)) {
      expect(VERSIONED_FIELDS).toContain(match[1] ?? '');
    }
  }

  const HOSTILE_KEYS: readonly { readonly name: string; readonly key: string }[] = [
    {
      // Bypass A: the length cap runs over the message and takes the closing quote with it.
      name: 'long enough that its own closing quote falls off the end',
      key: `${NOTE_FRAGMENT}-${'x'.repeat(200)}`,
    },
    {
      // Bypass B: the key supplies its own quotes, so the leak sits *between* two pairs.
      name: 'carrying a double quote of its own',
      key: `x" ${NOTE_FRAGMENT} "password`,
    },
    {
      name: 'carrying a newline, a backslash and a percent sign',
      key: `a\nb\\c%d-${NOTE_FRAGMENT}`,
    },
    { name: 'that is itself valid JSON', key: JSON.stringify({ note: NOTE_FRAGMENT }) },
    {
      // Nothing wrong with its *shape* — which is the point. An allow-list loosened into a
      // "looks like a field name" test would wave this straight through.
      name: 'that is a perfectly well-formed identifier and still not one of ours',
      key: NOTE_FRAGMENT,
    },
    { name: 'that is empty', key: '' },
    { name: 'that impersonates the redaction marker', key: '…' },
  ];

  for (const { name, key } of HOSTILE_KEYS) {
    it(`does not repeat a snapshot key ${name}`, () => {
      const diagnosis = diagnose(documentWithSnapshotKey(key));

      expect(diagnosis.issues.map((issue) => issue.code)).toContain('invalid-history');
      expect(JSON.stringify(diagnosis)).not.toContain(NOTE_FRAGMENT);
      expectOnlyKnownFieldNamesAreQuoted(historyDetailOf(documentWithSnapshotKey(key)));
    });
  }

  it('does not repeat a changed-field name that came out of the document', () => {
    // Same quoting, same message, same two bypasses — a scrubber that missed one missed both.
    const document = documentWithVersions([
      {
        versionNumber: 1,
        savedAt: FIXTURE_NOW - DAY,
        changedFields: [
          'title',
          `q" ${NOTE_FRAGMENT} "password`,
        ] as unknown as Version['changedFields'],
        snapshot: { title: 'a' },
        origin: { action: 'update' },
      },
    ]);

    expect(JSON.stringify(diagnose(document))).not.toContain(NOTE_FRAGMENT);
    expectOnlyKnownFieldNamesAreQuoted(historyDetailOf(document));
  });

  it('does not repeat a version number that is not a number at all', () => {
    // A third path the quoted-run scrubber could never have covered: the ascending-order
    // message interpolates the version number *unquoted*, and a corrupt document's version
    // number is only a number because the type says so.
    const document = documentWithVersions([
      {
        versionNumber: `${NOTE_FRAGMENT}-not-a-number` as unknown as number,
        savedAt: FIXTURE_NOW - DAY,
        changedFields: ['title'],
        snapshot: { title: 'a' },
        origin: { action: 'update' },
      },
    ]);

    expect(JSON.stringify(diagnose(document))).not.toContain(NOTE_FRAGMENT);
  });

  it('still names the invariant that broke, so the finding is worth reading', () => {
    const detail = historyDetailOf(documentWithSnapshotKey(`${NOTE_FRAGMENT}-key`));
    expect(detail).toContain('snapshot');
  });

  it('names a snapshot key that IS one of our own field names, because that is safe', () => {
    // The allow-list is the whole defence: a key equal to one of our literals is one of our
    // literals, and telling the reader which field is the difference between a report they
    // can act on and one they cannot.
    const document = documentWithVersions([
      {
        versionNumber: 1,
        savedAt: FIXTURE_NOW - DAY,
        changedFields: ['title'],
        snapshot: { title: 'a', password: 'never-shown' },
        origin: { action: 'update' },
      },
    ]);

    const detail = historyDetailOf(document);
    expect(detail).toContain('"password"');
    expect(detail).not.toContain('never-shown');
  });
});

describe('clocks that are wrong', () => {
  it('flags a timestamp in the future and says how far ahead', () => {
    const record = recordOf('r1');
    const ahead: Credential = {
      ...record,
      meta: { ...record.meta, updatedAt: FIXTURE_NOW + 40 * DAY },
    };
    const issue = diagnose(documentWith([ahead])).issues.find(
      (entry) => entry.code === 'future-timestamp'
    );

    expect(issue?.detail).toContain('updatedAt');
    expect(issue?.detail).toContain('40 day(s) ahead');
  });

  it('does not flag an expiry date in the future, which is the point of an expiry date', () => {
    const record = recordOf('r1');
    const expiring: Credential = {
      ...record,
      meta: { ...record.meta, expiresAt: FIXTURE_NOW + 90 * DAY, rotationIntervalDays: 90 },
    };
    // A check that fires on normal data is noise, and noise is ignored.
    expect(codes(documentWith([expiring]))).not.toContain('future-timestamp');
  });

  it('flags a history entry saved in the future', () => {
    const record: Credential = {
      ...recordOf('r1'),
      history: {
        enabled: true,
        maxVersions: null,
        versions: [
          {
            versionNumber: 1,
            savedAt: FIXTURE_NOW + DAY,
            changedFields: ['title'],
            snapshot: { title: 'a' },
            origin: { action: 'update' },
          },
        ],
      },
    };
    const issue = diagnose(documentWith([record])).issues.find(
      (entry) => entry.code === 'future-timestamp'
    );
    expect(issue?.detail).toContain('history.savedAt');
  });

  it('flags a trashed-at in the future, which quietly breaks retention', () => {
    const record: Credential = { ...recordOf('r1'), trashedAt: FIXTURE_NOW + 10 * DAY };
    const issue = diagnose(documentWith([record])).issues.find(
      (entry) => entry.code === 'future-timestamp'
    );
    expect(issue?.detail).toContain('trashedAt');
  });
});

describe('the document envelope', () => {
  it('refuses to treat a newer document version as readable', () => {
    const document = documentWith([recordOf('r1')], {
      documentVersion: VAULT_DOCUMENT_VERSION + 1,
    });
    expect(codes(document)).toContain('document-version-unsupported');
  });

  it('accepts the current document version silently', () => {
    expect(codes(documentWith([recordOf('r1')]))).toEqual([]);
  });
});

describe('folders and tags, delegated rather than re-derived', () => {
  it('carries the organisation checker’s folder-cycle finding', () => {
    const document = documentWith([], { folders: [folder('a', 'b'), folder('b', 'a')] });
    const diagnosis = diagnose(document);

    expect(diagnosis.organisation.map((finding) => finding.kind)).toContain('folder-cycle');
    expect(diagnosis.healthy).toBe(false);
  });

  it('carries a record pointing at a folder that does not exist', () => {
    const record: Credential = { ...recordOf('r1'), folderId: 'ghost' };
    const kinds = diagnose(documentWith([record])).organisation.map((finding) => finding.kind);
    expect(kinds).toContain('record-missing-folder');
  });

  it('drops the colliding name from an organisation finding', () => {
    // `integrity.ts` puts the name in its own field so each caller can decide. A report
    // pasted into an issue tracker decides not to: a tag named after an employer or an ex
    // is not something to publish on the user's behalf.
    const document = documentWith([], {
      tags: [tag('t1', 'Ex-Employer'), tag('t2', 'ex-employer')],
    });
    const diagnosis = diagnose(document);

    expect(diagnosis.organisation.some((finding) => finding.kind === 'duplicate-tag-name')).toBe(
      true
    );
    expect(JSON.stringify(diagnosis)).not.toContain('Ex-Employer');
    for (const finding of diagnosis.organisation) {
      expect(Object.keys(finding)).not.toContain('name');
    }
  });

  it('gives every organisation finding a severity and empty arrays rather than gaps', () => {
    const document = documentWith([], { folders: [folder('a', 'missing')] });
    for (const finding of diagnose(document).organisation) {
      expect(['critical', 'warning', 'info']).toContain(finding.severity);
      expect(Array.isArray(finding.folderIds)).toBe(true);
      expect(Array.isArray(finding.recordIds)).toBe(true);
      expect(Array.isArray(finding.tagIds)).toBe(true);
    }
  });
});

describe('attachments, when the chunk list is supplied', () => {
  const withAttachment = (id: string, size: number): Credential => {
    const bytes = new Uint8Array(size).fill(7);
    return {
      ...recordOf('r1'),
      attachments: [
        {
          id,
          name: 'payslip.pdf',
          mime: 'application/pdf',
          size: bytes.length,
          sha256: 'f'.repeat(64),
          addedAt: FIXTURE_NOW,
        },
      ],
    };
  };

  it('finds metadata whose chunk is not in the file', () => {
    const diagnosis = diagnoseDocument(documentWith([withAttachment(chunkId('a'), 10)]), {
      now: FIXTURE_NOW,
      chunks: [],
    });

    expect(diagnosis.attachments?.issues.map((issue) => issue.code)).toContain('missing-chunk');
    expect(diagnosis.counts.warning).toBeGreaterThan(0);
  });

  it('finds a chunk nothing points at', () => {
    const diagnosis = diagnoseDocument(documentWith([recordOf('r1')]), {
      now: FIXTURE_NOW,
      chunks: [{ id: chunkId('b'), byteLength: 40 }],
    });

    expect(diagnosis.attachments?.issues.map((issue) => issue.code)).toContain(
      'unreferenced-chunk'
    );
  });

  it('finds metadata and chunk disagreeing about size', () => {
    const diagnosis = diagnoseDocument(documentWith([withAttachment(chunkId('c'), 10)]), {
      now: FIXTURE_NOW,
      chunks: [{ id: chunkId('c'), byteLength: 99 }],
    });

    expect(diagnosis.attachments?.issues.map((issue) => issue.code)).toContain('size-mismatch');
  });

  it('counts attachment findings into the severity totals, not just its own list', () => {
    const clean = diagnoseDocument(documentWith([recordOf('r1')]), {
      now: FIXTURE_NOW,
      chunks: [],
    });
    const dirty = diagnoseDocument(documentWith([withAttachment(chunkId('d'), 5)]), {
      now: FIXTURE_NOW,
      chunks: [],
    });

    expect(clean.healthy).toBe(true);
    expect(dirty.healthy).toBe(false);
  });
});

describe('nothing is repaired', () => {
  it('leaves the document exactly as it was handed over', () => {
    const record = withCustom(recordOf('r1'), [customField('dup'), customField('dup')]);
    const document = documentWith([record], { folders: [folder('a', 'b'), folder('b', 'a')] });
    const before = structuredClone(document);

    diagnose(document);

    // Corruption has causes — a crash, a bad merge, a failing disk, a bug — and every
    // repair destroys the evidence of which. This module reports; the caller chooses.
    expect(document).toEqual(before);
  });
});
