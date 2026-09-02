// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ConflictChoice } from '@shared/model/sync.js';
import { assertValidHistory } from '../history/versioning.js';
import { mergeCredential, type RecordMergeContext } from './merge-record.js';
import {
  DAY,
  NOW,
  attachment,
  customField,
  edited,
  origin,
  question,
  record,
} from './test-fixtures.js';

/**
 * Record-level merge rules.
 *
 * The two things here that would be expensive to get silently wrong, in order:
 *
 *   1. **A tombstone is never overruled by a record that merely exists.** Every other bug in
 *      this file produces a wrong value the user can see and fix. This one produces a
 *      credential the user deliberately destroyed, quietly back in their vault, on a device
 *      they were not looking at. Both directions are tested, with and without an ancestor.
 *
 *   2. **Two devices editing different fields must not force a choice.** If that breaks, the
 *      engine still "works" — it just asks the user to throw away half of every merge, and
 *      people click through prompts.
 *
 * Everything is asserted in both argument orders where the property is meant to be
 * symmetric; `properties.test.ts` does that exhaustively, so the cases here that repeat it do
 * so only where the asymmetry would be specific to this rule.
 */

function ctx(overrides: Partial<RecordMergeContext> = {}): RecordMergeContext {
  return {
    ancestorKnown: overrides.ancestorKnown ?? true,
    mergeOrigin: overrides.mergeOrigin ?? null,
    resolutions: overrides.resolutions ?? new Map<string, ConflictChoice>(),
  };
}

function resolutions(entries: Record<string, ConflictChoice>): ReadonlyMap<string, ConflictChoice> {
  return new Map(Object.entries(entries));
}

// ── Disjoint edits ───────────────────────────────────────────────────────────

describe('two devices editing different fields', () => {
  const base = record({ id: 'a', title: 'Gmail', password: 'old-password' });

  it('merges cleanly, with no conflict at all', () => {
    const ours = edited(base, { title: 'Google Mail' });
    const theirs = edited(base, { password: 'new-password' });

    const merged = mergeCredential(base, ours, theirs, ctx());

    expect(merged.conflicts).toEqual([]);
    expect(merged.credential.title).toBe('Google Mail');
    expect(merged.credential.fields.password).toBe('new-password');
  });

  it('takes the other side when we did not touch the field', () => {
    const theirs = edited(base, { email: 'me@example.com', username: 'me' });
    const merged = mergeCredential(base, base, theirs, ctx());

    expect(merged.conflicts).toEqual([]);
    expect(merged.credential.fields.email).toBe('me@example.com');
    expect(merged.credential.fields.username).toBe('me');
  });

  it('keeps ours when the other side did not touch the field', () => {
    const ours = edited(base, { title: 'Renamed' });
    const merged = mergeCredential(base, ours, base, ctx());

    expect(merged.conflicts).toEqual([]);
    expect(merged.credential.title).toBe('Renamed');
  });
});

// ── Genuine conflicts ────────────────────────────────────────────────────────

