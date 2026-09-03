// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { MERGE_MODES } from '@shared/model/sync.js';
import {
  countsSentence,
  MERGE_MODE_EXPLANATIONS,
  MERGE_MODE_HEADLINES,
  modeNotice,
  remainingHeadline,
  showsAncestor,
} from './merge-mode.js';
import { NO_SELECTIONS, summarise } from './resolution-state.js';
import { conflict, report } from './test-fixtures.js';
import { groupNotes, notesHeadline, totalNotes } from './merge-notes.js';

/**
 * That two-way and three-way are presented as the different situations they are.
 *
 * Fault injections performed:
 *
 *  1. `MERGE_MODE_EXPLANATIONS` sharing one string across both modes — fails "the two modes are
 *     explained differently, not with one hedged sentence".
 *  2. `showsAncestor` returning `true` for both — fails "two-way has no ancestor column,
 *     because there was no ancestor".
 *  3. `remainingHeadline` using a fixed noun — fails "a two-way difference is not called a
 *     disagreement".
 *  4. `countsSentence` printing `counts.base ?? 0` — fails "never invents an ancestor count in
 *     two-way mode".
 *  5. Dropping the two-way `MERGE_MODE_CONSEQUENCES` entry — fails "two-way says out loud that
 *     nothing was deleted".
 *  6. `groupNotes` filtering out a kind — fails "every note reaches exactly one group".
 */

describe('the mode notice', () => {
  it('the two modes are explained differently, not with one hedged sentence', () => {
    expect(MERGE_MODE_HEADLINES['two-way']).not.toBe(MERGE_MODE_HEADLINES['three-way']);
    expect(MERGE_MODE_EXPLANATIONS['two-way']).not.toBe(MERGE_MODE_EXPLANATIONS['three-way']);
    for (const mode of MERGE_MODES) {
      expect(MERGE_MODE_EXPLANATIONS[mode].length, mode).toBeGreaterThan(80);
    }
  });

  it('two-way says out loud that nothing was deleted', () => {
    const notice = modeNotice('two-way');
    expect(notice.consequence).not.toBeNull();
    expect(notice.consequence ?? '').toContain('Nothing has been deleted');
  });

  it('three-way does not carry the two-way caveat', () => {
    expect(modeNotice('three-way').consequence).toBeNull();
  });

  it('gives each mode a distinct symbol, so the banner is not colour alone', () => {
    expect(modeNotice('two-way').symbol).not.toBe(modeNotice('three-way').symbol);
  });

  it('two-way explains why the list is long, rather than apologising for it', () => {
    expect(MERGE_MODE_EXPLANATIONS['two-way']).toContain('guessing');
  });
});

describe('the ancestor column', () => {
  it('two-way has no ancestor column, because there was no ancestor', () => {
    expect(showsAncestor('two-way')).toBe(false);
    expect(showsAncestor('three-way')).toBe(true);
  });
});

describe('the counting sentence', () => {
  it('a two-way difference is not called a disagreement', () => {
    const twoWay = report({ mode: 'two-way', conflicts: [conflict()] });
    const threeWay = report({ mode: 'three-way', conflicts: [conflict()] });

    expect(remainingHeadline(twoWay, summarise(twoWay, NO_SELECTIONS))).toContain('difference');
    expect(remainingHeadline(threeWay, summarise(threeWay, NO_SELECTIONS))).toContain(
      'disagreement'
    );
  });

  it('says something true when there is nothing at all to settle, in each mode', () => {
    const twoWay = report({ mode: 'two-way' });
    const threeWay = report({ mode: 'three-way' });
    expect(remainingHeadline(twoWay, summarise(twoWay, NO_SELECTIONS))).toContain(
      'same values everywhere'
    );
    expect(remainingHeadline(threeWay, summarise(threeWay, NO_SELECTIONS))).toContain(
      'changed in both files'
    );
  });

  it('counts down rather than counting up', () => {
    const source = report({
      conflicts: [
        conflict({ targetId: 'rec-1', field: 'title' }),
        conflict({ targetId: 'rec-2', field: 'title' }),
      ],
    });
    const answered = new Map([[source.conflicts[0]?.id ?? '', 'ours' as const]]);
    expect(remainingHeadline(source, summarise(source, answered))).toBe(
      '1 of 2 disagreements still to answer.'
    );
  });

  it('never invents an ancestor count in two-way mode', () => {
    const twoWay = report({
      mode: 'two-way',
      counts: {
        ours: 5,
        theirs: 6,
        base: null,
        merged: 7,
        added: 2,
        updated: 1,
        unchanged: 4,
        trashed: 0,
        conflicted: 1,
      },
    });
    const sentence = countsSentence(twoWay);
    expect(sentence).not.toContain('last agreed');
    expect(sentence).toContain('7 records after merging');
  });

  it('states the ancestor count in three-way mode, where there is one', () => {
    expect(countsSentence(report())).toContain('when the two files last agreed');
  });
});

describe('the notes panel', () => {
  it('every note reaches exactly one group', () => {
    const notes = [
      { kind: 'record-added' as const, targetId: 'rec-1', count: null },
      { kind: 'record-added' as const, targetId: 'rec-2', count: null },
      { kind: 'record-kept-unmatched' as const, targetId: 'rec-3', count: null },
      { kind: 'history-truncated' as const, targetId: 'rec-1', count: 12 },
    ];
    const groups = groupNotes(notes);
    expect(totalNotes(groups)).toBe(notes.length);
  });

  it('sorts the things worth looking at above the things that are merely true', () => {
    const groups = groupNotes([
      { kind: 'record-added', targetId: 'rec-1', count: null },
      { kind: 'attachment-needed', targetId: 'chunk-1', count: null },
    ]);
    expect(groups[0]?.kind).toBe('attachment-needed');
    expect(groups[0]?.severity).toBe('attention');
  });

  it('sums the counted kinds rather than showing a bare group size', () => {
    const groups = groupNotes([
      { kind: 'history-truncated', targetId: 'rec-1', count: 12 },
      { kind: 'history-truncated', targetId: 'rec-2', count: 30 },
    ]);
    expect(groups[0]?.total).toBe(42);
  });

  it('leads with the attention count when there is one', () => {
    const groups = groupNotes([
      { kind: 'record-kept-unmatched', targetId: 'rec-1', count: null },
      { kind: 'tag-added', targetId: 'tag-1', count: null },
    ]);
    expect(notesHeadline(groups)).toContain('1 thing worth looking at');
  });

  it('says nothing happened rather than showing an empty panel heading', () => {
    expect(notesHeadline(groupNotes([]))).toContain('no decisions of its own');
  });
});
