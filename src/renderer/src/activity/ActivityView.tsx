// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useState } from 'react';
import type { ActivityEntry } from '@shared/model/activity.js';
import type { CredentialProjection } from '@shared/model/credential.js';
import { Button } from '../components/Button.js';
import { EmptyState, ErrorState } from '../components/Feedback.js';
import { relativeTime } from '../history/origin-labels.js';
import {
  KIND_SYMBOLS,
  KIND_TONES,
  LOCK_REASON_LABELS,
  describeEntry,
  recordCount,
  type EntryNaming,
} from './activity-presentation.js';
import { useActivity } from './activity-store.js';
import './activity.css';

/**
 * What this session has done.
 *
 * The log answers one question a password manager otherwise cannot: *did something just
 * walk my vault?* The vault's own history records every change with provenance, durably,
 * inside the ciphertext — but reading changes nothing, so history cannot see a reveal or a
 * copy, and those are precisely the actions somebody else at your machine would perform.
 *
 * ## Newest first, and cleared on lock
 *
 * The snapshot arrives oldest-first — stated once, in `ActivitySnapshot` — and is reversed
 * here. Both facts about clearing are said on screen rather than left to be discovered: the
 * log is in-memory only and goes when the vault locks, which is a deliberate design (see
 * `activity-log.ts`) and would otherwise read as the app losing things.
 *
 * ## Names are off by default
 *
 * A row says "Password revealed" rather than "Password revealed for Barclays" until asked.
 * The whole argument is in `activity-presentation.ts`; the short version is that this list
 * is compact, timestamped, screenshot-friendly and read aloud by screen readers, which
 * makes it a genuinely different disclosure from the credential list it derives from. The
 * question the log exists for is answered by counts and rates without naming anything.
 *
 * At audit privacy level `none` the entries carry no id at all, so the toggle has nothing to
 * resolve and the rows stay unnamed whatever it says. That is belt and braces, not the only
 * guard.
 */

export interface ActivityViewProps {
  /** The safe projection the shell already holds, used only to turn an id into a title. */
  readonly records: readonly CredentialProjection[];
  /** True when the frame supplies the `<h1>`. */
  readonly hideTitle?: boolean;
}

export function ActivityView({ records, hideTitle = false }: ActivityViewProps): React.JSX.Element {
  const { snapshot, lastLock, readAt, loading, error, refresh } = useActivity();
  const [showNames, setShowNames] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const naming = useMemo<EntryNaming>(() => {
    const titles = new Map(records.map((record) => [record.id, record.title]));
    return { showRecordNames: showNames, nameFor: (id) => titles.get(id) };
  }, [records, showNames]);

  if (error !== null) {
    return (
      <div className="kh-activity kh-activity--message">
        <ErrorState
          title="The activity log could not be read"
          description={error}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                void refresh();
              }}
            >
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  // Oldest first on the wire; newest first on screen. A log you scroll to the bottom of to
  // find what just happened is a log you stop opening.
  const entries = [...(snapshot?.entries ?? [])].reverse();

  return (
    <section className="kh-activity" aria-busy={loading}>
      {!hideTitle && <h1 className="kh-activity__title">Session activity</h1>}

      <p className="kh-activity__lead">
        Everything this session did with the vault, including the reads that the vault&rsquo;s own
        history cannot record. Kept in memory only, and cleared the moment the vault locks.
      </p>

      <div className="kh-activity__controls">
        <label className="kh-activity__names">
          <input
            type="checkbox"
            checked={showNames}
            onChange={(event) => {
              setShowNames(event.target.checked);
            }}
          />
          <span>Show which record each row is about</span>
        </label>

        <Button
          variant="secondary"
          size="sm"
          loading={loading}
          onClick={() => {
            void refresh();
          }}
        >
          Refresh
        </Button>
      </div>

      {lastLock !== null && (
        <p className="kh-activity__notice">
          {/*
            The reason alone, not `describeEntry`. That returns the whole sentence — "Vault
            locked — you locked it" — which read as "…when the vault last locked — Vault locked
            — you locked it" once this line supplied its own subject. Caught by looking at the
            rendered screen rather than at the test, which asserted the entry was shown and was
            perfectly happy with it being shown twice.
          */}
          <span aria-hidden="true">{KIND_SYMBOLS.lock}</span> The log was cleared when the vault
          last locked
          {lastLock.lockReason === undefined
            ? '.'
            : ` — ${LOCK_REASON_LABELS[lastLock.lockReason]}.`}
        </p>
      )}

      {snapshot !== null && snapshot.droppedCount > 0 && (
        <p className="kh-activity__notice">
          <span aria-hidden="true">⋯</span> This session has done more than the log holds.{' '}
          {recordCount(snapshot.droppedCount, 'older entry')} dropped off the end; it keeps the most
          recent {snapshot.capacity}.
        </p>
      )}

      {entries.length === 0 ? (
        <EmptyState
          title="Nothing recorded yet"
          description="Unlocking, revealing, copying and saving all appear here. The list starts again every time the vault is unlocked."
        />
      ) : (
        <ol className="kh-activity__list">
          {entries.map((entry) => (
            <ActivityRow key={entry.seq} entry={entry} naming={naming} now={readAt} />
          ))}
        </ol>
      )}
    </section>
  );
}

function ActivityRow({
  entry,
  naming,
  now,
}: {
  readonly entry: ActivityEntry;
  readonly naming: EntryNaming;
  readonly now: number;
}): React.JSX.Element {
  return (
    <li className={`kh-activity-row kh-activity-row--${KIND_TONES[entry.kind]}`}>
      <span className="kh-activity-row__symbol" aria-hidden="true">
        {KIND_SYMBOLS[entry.kind]}
      </span>
      <span className="kh-activity-row__text">{describeEntry(entry, naming)}</span>
      {/*
        `title` carries the exact timestamp, because "2 hours ago" is the right default and
        the wrong answer for the one question this log is opened to settle: whether something
        happened while you were away from the machine.
      */}
      <time
        className="kh-activity-row__when"
        dateTime={new Date(entry.at).toISOString()}
        title={new Date(entry.at).toLocaleString()}
      >
        {relativeTime(entry.at, now)}
      </time>
    </li>
  );
}