describe('two devices changing the same field differently', () => {
  const base = record({ id: 'a', title: 'Gmail', password: 'old' });
  const ours = edited(base, { password: 'mine-is-longer' });
  const theirs = edited(base, { password: 'yours' });

  it('reports a conflict naming the record and the field', () => {
    const merged = mergeCredential(base, ours, theirs, ctx());

    expect(merged.conflicts).toHaveLength(1);
    const conflict = merged.conflicts[0];
    expect(conflict?.id).toBe('record:a:field:password');
    expect(conflict?.kind).toBe('record-field');
    expect(conflict?.targetId).toBe('a');
    expect(conflict?.field).toBe('password');
    expect(conflict?.resolution).toBe('unresolved');
  });

  it('carries lengths for a secret field, never the values', () => {
    const merged = mergeCredential(base, ours, theirs, ctx());
    const conflict = merged.conflicts[0];

    expect(conflict?.ours).toEqual({ kind: 'secret', length: 'mine-is-longer'.length });
    expect(conflict?.theirs).toEqual({ kind: 'secret', length: 'yours'.length });
    expect(conflict?.base).toEqual({ kind: 'secret', length: 'old'.length });
    expect(JSON.stringify(conflict)).not.toContain('mine-is-longer');
    expect(JSON.stringify(conflict)).not.toContain('yours');
  });

  it('carries the values for a non-secret field, because a resolver has to show them', () => {
    const merged = mergeCredential(
      base,
      edited(base, { title: 'Mine' }),
      edited(base, { title: 'Theirs' }),
      ctx()
    );
    expect(merged.conflicts[0]?.ours).toEqual({ kind: 'value', value: 'Mine' });
    expect(merged.conflicts[0]?.theirs).toEqual({ kind: 'value', value: 'Theirs' });
  });

  it('holds ours provisionally, and says so', () => {
    const merged = mergeCredential(base, ours, theirs, ctx());
    expect(merged.credential.fields.password).toBe('mine-is-longer');
    expect(merged.conflicts[0]?.applied).toBe('ours');
    expect(merged.conflicts[0]?.resolution).toBe('unresolved');
  });

  it('applies a resolution of "theirs" and marks it as the user\'s', () => {
    const merged = mergeCredential(
      base,
      ours,
      theirs,
      ctx({ resolutions: resolutions({ 'record:a:field:password': 'theirs' }) })
    );
    expect(merged.credential.fields.password).toBe('yours');
    expect(merged.conflicts[0]?.applied).toBe('theirs');
    expect(merged.conflicts[0]?.resolution).toBe('user');
  });

  it('ignores a stale resolution when both sides caught up to the same value', () => {
    // The user resolved, then the other device synced and the two agree. Two identical records
    // short-circuit before any resolution is looked at, which is the cheapest way to be right.
    const merged = mergeCredential(
      base,
      ours,
      ours,
      ctx({ resolutions: resolutions({ 'record:a:field:password': 'theirs' }) })
    );
    expect(merged.credential.fields.password).toBe('mine-is-longer');
    expect(merged.conflicts).toEqual([]);
  });

  it('ignores a stale resolution for a field only the other side has since changed', () => {
    // The dangerous shape, and the one the identical-records case above does *not* reach: the
    // record still differs overall, so the merge runs in full, but this field no longer
    // disagrees — they rotated the password and we never touched it. Honouring a resolution
    // collected when it *did* disagree would overwrite their rotation with the ancestor's
    // value, and nobody would ever be asked about it.
    const merged = mergeCredential(
      base,
      base,
      edited(base, { password: 'rotated-since-they-answered' }),
      ctx({ resolutions: resolutions({ 'record:a:field:password': 'ours' }) })
    );
    expect(merged.credential.fields.password).toBe('rotated-since-they-answered');
    expect(merged.conflicts).toEqual([]);
  });
});

describe('without an ancestor', () => {
  const ours = record({ id: 'a', title: 'Mine' });
  const theirs = record({ id: 'a', title: 'Theirs' });

  it('treats every difference as a conflict, because it cannot know who changed what', () => {
    const merged = mergeCredential(null, ours, theirs, ctx({ ancestorKnown: false }));
    const fields = merged.conflicts.map((conflict) => conflict.field);
    expect(fields).toContain('title');
    expect(merged.conflicts.every((conflict) => conflict.base === null)).toBe(true);
  });

  it('marks the base side as absent when the document had an ancestor but the record did not', () => {
    // Created independently on both devices — a re-imported export. Two-way for this record,
    // inside an otherwise three-way merge, and the report must not blur the two.
    const merged = mergeCredential(null, ours, theirs, ctx({ ancestorKnown: true }));
    expect(merged.conflicts[0]?.base).toEqual({ kind: 'absent' });
  });
});

// ── Tombstones ───────────────────────────────────────────────────────────────

