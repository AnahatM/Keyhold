// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DEFAULT_VAULT_SETTINGS, VAULT_DOCUMENT_VERSION } from '@shared/model/vault-document.js';
import { DuplicateIdError, mergeDocuments } from './merge-document.js';
import {
  DAY,
  MERGE_OPTIONS,
  NOW,
  attachment,
  doc,
  edited,
  folder,
  origin,
  paletteTag,
  record,
} from './test-fixtures.js';

/**
 * The engine's front door: two whole documents in, one document and a report out.
 *
 * The record-level rules are covered in `merge-record.test.ts`. What is tested here is the
 * layer above them — which records exist at all — and it is where the single most expensive
 * mistake in the whole engine lives.
 *
 * **Absence is not deletion.** A record in the ancestor and on one side only is *kept*, because
 * "the other device purged it" and "the other device's copy is incomplete" are indistinguishable
 * without a tombstone, and only one of those two readings can lose a password. The cost is
 * written down honestly: a genuine purge can come back once. The test for it is here, and so is
 * the test that a real tombstone is still honoured, because the two rules are only safe
 * together.
 */

const EMPTY = doc();

// ── The degenerate documents ─────────────────────────────────────────────────

describe('empty and one-sided documents', () => {
  it('merges two empty vaults into an empty vault', () => {
    const merged = mergeDocuments(null, EMPTY, EMPTY, MERGE_OPTIONS);
    expect(merged.document.records).toEqual([]);
    expect(merged.report.conflicts).toEqual([]);
    expect(merged.report.requiresResolution).toBe(false);
    expect(merged.report.mode).toBe('two-way');
  });

  it('takes everything from the other side when ours is empty', () => {
    const theirs = doc({ records: [record({ id: 'a' }), record({ id: 'b' })] });
    const merged = mergeDocuments(null, EMPTY, theirs, MERGE_OPTIONS);

    expect(merged.document.records.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(merged.report.conflicts).toEqual([]);
    expect(merged.report.notes.filter((note) => note.kind === 'record-added')).toHaveLength(2);
    expect(merged.report.counts).toMatchObject({ ours: 0, theirs: 2, merged: 2, added: 2 });
  });

  it('keeps everything of ours when the other side is empty', () => {
    const ours = doc({ records: [record({ id: 'a' })] });
    const merged = mergeDocuments(null, ours, EMPTY, MERGE_OPTIONS);
    expect(merged.document.records.map((entry) => entry.id)).toEqual(['a']);
    expect(merged.report.notes.map((note) => note.kind)).not.toContain('record-added');
  });

  it('reports three-way mode as soon as there is an ancestor, even an empty one', () => {
    expect(mergeDocuments(EMPTY, EMPTY, EMPTY, MERGE_OPTIONS).report.mode).toBe('three-way');
    expect(mergeDocuments(EMPTY, EMPTY, EMPTY, MERGE_OPTIONS).report.counts.base).toBe(0);
  });
});

// ── Absence, deletion and the difference between them ────────────────────────

describe('which records survive', () => {
  const gmail = record({ id: 'a', title: 'Gmail' });
  const bank = record({ id: 'b', title: 'Bank' });

  it('keeps a record the other side no longer has, and says it did', () => {
    const base = doc({ records: [gmail, bank] });
    const theirs = doc({ records: [gmail] });

    const merged = mergeDocuments(base, base, theirs, MERGE_OPTIONS);
    expect(merged.document.records.map((entry) => entry.id)).toEqual(['a', 'b']);
    const note = merged.report.notes.find((entry) => entry.kind === 'record-kept-unmatched');
    expect(note?.targetId).toBe('b');
  });

  it('keeps it in the other direction too', () => {
    const base = doc({ records: [gmail, bank] });
    const ours = doc({ records: [gmail] });

    const merged = mergeDocuments(base, ours, base, MERGE_OPTIONS);
    expect(merged.document.records.map((entry) => entry.id).sort()).toEqual(['a', 'b']);
  });

  it('drops a record both devices purged, because they agree', () => {
    const base = doc({ records: [gmail, bank] });
    const both = doc({ records: [gmail] });

    const merged = mergeDocuments(base, both, both, MERGE_OPTIONS);
    expect(merged.document.records.map((entry) => entry.id)).toEqual(['a']);
    expect(merged.report.notes.find((note) => note.kind === 'record-purged')?.targetId).toBe('b');
  });

  it('brings in a record only the other side has', () => {
    const base = doc({ records: [gmail] });
    const theirs = doc({ records: [gmail, bank] });

    const merged = mergeDocuments(base, base, theirs, MERGE_OPTIONS);
    expect(merged.document.records.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(merged.report.notes.find((note) => note.kind === 'record-added')?.targetId).toBe('b');
  });
});

describe('a tombstone is honoured at document level, in both directions', () => {
  const live = record({ id: 'a', title: 'Old account' });
  const dead = edited(live, { trashedAt: NOW - DAY });

  it('when we trashed it and they still hold it live', () => {
    const merged = mergeDocuments(
      doc({ records: [live] }),
      doc({ records: [dead] }),
      doc({ records: [live] }),
      MERGE_OPTIONS
    );
    expect(merged.document.records[0]?.trashedAt).toBe(NOW - DAY);
    expect(merged.report.counts.trashed).toBe(1);
  });

  it('when they trashed it and we still hold it live', () => {
    const merged = mergeDocuments(
      doc({ records: [live] }),
      doc({ records: [live] }),
      doc({ records: [dead] }),
      MERGE_OPTIONS
    );
    expect(merged.document.records[0]?.trashedAt).toBe(NOW - DAY);
  });

  it('with no ancestor at all, in both directions', () => {
    expect(
      mergeDocuments(null, doc({ records: [dead] }), doc({ records: [live] }), MERGE_OPTIONS)
        .document.records[0]?.trashedAt
    ).toBe(NOW - DAY);
    expect(
      mergeDocuments(null, doc({ records: [live] }), doc({ records: [dead] }), MERGE_OPTIONS)
        .document.records[0]?.trashedAt
    ).toBe(NOW - DAY);
  });

  it('and a trashed record is still a record: it is never dropped from the document', () => {
    const merged = mergeDocuments(
      null,
      doc({ records: [dead] }),
      doc({ records: [live] }),
      MERGE_OPTIONS
    );
    expect(merged.document.records).toHaveLength(1);
  });
});

// ── Independent creation ─────────────────────────────────────────────────────

describe('records created independently on both devices', () => {
  it('keeps both when the ids differ', () => {
    const base = doc();
    const merged = mergeDocuments(
      base,
      doc({ records: [record({ id: 'mine' })] }),
      doc({ records: [record({ id: 'yours' })] }),
      MERGE_OPTIONS
    );
    expect(merged.document.records.map((entry) => entry.id).sort()).toEqual(['mine', 'yours']);
    expect(merged.report.conflicts).toEqual([]);
  });

  it('merges two-way for that record alone when the ids collide', () => {
    // A re-imported export, most plausibly. The document merge is three-way; this record has
    // no ancestor inside it, and the report must say so rather than claiming a base it lacks.
    const merged = mergeDocuments(
      doc(),
      doc({ records: [record({ id: 'a', title: 'Mine' })] }),
      doc({ records: [record({ id: 'a', title: 'Theirs' })] }),
      MERGE_OPTIONS
    );
    const conflict = merged.report.conflicts.find((entry) => entry.field === 'title');
    expect(conflict?.base).toEqual({ kind: 'absent' });
    expect(merged.report.mode).toBe('three-way');
  });

  it('marks the base as unknown rather than absent when the whole merge is two-way', () => {
    const merged = mergeDocuments(
      null,
      doc({ records: [record({ id: 'a', title: 'Mine' })] }),
      doc({ records: [record({ id: 'a', title: 'Theirs' })] }),
      MERGE_OPTIONS
    );
    expect(merged.report.conflicts.every((conflict) => conflict.base === null)).toBe(true);
    expect(merged.report.mode).toBe('two-way');
  });
});

// ── Conflicts gate the write ─────────────────────────────────────────────────

describe('an unresolved conflict makes the document provisional', () => {
  const base = doc({ records: [record({ id: 'a', password: 'old' })] });
  const ours = doc({ records: [record({ id: 'a', password: 'mine' })] });
  const theirs = doc({ records: [record({ id: 'a', password: 'theirs' })] });

  it('sets requiresResolution and still returns a complete document', () => {
    const merged = mergeDocuments(base, ours, theirs, MERGE_OPTIONS);
    expect(merged.report.requiresResolution).toBe(true);
    expect(merged.document.records).toHaveLength(1);
    expect(merged.report.counts.conflicted).toBe(1);
  });

  it('clears once the resolution is folded into a second run', () => {
    const first = mergeDocuments(base, ours, theirs, MERGE_OPTIONS);
    const id = first.report.conflicts[0]?.id ?? '';
    const second = mergeDocuments(base, ours, theirs, {
      ...MERGE_OPTIONS,
      resolutions: { [id]: 'theirs' },
    });

    expect(second.report.requiresResolution).toBe(false);
    expect(second.document.records[0]?.fields.password).toBe('theirs');
    expect(second.report.conflicts[0]?.resolution).toBe('user');
  });

  it('does not block on a policy-resolved settings disagreement', () => {
    const merged = mergeDocuments(
      null,
      doc({ settings: { ...DEFAULT_VAULT_SETTINGS, passwordAgeWarningDays: 365 } }),
      doc({ settings: { ...DEFAULT_VAULT_SETTINGS, passwordAgeWarningDays: 90 } }),
      MERGE_OPTIONS
    );
    expect(merged.report.requiresResolution).toBe(false);
    expect(merged.document.settings.passwordAgeWarningDays).toBe(90);
  });
});

// ── Attachments ──────────────────────────────────────────────────────────────

describe('attachment chunks the caller must copy across', () => {
  it('names every chunk the merged document references and our container lacks', () => {
    const ours = doc({ records: [record({ id: 'a', attachments: [attachment('aaaa')] })] });
    const theirs = doc({
      records: [
        record({ id: 'a', attachments: [attachment('aaaa'), attachment('bbbb')] }),
        record({ id: 'b', attachments: [attachment('cccc')] }),
      ],
    });

    const merged = mergeDocuments(null, ours, theirs, MERGE_OPTIONS);
    expect(merged.report.attachmentsToImport).toEqual(['bbbb', 'cccc']);
  });

  it('does not ask for a chunk some other record of ours already holds', () => {
    const held = attachment('shared');
    const ours = doc({ records: [record({ id: 'a', attachments: [held] })] });
    const theirs = doc({
      records: [record({ id: 'a' }), record({ id: 'b', attachments: [held] })],
    });

    const merged = mergeDocuments(null, ours, theirs, MERGE_OPTIONS);
    expect(merged.report.attachmentsToImport).toEqual([]);
  });
});

// ── The folder tree survives the merge ───────────────────────────────────────

describe('the folder tree after a merge', () => {
  const work = folder('f1', 'Work');

  it('resurrects a folder one side deleted while the other was still filing into it', () => {
    const base = doc({ records: [record({ id: 'a' })], folders: [work] });
    const ours = doc({ records: [record({ id: 'a' })], folders: [] });
    const theirs = doc({ records: [record({ id: 'a', folderId: 'f1' })], folders: [work] });

    const merged = mergeDocuments(base, ours, theirs, MERGE_OPTIONS);
    expect(merged.document.folders.map((entry) => entry.id)).toEqual(['f1']);
    expect(merged.document.records[0]?.folderId).toBe('f1');
    expect(merged.report.notes.map((note) => note.kind)).toContain('folder-resurrected');
  });

  it('unfiles a record whose folder exists in neither document', () => {
    const merged = mergeDocuments(
      null,
      doc({ records: [record({ id: 'a', folderId: 'ghost' })] }),
      doc({ records: [record({ id: 'a', folderId: 'ghost' })] }),
      MERGE_OPTIONS
    );
    expect(merged.document.records[0]?.folderId).toBeNull();
    expect(merged.report.notes.map((note) => note.kind)).toContain('record-unfiled');
  });

  it('carries the tag palette across', () => {
    const merged = mergeDocuments(
      null,
      doc({ tags: [paletteTag('t1', 'work')] }),
      doc({ tags: [paletteTag('t2', 'email')] }),
      MERGE_OPTIONS
    );
    expect(merged.document.tags.map((entry) => entry.id).sort()).toEqual(['t1', 't2']);
  });
});

// ── Refusals ─────────────────────────────────────────────────────────────────

describe('what the engine refuses to do', () => {
  it('refuses to merge documents written against different schema versions', () => {
    const older = { ...EMPTY, documentVersion: VAULT_DOCUMENT_VERSION - 1 };
    expect(() => mergeDocuments(null, EMPTY, older, MERGE_OPTIONS)).toThrow(
      /different document versions/
    );
  });

  it('refuses when only the ancestor is on a different version', () => {
    const older = { ...EMPTY, documentVersion: VAULT_DOCUMENT_VERSION - 1 };
    expect(() => mergeDocuments(older, EMPTY, EMPTY, MERGE_OPTIONS)).toThrow(
      /different document versions/
    );
  });
});

/**
 * Two entries under one id is corruption, and this engine refuses rather than picking a
 * survivor. The reasoning is on `assertUniqueIds`; what the tests below pin down is that the
 * refusal happens *before* anything reads the document, because both of the things it prevents
 * were silent.
 *
 * Without the guard, a document holding `a` twice merged to a document holding `a` once — the
 * `Map` in `indexRecords` keeps the last, so the earlier record and its password were gone with
 * no note, no conflict and nothing in the report naming it. And `orderIds` was handed
 * `['a', 'a']` against a surviving set of `{a, b}`, matched it on length, and returned record
 * `a` twice while dropping `b` — a healthy, unrelated credential that had merged cleanly from
 * the other side. Neither threw. Both are hard rule 6, in its worst form.
 */
describe('duplicate ids are refused, not resolved', () => {
  /**
   * The refusal itself, for the tests that assert something *about* it.
   *
   * A bare `try`/`catch` around a merge is a trap here: if the guard stops running, the merge
   * returns normally, `expect.unreachable` throws, and the `catch` swallows it into assertions
   * that were written for a `DuplicateIdError` and may quietly pass against something else.
   * Narrowing here means a missing refusal fails every test below rather than some of them.
   */
  const refusalFrom = (merge: () => unknown): DuplicateIdError => {
    let thrown: unknown;
    try {
      merge();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DuplicateIdError);
    return thrown as DuplicateIdError;
  };

  it('refuses when two of our records share an id, rather than keeping the last one', () => {
    const first = record({ id: 'a', title: 'Gmail', password: 'the one that matters' });
    const second = record({ id: 'a', title: 'Gmail (dup)', password: 'the other one' });
    expect(() =>
      mergeDocuments(null, doc({ records: [first, second] }), EMPTY, MERGE_OPTIONS)
    ).toThrow(/records sharing an id/);
  });

  it('refuses rather than dropping an unrelated record the duplicate would displace', () => {
    const ours = doc({ records: [record({ id: 'a' }), record({ id: 'a' })] });
    const theirs = doc({ records: [record({ id: 'b', title: 'Bank' })] });
    expect(() => mergeDocuments(null, ours, theirs, MERGE_OPTIONS)).toThrow(DuplicateIdError);
  });

  it('refuses a duplicate on their side and on the ancestor too', () => {
    const dup = doc({ records: [record({ id: 'a' }), record({ id: 'a' })] });
    expect(() => mergeDocuments(null, EMPTY, dup, MERGE_OPTIONS)).toThrow(DuplicateIdError);
    expect(() => mergeDocuments(dup, EMPTY, EMPTY, MERGE_OPTIONS)).toThrow(DuplicateIdError);
  });

  it('refuses duplicate folder and tag ids as well as records', () => {
    const folders = doc({ folders: [folder('f1', 'Work'), folder('f1', 'Personal')] });
    const tags = doc({ tags: [paletteTag('t1'), paletteTag('t1', 'other')] });
    expect(() => mergeDocuments(null, folders, EMPTY, MERGE_OPTIONS)).toThrow(/folders sharing/);
    expect(() => mergeDocuments(null, tags, EMPTY, MERGE_OPTIONS)).toThrow(/tags sharing/);
  });

  it('names the side, the list and every offending id, so a caller can say what to repair', () => {
    const ours = doc({
      records: [record({ id: 'b' }), record({ id: 'a' }), record({ id: 'b' }), record({ id: 'a' })],
    });
    const refusal = refusalFrom(() => mergeDocuments(null, ours, EMPTY, MERGE_OPTIONS));
    expect(refusal.side).toBe('ours');
    expect(refusal.entity).toBe('record');
    expect(refusal.ids).toEqual(['a', 'b']);
  });

  it('reports our own vault first, because that is the one the user can repair', () => {
    const dup = doc({ records: [record({ id: 'a' }), record({ id: 'a' })] });
    expect(refusalFrom(() => mergeDocuments(dup, dup, dup, MERGE_OPTIONS)).side).toBe('ours');
  });

  it('reports the incoming vault when ours is clean', () => {
    const dup = doc({ records: [record({ id: 'a' }), record({ id: 'a' })] });
    expect(refusalFrom(() => mergeDocuments(null, EMPTY, dup, MERGE_OPTIONS)).side).toBe('theirs');
    expect(refusalFrom(() => mergeDocuments(dup, EMPTY, EMPTY, MERGE_OPTIONS)).side).toBe('base');
  });

  it('says nothing about a record beyond its id', () => {
    // The refusal travels to a UI and may reach a log. Ids already cross that boundary as
    // `MergeNote.targetId`; a title, a username or a password must not.
    const secret = 'correct horse battery staple';
    const ours = doc({
      records: [
        record({ id: 'a', title: 'Gmail', username: 'me@example.com', password: secret }),
        record({ id: 'a', title: 'Gmail', username: 'me@example.com', password: secret }),
      ],
    });
    const { message } = refusalFrom(() => mergeDocuments(null, ours, EMPTY, MERGE_OPTIONS));
    expect(message).toContain('(a)');
    for (const leak of [secret, 'Gmail', 'me@example.com']) {
      expect(message).not.toContain(leak);
    }
  });

  it('still merges a document whose ids are merely repeated across the two sides', () => {
    // The guard is per document. The same id on both sides is the ordinary case — it is what
    // a merge *is* — and a guard that confused the two would refuse every real merge.
    const shared = record({ id: 'a', title: 'Gmail' });
    const merged = mergeDocuments(
      doc({ records: [shared] }),
      doc({ records: [shared] }),
      doc({ records: [edited(shared, { title: 'Google' })] }),
      MERGE_OPTIONS
    );
    expect(merged.document.records.map((entry) => entry.id)).toEqual(['a']);
  });
});

// ── The report is a description of what happened ─────────────────────────────

describe('the report', () => {
  it('uses the clock it was handed and no other', () => {
    const merged = mergeDocuments(null, EMPTY, EMPTY, { now: 42 });
    expect(merged.report.generatedAt).toBe(42);
  });

  it('counts added, updated and unchanged relative to our side', () => {
    const shared = record({ id: 'a', title: 'Gmail' });
    const ours = doc({ records: [shared, record({ id: 'b' })] });
    const theirs = doc({
      records: [edited(shared, { title: 'Google' }), record({ id: 'b' }), record({ id: 'c' })],
    });

    const merged = mergeDocuments(doc({ records: [shared, record({ id: 'b' })] }), ours, theirs, {
      ...MERGE_OPTIONS,
    });
    expect(merged.report.counts).toMatchObject({
      ours: 2,
      theirs: 3,
      merged: 3,
      added: 1,
      updated: 1,
      unchanged: 1,
    });
  });

  it('records the merge on each record it changed when an origin is supplied', () => {
    const shared = record({ id: 'a', title: 'Gmail' });
    const merged = mergeDocuments(
      doc({ records: [shared] }),
      doc({ records: [shared] }),
      doc({ records: [edited(shared, { title: 'Google' })] }),
      { ...MERGE_OPTIONS, mergeOrigin: origin('merge', 'laptop') }
    );
    expect(merged.document.records[0]?.history.versions.at(-1)?.origin.action).toBe('merge');
  });

  it('writes no merge version when no origin is supplied', () => {
    const shared = record({ id: 'a', title: 'Gmail' });
    const merged = mergeDocuments(
      doc({ records: [shared] }),
      doc({ records: [shared] }),
      doc({ records: [edited(shared, { title: 'Google' })] }),
      MERGE_OPTIONS
    );
    expect(merged.document.records[0]?.history.versions).toEqual([]);
  });
});
