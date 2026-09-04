// SPDX-License-Identifier: GPL-3.0-or-later
import { useMemo } from 'react';
import type { HealthRuleId, VaultHealthReport } from '@shared/model/health.js';
import { Button } from '../components/Button.js';
import { EmptyState } from '../components/Feedback.js';
import { HealthRuleSection } from './HealthRuleSection.js';
import { HealthRuleToggles } from './HealthRuleToggles.js';
import { HealthScoreCard } from './HealthScoreCard.js';
import { countLabel, groupIssuesByRule, type HealthRecordRef } from './health-presentation.js';
import { explainScore } from './health-score.js';
import type { RuleToggles } from './use-health-report.js';

/**
 * The dashboard body, given a report.
 *
 * Split from `HealthDashboard` so that everything visible is a pure function of props. That
 * is not architectural neatness for its own sake: `@testing-library/react` is not a
 * dependency of this project, so the only way to assert over what this screen actually
 * renders is to mount it with a fixture through the bare `react-dom/client` harness in
 * `chrome/test-dom.ts` — which needs a component that takes nothing but props and issues no
 * IPC. `health-no-secrets.test.tsx` does exactly that, and it is the test that enforces the
 * boundary this whole feature sits on.
 */
export function HealthReportView({
  report,
  records,
  enabledRules,
  pending,
  onSelectCredential,
  onRuleEnabled,
  onReset,
  onRefresh,
  hideTitle = false,
}: {
  readonly report: VaultHealthReport;
  readonly records: readonly HealthRecordRef[];
  readonly enabledRules: RuleToggles;
  readonly pending: boolean;
  readonly onSelectCredential: (credentialId: string) => void;
  readonly onRuleEnabled: (rule: HealthRuleId, enabled: boolean) => void;
  readonly onReset: () => void;
  readonly onRefresh: () => void;
  /**
   * Drops the "Vault health" heading, keeping the subtitle and the Re-check button.
   *
   * Set when the host already titles the page — `ToolView` does, because the heading is what
   * focus moves to on navigation and so has to exist above whatever is mounted inside it.
   * Two identical page titles stacked on each other reads as a bug.
   */
  readonly hideTitle?: boolean;
}): React.JSX.Element {
  const explanation = useMemo(() => explainScore(report), [report]);
  const groups = useMemo(() => groupIssuesByRule(report), [report]);

  const recordsById = useMemo(
    () => new Map(records.map((record) => [record.id, record])),
    [records]
  );
  const entropyById = useMemo(
    () =>
      new Map(report.byCredential.map((entry) => [entry.credentialId, entry.passwordEntropyBits])),
    [report]
  );

  const disabledCount = explanation.totalRuleCount - explanation.enabledRuleCount;

  return (
    // The label goes with the heading: pointing `aria-labelledby` at an id that is no longer
    // rendered leaves the region unnamed *and* silently broken, which is worse than being
    // plainly unnamed inside a `<main>` the frame has already titled.
    <section className="kh-health" aria-labelledby={hideTitle ? undefined : 'kh-health-heading'}>
      <header className="kh-health__header" data-compact={hideTitle || undefined}>
        {!hideTitle && (
          <h2 id="kh-health-heading" className="kh-health__title">
            Vault health
          </h2>
        )}
        <p className="kh-health__subtitle">
          Eight checks, run on this device against the vault in memory. Nothing is sent anywhere.
        </p>
        <Button variant="secondary" size="sm" loading={pending} onClick={onRefresh}>
          Re-check
        </Button>
      </header>

      <HealthScoreCard explanation={explanation} generatedAt={report.generatedAt} />

      <section className="kh-health-findings" aria-labelledby="kh-health-findings-heading">
        <h3 id="kh-health-findings-heading" className="kh-health__heading">
          Findings
        </h3>

        {groups.length === 0 ? (
          <AllClear
            measured={explanation.measured}
            enabledRuleCount={explanation.enabledRuleCount}
            disabledCount={disabledCount}
            trashedCount={explanation.trashedCount}
          />
        ) : (
          <>
            <p className="kh-health__hint">
              Ordered by what each finding costs the score, heaviest first — reuse spreads across
              accounts, and age does not. Select any record to open it.
            </p>
            {groups.map((group) => (
              <HealthRuleSection
                key={group.rule}
                group={group}
                recordsById={recordsById}
                entropyById={entropyById}
                onSelectCredential={onSelectCredential}
              />
            ))}
          </>
        )}
      </section>

      <HealthRuleToggles
        enabledRules={enabledRules}
        counts={report.counts}
        pending={pending}
        onRuleEnabled={onRuleEnabled}
        onReset={onReset}
      />

      <NotChecked />
    </section>
  );
}

