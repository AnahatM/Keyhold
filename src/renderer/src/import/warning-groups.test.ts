// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { IMPORT_WARNING_KINDS, importWarning } from '@shared/model/import.js';
import { groupWarnings, lossWarnings, totalWarnings, warningHeadline } from './warning-groups.js';
import { PLANTED_WARNINGS } from './test-fixtures.js';

/**
 * Warnings are grouped, never hidden.
 *
 * The guard here is the conservation law: **every warning the engine produced appears in
 * exactly one group.** An importer that quietly drops the tail of its own warning list is
 * worse than one with no warnings at all, because the user has been told there is nothing
 * more to see. `totalWarnings` is therefore asserted against the input length rather than
 * against a number written down beside it.
 */

describe('grouping warnings', () => {
  it('loses none of them', () => {
    const groups = groupWarnings(PLANTED_WARNINGS);
    expect(totalWarnings(groups)).toBe(PLANTED_WARNINGS.length);
  });

  it('puts each warning in exactly one group', () => {
    const groups = groupWarnings(PLANTED_WARNINGS);
    const seen = groups.flatMap((group) => group.warnings);
    expect(seen).toHaveLength(PLANTED_WARNINGS.length);
    expect(new Set(seen).size).toBe(PLANTED_WARNINGS.length);
  });

  it('has words for every kind the engine can emit', () => {
    // One warning of every kind — so a kind added to the engine without copy here shows up
    // as an unlabelled group rather than as a blank line in front of a user.
    const everyKind = IMPORT_WARNING_KINDS.map((kind) =>
      importWarning(kind, 'Something happened.')
    );
    const groups = groupWarnings(everyKind);

    expect(groups).toHaveLength(IMPORT_WARNING_KINDS.length);
    for (const group of groups) {
      expect(group.label).not.toBe('');
      expect(group.description).not.toBe('');
      expect(['loss', 'notice']).toContain(group.severity);
    }
  });

  it('puts everything that lost data ahead of everything that did not', () => {
    const everyKind = IMPORT_WARNING_KINDS.map((kind) =>
      importWarning(kind, 'Something happened.')
    );
    const severities = groupWarnings(everyKind).map((group) => group.severity);
    const firstNotice = severities.indexOf('notice');
    expect(severities.slice(0, firstNotice).every((severity) => severity === 'loss')).toBe(true);
    expect(severities.slice(firstNotice).every((severity) => severity === 'notice')).toBe(true);
  });

  it('omits a kind with nothing in it rather than printing an empty heading', () => {
    const groups = groupWarnings([importWarning('skipped-row', 'Row was empty.', { line: 4 })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('skipped-row');
  });

  it('counts losses apart from notices', () => {
    const groups = groupWarnings(PLANTED_WARNINGS);
    // Three losses in the fixture: two dropped values and one skipped row.
    expect(lossWarnings(groups)).toBe(3);
    expect(totalWarnings(groups) - lossWarnings(groups)).toBe(3);
  });
});

describe('the headline', () => {
  it('says nothing was lost when nothing was', () => {
    expect(warningHeadline(groupWarnings([]))).toContain('Nothing was lost');
  });

  it('says the loss count out loud when there is one', () => {
    // "12 notes" and "12 things you are about to lose" are the same number and completely
    // different sentences. The user is entitled to the second one.
    const headline = warningHeadline(groupWarnings(PLANTED_WARNINGS));
    expect(headline).toContain('3 things');
    expect(headline).toContain('will not reach your vault');
  });

  it('does not claim a loss when every warning is a notice', () => {
    const notices = groupWarnings([
      importWarning('derived-value', 'Title worked out from the web address.'),
    ]);
    const headline = warningHeadline(notices);
    expect(headline).toBe('1 note about how this file was read.');
    expect(headline).not.toContain('will not reach');
  });

  it('pluralises one of a thing correctly', () => {
    const single = groupWarnings([importWarning('skipped-row', 'Row was empty.', { line: 2 })]);
    expect(warningHeadline(single)).toBe('1 thing in this file will not reach your vault.');
  });
});
