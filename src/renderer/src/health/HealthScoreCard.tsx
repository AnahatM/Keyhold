// SPDX-License-Identifier: GPL-3.0-or-later
import { Badge } from '../components/Feedback.js';
import { countLabel } from './health-presentation.js';
import {
  BEST_ACHIEVABLE_SCORE,
  WORST_ACHIEVABLE_SCORE,
  scoreBand,
  type ScoreExplanation,
} from './health-score.js';
import { Icon } from '../components/Icon.js';

/**
 * The score, with its working shown.
 *
 * A number on its own is a number people learn to ignore, so the arithmetic is on screen
 * next to it: every rule that fired, how many records it flagged, what each one costs, and
 * the division that turns the total into a score out of 100. The engine guarantees the
 * result is reproducible from the report; this card reproduces it and says whether it
 * matched.
 *
 * ## Presentation decisions
 *
 * **The dial is decoration and is marked as such.** The score is text, the band is a word,
 * and the ring is `aria-hidden`. Nothing here is communicated by the arc's colour alone —
 * remove all the colour and the card still reads.
 *
 * **The cap gets its own row rather than being smeared over the rules.** The per-record cap
 * is applied per record and cannot be attributed back to the rules that caused it without
 * inventing an allocation. Inventing one would make the table add up while being wrong,
 * which is worse than a table with an explicit adjustment line in it.
 *
 * **The floor is stated, the ceiling is qualified.** A maximally-broken vault scores 1, not
 * 0, and 100 means "nothing the enabled checks look for", not "secure". Both are said out
 * loud, because a scale whose ends are misunderstood is a scale that misleads.
 */
export function HealthScoreCard({
  explanation,
  generatedAt,
}: {
  readonly explanation: ScoreExplanation;
  readonly generatedAt: number;
}): React.JSX.Element {
  const band = scoreBand(explanation);

  return (
    <section className="kh-health-score" aria-labelledby="kh-health-score-heading">
      <h3 id="kh-health-score-heading" className="kh-health__heading">
        Health score
      </h3>

      {/*
        The live region is the headline only. Wrapping the table in it too would make a
        screen reader re-read forty numbers every time a check is toggled, which is how a
        helpful announcement becomes something people switch off.
      */}
      <div className="kh-health-score__headline" role="status" aria-live="polite">
        <ScoreDial score={explanation.score} bandId={band.id} measured={explanation.measured} />
        <div className="kh-health-score__verdict">
          <p className="kh-health-score__number">
            {explanation.measured ? (
              <>
                <strong>{explanation.score}</strong>
                <span className="kh-health-score__outof"> / {BEST_ACHIEVABLE_SCORE}</span>
              </>
            ) : (
              <strong className="kh-health-score__outof">Not scored</strong>
            )}
          </p>
          {/*
            A tick when there is genuinely nothing to fix, and **no icon at all** otherwise.
            The bullet it used to carry was a picture of nothing — a mark that said only "this
            badge has a mark". A badge is perfectly legible as a coloured label, and forcing a
            glyph into a slot with no meaning is how an icon set starts looking arbitrary.
          */}
          <Badge tone={band.tone} {...(band.id === 'clear' ? { symbol: 'check' as const } : {})}>
            {band.label}
          </Badge>
          <p className="kh-health-score__summary">{band.summary}</p>
        </div>
      </div>

      <dl className="kh-health-score__facts">
        <div>
          <dt>Checked</dt>
          <dd>{countLabel(explanation.analysedCount)}</dd>
        </div>
        <div>
          <dt>Flagged</dt>
          <dd>{countLabel(explanation.flaggedRecordCount)}</dd>
        </div>
        <div>
          <dt>Clean</dt>
          <dd>{countLabel(explanation.healthyCount)}</dd>
        </div>
        <div>
          {/* Surfaced so the "Checked" number is explained rather than quietly short. */}
          <dt>Skipped (in Trash)</dt>
          <dd>{countLabel(explanation.trashedCount)}</dd>
        </div>
      </dl>

      {explanation.measured && <ScoreWorking explanation={explanation} />}

      <p className="kh-health-score__scale">
        The scale runs {WORST_ACHIEVABLE_SCORE}–{BEST_ACHIEVABLE_SCORE}, not 0–100: some rules
        cannot fire on the same record, so the worst possible average penalty is{' '}
        {100 - WORST_ACHIEVABLE_SCORE}. {BEST_ACHIEVABLE_SCORE} means nothing the enabled checks
        look for was found — not that a vault is secure, which these eight offline rules cannot tell
        you.
      </p>

      <p className="kh-health-score__generated">
        Analysed at{' '}
        <time dateTime={new Date(generatedAt).toISOString()}>
          {new Date(generatedAt).toLocaleTimeString()}
        </time>
        , entirely on this device.
      </p>
    </section>
  );
}

