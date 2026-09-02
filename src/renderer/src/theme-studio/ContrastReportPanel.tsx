// SPDX-License-Identifier: GPL-3.0-or-later
import { useMemo } from 'react';
import {
  ESCAPE_FLOOR_MINIMUM,
  type ContrastFinding,
  type ContrastReport,
} from '@shared/theme/keeptheme.js';
import { Badge } from '../components/Feedback.js';

/**
 * The live contrast report: every declared pair, its ratio, its minimum, and a verdict.
 *
 * This is the accessibility screen, so it has to be accessible itself, and two decisions
 * follow from that:
 *
 * **Pass and fail are words, never colour alone.** Green and red rows in a panel about
 * colour contrast would be a WCAG 1.4.1 failure in the one place it would be most
 * embarrassing — and unreadable to exactly the users this panel serves. Every row carries
 * the word "Pass" or "Fail" and a symbol; the tint is the third signal, not the only one.
 *
 * **There is no live region.** The obvious instinct is `aria-live` on the summary so a
 * screen-reader user hears the score change. In practice the report recomputes on every
 * frame of a colour slider, and a polite live region tied to a drag announces continuously
 * and drowns everything else out. The summary is a static heading instead, re-read on
 * demand, which is what a user of this panel actually wants.
 *
 * The ratios come from `evaluatePaletteContrast`, which is the same function the format
 * gate uses. The panel does no arithmetic of its own — if it did, it could tell the user a
 * theme passes while the gate refuses it.
 */

export interface ContrastReportPanelProps {
  readonly report: ContrastReport;
  /** The subset a theme may never fail, whatever the user consents to. */
  readonly floor: ContrastReport;
}

function isFloorFailure(finding: ContrastFinding, floor: ContrastReport): boolean {
  return floor.failures.some(
    (failure) =>
      failure.foreground === finding.foreground && failure.background === finding.background
  );
}

export function ContrastReportPanel({
  report,
  floor,
}: ContrastReportPanelProps): React.JSX.Element {
  // Failures first, then everything else in declaration order. Someone opening this panel
  // is looking for what is wrong, and making them scroll for it is the whole problem.
  const rows = useMemo(
    () => [...report.findings].sort((a, b) => Number(a.passes) - Number(b.passes)),
    [report]
  );

  const passing = report.findings.length - report.failures.length;

  return (
    <section className="kh-studio-report" aria-labelledby="kh-studio-report-heading">
      <h3 className="kh-panel__heading" id="kh-studio-report-heading">
        Contrast
      </h3>

      <p className="kh-studio-report__summary">
        <strong>
          {passing} of {report.findings.length} checks pass.
        </strong>{' '}
        {report.worst === null
          ? null
          : `Weakest pair: ${report.worst.foreground} on ${report.worst.background} at ${report.worst.ratioText}, which needs ${report.worst.minimumText}.`}
      </p>

      {!floor.passes && (
        <p className="kh-studio-report__floor" role="alert">
          <strong>This theme cannot be used.</strong> {floor.failures.length} pair
          {floor.failures.length === 1 ? '' : 's'} fall below {ESCAPE_FLOOR_MINIMUM}:1, the point at
          which you could no longer read the screen that changes the theme back. There is no
          override for this — the choice would not be undoable.
        </p>
      )}

      <div className="kh-studio-report__scroll">
        <table className="kh-studio-table">
          <caption className="kh-visually-hidden">
            Every declared foreground and background pair, with its measured contrast ratio, the
            minimum WCAG AA requires, and whether it passes.
          </caption>
          <thead>
            <tr>
              <th scope="col">Pair</th>
              <th scope="col">Used for</th>
              <th scope="col">Ratio</th>
              <th scope="col">Needs</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((finding) => {
              const blocking = !finding.passes && isFloorFailure(finding, floor);
              return (
                <tr
                  key={`${finding.foreground}/${finding.background}`}
                  className={finding.passes ? undefined : 'kh-studio-table__row--fail'}
                >
                  <th scope="row">
                    <code>{finding.foreground}</code>
                    <span className="kh-studio-table__on"> on </span>
                    <code>{finding.background}</code>
                  </th>
                  <td>
                    {finding.requirement.note}
                    {blocking && (
                      <span className="kh-studio-table__blocking">
                        {' '}
                        — below the legibility floor
                      </span>
                    )}
                  </td>
                  <td className="kh-studio-table__number">{finding.ratioText}</td>
                  <td className="kh-studio-table__number">{finding.minimumText}</td>
                  <td>
                    <Badge
                      tone={finding.passes ? 'success' : 'danger'}
                      symbol={finding.passes ? '✓' : '✕'}
                    >
                      {finding.verdict}
                    </Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
