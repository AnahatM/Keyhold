// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { SECRET_VERSIONED_FIELDS, VERSIONED_FIELDS } from '@shared/model/credential.js';
import { MERGE_CONFLICT_KINDS } from '@shared/model/sync.js';
import {
  CONFLICT_KIND_MEANINGS,
  CONFLICT_KIND_SYMBOLS,
  conflictQuestion,
  describeSide,
  fieldLabel,
  hidesValue,
  targetKindOf,
} from './conflict-language.js';
import { nameTarget, targetNamesFrom } from './merge-targets.js';
import {
  conflict,
  names,
  secret,
  value,
  PLANTED_SECRET,
  plantedSecretSide,
} from './test-fixtures.js';

/**
 * The English layer: that a conflict can be read, and that reading it leaks nothing.
 *
 * Fault injections performed:
 *
 *  1. `fieldLabel` returning `conflict.field ?? ''` — fails "never renders a raw identifier"
 *     and "every versioned field has a word for it".
 *  2. Removing `humanise`'s fallback so an unknown property returns `''` — fails "an identifier
 *     the maps have never heard of is still readable".
 *  3. `hidesValue` testing only `SECRET_VERSIONED_FIELDS` — fails "a side that crossed as a
 *     secret is hidden whatever the field is called".
 *  4. `describeSide` returning `String(side.value)` for the `secret` arm — fails "a secret side
 *     renders its length and nothing that came with it".
 *  5. `describeSide`'s `absent` arm returning the same text as an empty string — fails "not in
 *     this file is not the same as empty".
 *  6. `nameTarget` returning `targetId` when nothing is found — fails "a missing name falls back
 *     to something readable, never a raw id".
 */

describe('naming the property', () => {
  it('every versioned field has a word for it, and none is its own identifier', () => {
    for (const field of VERSIONED_FIELDS) {
      const label = fieldLabel(conflict({ field }));
      expect(label, field).not.toBe(field);
      expect(label.length, field).toBeGreaterThan(0);
      expect(label[0], field).toBe(label[0]?.toUpperCase());
    }
  });

  it('names the folder and tag properties the engine actually emits', () => {
    expect(fieldLabel(conflict({ kind: 'folder', field: 'name' }))).toBe('Name');
    expect(fieldLabel(conflict({ kind: 'folder', field: 'parentId' }))).toBe('Parent folder');
    expect(fieldLabel(conflict({ kind: 'tag', field: 'colour' }))).toBe('Colour');
    expect(fieldLabel(conflict({ kind: 'record-history', field: 'maxVersions' }))).toBe(
      'Versions kept'
    );
  });

  it('names a setting by its key, because a setting conflict has no field', () => {
    const c = conflict({ kind: 'setting', targetId: 'trashRetentionDays', field: null });
    expect(fieldLabel(c)).toBe('Days a trashed record is kept');
  });

  it('never renders a raw identifier', () => {
    const c = conflict({ field: 'rotationIntervalDays' });
    expect(fieldLabel(c)).not.toContain('rotationIntervalDays');
    expect(fieldLabel(c)).not.toContain(':');
  });

  it('an identifier the maps have never heard of is still readable', () => {
    expect(fieldLabel(conflict({ field: 'someBrandNewProperty' }))).toBe('Some brand new property');
  });
});

describe('what kind of thing conflicted', () => {
  it('every conflict kind has a subject, a meaning and a distinct icon', () => {
    const icons = new Set<string>();
    for (const kind of MERGE_CONFLICT_KINDS) {
      expect(CONFLICT_KIND_MEANINGS[kind].length, kind).toBeGreaterThan(20);
      expect(targetKindOf(conflict({ kind })), kind).toBeTruthy();
      icons.add(CONFLICT_KIND_SYMBOLS[kind]);
    }
    // Distinct shapes, so the signal survives greyscale and a colour-blind reader. The names
    // are typed `IconName`, so this is the half the type cannot check: six valid names that
    // happen to be the same name would compile and would draw six identical rows.
    expect(icons.size).toBe(MERGE_CONFLICT_KINDS.length);
  });

  it('routes each kind to the right subject', () => {
    expect(targetKindOf(conflict({ kind: 'record-field' }))).toBe('record');
    expect(targetKindOf(conflict({ kind: 'record-delete-vs-edit' }))).toBe('record');
    expect(targetKindOf(conflict({ kind: 'record-history' }))).toBe('record');
    expect(targetKindOf(conflict({ kind: 'folder' }))).toBe('folder');
    expect(targetKindOf(conflict({ kind: 'tag' }))).toBe('tag');
    expect(targetKindOf(conflict({ kind: 'setting' }))).toBe('setting');
  });
});