describe('a deletion is never resurrected', () => {
  const base = record({ id: 'a', title: 'Old account' });

  it('keeps the tombstone when we deleted and they merely still have it', () => {
    const ours = edited(base, { trashedAt: NOW - DAY });
    const merged = mergeCredential(base, ours, base, ctx());

    expect(merged.credential.trashedAt).toBe(NOW - DAY);
    expect(merged.conflicts).toEqual([]);
  });

  it('keeps the tombstone when they deleted and we merely still have it', () => {
    const theirs = edited(base, { trashedAt: NOW - DAY });
    const merged = mergeCredential(base, base, theirs, ctx());

    expect(merged.credential.trashedAt).toBe(NOW - DAY);
  });

  it('keeps the tombstone with no ancestor at all — both directions', () => {
    const live = record({ id: 'a' });
    const dead = record({ id: 'a', trashedAt: NOW - DAY });

    expect(
      mergeCredential(null, dead, live, ctx({ ancestorKnown: false })).credential.trashedAt
    ).toBe(NOW - DAY);
    expect(
      mergeCredential(null, live, dead, ctx({ ancestorKnown: false })).credential.trashedAt
    ).toBe(NOW - DAY);
  });

  it('reports it, so a merge is never silent about a record disappearing', () => {
    const live = record({ id: 'a' });
    const dead = record({ id: 'a', trashedAt: NOW - DAY });
    const merged = mergeCredential(null, live, dead, ctx({ ancestorKnown: false }));

    expect(merged.notes.map((note) => note.kind)).toContain('tombstone-preserved');
  });
});

describe('trashed on one side, edited on the other', () => {
  const base = record({ id: 'a', title: 'Bank', password: 'old' });
  const ours = edited(base, { trashedAt: NOW - DAY });
  const theirs = edited(base, { password: 'rotated-yesterday', title: 'Bank plc' });

  it('keeps the tombstone', () => {
    expect(mergeCredential(base, ours, theirs, ctx()).credential.trashedAt).toBe(NOW - DAY);
  });

  it('does not throw the edits away — they are in the trashed record', () => {
    const merged = mergeCredential(base, ours, theirs, ctx());
    expect(merged.credential.fields.password).toBe('rotated-yesterday');
    expect(merged.credential.title).toBe('Bank plc');
  });

  it('raises a delete-vs-edit conflict rather than deciding quietly', () => {
    const merged = mergeCredential(base, ours, theirs, ctx());
    const conflict = merged.conflicts.find((entry) => entry.kind === 'record-delete-vs-edit');
    expect(conflict?.id).toBe('record:a:trash');
    expect(conflict?.applied).toBe('ours');
    expect(conflict?.resolution).toBe('unresolved');
  });

  it('can be resolved in favour of keeping the record', () => {
    const merged = mergeCredential(
      base,
      ours,
      theirs,
      ctx({ resolutions: resolutions({ 'record:a:trash': 'theirs' }) })
    );
    expect(merged.credential.trashedAt).toBeNull();
    expect(merged.credential.fields.password).toBe('rotated-yesterday');
  });
});

describe('restoring from the trash', () => {
  it('wins when only one side restored, with no conflict', () => {
    const base = record({ id: 'a', trashedAt: NOW - 5 * DAY });
    const theirs = edited(base, { trashedAt: null });

    const merged = mergeCredential(base, base, theirs, ctx());
    expect(merged.credential.trashedAt).toBeNull();
    expect(merged.conflicts).toEqual([]);
    expect(merged.notes.map((note) => note.kind)).toContain('record-restored');
  });

  it('keeps the later tombstone when both sides deleted at different moments', () => {
    // Both agree it is gone; the instant only decides when retention purges it, and the later
    // one gives the user the longer window to change their mind.
    const ours = record({ id: 'a', trashedAt: NOW - 5 * DAY });
    const theirs = record({ id: 'a', trashedAt: NOW - DAY });

    expect(
      mergeCredential(null, ours, theirs, ctx({ ancestorKnown: false })).credential.trashedAt
    ).toBe(NOW - DAY);
    expect(
      mergeCredential(null, theirs, ours, ctx({ ancestorKnown: false })).credential.trashedAt
    ).toBe(NOW - DAY);
  });
});

