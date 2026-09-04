// SPDX-License-Identifier: GPL-3.0-or-later

import type { ExportFormatDescriptor, ExportFormatId } from '@shared/model/export.js';
import type { ExportPreview } from '@shared/model/export-plan.js';
import { Badge, EmptyState } from '../components/Feedback.js';
import { betaNotice, fidelityLabel, safetyBadge, summariseLosses } from './export-presentation.js';
import './export.css';

/**
 * Step one: which file to make.
 *
 * **The list is the engine's, verbatim.** Names, descriptions, extensions and order all
 * come from the format registry over IPC — including the order, which is deliberate on the
 * engine's side: the encrypted parcel is first so that the dangerous option is never the
 * obvious one. Sorting, filtering or relabelling here would quietly overrule a decision
 * made where the formats actually live, and would be the second list rule 8 forbids.
 *
 * Native radios in a `<fieldset>` with a `<legend>`, rather than clickable cards with
 * `role="radio"` painted on. Arrow-key navigation, the roving tab stop, the announced
 * "2 of 4" and the grouped label are all free and all things a hand-rolled version gets
 * subtly wrong. The card is the `<label>`, so the whole row is a hit target.
 */
export interface ExportFormatStepProps {
  readonly formats: readonly ExportFormatDescriptor[];
  readonly selectedId: ExportFormatId | null;
  readonly preview: ExportPreview | null;
  readonly onChoose: (id: ExportFormatId) => void;
  readonly describedById: string;
}

export function ExportFormatStep({
  formats,
  selectedId,
  preview,
  onChoose,
  describedById,
}: ExportFormatStepProps): React.JSX.Element {
  if (formats.length === 0) {
    return (
      <EmptyState
        title="No export formats are available"
        description="Keyhold could not read its own format registry. Reopening the app usually clears this; if it does not, the installation is damaged."
      />
    );
  }

  return (
    <fieldset className="kh-export-formats" aria-describedby={describedById}>
      <legend className="kh-visually-hidden">Export format</legend>

      {formats.map((format) => {
        const badge = safetyBadge(format);
        const beta = betaNotice(format);
        const selected = format.id === selectedId;
        const showsLosses = selected && preview !== null && preview.format === format.id;

        return (
          <label
            key={format.id}
            className={`kh-export-format${selected ? ' kh-export-format--selected' : ''}`}
          >
            <input
              type="radio"
              name="kh-export-format"
              className="kh-export-format__radio"
              value={format.id}
              checked={selected}
              onChange={() => {
                onChoose(format.id);
              }}
            />

            <span className="kh-export-format__body">
              <span className="kh-export-format__head">
                <span className="kh-export-format__name">{format.name}</span>
                <code className="kh-export-format__extension">{format.extension}</code>
                <Badge tone={badge.tone} symbol={badge.symbol}>
                  {badge.label}
                </Badge>
                {beta !== null && (
                  <Badge tone="info" symbol={beta.symbol}>
                    {beta.label}
                  </Badge>
                )}
              </span>

              <span className="kh-export-format__description">{format.description}</span>
              <span className="kh-export-format__meaning">{badge.meaning}</span>
              <span className="kh-export-format__fidelity">{fidelityLabel(format)}</span>

              {/* Under the format's own description, not tucked into the badge's tooltip. A
                  caveat somebody has to hover to find is a caveat written for the record
                  rather than for the reader. */}
              {beta !== null && <span className="kh-export-format__beta">{beta.reason}</span>}

              {/* Only for the selected format: the preview is fetched for one format at a
                  time, and inventing a per-format summary from the descriptor would be this
                  file guessing at what the engine already knows exactly. */}
              {showsLosses && (
                <span className="kh-export-format__losses">{summariseLosses(preview.losses)}</span>
              )}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
