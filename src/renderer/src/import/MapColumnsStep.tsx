// SPDX-License-Identifier: GPL-3.0-or-later
import { useId } from 'react';
import { CUSTOM_FIELD_TYPES, type CustomFieldType } from '@shared/model/credential.js';
import {
  normaliseColumnKey,
  type ColumnMapping,
  type ImportFieldTarget,
} from '@shared/model/import.js';
import type { ImportRecordPreview } from '@shared/model/import-plan.js';
import {
  customLabelFor,
  customTypeFor,
  FIELD_TARGET_COPY,
  SELECTABLE_FIELD_TARGETS,
  targetFor,
  withCustomLabel,
  withCustomType,
  withTarget,
} from './field-targets.js';
import {
  generalIssues,
  issuesForColumn,
  validateMapping,
  type MappingIssue,
} from './mapping-validation.js';
import { RecordPreviewTable } from './RecordPreviewTable.js';
import './import.css';
import { Icon } from '../components/Icon.js';

/**
 * Step three: say what the columns mean.
 *
 * Only the catch-all CSV parser reaches this step; the ten named formats already know. But
 * this is the step that decides whether Keyhold can take *anyone's* data or only data from
 * ten products, so it gets the real treatment rather than a bare list of dropdowns:
 *
 * - **Native controls throughout.** A `<select>` and an `<input>` are keyboard-operable,
 *   screen-reader-operable and platform-idiomatic without a line of JavaScript. A custom
 *   combobox here would be work spent making something worse.
 * - **Errors are attached to their control**, through `aria-describedby` and `aria-invalid`,
 *   not floated at the top of the table where someone working down the rows never meets them.
 * - **The sample below is the evidence.** Every change re-runs the real parse, so the table
 *   underneath is what the import will actually produce — not an approximation computed here.
 */
export function MapColumnsStep({
  columns,
  mapping,
  sample,
  onChange,
}: {
  readonly columns: readonly string[];
  readonly mapping: ColumnMapping;
  readonly sample: readonly ImportRecordPreview[];
  readonly onChange: (mapping: ColumnMapping) => void;
}): React.JSX.Element {
  const baseId = useId();
  const issues = validateMapping(columns, mapping);
  const general = generalIssues(issues);

  return (
    <div className="kh-import-step">
      {general.length > 0 && (
        <ul className="kh-import-issues">
          {general.map((issue) => (
            <li
              key={issue.id}
              id={issue.id}
              className={`kh-import-issue kh-import-issue--${issue.severity}`}
              // Errors are announced when they appear. A warning is context, not an
              // interruption, so it is not given a live region.
              role={issue.severity === 'error' ? 'alert' : undefined}
            >
              <Icon name={issue.severity === 'error' ? 'warning' : 'info'} size="sm" />
              <span>{issue.message}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="kh-import-table-scroll">
        <table className="kh-import-table kh-import-map">
          <caption className="kh-import-table__caption">
            One row per column in your file. Anything you leave as a custom field is kept under its
            own name — nothing is thrown away unless you say so.
          </caption>
          <thead>
            <tr>
              <th scope="col">Column in your file</th>
              <th scope="col">Becomes</th>
              <th scope="col">Custom field details</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((column) => (
              <ColumnRow
                key={normaliseColumnKey(column)}
                baseId={baseId}
                column={column}
                mapping={mapping}
                issues={issuesForColumn(issues, column)}
                onChange={onChange}
              />
            ))}
          </tbody>
        </table>
      </div>

      <RecordPreviewTable
        records={sample}
        caption="The first rows of your file, as this mapping reads them. Passwords and notes are never shown."
      />
    </div>
  );
}

function ColumnRow({
  baseId,
  column,
  mapping,
  issues,
  onChange,
}: {
  readonly baseId: string;
  readonly column: string;
  readonly mapping: ColumnMapping;
  readonly issues: readonly MappingIssue[];
  readonly onChange: (mapping: ColumnMapping) => void;
}): React.JSX.Element {
  const key = normaliseColumnKey(column);
  const target = targetFor(mapping, column);
  const selectId = `${baseId}-${key}-target`;
  const labelId = `${baseId}-${key}-label`;
  const typeId = `${baseId}-${key}-type`;

  const hasError = issues.some((issue) => issue.severity === 'error');
  const describedBy = [`${baseId}-${key}-help`, ...issues.map((issue) => issue.id)].join(' ');

  return (
    <tr
      className={hasError ? 'kh-import-map__row kh-import-map__row--error' : 'kh-import-map__row'}
    >
      {/* A row header, not a cell: it is the name of the thing every other cell describes. */}
      <th scope="row" className="kh-import-map__column">
        <label htmlFor={selectId}>{column}</label>
      </th>

      <td>
        <select
          id={selectId}
          className="kh-field__input"
          value={target}
          aria-invalid={hasError || undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            onChange(withTarget(mapping, column, event.target.value as ImportFieldTarget));
          }}
        >
          {SELECTABLE_FIELD_TARGETS.map((option) => (
            <option key={option} value={option}>
              {FIELD_TARGET_COPY[option].label}
            </option>
          ))}
        </select>
        <p className="kh-field__hint" id={`${baseId}-${key}-help`}>
          {FIELD_TARGET_COPY[target].help}
        </p>
        {issues.map((issue) => (
          <p
            key={issue.id}
            id={issue.id}
            className={issue.severity === 'error' ? 'kh-field__error' : 'kh-field__hint'}
            role={issue.severity === 'error' ? 'alert' : undefined}
          >
            {issue.message}
          </p>
        ))}
      </td>

      <td>
        {target === 'custom' ? (
          <div className="kh-import-map__custom">
            <div className="kh-field">
              <label className="kh-field__label" htmlFor={labelId}>
                Label
              </label>
              <div className="kh-field__control">
                <input
                  id={labelId}
                  className="kh-field__input"
                  type="text"
                  value={customLabelFor(mapping, column) ?? ''}
                  placeholder={column}
                  onChange={(event) => {
                    onChange(withCustomLabel(mapping, column, event.target.value));
                  }}
                />
              </div>
            </div>
            <div className="kh-field">
              <label className="kh-field__label" htmlFor={typeId}>
                Type
              </label>
              <div className="kh-field__control">
                <select
                  id={typeId}
                  className="kh-field__input"
                  value={customTypeFor(mapping, column) ?? ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    onChange(
                      withCustomType(
                        mapping,
                        column,
                        value === '' ? null : (value as CustomFieldType)
                      )
                    );
                  }}
                >
                  {/*
                   * "Work it out" is the default and stays available: the type guesser reads
                   * the label *and* the value, which is more than a user can do from a
                   * dropdown before they have seen the data.
                   */}
                  <option value="">Work it out from the data</option>
                  {CUSTOM_FIELD_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        ) : (
          <span className="kh-import-mask kh-import-mask--empty">—</span>
        )}
      </td>
    </tr>
  );
}