// ── Keyed lists ──────────────────────────────────────────────────────────────

describe('custom fields merge entry by entry', () => {
  const base = record({ id: 'a', custom: [customField('f1', 'Account', '1234')] });

  it('keeps both when each device added a different field', () => {
    const ours = edited(base, {
      custom: [customField('f1', 'Account', '1234'), customField('f2', 'Sort code', '00-11')],
    });
    const theirs = edited(base, {
      custom: [customField('f1', 'Account', '1234'), customField('f3', 'PIN', '9999')],
    });

    const merged = mergeCredential(base, ours, theirs, ctx());
    expect(merged.conflicts).toEqual([]);
    expect(merged.credential.fields.custom.map((field) => field.id)).toEqual(['f1', 'f2', 'f3']);
  });

  it('renumbers order contiguously, exactly as a hand edit would', () => {
    const ours = edited(base, {
      custom: [
        customField('f1', 'Account', '1234', { order: 0 }),
        customField('f2', 'B', 'x', { order: 7 }),
      ],
    });
    const theirs = edited(base, {
      custom: [
        customField('f1', 'Account', '1234', { order: 0 }),
        customField('f3', 'C', 'y', { order: 9 }),
      ],
    });

    const merged = mergeCredential(base, ours, theirs, ctx());
    expect(merged.credential.fields.custom.map((field) => field.order)).toEqual([0, 1, 2]);
  });

  it('honours a deletion the other side did not touch', () => {
    const ours = edited(base, { custom: [] });
    const merged = mergeCredential(base, ours, base, ctx());
    expect(merged.credential.fields.custom).toEqual([]);
    expect(merged.conflicts).toEqual([]);
  });

  it('keeps an entry deleted on one side and edited on the other, and flags it', () => {
    const ours = edited(base, { custom: [] });
    const theirs = edited(base, { custom: [customField('f1', 'Account', '5678')] });

    const merged = mergeCredential(base, ours, theirs, ctx());
    expect(merged.credential.fields.custom).toHaveLength(1);
    expect(merged.conflicts.map((conflict) => conflict.field)).toEqual(['custom']);
  });

  it('projects a custom-field conflict without the values of secret entries', () => {
    const secretBase = record({
      id: 'a',
      custom: [customField('f1', 'PIN', '1111', { type: 'pin' })],
    });
    const ours = edited(secretBase, {
      custom: [customField('f1', 'PIN', 'AAAA', { type: 'pin' })],
    });
    const theirs = edited(secretBase, {
      custom: [customField('f1', 'PIN', 'BBBB', { type: 'pin' })],
    });

    const merged = mergeCredential(secretBase, ours, theirs, ctx());
    const serialised = JSON.stringify(merged.conflicts);
    expect(serialised).not.toContain('AAAA');
    expect(serialised).not.toContain('BBBB');
    expect(serialised).toContain('"hasValue":true');
  });
});

