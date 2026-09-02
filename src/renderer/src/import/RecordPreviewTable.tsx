// SPDX-License-Identifier: GPL-3.0-or-later
import type { ImportRecordPreview } from '@shared/model/import-plan.js';
import { SecretMask } from './SecretMask.js';
import './import.css';

/**
 * The first few records, as they will be imported.
 *
 * This is the control that makes column mapping possible: a dropdown labelled "Username" is
 * a claim, and this table is the evidence. Without it the user is choosing between thirteen
 * abstract targets and finding out whether they were right after the import.
 *
 * **It renders the safe projection and nothing else.** There is no prop here that could carry
 * a password: the model is `ImportRecordPreview`, whose only knowledge of one is its length,
 * and the length is rendered by {@link SecretMask}, which takes a number. Notes are treated
 * identically — free text is where people keep recovery codes, so it is secret by the same
 * rule that makes it secret in `CredentialProjection`.
 */
export function RecordPreviewTable({
  records,
  caption,
}: {
  readonly records: readonly ImportRecordPreview[];
  readonly caption: string;
}): React.JSX.Element {
  if (records.length === 0) {
    return (
      <p className="kh-import-empty-note">
        No records yet — the mapping does not produce anything from this file.
      </p>
    );
  }

  return (
    // The wrapper scrolls, not the page: a mapping with fourteen columns is wide, and a
    // horizontally scrolling dialog is a dialog whose buttons walk off the screen.
    <div className="kh-import-table-scroll">
      <table className="kh-import-table">
        <caption className="kh-import-table__caption">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Title</th>
            <th scope="col">Login</th>
            <th scope="col">Web address</th>
            <th scope="col">Folder</th>
            <th scope="col">Password</th>
            <th scope="col">Other fields</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.index}>
              <th scope="row" className="kh-import-table__title">
                {record.title}
                {record.favorite && (
                  <span className="kh-import-table__flag">
                    <span aria-hidden="true">★</span>
                    <span className="kh-visually-hidden">Favourite</span>
                  </span>
                )}
              </th>
              <td>{record.username !== '' ? record.username : record.email}</td>
              <td className="kh-import-table__url">{record.urls[0] ?? ''}</td>
              <td>{record.folderPath ?? ''}</td>
              <td>
                <SecretMask length={record.passwordLength} what="password" />
              </td>
              <td>
                <OtherFields record={record} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Everything that did not get a column of its own: notes, tags, and custom fields.
 *
 * Summarised rather than listed in full, because the point of this table is "did my columns
 * land in the right places", and a row three lines tall makes five records unreadable. A
 * secret custom value is named and marked; it is never shown, and neither is a note.
 */
function OtherFields({ record }: { readonly record: ImportRecordPreview }): React.JSX.Element {
  const parts: React.JSX.Element[] = [];

  if (record.hasNotes) {
    parts.push(
      <span key="notes" className="kh-import-chip">
        Notes: <SecretMask length={record.notesLength} what="note" />
      </span>
    );
  }

  for (const tag of record.tags) {
    parts.push(
      <span key={`tag-${tag}`} className="kh-import-chip">
        #{tag}
      </span>
    );
  }

  for (const field of record.custom) {
    parts.push(
      <span key={`custom-${field.label}`} className="kh-import-chip">
        {field.label}:{' '}
        {field.isSecret ? (
          <span>
            <span aria-hidden="true">•••</span>
            <span className="kh-visually-hidden">hidden, {field.type}</span>
          </span>
        ) : (
          (field.value ?? '')
        )}
      </span>
    );
  }

  if (parts.length === 0) return <span className="kh-import-mask kh-import-mask--empty">—</span>;
  return <span className="kh-import-chips">{parts}</span>;
}