/**
 * The all-clear, kept honest.
 *
 * Three different situations reach this branch and they do not mean the same thing: an empty
 * vault is unmeasured, a clean vault with every check on is a real all-clear, and a clean
 * vault with checks switched off is only clear of the things still being looked for. Showing
 * one cheerful message for all three would be the dashboard's first lie.
 */
function AllClear({
  measured,
  enabledRuleCount,
  disabledCount,
  trashedCount,
}: {
  readonly measured: boolean;
  readonly enabledRuleCount: number;
  readonly disabledCount: number;
  readonly trashedCount: number;
}): React.JSX.Element {
  if (!measured) {
    return (
      <EmptyState
        icon="folders"
        title="Nothing to check yet"
        description={
          trashedCount === 0
            ? 'Add a credential and this page will tell you what it finds.'
            : `Every record in this vault is in the Trash, and trashed records are excluded from every check. ${countLabel(trashedCount)} skipped.`
        }
      />
    );
  }

  if (enabledRuleCount === 0) {
    return (
      <EmptyState
        icon="power"
        title="Every check is switched off"
        description="Nothing is being looked for, so nothing is being found. Turn a check back on below."
      />
    );
  }

  return (
    <EmptyState
      icon="check"
      title="Nothing flagged"
      description={
        disabledCount === 0
          ? 'All eight checks ran and none of them found anything. They cover password reuse, strength, age, expiry, insecure addresses, duplicates and findability — all offline. Whether a password has appeared in a breach is a separate, opt-in check below, and this result does not include it.'
          : `The ${enabledRuleCount} checks that are switched on found nothing. ${countLabel(disabledCount, 'check')} did not run, so this is not a clean bill of health for those.`
      }
    />
  );
}

/**
 * What the score does not know.
 *
 * Written out rather than left implicit, because the failure mode of a health dashboard is
 * a user reading a high number as "I am safe". Each limit here is a real one, phrased as a
 * fact rather than as a roadmap promise.
 *
 * The breach entry used to say the check did not exist and would be opt-in "if it is ever
 * added". The engine had in fact been finished for some time and was simply unreachable —
 * this project's characteristic failure, and the reason a claim about absence is the most
 * dangerous kind of documentation there is: nothing fails when it stops being true. It now
 * points at the section below it, and says the thing that remains true either way, which is
 * that the score never includes it.
 */
function NotChecked(): React.JSX.Element {
  return (
    <section className="kh-health-limits" aria-labelledby="kh-health-limits-heading">
      <h3 id="kh-health-limits-heading" className="kh-health__heading">
        What this does not check
      </h3>
      <ul className="kh-health-limits__list">
        <li>
          <strong>Whether a password has appeared in a breach — unless you ask.</strong> The checks
          above are entirely offline and none of them knows anything about breaches. There is a
          check that does, below this list, and it is off until you turn it on: it is the only thing
          in Keyhold that uses the internet, it never runs on its own, and the score above never
          includes it.
        </li>
        <li>
          <strong>Whether an account has two-factor authentication.</strong> There is no two-factor
          field on a record to check, so guessing from a custom field would produce confident
          nonsense.
        </li>
        <li>
          <strong>How guessable a password really is.</strong> Strength here is a
          length-and-character-set estimate. It is accurate for generated passwords and
          over-generous to human-chosen ones — something like <code>Anahat1998!</code> scores well
          and falls in seconds. Read it as a lower bound on badness: what it calls weak really is
          weak.
        </li>
        <li>
          <strong>Every duplicate.</strong> Two records match only when they share a web host and
          the same username, or the same email. A record identified by username and its twin
          identified only by email will not be paired — a missed suggestion costs less than telling
          you to merge two genuinely different accounts.
        </li>
        <li>
          <strong>Anything in the Trash.</strong> Trashed records are excluded from every check and
          from the score.
        </li>
      </ul>
    </section>
  );
}