describe('security questions merge entry by entry', () => {
  const base = record({ id: 'a', securityQuestions: [question('q1', 'Pet?', 'Rex')] });

  it('keeps both when each device added a different question', () => {
    const ours = edited(base, {
      securityQuestions: [question('q1', 'Pet?', 'Rex'), question('q2', 'City?', 'Leeds')],
    });
    const theirs = edited(base, {
      securityQuestions: [question('q1', 'Pet?', 'Rex'), question('q3', 'School?', 'Fairfield')],
    });

    const merged = mergeCredential(base, ours, theirs, ctx());
    expect(merged.credential.fields.securityQuestions.map((entry) => entry.id)).toEqual([
      'q1',
      'q2',
      'q3',
    ]);
    expect(merged.conflicts).toEqual([]);
  });

  it('never puts an answer in a conflict', () => {
    const ours = edited(base, { securityQuestions: [question('q1', 'Pet?', 'ANSWER-OURS')] });
    const theirs = edited(base, { securityQuestions: [question('q1', 'Pet?', 'ANSWER-THEIRS')] });

    const merged = mergeCredential(base, ours, theirs, ctx());
    const serialised = JSON.stringify(merged.conflicts);
    expect(serialised).toContain('Pet?');
    expect(serialised).not.toContain('ANSWER-OURS');
    expect(serialised).not.toContain('ANSWER-THEIRS');
  });
});

// ── Tags ─────────────────────────────────────────────────────────────────────

describe('tags merge as a set', () => {
  const base = record({ id: 'a', tags: ['work'] });

  it('keeps additions from both sides, with no conflict', () => {
    const merged = mergeCredential(
      base,
      edited(base, { tags: ['work', 'email'] }),
      edited(base, { tags: ['work', '2fa'] }),
      ctx()
    );
    expect([...merged.credential.tags].sort()).toEqual(['2fa', 'email', 'work']);
    expect(merged.conflicts).toEqual([]);
  });

  it('honours a removal rather than putting the tag straight back', () => {
    const merged = mergeCredential(
      base,
      edited(base, { tags: [] }),
      edited(base, { tags: ['work', '2fa'] }),
      ctx()
    );
    expect(merged.credential.tags).toEqual(['2fa']);
  });

  it('unions when there is no ancestor, because absence cannot mean removal', () => {
    const merged = mergeCredential(
      null,
      record({ id: 'a', tags: ['work'] }),
      record({ id: 'a', tags: ['personal'] }),
      ctx({ ancestorKnown: false })
    );
    expect([...merged.credential.tags].sort()).toEqual(['personal', 'work']);
  });
});

// ── Metadata ─────────────────────────────────────────────────────────────────

describe('metadata is carried, never used to decide', () => {
  const base = record({ id: 'a', createdAt: NOW - 100 * DAY, useCount: 4, password: 'old' });

  it('takes the earlier creation and the later modification', () => {
    const ours = edited(base, { createdAt: NOW - 100 * DAY, updatedAt: NOW - 3 * DAY });
    const theirs = edited(base, { createdAt: NOW - 120 * DAY, updatedAt: NOW - DAY, title: 'X' });

    const merged = mergeCredential(base, ours, theirs, ctx());
    expect(merged.credential.meta.createdAt).toBe(NOW - 120 * DAY);
    expect(merged.credential.meta.updatedAt).toBe(NOW - DAY);
  });

  it('never stamps the merge time onto a record', () => {
    const ours = edited(base, { title: 'Mine', updatedAt: NOW - 3 * DAY });
    const theirs = edited(base, { username: 'them', updatedAt: NOW - 2 * DAY });

    const merged = mergeCredential(base, ours, theirs, ctx());
    expect(merged.credential.meta.updatedAt).toBe(NOW - 2 * DAY);
    expect(merged.credential.meta.updatedAt).toBeLessThan(NOW);
  });

  it('moves passwordUpdatedAt with the password that won', () => {
    const ours = edited(base, { password: 'old', passwordUpdatedAt: NOW - 90 * DAY });
    const theirs = edited(base, { password: 'rotated', passwordUpdatedAt: NOW - DAY });

    const merged = mergeCredential(base, ours, theirs, ctx());
    expect(merged.credential.fields.password).toBe('rotated');
    expect(merged.credential.meta.passwordUpdatedAt).toBe(NOW - DAY);
  });

  it('takes the earlier stamp when both sides ended up on the same password', () => {
    // Otherwise a sync would silently make an old password look freshly rotated, and the
    // health rule that exists to nag about age would stop nagging.
    const ours = edited(base, { password: 'same', passwordUpdatedAt: NOW - 400 * DAY, title: 'A' });
    const theirs = edited(base, { password: 'same', passwordUpdatedAt: NOW - DAY });

    const merged = mergeCredential(base, ours, theirs, ctx());
    expect(merged.credential.meta.passwordUpdatedAt).toBe(NOW - 400 * DAY);
  });

  it('adds the uses each side accrued since the ancestor, not the totals', () => {
    const ours = edited(base, { useCount: 6 });
    const theirs = edited(base, { useCount: 9 });

    // 4 in the shared past, +2 here, +5 there. Adding the totals would give 15 and would
    // inflate again on every subsequent sync.
    expect(mergeCredential(base, ours, theirs, ctx()).credential.meta.useCount).toBe(11);
  });

  it('falls back to the larger count with no ancestor to subtract', () => {
    const ours = record({ id: 'a', useCount: 6 });
    const theirs = record({ id: 'a', useCount: 9 });
    expect(
      mergeCredential(null, ours, theirs, ctx({ ancestorKnown: false })).credential.meta.useCount
    ).toBe(9);
  });
});

