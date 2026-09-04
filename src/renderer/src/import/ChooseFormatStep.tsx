// SPDX-License-Identifier: GPL-3.0-or-later
import { useId } from 'react';
import type { ImportFormatDescriptor } from '@shared/model/import.js';
import type { ImportSource } from '@shared/model/import-plan.js';
import { Icon } from '../components/Icon.js';
import './import.css';

/**
 * Step two: confirm the format.
 *
 * **Detection is a suggestion and the user decides.** `detectFormat` reads a header row,
 * which is weak evidence — two products ship the same columns, and a renamed file carries
 * none at all. So the detected format is pre-selected and the formats that *also* claimed
 * the file are offered beside it, in the registry's own confidence order, with everything
 * else one control away.
 *
 * The alternatives are the part that matters. A Safari export whose columns are a subset of
 * 1Password's will be claimed by both; if the wizard only showed the winner, a user whose
 * file was read by the wrong parser would have no way to say so except to give up.
 */
export function ChooseFormatStep({
  source,
  formats,
  formatId,
  onChange,
}: {
  readonly source: ImportSource;
  readonly formats: readonly ImportFormatDescriptor[];
  readonly formatId: string | null;
  readonly onChange: (formatId: string) => void;
}): React.JSX.Element {
  const groupName = useId();
  const otherSelectId = `${groupName}-other`;

  const candidates = source.candidateFormatIds
    .map((id) => formats.find((format) => format.id === id))
    .filter((format): format is ImportFormatDescriptor => format !== undefined);

  const candidateIds = new Set(candidates.map((format) => format.id));
  const usingOther = formatId !== null && !candidateIds.has(formatId);

  return (
    <div className="kh-import-step">
      <fieldset className="kh-import-fieldset">
        <legend className="kh-import-section__heading">
          Which of these is <span className="kh-import-filename">{source.fileName}</span>?
        </legend>

        {candidates.length === 0 && (
          <p className="kh-import-note kh-import-note--warning">
            <Icon name="warning" /> Nothing recognised this file. Pick a format below — “Any CSV
            file” lets you map the columns yourself, and works for exports Keyhold has never seen.
          </p>
        )}

        {candidates.map((format, index) => (
          <label key={format.id} className="kh-import-choice">
            <input
              type="radio"
              name={groupName}
              value={format.id}
              checked={formatId === format.id}
              onChange={() => {
                onChange(format.id);
              }}
              {...(index === 0 ? { 'data-kh-autofocus': true } : {})}
            />
            <span className="kh-import-choice__body">
              <span className="kh-import-choice__label">
                {format.name}
                {format.id === source.detectedFormatId && (
                  <span className="kh-import-choice__tag">
                    <Icon name="check" /> Best match
                  </span>
                )}
              </span>
              <span className="kh-import-choice__help">{format.description}</span>
            </span>
          </label>
        ))}

        <label className="kh-import-choice">
          <input
            type="radio"
            name={groupName}
            value="__other"
            checked={usingOther}
            onChange={() => {
              // Falls to the catch-all rather than to nothing, so choosing "a different
              // format" always leaves a workable selection behind it.
              const fallback = formats.find((format) => format.needsMapping) ?? formats[0];
              if (fallback !== undefined) onChange(fallback.id);
            }}
          />
          <span className="kh-import-choice__body">
            <span className="kh-import-choice__label">A different format</span>
            <span className="kh-import-choice__help">
              Every format Keyhold can read, whether or not it recognised this file.
            </span>
          </span>
        </label>
      </fieldset>

      {usingOther && (
        <div className="kh-field">
          <label className="kh-field__label" htmlFor={otherSelectId}>
            Format
          </label>
          <div className="kh-field__control">
            <select
              id={otherSelectId}
              className="kh-field__input"
              // `usingOther` already established that this is not null, so there is no
              // fallback to write here — an `?? ''` would be a branch that cannot run.
              value={formatId}
              onChange={(event) => {
                onChange(event.target.value);
              }}
            >
              {formats.map((format) => (
                <option key={format.id} value={format.id}>
                  {format.name}
                </option>
              ))}
            </select>
          </div>
          <p className="kh-field__hint">
            Reading a file with the wrong format is not dangerous — nothing is written until you
            approve the dry run on the next screen.
          </p>
        </div>
      )}
    </div>
  );
}
