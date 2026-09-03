// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { SECRET_VERSIONED_FIELDS } from '@shared/model/credential.js';
import type { MergeConflict } from '@shared/model/sync.js';
import {
  acrossTargetRefusal,
  applySweep,
  describeSweep,
  planSweep,
  refusalSentence,
  SWEEP_REFUSALS,
} from './bulk-resolution.js';
import { NO_SELECTIONS, statusOf, type Selections } from './resolution-state.js';
import { conflict, secret, value } from './test-fixtures.js';

/**
 * Where the bulk-resolution line is, asserted rather than described.
 *
 * The failure this file exists to prevent is not a crash. It is a sweep that quietly settles a
 * password conflict — at which point the merge engine, the conflict projection and this whole
 * screen have been reduced to a nicer label on last-writer-wins.
 *
 * Fault injections performed:
 *
 *  1. `acrossTargetRefusal` returning `null` unconditionally — fails "no across-subjects sweep
 *     can settle a hidden value, for any secret field the model classifies" and the
 *     delete-vs-edit assertion.
 *  2. Dropping the `record-delete-vs-edit` arm of `acrossTargetRefusal` — fails "a record
 *     trashed in one file and edited in the other is never swept across subjects".
 *  3. `planSweep` omitting the `statusOf(...) !== 'needs-choice'` guard — fails "a sweep never
 *     overwrites an answer already given" and "a sweep leaves a policy decision alone".
 *  4. `applySweep` writing `plan.choice` over an existing entry — fails "applying a stale plan
 *     cannot overwrite an answer given since".
 *  5. `applySweep` iterating the conflicts rather than `plan.willSet` (simulated by passing a
 *     plan whose `willSet` was narrowed) — fails "applies exactly the ids the plan named".
 *  6. `describeSweep` omitting the refused clause — fails "says what it will not do, as well as
 *     what it will".
 */

const visible = (id: string): MergeConflict =>
  conflict({ targetId: id, field: 'title', ours: value('a'), theirs: value('b') });

describe('what an across-subjects sweep refuses', () => {
  it('no across-subjects sweep can settle a hidden value, for any secret field the model classifies', () => {
    // Driven from `SECRET_VERSIONED_FIELDS` rather than a hand-written list, so a field promoted
    // to secret in `credential.ts` is covered here the day it is promoted.
    for (const field of SECRET_VERSIONED_FIELDS) {
      const c = conflict({ field, ours: secret(8), theirs: secret(12) });
      expect(acrossTargetRefusal(c), field).toBe('hidden');
      expect(planSweep([c], NO_SELECTIONS, 'across-targets', 'ours').willSet).toEqual([]);
    }
  });

  it('catches a hidden value even when the field name is one it has never heard of', () => {
    const c = conflict({ field: 'someFutureSecret', ours: secret(4), theirs: secret(9) });
    expect(acrossTargetRefusal(c)).toBe('hidden');
  });

  it('a record trashed in one file and edited in the other is never swept across subjects', () => {
    const c = conflict({
      kind: 'record-delete-vs-edit',
      field: 'trashedAt',
      ours: value(null),
      theirs: value(1_700_000_000_000),
    });
    // Both sides are plain timestamps — perfectly visible, and completely beside the point.
    expect(acrossTargetRefusal(c)).toBe('trashed');
    expect(planSweep([c], NO_SELECTIONS, 'across-targets', 'ours').willSet).toEqual([]);
  });

  it('lets a fully visible value through', () => {
    const c = visible('rec-1');
    expect(acrossTargetRefusal(c)).toBeNull();
    expect(planSweep([c], NO_SELECTIONS, 'across-targets', 'ours').willSet).toEqual([c.id]);
  });
});

describe('what a single-subject sweep may do', () => {
  it('sweeps hidden values within one named record, which the across sweep will not', () => {
    const password = conflict({ field: 'password', ours: secret(8), theirs: secret(12) });
    const within = planSweep([password], NO_SELECTIONS, 'one-target', 'ours');
    const across = planSweep([password], NO_SELECTIONS, 'across-targets', 'ours');

    expect(within.willSet).toEqual([password.id]);
    expect(across.willSet).toEqual([]);
    expect(across.refused.map((refusal) => refusal.reason)).toEqual(['hidden']);
  });
});