// ── History settings ─────────────────────────────────────────────────────────

describe('per-record history settings resolve by policy', () => {
  const base = record({ id: 'a', historyEnabled: true, historyMaxVersions: 50 });

  it('takes a one-sided switch as an ordinary edit — a boolean cannot conflict three-way', () => {
    // Stated outright because it is the reason the "off wins" policy below needs a two-way
    // merge to be reachable at all. `enabled` has two values: if ours differs from the base,
    // theirs either matches the base (one side moved — an edit, not a disagreement) or matches
    // ours. There is no third value left for the two sides to disagree on. Where an ancestor
    // exists, "the user turned this off" is a fact, and honouring a fact beats applying a
    // policy — so the absence of a conflict here is the correct outcome, not a missed one.
    const merged = mergeCredential(
      base,
      edited(base, { historyEnabled: false, title: 'A' }),
      edited(base, { historyEnabled: true, historyMaxVersions: 10 }),
      ctx()
    );
    expect(merged.credential.history.enabled).toBe(false);
    expect(merged.conflicts.map((entry) => entry.field)).not.toContain('enabled');
  });

  it('switches history off when the two sides disagree with no ancestor to appeal to', () => {
    const merged = mergeCredential(
      null,
      record({ id: 'a', historyEnabled: true }),
      record({ id: 'a', historyEnabled: false }),
      ctx({ ancestorKnown: false })
    );
    expect(merged.credential.history.enabled).toBe(false);
    const conflict = merged.conflicts.find((entry) => entry.field === 'enabled');
    expect(conflict?.id).toBe('record:a:history:enabled');
    expect(conflict?.kind).toBe('record-history');
    expect(conflict?.resolution).toBe('policy');
    expect(conflict?.applied).toBe('theirs');
  });

  it('switches it off whichever way round the two documents were passed', () => {
    const merged = mergeCredential(
      null,
      record({ id: 'a', historyEnabled: false }),
      record({ id: 'a', historyEnabled: true }),
      ctx({ ancestorKnown: false })
    );
    expect(merged.credential.history.enabled).toBe(false);
    expect(merged.conflicts.find((entry) => entry.field === 'enabled')?.applied).toBe('ours');
  });

  it('lets the user override the policy and switch it back on', () => {
    const merged = mergeCredential(
      null,
      record({ id: 'a', historyEnabled: true }),
      record({ id: 'a', historyEnabled: false }),
      ctx({
        resolutions: resolutions({ 'record:a:history:enabled': 'ours' }),
        ancestorKnown: false,
      })
    );
    expect(merged.credential.history.enabled).toBe(true);
    expect(merged.conflicts.find((entry) => entry.field === 'enabled')?.resolution).toBe('user');
  });

  it('keeps the larger retention cap, with null winning as unlimited', () => {
    const merged = mergeCredential(
      base,
      edited(base, { historyMaxVersions: 10 }),
      edited(base, { historyMaxVersions: null }),
      ctx()
    );
    expect(merged.credential.history.maxVersions).toBeNull();
  });

  it('does not block the merge on a settings-shaped disagreement', () => {
    const merged = mergeCredential(
      base,
      edited(base, { historyMaxVersions: 10 }),
      edited(base, { historyMaxVersions: 20 }),
      ctx()
    );
    expect(merged.conflicts.every((conflict) => conflict.resolution === 'policy')).toBe(true);
  });
});

