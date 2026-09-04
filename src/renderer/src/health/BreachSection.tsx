// SPDX-License-Identifier: GPL-3.0-or-later
import type { BreachAvailability, BreachReport } from '@shared/model/breach.js';
import { Button } from '../components/Button.js';
import { Badge } from '../components/Feedback.js';
import { breachHeadline, breachIncompleteNote, breachUnavailable } from './breach-presentation.js';
import type { BreachCheckState } from './use-breach-check.js';
import './breach.css';

/**
 * The one place in Keyhold that offers to make a network request.
 *
 * ## Nothing here starts on its own
 *
 * The button is the whole design. Every other panel in this app fetches when it mounts; this
 * one waits, because a request made because somebody opened a screen is a request they did
 * not ask for, and "Keyhold makes no network requests" would then be true only of the
 * settings dialog. Opening the health dashboard costs nothing and reveals nothing.
 *
 * ## When it cannot run, it says which switch — and does not pretend
 *
 * There is no disabled button with a tooltip. A control that looks like it might work if you
 * clicked it right teaches people to keep clicking; a sentence naming the switch that is off,
 * and where it lives, is something they can act on. The three reasons are distinguished
 * because they call for three different actions — `breachAvailability` in the model decides
 * which one applies, so the dashboard and any future surface cannot disagree about it.
 *
 * ## An incomplete run is never rendered as a clean one
 *
 * `unknownCount` is shown beside the other two and never folded into them. A sweep where a
 * third of the records could not be reached is not a clean bill of health, and a summary
 * reading "0 breached" over a failed run is the single worst thing this screen could say.
 */

export interface BreachSectionProps extends BreachCheckState {
  /** Takes the user to the setting that is off. Supplied by the shell, not built here. */
  readonly onOpenSettings: () => void;
}

export function BreachSection({
  availability,
  report,
  running,
  error,
  run,
  onOpenSettings,
}: BreachSectionProps): React.JSX.Element {
  return (
    <section className="kh-breach" aria-labelledby="kh-breach-heading">
      <div className="kh-breach__head">
        <h3 id="kh-breach-heading" className="kh-health__heading">
          Checked against known breaches
        </h3>
        {availability !== null && !availability.canRun && (
          <Badge tone="neutral" symbol="offline">
            Off
          </Badge>
        )}
      </div>

      <p className="kh-breach__explainer">
        Your passwords are never sent. Each one is hashed on this computer, and only the first five
        characters of that hash leave it — the service replies with every leaked hash starting the
        same way, and Keyhold searches that list here. It cannot tell which password was asked
        about, or whether it was found.
      </p>

      {availability !== null && !availability.canRun ? (
        <Unavailable availability={availability} onOpenSettings={onOpenSettings} />
      ) : (
        <div className="kh-breach__actions">
          <Button
            variant="secondary"
            icon="shield"
            loading={running}
            disabled={running || availability === null}
            onClick={run}
          >
            {running ? 'Checking…' : 'Check now'}
          </Button>
          {running && (
            <p className="kh-breach__pacing">
              Deliberately unhurried — Keyhold waits between requests rather than hammering a free
              service. A large vault takes a minute or two.
            </p>
          )}
        </div>
      )}

      {error !== null && (
        <p className="kh-breach__error" role="alert">
          {error}
        </p>
      )}

      {report !== null && <Result report={report} />}
    </section>
  );
}

function Unavailable({
  availability,
  onOpenSettings,
}: {
  readonly availability: BreachAvailability;
  readonly onOpenSettings: () => void;
}): React.JSX.Element {
  const copy = breachUnavailable(availability);

  return (
    <div className="kh-breach__unavailable">
      <p>{copy.message}</p>
      {copy.settable && (
        // Only when there is actually a switch to reach. A locked vault has no setting to
        // change, and a button that took somebody to Settings to solve that would be sending
        // them somewhere useless.
        <Button variant="ghost" icon="settings" onClick={onOpenSettings}>
          {copy.action}
        </Button>
      )}
    </div>
  );
}

function Result({ report }: { readonly report: BreachReport }): React.JSX.Element {
  const incomplete = breachIncompleteNote(report);

  return (
    <div className="kh-breach__result">
      <p className="kh-breach__headline">{breachHeadline(report)}</p>

      <dl className="kh-breach__counts">
        <div>
          <dt>Found in a breach</dt>
          <dd className={report.breachedCount > 0 ? 'kh-breach__count--bad' : undefined}>
            {report.breachedCount}
          </dd>
        </div>
        <div>
          <dt>Not found</dt>
          <dd>{report.safeCount}</dd>
        </div>
        <div>
          <dt>Could not check</dt>
          <dd className={report.unknownCount > 0 ? 'kh-breach__count--unknown' : undefined}>
            {report.unknownCount}
          </dd>
        </div>
      </dl>

      {incomplete !== null && (
        <p className="kh-breach__incomplete" role="status">
          {incomplete}
        </p>
      )}

      {/*
        Reported because a user of a zero-network application is entitled to a real answer to
        "how many requests did that make?", and because it is the number that shows the
        k-anonymity sharing working: far below the record count on any real vault.
      */}
      <p className="kh-breach__requests">
        {report.requestCount === 1
          ? '1 request was made.'
          : `${String(report.requestCount)} requests were made.`}
      </p>
    </div>
  );
}
