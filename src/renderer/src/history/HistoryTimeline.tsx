// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useState } from 'react';
import type { CredentialProjection, VersionProjection } from '@shared/model/credential.js';
import type { FieldDiffProjection } from '@shared/model/history.js';
import { Button } from '../components/Button.js';
import { EmptyState } from '../components/Feedback.js';
import { useCredentials } from '../vault/credential-store.js';
import { DiffRows } from './DiffRows.js';
import {
  actionLabel,
  changeSummary,
  originDetail,
  originSummary,
  relativeTime,
} from './origin-labels.js';
import { useNow } from './use-now.js';
import './history.css';

/**
 * The edit timeline: what changed, when, and from where.
 *
 * Keyhold's headline feature, and the screen it is judged on. Three things it must get
 * right, in order of how badly each one reads when it is wrong:
 *
 * **A restore must put back what the user was looking at.** Each row *is* a state, and
 * expanding it shows exactly the state its button restores. The main process guarantees
 * this with one function behind both; this component's job is not to invent a second idea
 * of what a row means.
 *
 * **Old secrets are still secrets.** A password row shows a length and a reveal button, and
 * the value is fetched one at a time through the broker under the same rate limit and
 * clipboard rules as the live one. Nothing here holds a secret across a re-render.
 *
 * **Provenance the user turned off must not be mentioned.** A row for a change recorded at
 * privacy level `none` says when and what, and nothing about where — not "unknown device",
 * which reads as a fault rather than as their own setting.
 */

export function HistoryTimeline({
  credential,
}: {
  readonly credential: CredentialProjection;
}): React.JSX.Element {
  // One clock for the whole timeline, so every row's "2 hours ago" is measured from the
  // same instant. Two rows reading `Date.now()` separately can disagree by a minute across
  // a boundary, which looks like a bug in the ordering.
  const now = useNow();

  // Newest first: the question a timeline is opened to answer is almost always "what
  // happened recently", and the record's own array is oldest-first for the delta walk.
  const versions = [...credential.history].reverse();

  if (!credential.historyEnabled && versions.length === 0) {
    return (
      <EmptyState
        icon="clock"
        title="History is off for this credential"
        description="Turn on “Keep past versions” when editing to record what changes, when, and from which device."
      />
    );
  }

  if (versions.length === 0) {
    return (
      <EmptyState
        icon="clock"
        title="No changes yet"
        description="Edits to this credential will appear here, newest first."
      />
    );
  }

  return (
    <ol className="kh-timeline" aria-label="Edit history">
      {versions.map((version) => (
        <TimelineEntry
          key={version.versionNumber}
          credential={credential}
          version={version}
          now={now}
        />
      ))}
      <CreationEntry credential={credential} now={now} />
    </ol>
  );
}

/**
 * The oldest row: where the record came from.
 *
 * Rendered from `meta.createdOrigin` rather than from a version, because creation has no
 * previous state to diff — and it is the one origin that survives history being switched
 * off, which is exactly when a user most wants to know where a record came from.
 */
function CreationEntry({
  credential,
  now,
}: {
  readonly credential: CredentialProjection;
  readonly now: number;
}): React.JSX.Element {
  const origin = credential.meta.createdOrigin;
  const where = originSummary(origin);

  return (
    <li className="kh-timeline__entry kh-timeline__entry--origin">
      <div className="kh-timeline__marker" aria-hidden="true" />
      <div className="kh-timeline__body">
        <p className="kh-timeline__headline">
          <strong>{actionLabel(origin.action)}</strong>
          <time dateTime={new Date(credential.meta.createdAt).toISOString()}>
            {relativeTime(credential.meta.createdAt, now)}
          </time>
        </p>
        {where !== '' && <p className="kh-timeline__where">{where}</p>}
      </div>
    </li>
  );
}

function TimelineEntry({
  credential,
  version,
  now,
}: {
  readonly credential: CredentialProjection;
  readonly version: VersionProjection;
  readonly now: number;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [diff, setDiff] = useState<FieldDiffProjection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { historyDiff } = useCredentials();

  const credentialId = credential.id;
  const versionNumber = version.versionNumber;

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setDiff(await historyDiff(credentialId, versionNumber));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load this change.');
    } finally {
      setLoading(false);
    }
  }, [credentialId, versionNumber, historyDiff]);

  const where = originSummary(version.origin);
  const detail = originDetail(version.origin);
  const panelId = `kh-history-${credentialId}-${String(versionNumber)}`;

  return (
    <li className="kh-timeline__entry">
      <div className="kh-timeline__marker" aria-hidden="true" />
      <div className="kh-timeline__body">
        <p className="kh-timeline__headline">
          <strong>{actionLabel(version.origin.action)}</strong>
          <time dateTime={new Date(version.savedAt).toISOString()}>
            {relativeTime(version.savedAt, now)}
          </time>
        </p>
        <p className="kh-timeline__summary">{changeSummary(version.changedFields)}</p>
        {where !== '' && (
          <p className="kh-timeline__where" title={detail === '' ? undefined : detail}>
            {where}
          </p>
        )}

        <div className="kh-timeline__actions">
          <Button
            variant="ghost"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={() => {
              // Fetched on the click rather than from an effect watching `expanded`.
              // An effect would call setState synchronously on every open, which cascades
              // renders — and the fetch is a response to a user action, not a
              // synchronisation with anything outside React.
              const opening = !expanded;
              setExpanded(opening);
              if (opening && diff === null && !loading) void load();
            }}
          >
            {expanded ? 'Hide changes' : 'Show changes'}
          </Button>
          <RestoreButton credential={credential} version={version} />
        </div>

        {expanded && (
          <div id={panelId} className="kh-timeline__diff">
            {loading && <p className="kh-timeline__status">Loading…</p>}
            {error !== null && (
              <p className="kh-timeline__status kh-timeline__status--error" role="alert">
                {error}
              </p>
            )}
            {diff !== null && (
              <DiffRows credentialId={credentialId} versionNumber={versionNumber} diff={diff} />
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Restoring a version.
 *
 * Two clicks, not a confirmation dialog: the restore is itself versioned and therefore
 * undoable from this same timeline, so a modal would be ceremony over an action that cannot
 * lose anything. The second click is there to stop a misclick, not to warn about danger.
 */
function RestoreButton({
  credential,
  version,
}: {
  readonly credential: CredentialProjection;
  readonly version: VersionProjection;
}): React.JSX.Element {
  const { restoreVersion } = useCredentials();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const restore = async (): Promise<void> => {
    setBusy(true);
    try {
      await restoreVersion(credential.id, version.versionNumber);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  if (!confirming) {
    return (
      <Button
        variant="ghost"
        disabled={busy}
        onClick={() => {
          setConfirming(true);
        }}
      >
        Restore this version
      </Button>
    );
  }

  return (
    <span className="kh-timeline__confirm">
      <Button variant="primary" disabled={busy} onClick={() => void restore()}>
        {busy ? 'Restoring…' : 'Confirm restore'}
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          setConfirming(false);
        }}
      >
        Cancel
      </Button>
    </span>
  );
}
