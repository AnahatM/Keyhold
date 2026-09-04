// SPDX-License-Identifier: GPL-3.0-or-later

import { useId } from 'react';
import { PLAINTEXT_AFTERMATH_REMINDER, type ExportOutcome } from '@shared/model/export-plan.js';
import { ErrorState } from '../components/Feedback.js';
import { Icon } from '../components/Icon.js';
import { countLabel } from '../health/health-presentation.js';
import { formatBytes } from './export-presentation.js';
import { LossList } from './LossList.js';
import './export.css';

/**
 * What actually happened.
 *
 * Three things, in this order, because that is the order they matter in: **what was
 * written**, **what was lost**, and — only for a readable file — **what is now true about
 * that file forever**.
 *
 * ## The reminder is not a second warning
 *
 * The warning before the export says what the file *is*. This says what the file *remains*,
 * and it is needed at a different moment: by now "save it somewhere only you can reach" is
 * advice about something that has already happened, and the useful sentence is the one
 * about deletion not being erasure.
 *
 * It states plainly that Keyhold does not shred the file. A "Delete securely" button here
 * would be the easiest kindness in the whole app and it would be a lie — on an SSD with
 * wear levelling, or a copy-on-write filesystem, overwriting a file's blocks does not
 * reliably overwrite its data. Offering false comfort about a plaintext copy of somebody's
 * entire credential store is worse than offering none, so this screen offers none.
 *
 * There is no "export again with the same settings" here either, for the same reason there
 * is no "remember this choice": the second time is when people stop reading.
 */
export interface ExportResultStepProps {
  readonly outcome: ExportOutcome;
}

export function ExportResultStep({ outcome }: ExportResultStepProps): React.JSX.Element {
  const reminderId = useId();

  if (outcome.status === 'failed') {
    return (
      <ErrorState
        title="Nothing was written"
        description={`${outcome.message} Your vault is unchanged.`}
      />
    );
  }

  if (outcome.status === 'cancelled') {
    return (
      <ErrorState
        title="Export cancelled"
        description="No file was written and your vault is unchanged."
      />
    );
  }

  const { report, location } = outcome;

  return (
    <div className="kh-export-result">
      {/*
       * Polite: the user pressed the button and is looking at the screen, so this is
       * confirmation rather than an interruption. Assertive would cut across the focus move
       * onto this step's heading.
       */}
      <p className="kh-export-result__headline" aria-live="polite">
        {/* The wrapper stays: `.kh-export-result__symbol` is where the success colour lives,
            and `Icon` takes its colour from whatever it is inside. */}
        <span className="kh-export-result__symbol">
          <Icon name="check" />
        </span>
        {countLabel(report.recordCount)} written to <strong>{location.fileName}</strong>.
      </p>

      <dl className="kh-export-result__facts">
        <div className="kh-export-result__fact">
          <dt>Saved in</dt>
          {/* A filesystem path on the user's own machine is not secret, and it is the only
              way to find the file again. Kept selectable so it can be copied. */}
          <dd>
            <code className="kh-path">{location.directory}</code>
          </dd>
        </div>
        <div className="kh-export-result__fact">
          <dt>File</dt>
          <dd>
            <code className="kh-path">{location.fileName}</code> ·{' '}
            {formatBytes(location.byteLength)}
          </dd>
        </div>
      </dl>

      <section className="kh-export-section">
        <h4 className="kh-export-section__heading">What did not make it into the file</h4>
        <LossList
          losses={report.losses}
          emptyNote="Nothing. Every record you chose is in the file, complete."
        />
      </section>

      {report.containsSecrets && (
        <section className="kh-export-danger" aria-labelledby={reminderId}>
          <h4 className="kh-export-danger__title" id={reminderId}>
            <span className="kh-export-danger__symbol">
              <Icon name="warning" />
            </span>
            This file is readable, and it is still on your disk
          </h4>
          <p className="kh-export-danger__body">{PLAINTEXT_AFTERMATH_REMINDER}</p>
        </section>
      )}
    </div>
  );
}
