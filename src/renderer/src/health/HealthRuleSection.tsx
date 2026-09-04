// SPDX-License-Identifier: GPL-3.0-or-later
import { useId } from 'react';
import type { HealthCluster, HealthIssue } from '@shared/model/health.js';
import { Badge } from '../components/Feedback.js';
import {
  SEVERITY_LABELS,
  SEVERITY_ICONS,
  SEVERITY_TONES,
  clusterCaption,
  clusterHeading,
  countLabel,
  formatEntropyBits,
  recordLabel,
  recordSubtitle,
  type HealthRecordRef,
  type RuleGroup,
} from './health-presentation.js';

/**
 * One rule's findings.
 *
 * ## Presentation decisions
 *
 * **Every finding is a link to its record.** A dashboard that tells you something is wrong
 * and then makes you go and find it is worse than no dashboard: it produces the anxiety
 * without the fix. Selection is a callback prop rather than a reach into the credential
 * store, so this component cannot mutate anything and can be rendered in a test with a
 * three-line fixture.
 *
 * **Reuse is shown as clusters, not as a count.** "3 records are reused" is unactionable —
 * the user has to know *which* records share the password before they can change any of
 * them. The group is the unit of the finding, which is why the engine reports clusters at
 * all.
 *
 * **The weight is on the heading.** Publishing what a finding costs is what makes the score
 * arguable rather than oracular, and it is also the honest way to say that `emptyTitle` is
 * not the same kind of problem as `reused`.
 */
export function HealthRuleSection({
  group,
  recordsById,
  entropyById,
  onSelectCredential,
}: {
  readonly group: RuleGroup;
  readonly recordsById: ReadonlyMap<string, HealthRecordRef>;
  readonly entropyById: ReadonlyMap<string, number>;
  readonly onSelectCredential: (credentialId: string) => void;
}): React.JSX.Element {
  const headingId = `kh-health-rule-${group.rule}`;

  return (
    <section
      className={`kh-health-rule kh-health-rule--${group.severity}`}
      aria-labelledby={headingId}
    >
      <header className="kh-health-rule__header">
        <h4 id={headingId} className="kh-health-rule__title">
          {group.label}
        </h4>
        {/* Word + symbol + colour. Never the colour on its own — WCAG 1.4.1, and this is the
            screen where it matters most. */}
        <Badge tone={SEVERITY_TONES[group.severity]} symbol={SEVERITY_ICONS[group.severity]}>
          {SEVERITY_LABELS[group.severity]}
        </Badge>
        <span className="kh-health-rule__count">{countLabel(group.flaggedCount)}</span>
        <span className="kh-health-rule__weight">
          −{group.weight} points each
          <span className="kh-visually-hidden"> from the health score</span>
        </span>
      </header>

      <p className="kh-health-rule__description">{group.description}</p>
      <p className="kh-health-rule__advice">{group.advice}</p>

      {group.presentation === 'clusters' ? (
        <ol className="kh-health-clusters">
          {group.clusters.map((cluster, index) => (
            <ClusterCard
              key={cluster.id}
              cluster={cluster}
              ordinal={index + 1}
              recordsById={recordsById}
              onSelectCredential={onSelectCredential}
            />
          ))}
        </ol>
      ) : (
        <ul className="kh-health-records">
          {group.issues.map((issue) => (
            <li key={`${issue.rule}-${issue.credentialId}`}>
              <RecordRow
                issue={issue}
                record={recordsById.get(issue.credentialId)}
                entropyBits={
                  group.rule === 'weak' ? entropyById.get(issue.credentialId) : undefined
                }
                onSelectCredential={onSelectCredential}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * A group of records that share a problem with each other.
 *
 * The heading uses the group's position in this list, never `cluster.id`. That id is a
 * synthetic sequential counter — deliberately not derived from the shared password, since a
 * hash of one would be an offline-attackable handle on it crossing the bridge — so showing
 * it would invite a user to read meaning into a number that has none.
 */
function ClusterCard({
  cluster,
  ordinal,
  recordsById,
  onSelectCredential,
}: {
  readonly cluster: HealthCluster;
  readonly ordinal: number;
  readonly recordsById: ReadonlyMap<string, HealthRecordRef>;
  readonly onSelectCredential: (credentialId: string) => void;
}): React.JSX.Element {
  // `useId`, deliberately NOT `cluster.id`. The id is not secret today, but the whole reason
  // it is a synthetic counter is that the thing it must never become — a handle derived from
  // the shared password — would then be sitting in a DOM attribute. Generating the id here
  // instead is what lets the render guard assert that no cluster id appears anywhere in the
  // markup, and it removes the collision risk of building one out of the rule and the
  // ordinal, which spells `reused-1` just as the engine's own ids do.
  const headingId = useId();

  return (
    <li className="kh-health-cluster">
      <h5 id={headingId} className="kh-health-cluster__title">
        {clusterHeading(cluster, ordinal)}
      </h5>
      <p className="kh-health-cluster__caption">{clusterCaption(cluster)}</p>
      <ul className="kh-health-records" aria-labelledby={headingId}>
        {cluster.credentialIds.map((credentialId) => (
          <li key={credentialId}>
            <RecordButton
              record={recordsById.get(credentialId)}
              credentialId={credentialId}
              onSelectCredential={onSelectCredential}
            />
          </li>
        ))}
      </ul>
    </li>
  );
}

function RecordRow({
  issue,
  record,
  entropyBits,
  onSelectCredential,
}: {
  readonly issue: HealthIssue;
  readonly record: HealthRecordRef | undefined;
  readonly entropyBits: number | undefined;
  readonly onSelectCredential: (credentialId: string) => void;
}): React.JSX.Element {
  return (
    <RecordButton
      record={record}
      credentialId={issue.credentialId}
      onSelectCredential={onSelectCredential}
      // The host of an insecure URL, never the URL: a URL can carry credentials in its
      // userinfo, which is why the engine only ever sends the host.
      note={issue.detail ?? (entropyBits === undefined ? null : formatEntropyBits(entropyBits))}
    />
  );
}

/**
 * The row itself: a real `<button>`, so it is in the tab order and responds to Enter and
 * Space without this file reimplementing either.
 */
function RecordButton({
  record,
  credentialId,
  onSelectCredential,
  note = null,
}: {
  readonly record: HealthRecordRef | undefined;
  readonly credentialId: string;
  readonly onSelectCredential: (credentialId: string) => void;
  readonly note?: string | null;
}): React.JSX.Element {
  const label = recordLabel(record);
  const subtitle = recordSubtitle(record);

  return (
    <button
      type="button"
      className="kh-health-record"
      // A visible label plus context, so a screen-reader user moving button to button hears
      // "Open Netflix" rather than a list of bare names with no verb.
      aria-label={`Open ${label}`}
      onClick={() => {
        onSelectCredential(credentialId);
      }}
    >
      <span className="kh-health-record__label">{label}</span>
      {subtitle !== '' && <span className="kh-health-record__subtitle">{subtitle}</span>}
      {note !== null && note !== '' && <span className="kh-health-record__note">{note}</span>}
      <span className="kh-health-record__go" aria-hidden="true">
        ›
      </span>
    </button>
  );
}
