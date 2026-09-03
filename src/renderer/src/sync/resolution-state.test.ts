// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ConflictChoice } from '@shared/model/sync.js';
import {
  carryOver,
  choose,
  effectiveChoice,
  isChoosable,
  seedSelections,
  statusOf,
  summarise,
  toResolutions,
  type Selections,
} from './resolution-state.js';
import { conflict, report } from './test-fixtures.js';

/**
 * What "settled" means.
 *
 * This is the file the whole screen's safety rests on: a merged document is provisional while
 * anything is unresolved, and every enable/disable on the screen is derived from `summarise`.
 *
 * Fault injections performed against these assertions:
 *
 *  1. `readyToApply: remaining === 0 && !needsRemerge` (dropping `!report.requiresResolution`)
 *     — fails "refuses to apply while the engine still says the merge is unresolved".
 *  2. `needsRemerge` computed as `conflict.resolution === 'unresolved'` only — fails "a choice
 *     that overrides a policy decision still needs a re-merge" and "changing an answer to the
 *     other side needs a re-merge".
 *  3. `carryOver` keeping every previous selection without pruning — fails "drops selections
 *     whose conflict the re-merge removed".
 *  4. `seedSelections` also seeding `'policy'` conflicts — fails "does not adopt the engine's
 *     policy decisions as the user's answers".
 *  5. `isChoosable` returning `true` unconditionally — fails "a combined conflict is not a
 *     question".
 *  6. `statusOf` checking `resolution` before `selections` — fails "a local choice beats the
 *     report it was made against".
 */

const sel = (entries: readonly (readonly [string, ConflictChoice])[] = []): Selections =>
  new Map(entries);

describe('what a conflict is currently in', () => {
  it('a combined conflict is not a question', () => {
    const merged = conflict({ applied: 'merged', resolution: 'policy' });
    expect(isChoosable(merged)).toBe(false);
    expect(statusOf(merged, sel())).toBe('combined');
    expect(effectiveChoice(merged, sel())).toBeNull();
  });

  it('an unresolved conflict with no selection needs a choice', () => {
    const c = conflict();
    expect(statusOf(c, sel())).toBe('needs-choice');
    expect(effectiveChoice(c, sel())).toBeNull();
  });

  it('a policy decision is settled, shown, and still overridable', () => {
    const c = conflict({ resolution: 'policy', applied: 'theirs' });
    expect(statusOf(c, sel())).toBe('auto');
    expect(effectiveChoice(c, sel())).toBe('theirs');
    expect(statusOf(c, sel([[c.id, 'ours']]))).toBe('chosen');
    expect(effectiveChoice(c, sel([[c.id, 'ours']]))).toBe('ours');
  });

  it('a local choice beats the report it was made against', () => {
    const c = conflict({ resolution: 'user', applied: 'ours' });
    expect(effectiveChoice(c, sel([[c.id, 'theirs']]))).toBe('theirs');
  });
});

describe('seeding from a report', () => {
  it('adopts choices the engine has already folded in', () => {
    const c = conflict({ resolution: 'user', applied: 'theirs' });
    expect([...seedSelections(report({ conflicts: [c] }))]).toEqual([[c.id, 'theirs']]);
  });

  it('does not adopt the engine’s policy decisions as the user’s answers', () => {
    const c = conflict({ resolution: 'policy', applied: 'theirs' });
    expect(seedSelections(report({ conflicts: [c] })).size).toBe(0);
  });

  it('does not adopt a combined conflict, which has no side to adopt', () => {
    const c = conflict({ applied: 'merged', resolution: 'policy' });
    expect(seedSelections(report({ conflicts: [c] })).size).toBe(0);
  });
});

describe('carrying selections across a re-merge', () => {
  const kept = conflict({ targetId: 'rec-1', field: 'title' });
  const gone = conflict({ targetId: 'rec-2', field: 'username' });

  it('keeps a selection whose conflict is still there', () => {
    const next = carryOver(sel([[kept.id, 'theirs']]), report({ conflicts: [kept] }));
    expect(next.get(kept.id)).toBe('theirs');
  });

  it('drops selections whose conflict the re-merge removed', () => {
    const before = sel([
      [kept.id, 'ours'],
      [gone.id, 'theirs'],
    ]);
    const next = carryOver(before, report({ conflicts: [kept] }));
    expect(next.has(gone.id)).toBe(false);
    expect(next.size).toBe(1);
  });

  it('folds in choices the engine absorbed but the local map had lost', () => {
    const absorbed = conflict({ targetId: 'rec-9', resolution: 'user', applied: 'theirs' });
    const next = carryOver(sel(), report({ conflicts: [absorbed] }));
    expect(next.get(absorbed.id)).toBe('theirs');
  });

  it('never overwrites a live local choice with the seeded one', () => {
    const absorbed = conflict({ targetId: 'rec-9', resolution: 'user', applied: 'theirs' });
    const next = carryOver(sel([[absorbed.id, 'ours']]), report({ conflicts: [absorbed] }));
    expect(next.get(absorbed.id)).toBe('ours');
  });
});