describe('which conflicts hide their value', () => {
  it('every field the model classifies as secret hides its value', () => {
    for (const field of SECRET_VERSIONED_FIELDS) {
      expect(hidesValue(conflict({ field, ours: value('x'), theirs: value('y') })), field).toBe(
        true
      );
    }
  });

  it('a side that crossed as a secret is hidden whatever the field is called', () => {
    expect(hidesValue(conflict({ field: 'title', ours: secret(4), theirs: value('b') }))).toBe(
      true
    );
  });

  it('a plain field with plain sides is not hidden', () => {
    expect(hidesValue(conflict({ field: 'username' }))).toBe(false);
  });
});

describe('rendering one side', () => {
  it('a secret side renders its length and nothing that came with it', () => {
    const summary = describeSide(plantedSecretSide(18), 'password');
    expect(summary.maskLength).toBe(18);
    expect(summary.hidden).toBe(true);
    expect(summary.text).toBe('Hidden — 18 characters');
    expect(JSON.stringify(summary)).not.toContain(PLANTED_SECRET);
  });

  it('says one character rather than 1 characters', () => {
    expect(describeSide(secret(1), 'password').text).toBe('Hidden — 1 character');
  });

  it('not in this file is not the same as empty', () => {
    const absent = describeSide({ kind: 'absent' }, 'title');
    const empty = describeSide(value(''), 'title');
    expect(absent.absent).toBe(true);
    expect(empty.absent).toBe(false);
    expect(absent.text).not.toBe(empty.text);
  });

  it('reads a trash timestamp as a trash state, not as a number', () => {
    expect(describeSide(value(null), 'trashedAt').text).toBe('Not in the trash');
    expect(describeSide({ kind: 'value', value: 1_700_000_000_000 }, 'trashedAt').text).toContain(
      'In the trash since'
    );
  });

  it('renders an empty list as None rather than as nothing', () => {
    expect(describeSide(value([]), 'tags').text).toBe('None');
    expect(describeSide(value(['work', 'cloud']), 'tags').text).toBe('work, cloud');
  });

  it('shows a custom field’s label and type, never its value', () => {
    const summary = describeSide(
      {
        kind: 'custom',
        fields: [
          {
            id: 'cf-1',
            label: 'Recovery code',
            type: 'text',
            hidden: false,
            order: 0,
            value: PLANTED_SECRET,
            hasValue: true,
            isSecret: false,
          },
        ],
      },
      'custom'
    );
    expect(summary.entries[0]?.label).toBe('Recovery code');
    expect(JSON.stringify(summary)).not.toContain(PLANTED_SECRET);
  });

  it('shows a security question’s prompt and whether it is answered, never the answer', () => {
    const summary = describeSide(
      { kind: 'questions', questions: [{ id: 'sq-1', question: 'First pet', hasAnswer: true }] },
      'securityQuestions'
    );
    expect(summary.entries[0]?.label).toBe('First pet');
    expect(summary.entries[0]?.detail).toContain('hidden');
  });
});

describe('naming the thing', () => {
  it('uses the title the vault list already holds', () => {
    expect(nameTarget('record', 'rec-1', names()).name).toBe('GitHub');
    expect(nameTarget('record', 'rec-1', names()).path).toBe('Work / Cloud');
  });

  it('a missing name falls back to something readable, never a raw id', () => {
    const fallback = nameTarget('record', '3f2ac1d0-9999-4444-8888-000000000000', names());
    expect(fallback.isFallback).toBe(true);
    expect(fallback.name).toBe('Record 3f2ac1d0…');
    expect(fallback.name).not.toContain('9999');
  });

  it('an untitled record gets the fallback rather than a blank heading', () => {
    const blank = targetNamesFrom({ records: [{ id: 'rec-9', title: '   ' }] });
    expect(nameTarget('record', 'rec-9', blank).isFallback).toBe(true);
  });

  it('stops at a folder cycle instead of walking it forever', () => {
    const cyclic = targetNamesFrom({
      folders: [
        { id: 'a', name: 'A', parentId: 'b' },
        { id: 'b', name: 'B', parentId: 'a' },
      ],
      records: [{ id: 'rec-1', title: 'X' }],
      recordFolders: [{ id: 'rec-1', folderId: 'a' }],
    });
    expect(nameTarget('record', 'rec-1', cyclic).path).toBe('B / A');
  });
});

describe('the question a row asks', () => {
  it('names the record and the property, not the id', () => {
    const target = nameTarget('record', 'rec-1', names());
    const question = conflictQuestion(conflict({ targetId: 'rec-1', field: 'password' }), target);
    expect(question).toBe('Which password should GitHub keep?');
    expect(question).not.toContain('rec-1');
  });

  it('asks a delete-versus-edit as the decision it actually is', () => {
    const target = nameTarget('record', 'rec-2', names());
    const question = conflictQuestion(
      conflict({ kind: 'record-delete-vs-edit', targetId: 'rec-2', field: 'trashedAt' }),
      target
    );
    expect(question).toContain('trashed in one file and edited in the other');
  });
});