/** The arithmetic, as a table, because that is what it is. */
function ScoreWorking({
  explanation,
}: {
  readonly explanation: ScoreExplanation;
}): React.JSX.Element {
  return (
    <div className="kh-health-working">
      <table className="kh-health-working__table">
        <caption className="kh-health-working__caption">
          How the score was reached. Each flagged record loses points, the total is averaged across
          every record checked, and the average is subtracted from {BEST_ACHIEVABLE_SCORE}.
        </caption>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col" className="kh-health-working__num">
              Records
            </th>
            <th scope="col" className="kh-health-working__num">
              Points each
            </th>
            <th scope="col" className="kh-health-working__num">
              Points
            </th>
          </tr>
        </thead>
        <tbody>
          {explanation.lines.length === 0 && (
            <tr>
              <td colSpan={4} className="kh-health-working__none">
                No check flagged anything.
              </td>
            </tr>
          )}
          {explanation.lines.map((line) => (
            <tr key={line.rule}>
              <th scope="row">{line.label}</th>
              <td className="kh-health-working__num">{line.flaggedCount}</td>
              <td className="kh-health-working__num">{line.weight}</td>
              <td className="kh-health-working__num">{line.points}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {explanation.pointsRemovedByCap > 0 && (
            <>
              <tr>
                <th scope="row" colSpan={3}>
                  Subtotal
                </th>
                <td className="kh-health-working__num">{explanation.rawPoints}</td>
              </tr>
              <tr>
                <th scope="row" colSpan={3}>
                  Less the per-record cap — no single record may cost more than 100
                </th>
                <td className="kh-health-working__num">−{explanation.pointsRemovedByCap}</td>
              </tr>
            </>
          )}
          <tr>
            <th scope="row" colSpan={3}>
              Points charged
            </th>
            <td className="kh-health-working__num">{explanation.chargedPoints}</td>
          </tr>
          <tr>
            <th scope="row" colSpan={3}>
              Averaged over {countLabel(explanation.analysedCount)} checked
            </th>
            <td className="kh-health-working__num">{explanation.averagePenalty.toFixed(1)}</td>
          </tr>
          <tr className="kh-health-working__result">
            <th scope="row" colSpan={3}>
              {BEST_ACHIEVABLE_SCORE} − {explanation.averagePenalty.toFixed(1)}, rounded
            </th>
            <td className="kh-health-working__num">{explanation.recomputedScore}</td>
          </tr>
        </tfoot>
      </table>

      {/*
        Stated either way. A quiet tick is a small claim; silence when it fails would be a
        dashboard hiding the one fact that would tell you not to trust it.
      */}
      {explanation.reproducible ? (
        <p className="kh-health-working__check">
          <Icon name="check" size="sm" /> Recalculated here from the report and it matches the score
          above.
        </p>
      ) : (
        <p className="kh-health-working__check kh-health-working__check--mismatch" role="alert">
          <span aria-hidden="true">!</span> This recalculation came to {explanation.recomputedScore}
          , not {explanation.score}. Treat the score with caution and please report it.
        </p>
      )}
    </div>
  );
}

/**
 * The ring.
 *
 * Inline SVG rather than a charting library: it is one arc, and the dependency rule in this
 * project is not worth spending on a circle. `pathLength="100"` lets the dash arithmetic be
 * the score itself instead of a circumference nobody can check by eye.
 */
function ScoreDial({
  score,
  bandId,
  measured,
}: {
  readonly score: number;
  readonly bandId: string;
  readonly measured: boolean;
}): React.JSX.Element {
  const filled = measured ? Math.max(0, Math.min(100, score)) : 0;

  return (
    <svg
      className={`kh-health-dial kh-health-dial--${bandId}`}
      viewBox="0 0 100 100"
      // Decoration. The score and the band are text a few pixels away; announcing the ring
      // as well would say the same thing twice.
      aria-hidden="true"
      focusable="false"
    >
      <circle className="kh-health-dial__track" cx="50" cy="50" r="42" pathLength={100} />
      <circle
        className="kh-health-dial__value"
        cx="50"
        cy="50"
        r="42"
        pathLength={100}
        strokeDasharray={`${filled} ${100 - filled}`}
      />
    </svg>
  );
}