describe('the resolutions sent to the engine', () => {
  it('is pruned to conflicts the current report actually has', () => {
    const live = conflict({ targetId: 'rec-1' });
    const dead = conflict({ targetId: 'rec-2' });
    const resolutions = toResolutions(
      sel([
        [live.id, 'ours'],
        [dead.id, 'theirs'],
      ]),
      report({ conflicts: [live] })
    );
    expect(resolutions).toEqual({ [live.id]: 'ours' });
  });

  it('is the whole accumulated map, not a delta', () => {
    const a = conflict({ targetId: 'rec-1', field: 'title' });
    const b = conflict({ targetId: 'rec-1', field: 'username' });
    const resolutions = toResolutions(
      sel([
        [a.id, 'ours'],
        [b.id, 'theirs'],
      ]),
      report({ conflicts: [a, b] })
    );
    expect(Object.keys(resolutions)).toHaveLength(2);
  });
});

describe('the summary the whole screen is gated on', () => {
  it('counts each kind of conflict once', () => {
    const needs = conflict({ targetId: 'rec-1', field: 'title' });
    const auto = conflict({ targetId: 'rec-2', field: 'username', resolution: 'policy' });
    const combined = conflict({
      targetId: 'rec-3',
      field: 'attachments',
      applied: 'merged',
      resolution: 'policy',
    });
    const summary = summarise(report({ conflicts: [needs, auto, combined] }), sel());

    expect(summary).toMatchObject({ choosable: 2, remaining: 1, auto: 1, combined: 1, chosen: 0 });
  });

  it('refuses to apply while anything is unanswered', () => {
    const summary = summarise(report({ conflicts: [conflict()] }), sel());
    expect(summary.readyToApply).toBe(false);
  });

  it('refuses to apply while a choice has not been folded into a merge', () => {
    const c = conflict();
    const summary = summarise(report({ conflicts: [c] }), sel([[c.id, 'ours']]));
    expect(summary.remaining).toBe(0);
    expect(summary.needsRemerge).toBe(true);
    expect(summary.readyToApply).toBe(false);
  });

  it('refuses to apply while the engine still says the merge is unresolved', () => {
    // The engine's flag is the authority. A report can only be built this way by hand, which is
    // exactly why the screen must not trust its own arithmetic alone.
    const resolved = conflict({ resolution: 'user', applied: 'ours' });
    const stale = { ...report({ conflicts: [resolved] }), requiresResolution: true };
    expect(summarise(stale, seedSelections(stale)).readyToApply).toBe(false);
  });

  it('a choice that overrides a policy decision still needs a re-merge', () => {
    const c = conflict({ resolution: 'policy', applied: 'theirs' });
    const summary = summarise(report({ conflicts: [c] }), sel([[c.id, 'ours']]));
    expect(summary.needsRemerge).toBe(true);
    expect(summary.readyToApply).toBe(false);
  });

  it('changing an answer to the other side needs a re-merge', () => {
    const c = conflict({ resolution: 'user', applied: 'ours' });
    const summary = summarise(report({ conflicts: [c] }), sel([[c.id, 'theirs']]));
    expect(summary.needsRemerge).toBe(true);
    expect(summary.readyToApply).toBe(false);
  });

  it('allows apply once the engine has re-run with every answer', () => {
    const c = conflict({ resolution: 'user', applied: 'ours' });
    const settled = report({ conflicts: [c] });
    expect(settled.requiresResolution).toBe(false);
    const summary = summarise(settled, seedSelections(settled));
    expect(summary).toMatchObject({ remaining: 0, needsRemerge: false, readyToApply: true });
  });

  it('allows apply on a report with nothing to settle at all', () => {
    expect(summarise(report(), sel()).readyToApply).toBe(true);
  });

  it('a merge whose only conflict is combined needs nothing from the user', () => {
    const combined = conflict({ applied: 'merged', resolution: 'policy' });
    const summary = summarise(report({ conflicts: [combined] }), sel());
    expect(summary).toMatchObject({ choosable: 0, remaining: 0, readyToApply: true });
  });
});

describe('choosing', () => {
  it('records and clears without mutating the previous map', () => {
    const before = sel();
    const after = choose(before, 'record:rec-1:field:title', 'theirs');
    expect(before.size).toBe(0);
    expect(after.get('record:rec-1:field:title')).toBe('theirs');
    expect(choose(after, 'record:rec-1:field:title', null).size).toBe(0);
  });
});