describe('a sweep is additive, always', () => {
  const a = visible('rec-1');
  const b = visible('rec-2');

  it('a sweep never overwrites an answer already given', () => {
    const selections: Selections = new Map([[a.id, 'theirs' as const]]);
    const plan = planSweep([a, b], selections, 'across-targets', 'ours');
    expect(plan.willSet).toEqual([b.id]);
    expect(plan.untouched).toBe(1);
    expect(applySweep(selections, plan).get(a.id)).toBe('theirs');
  });

  it('a sweep leaves a policy decision alone', () => {
    const auto = conflict({ targetId: 'rec-3', resolution: 'policy', applied: 'theirs' });
    const plan = planSweep([auto], NO_SELECTIONS, 'across-targets', 'ours');
    expect(plan.willSet).toEqual([]);
    expect(plan.untouched).toBe(1);
    expect(statusOf(auto, applySweep(NO_SELECTIONS, plan))).toBe('auto');
  });

  it('applies exactly the ids the plan named', () => {
    const plan = planSweep([a, b], NO_SELECTIONS, 'across-targets', 'ours');
    const narrowed = { ...plan, willSet: [a.id] };
    const applied = applySweep(NO_SELECTIONS, narrowed);
    expect([...applied.keys()]).toEqual([a.id]);
  });

  it('applying a stale plan cannot overwrite an answer given since', () => {
    const plan = planSweep([a, b], NO_SELECTIONS, 'across-targets', 'theirs');
    const answeredSince: Selections = new Map([[a.id, 'ours' as const]]);
    const applied = applySweep(answeredSince, plan);
    expect(applied.get(a.id)).toBe('ours');
    expect(applied.get(b.id)).toBe('theirs');
  });
});

describe('the sentence on the button', () => {
  it('says what it will not do, as well as what it will', () => {
    const password = conflict({
      targetId: 'rec-2',
      field: 'password',
      ours: secret(1),
      theirs: secret(2),
    });
    const plan = planSweep([visible('rec-1'), password], NO_SELECTIONS, 'across-targets', 'ours');
    const sentence = describeSweep(plan);

    expect(sentence).toContain('1 conflict');
    expect(sentence).toContain('still need you individually');
  });

  it('says so plainly when nothing can be swept here at all', () => {
    const password = conflict({ field: 'password', ours: secret(1), theirs: secret(2) });
    const plan = planSweep([password], NO_SELECTIONS, 'across-targets', 'theirs');
    expect(describeSweep(plan)).toContain('Nothing can be answered in bulk');
  });

  it('names every refusal reason, with its count, and pluralises each one', () => {
    const conflicts = [
      conflict({ targetId: 'r1', field: 'password', ours: secret(1), theirs: secret(2) }),
      conflict({ targetId: 'r2', field: 'notes', ours: secret(3), theirs: secret(4) }),
      conflict({
        targetId: 'r3',
        kind: 'record-delete-vs-edit',
        field: 'trashedAt',
        ours: value(null),
        theirs: value(1),
      }),
    ];
    const sentence = refusalSentence(planSweep(conflicts, NO_SELECTIONS, 'across-targets', 'ours'));

    expect(sentence).toContain(`2 ${SWEEP_REFUSALS.hidden.many}`);
    expect(sentence).toContain(`1 ${SWEEP_REFUSALS.trashed.one}`);
  });

  it('says nothing at all when a sweep refused nothing', () => {
    expect(
      refusalSentence(planSweep([visible('rec-1')], NO_SELECTIONS, 'across-targets', 'ours'))
    ).toBe('');
  });

  it('names the side by what it is, never as "mine"', () => {
    const plan = planSweep([visible('rec-1')], NO_SELECTIONS, 'across-targets', 'ours');
    expect(describeSweep(plan)).toContain('this device');
    expect(describeSweep(plan).toLowerCase()).not.toContain('mine');
  });
});

describe('the whole-report sweep that does not exist', () => {
  it('has no scope that reaches every conflict in a report containing a hidden value', () => {
    const conflicts = [
      visible('rec-1'),
      conflict({ targetId: 'rec-2', field: 'password', ours: secret(8), theirs: secret(9) }),
      conflict({
        targetId: 'rec-3',
        kind: 'record-delete-vs-edit',
        field: 'trashedAt',
        ours: value(null),
        theirs: value(1),
      }),
    ];
    // `'one-target'` is only ever handed one subject's conflicts by the UI, but even given all
    // three it is the *scope* that is being asserted here: the across scope, which is the only
    // one the page-level control can use, cannot reach two of the three.
    const across = planSweep(conflicts, NO_SELECTIONS, 'across-targets', 'ours');
    expect(across.willSet).toHaveLength(1);
    expect(across.refused).toHaveLength(2);
  });
});
