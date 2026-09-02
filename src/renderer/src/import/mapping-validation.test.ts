// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ColumnMapping } from '@shared/model/import.js';
import { SINGLE_VALUED_IMPORT_TARGETS } from '@shared/model/import-plan.js';
import {
  generalIssues,
  issuesForColumn,
  mappingErrors,
  validateMapping,
} from './mapping-validation.js';
import { genericMapping } from './test-fixtures.js';

/**
 * What is wrong with a mapping, and which control it is wrong on.
 *
 * Two severities doing two different jobs. An **error** blocks the dry run because running
 * it would produce something the engine cannot honour. A **warning** blocks nothing; it says
 * what the user is about to get, so that "every record imported without a password" is a
 * thing they chose rather than a thing they discover afterwards — which is the failure this
 * step exists to prevent, and the reason the no-password case is a warning and not silence.
 *
 * Every issue is asserted to carry the column it belongs to, because an error floating at
 * the top of a table unattached to its row is invisible to someone working down the rows
 * with a screen reader (WCAG 3.3.1) and unhelpful to everyone else.
 */

function mapping(columns: Record<string, ColumnMapping['columns'][string]>): ColumnMapping {
  return { columns };
}

describe('errors, which block the dry run', () => {
  it('refuses two columns pointed at the same single-valued field', () => {
    const issues = mappingErrors(mapping({ pass: 'password', pwd: 'password', name: 'title' }));
    const passwordErrors = issues.filter((issue) => issue.severity === 'error');

    // One per offending column, so both dropdowns are marked rather than one of them.
    expect(passwordErrors.map((issue) => issue.columnKey).sort()).toEqual(['pass', 'pwd']);
    for (const issue of passwordErrors) expect(issue.message).toContain('password');
  });

  it('allows several columns to feed a field that accumulates', () => {
    // URLs and tags are lists; two columns of them is normal, not a conflict.
    expect(mappingErrors(mapping({ uri: 'url', uri2: 'url', name: 'title' }))).toEqual([]);
  });

  it('checks every single-valued target, not just the password', () => {
    for (const target of SINGLE_VALUED_IMPORT_TARGETS) {
      const issues = mappingErrors(mapping({ a: target, b: target, name: 'title' }));
      expect(issues.filter((issue) => issue.severity === 'error').length).toBeGreaterThanOrEqual(2);
    }
  });

  it('refuses a mapping that would produce no records at all', () => {
    // Tags, folders and favourites cannot make a record on their own — `finishDraft` returns
    // null for a draft with no content, so this would import several hundred nothings.
    const issues = mappingErrors(mapping({ folder: 'folder', fav: 'favorite', t: 'tags' }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.columnKey).toBeNull();
    expect(issues[0]?.message).toContain('no records');
  });

  it('is happy with a mapping that can work', () => {
    expect(mappingErrors(genericMapping())).toEqual([]);
  });

  it('gives every issue a stable id, so aria-describedby does not churn', () => {
    const broken = mapping({ pass: 'password', pwd: 'password' });
    expect(mappingErrors(broken).map((issue) => issue.id)).toEqual(
      mappingErrors(broken).map((issue) => issue.id)
    );
    expect(new Set(mappingErrors(broken).map((issue) => issue.id)).size).toBe(
      mappingErrors(broken).length
    );
  });
});

describe('warnings, which block nothing and say what will happen', () => {
  const columns = ['name', 'login_username', 'login_password', 'login_uri', 'folder', 'notes'];

  it('says so when nothing is mapped to the password', () => {
    const issues = validateMapping(columns, mapping({ name: 'title', login_uri: 'url' }));
    const warning = issues.find((issue) => issue.id === 'mapping-warning-no-password');
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toContain('without one');
  });

  it('says so when nothing is mapped to the title', () => {
    const issues = validateMapping(columns, mapping({ login_password: 'password' }));
    expect(issues.some((issue) => issue.id === 'mapping-warning-no-title')).toBe(true);
  });

  it('names each dropped column on its own row', () => {
    const issues = validateMapping(columns, {
      ...genericMapping(),
      columns: { ...genericMapping().columns, notes: 'drop' },
    });
    const dropped = issues.find((issue) => issue.id === 'mapping-warning-drop-notes');
    expect(dropped?.columnKey).toBe('notes');
    expect(dropped?.message).toContain('will not be in your vault');
  });

  it('warns on a header the mapping says nothing about', () => {
    // Not "ignored" — `mapCsvTable` carries it as a custom field. Saying so on the row beats
    // letting the user find it in the dry run under a heading they have to go and read.
    const issues = validateMapping([...columns, 'Reprompt'], genericMapping());
    const unmapped = issues.find((issue) => issue.id === 'mapping-warning-unmapped-reprompt');
    expect(unmapped?.message).toContain('custom field');
  });

  it('normalises the header before matching it against the mapping', () => {
    const issues = validateMapping(['  NAME  '], genericMapping());
    expect(issues.some((issue) => issue.id === 'mapping-warning-unmapped-name')).toBe(false);
  });

  it('keeps every error alongside the warnings', () => {
    const broken = mapping({ pass: 'password', pwd: 'password', name: 'title' });
    const all = validateMapping(['pass', 'pwd', 'name'], broken);
    expect(all.filter((issue) => issue.severity === 'error')).toHaveLength(2);
  });
});

describe('attaching issues to controls', () => {
  it('finds the issues for one column by its written header', () => {
    const broken = mapping({ pass: 'password', pwd: 'password', name: 'title' });
    const issues = validateMapping(['pass', 'pwd', 'name'], broken);
    expect(issuesForColumn(issues, '  PASS ')).toHaveLength(1);
    expect(issuesForColumn(issues, 'name')).toHaveLength(0);
  });

  it('separates the issues that belong to the mapping as a whole', () => {
    const issues = validateMapping([], mapping({ folder: 'folder' }));
    const general = generalIssues(issues);
    expect(general.length).toBeGreaterThan(0);
    for (const issue of general) expect(issue.columnKey).toBeNull();
  });
});