// ── Attachments ──────────────────────────────────────────────────────────────

describe('attachments', () => {
  const base = record({ id: 'a', attachments: [attachment('aaaa')] });

  it('unions the metadata and names the chunks we do not hold', () => {
    const ours = edited(base, { attachments: [attachment('aaaa')] });
    const theirs = edited(base, { attachments: [attachment('aaaa'), attachment('bbbb')] });

    const merged = mergeCredential(base, ours, theirs, ctx());
    expect(merged.credential.attachments.map((entry) => entry.id)).toEqual(['aaaa', 'bbbb']);
    expect(merged.attachmentsToImport).toEqual(['bbbb']);
    expect(merged.notes.map((note) => note.kind)).toContain('attachment-needed');
  });
});

// ── The merge is itself an audited change ────────────────────────────────────

describe('recording the merge in the timeline', () => {
  const base = record({ id: 'a', title: 'Gmail' });

  it('appends a version with the merge origin when the record changed', () => {
    const merged = mergeCredential(
      base,
      base,
      edited(base, { title: 'Google' }),
      ctx({ mergeOrigin: origin('merge', 'laptop') })
    );

    const last = merged.credential.history.versions.at(-1);
    expect(last?.origin.action).toBe('merge');
    expect(last?.changedFields).toEqual(['title']);
    // The snapshot holds what *this* device used to have, which is what a restore needs.
    expect(last?.snapshot).toEqual({ title: 'Gmail' });
    assertValidHistory(merged.credential);
  });

  it('writes nothing when the merge changed nothing on our side', () => {
    const merged = mergeCredential(
      base,
      edited(base, { title: 'Google' }),
      base,
      ctx({ mergeOrigin: origin('merge') })
    );
    expect(merged.credential.history.versions).toEqual([]);
  });

  it('writes nothing when no merge origin was supplied', () => {
    const merged = mergeCredential(base, base, edited(base, { title: 'Google' }), ctx());
    expect(merged.credential.history.versions).toEqual([]);
  });

  it('writes nothing when history is off for the record', () => {
    const off = record({ id: 'a', title: 'Gmail', historyEnabled: false });
    const merged = mergeCredential(
      off,
      off,
      edited(off, { title: 'Google' }),
      ctx({ mergeOrigin: origin('merge') })
    );
    expect(merged.credential.history.versions).toEqual([]);
  });
});

// ── Validation ───────────────────────────────────────────────────────────────

describe('a merged record is held to the model invariants', () => {
  it('refuses to produce a record with an over-length title', () => {
    const base = record({ id: 'a', title: 'short' });
    const ours = edited(base, { title: 'x'.repeat(401) });
    // The oversized title is on our side alone, so it wins by the ordinary rule — and is then
    // rejected, rather than written to a vault file where it would fail on the next load.
    expect(() => mergeCredential(base, ours, base, ctx())).toThrow(/longer than/);
  });

  it('never produces duplicate custom-field ids from a keyed merge', () => {
    const base = record({ id: 'a', custom: [customField('f1', 'A', '1')] });
    const merged = mergeCredential(
      base,
      edited(base, { custom: [customField('f1', 'A', '2')] }),
      edited(base, { custom: [customField('f1', 'A', '3')] }),
      ctx()
    );
    const ids = merged.credential.fields.custom.map((field) => field.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
