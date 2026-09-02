// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { IMPORT_FIELD_TARGETS } from '@shared/model/import.js';
import {
  CONTENT_FIELD_TARGETS,
  columnsWithTarget,
  customLabelFor,
  customTypeFor,
  FIELD_TARGET_COPY,
  SELECTABLE_FIELD_TARGETS,
  targetFor,
  withCustomLabel,
  withCustomType,
  withTarget,
} from './field-targets.js';
import { genericMapping } from './test-fixtures.js';

/**
 * The mapping table's vocabulary, and the pure edits it performs.
 *
 * The edits are the part worth testing. They are pure functions over `ColumnMapping` rather
 * than mutations because the same mapping object is what a pending preview request carries:
 * an in-place edit would change the mapping a request was issued for, and the answer coming
 * back would describe something the user had already moved on from.
 */

describe('the vocabulary', () => {
  it('has words for every target, so no dropdown option can render blank', () => {
    for (const target of IMPORT_FIELD_TARGETS) {
      expect(FIELD_TARGET_COPY[target].label).not.toBe('');
      expect(FIELD_TARGET_COPY[target].help).not.toBe('');
    }
  });

  it('does not offer the parser’s internal target as a user choice', () => {
    // "Handled by the format" and "Don't import" would read as interchangeable options, and
    // one of them loses data while the other does not.
    expect(SELECTABLE_FIELD_TARGETS).not.toContain('ignore');
    expect(SELECTABLE_FIELD_TARGETS).toContain('drop');
    expect(SELECTABLE_FIELD_TARGETS).toHaveLength(IMPORT_FIELD_TARGETS.length - 1);
  });

  it('counts as content only the targets that can put something in a record', () => {
    for (const target of ['tags', 'folder', 'favorite', 'drop', 'ignore'] as const) {
      expect(CONTENT_FIELD_TARGETS).not.toContain(target);
    }
    for (const target of ['title', 'username', 'password', 'url', 'notes'] as const) {
      expect(CONTENT_FIELD_TARGETS).toContain(target);
    }
  });
});

describe('reading a mapping', () => {
  it('looks a column up by its written header, however it was written', () => {
    expect(targetFor(genericMapping(), '  Login_Password ')).toBe('password');
  });

  it('treats a column the mapping has never heard of as a custom field', () => {
    // Which is what `mapCsvTable` actually does with it, so the dropdown shows the truth.
    expect(targetFor(genericMapping(), 'Reprompt')).toBe('custom');
  });

  it('lists every column pointed at a target', () => {
    expect(columnsWithTarget(genericMapping(), 'password')).toEqual(['login_password']);
    expect(columnsWithTarget(genericMapping(), 'totp')).toEqual([]);
  });
});

describe('editing a mapping', () => {
  it('never mutates the mapping it was given', () => {
    const before = genericMapping();
    const snapshot = JSON.stringify(before);
    withTarget(before, 'notes', 'drop');
    withCustomType(before, 'notes', 'multiline');
    withCustomLabel(before, 'notes', 'Remarks');
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('clears a custom label and type when a column stops being custom', () => {
    // A dead override would silently reappear if the column were moved back — and, worse,
    // would be sent in a preview request for a column that is no longer custom.
    const custom = withCustomLabel(
      withCustomType(withTarget(genericMapping(), 'Reprompt', 'custom'), 'Reprompt', 'boolean'),
      'Reprompt',
      'Ask again'
    );
    expect(customTypeFor(custom, 'Reprompt')).toBe('boolean');
    expect(customLabelFor(custom, 'Reprompt')).toBe('Ask again');

    const moved = withTarget(custom, 'Reprompt', 'drop');
    expect(customTypeFor(moved, 'Reprompt')).toBeNull();
    expect(customLabelFor(moved, 'Reprompt')).toBeNull();
  });

  it('keeps the overrides when a column stays custom', () => {
    const custom = withCustomLabel(withTarget(genericMapping(), 'x', 'custom'), 'x', 'Extra');
    expect(customLabelFor(withTarget(custom, 'x', 'custom'), 'x')).toBe('Extra');
  });

  it('lets "work it out" be chosen again after picking a type wrongly', () => {
    const typed = withCustomType(genericMapping(), 'x', 'date');
    expect(customTypeFor(typed, 'x')).toBe('date');
    expect(customTypeFor(withCustomType(typed, 'x', null), 'x')).toBeNull();
  });

  it('clears a custom label rather than storing an empty one', () => {
    // An empty override would produce a field labelled `Field`, which is a silent downgrade
    // from emptying a box the user only meant to retype.
    const labelled = withCustomLabel(genericMapping(), 'x', 'Extra');
    expect(customLabelFor(withCustomLabel(labelled, 'x', '   '), 'x')).toBeNull();
  });
});
