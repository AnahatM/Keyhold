// SPDX-License-Identifier: GPL-3.0-or-later
import {
  isSingleValuedImportTarget,
  SINGLE_VALUED_IMPORT_TARGETS,
} from '@shared/model/import-plan.js';
import { normaliseColumnKey, type ColumnMapping } from '@shared/model/import.js';
import { CONTENT_FIELD_TARGETS, columnsWithTarget, FIELD_TARGET_COPY } from './field-targets.js';

/**
 * What is wrong with a mapping, and which control it is wrong on.
 *
 * Two severities with two different jobs. An **error** blocks the dry run, because running it
 * would produce a result the engine cannot honour — two columns cannot both be the password.
 * A **warning** does not block anything; it says what the user is about to get, so that
 * "every record imported without a password" is a thing they chose rather than a thing they
 * discover afterwards.
 *
 * Every issue carries the column key it belongs to and a stable `id`, so the mapping table
 * can wire it to its control with `aria-describedby` and `aria-invalid`. An error message
 * floating at the top of a table, unattached to the row that caused it, is invisible to a
 * screen-reader user working down the rows — which is WCAG 3.3.1, and also just unhelpful.
 */

export type MappingIssueSeverity = 'error' | 'warning';

export interface MappingIssue {
  /** Stable across renders for the same problem, so `aria-describedby` does not churn. */
  readonly id: string;
  /** The normalised column key, or `null` for a problem with the mapping as a whole. */
  readonly columnKey: string | null;
  readonly severity: MappingIssueSeverity;
  readonly message: string;
}

/**
 * The problems that make a mapping unrunnable.
 *
 * Separate from {@link validateMapping} because the step machine needs this answer without a
 * column list — `canAdvance` is a pure function of state, and threading the header row into
 * it to ask "may I press Continue" would put a rendering concern in the machine.
 */
export function mappingErrors(mapping: ColumnMapping): readonly MappingIssue[] {
  const issues: MappingIssue[] = [];

  for (const target of SINGLE_VALUED_IMPORT_TARGETS) {
    const claimants = columnsWithTarget(mapping, target);
    if (claimants.length < 2) continue;
    const label = FIELD_TARGET_COPY[target].label.toLowerCase();
    for (const key of claimants) {
      issues.push({
        id: `mapping-error-${target}-${key}`,
        columnKey: key,
        severity: 'error',
        message: `${claimants.length} columns are set to ${label}, and a record has only one. Point all but one somewhere else.`,
      });
    }
  }

  const hasContent = CONTENT_FIELD_TARGETS.some(
    (target) => columnsWithTarget(mapping, target).length > 0
  );
  if (!hasContent) {
    issues.push({
      id: 'mapping-error-empty',
      columnKey: null,
      severity: 'error',
      message:
        'Nothing is mapped to a field that can hold content, so this import would produce no records. Map at least one column to a title, login, password, web address or custom field.',
    });
  }

  return issues;
}

/**
 * Everything worth saying about a mapping: the errors, plus the consequences.
 *
 * The warnings are the ones a user would otherwise only learn from the result screen — and
 * two of them are the difference between a usable vault and a useless one. A CSV imported
 * with no password column produces several hundred records that look right and cannot log in
 * to anything.
 */
export function validateMapping(
  columns: readonly string[],
  mapping: ColumnMapping
): readonly MappingIssue[] {
  const issues: MappingIssue[] = [...mappingErrors(mapping)];

  if (columnsWithTarget(mapping, 'password').length === 0) {
    issues.push({
      id: 'mapping-warning-no-password',
      columnKey: null,
      severity: 'warning',
      message:
        'No column is mapped to the password. Every record will be imported without one — check this is what you meant.',
    });
  }

  if (columnsWithTarget(mapping, 'title').length === 0) {
    issues.push({
      id: 'mapping-warning-no-title',
      columnKey: null,
      severity: 'warning',
      message:
        'No column is mapped to the title. Keyhold will work one out from the web address or the login, and will tell you which records it did that for.',
    });
  }

  for (const key of columnsWithTarget(mapping, 'drop')) {
    issues.push({
      id: `mapping-warning-drop-${key}`,
      columnKey: key,
      severity: 'warning',
      message: 'This column will not be in your vault.',
    });
  }

  // A header the mapping says nothing about is not "ignored" — `mapCsvTable` carries it as a
  // custom field and warns. Saying so here, on the row, is better than letting the user find
  // it in the dry run's warning list under a heading they have to go and read.
  for (const column of columns) {
    const key = normaliseColumnKey(column);
    if (key === '' || key in mapping.columns) continue;
    issues.push({
      id: `mapping-warning-unmapped-${key}`,
      columnKey: key,
      severity: 'warning',
      message: 'Not mapped, so it will be kept as a custom field under its own name.',
    });
  }

  return issues;
}

/** The issues attached to one control, for its `aria-describedby`. */
export function issuesForColumn(
  issues: readonly MappingIssue[],
  column: string
): readonly MappingIssue[] {
  const key = normaliseColumnKey(column);
  return issues.filter((issue) => issue.columnKey === key);
}

/** The issues that belong to the mapping as a whole rather than to any one column. */
export function generalIssues(issues: readonly MappingIssue[]): readonly MappingIssue[] {
  return issues.filter((issue) => issue.columnKey === null);
}

/** True when a target is one a record can only hold once — for the dropdown's own hint. */
export { isSingleValuedImportTarget };
