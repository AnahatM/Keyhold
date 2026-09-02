// SPDX-License-Identifier: GPL-3.0-or-later
import { Button } from '../components/Button.js';
import { ErrorState, LoadingState } from '../components/Feedback.js';
import { HealthReportView } from './HealthReportView.js';
import type { HealthRecordRef } from './health-presentation.js';
import { useHealthReport, type AnalyseHealth } from './use-health-report.js';
import './health.css';

/**
 * The health dashboard — roadmap Phase 13.
 *
 * Eight offline rules, a score you can check the arithmetic of, findings ordered by what
 * they cost, and a switch for every rule. The analysis runs in the main process because that
 * is the only place the passwords are; what arrives here carries record ids, counts, dates,
 * hosts and severities, and nothing derived from a password.
 *
 * ## Why this takes props rather than reading the store
 *
 * `onSelectCredential` is a callback and `records` is a list of four-field structs, so this
 * component can neither mutate a credential nor reach anything beyond a title and an
 * identity. That keeps the review question — "can the dashboard touch a secret?" — answerable
 * by reading the prop types, and it is what makes the render-level no-secrets guard in
 * `health-no-secrets.test.tsx` possible without a DOM testing library.
 *
 * ## The three states
 *
 * Loading, failed, and loaded, all handled. The first analysis of a large vault is real work,
 * and a blank rectangle while it runs is the single most common way an otherwise finished
 * screen feels broken.
 */
export interface HealthDashboardProps {
  /** Enough to name a record in a list. A `CredentialProjection` satisfies this. */
  readonly records: readonly HealthRecordRef[];
  readonly onSelectCredential: (credentialId: string) => void;
  /**
   * Injectable so the dashboard can be rendered without a preload bridge. Defaults to
   * `window.keyhold.health.analyse`.
   */
  readonly analyse?: AnalyseHealth;
}

export function HealthDashboard({
  records,
  onSelectCredential,
  analyse,
}: HealthDashboardProps): React.JSX.Element {
  const { report, error, pending, enabledRules, setRuleEnabled, resetRules, refresh } =
    useHealthReport(analyse);

  if (report === null) {
    if (error !== null) {
      return (
        <div className="kh-health kh-health--message">
          <ErrorState
            title="The health check could not run"
            description={error}
            action={
              <Button variant="secondary" onClick={refresh}>
                Try again
              </Button>
            }
          />
        </div>
      );
    }

    return (
      <div className="kh-health kh-health--message">
        <LoadingState label="Checking this vault's health" rows={4} />
      </div>
    );
  }

  return (
    <>
      {/* A failure after a successful run leaves the previous report on screen rather than
          replacing it with an error page. The numbers are stale, and the banner says so —
          which is more useful than throwing away the last thing that worked. */}
      {error !== null && (
        <p className="kh-health__stale" role="alert">
          Showing the previous result: the latest check failed. {error}
        </p>
      )}
      <HealthReportView
        report={report}
        records={records}
        enabledRules={enabledRules}
        pending={pending}
        onSelectCredential={onSelectCredential}
        onRuleEnabled={setRuleEnabled}
        onReset={resetRules}
        onRefresh={refresh}
      />
    </>
  );
}
