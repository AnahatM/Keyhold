// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useId, useState } from 'react';
import type { CredentialProjection } from '@shared/model/credential.js';
import type { FieldDiffProjection, HistoryPointRef } from '@shared/model/history.js';
import { Button } from '../components/Button.js';
import { useCredentials } from '../vault/credential-store.js';
import { DiffRows } from './DiffRows.js';
import { defaultComparison, historyPointsFor, isComparablePair } from './history-points.js';
import './history.css';

/**
 * What is different between two points in a record's history.
 *
 * The timeline answers "what did this edit change". It cannot answer "what is different
 * between the version from March and what I have now", which is the question somebody asks
 * after a bad sync, a shared account, or a password they do not recognise. `kh:history:compare`
 * has answered it end to end since it was written; nothing ever asked.
 *
 * Collapsed by default. The timeline is the thing people open history for, and a comparison
 * panel permanently above it would push the answer they came for below the fold to serve the
 * rarer question.
 *
 * **Old secrets stay secret.** The rows come from `DiffRows`, which shows a length and a reveal
 * button and fetches through the broker one value at a time — the same path, the same rate
 * limit and the same clipboard rules as a live secret. Nothing here holds a value across a
 * re-render, and the comparison itself is computed in the main process.
 */

export function CompareVersions({
  credential,
}: {
  readonly credential: CredentialProjection;
}): React.JSX.Element | null {
  const { historyCompare } = useCredentials();
  const points = historyPointsFor(credential);
  const opening = defaultComparison(points);

  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState<HistoryPointRef>(opening?.from ?? 'current');
  const [to, setTo] = useState<HistoryPointRef>(opening?.to ?? 'current');
  const [diff, setDiff] = useState<FieldDiffProjection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const panelId = useId();
  const credentialId = credential.id;
  const comparable = isComparablePair(from, to);

  /**
   * Runs one comparison, for an explicit pair.
   *
   * Driven by the events that change the question — opening the panel, and either select —
   * rather than by an effect watching the state they set. An effect would have to call
   * `setLoading` in its own body, which React flags as a cascading render, and taking the pair
   * as arguments avoids the other half of that problem: a handler reading `from` from state
   * would read the value from before its own `setFrom`.
   */
  const runCompare = useCallback(
    async (nextFrom: HistoryPointRef, nextTo: HistoryPointRef): Promise<void> => {
      if (!isComparablePair(nextFrom, nextTo)) {
        setDiff(null);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        setDiff(await historyCompare(credentialId, nextFrom, nextTo));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not compare those two versions.');
      } finally {
        setLoading(false);
      }
    },
    [credentialId, historyCompare]
  );

  // Nothing to compare a single state against. Rendering the control anyway would be an
  // affordance that can only ever say no.
  if (opening === null) return null;

  return (
    <section className="kh-compare">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void runCompare(from, to);
        }}
      >
        {open ? 'Hide comparison' : 'Compare two versions'}
      </Button>

      {open && (
        <div className="kh-compare__panel" id={panelId}>
          <div className="kh-compare__pickers">
            <PointPicker
              label="From"
              value={from}
              points={points}
              credentialId={credentialId}
              onChange={(next) => {
                setFrom(next);
                void runCompare(next, to);
              }}
            />
            <PointPicker
              label="To"
              value={to}
              points={points}
              credentialId={credentialId}
              onChange={(next) => {
                setTo(next);
                void runCompare(from, next);
              }}
            />
          </div>

          {!comparable && (
            <p className="kh-timeline__status">
              Pick two different points — comparing a version with itself has no answer.
            </p>
          )}
          {comparable && loading && <p className="kh-timeline__status">Comparing…</p>}
          {comparable && error !== null && (
            <p className="kh-timeline__status" role="alert">
              {error}
            </p>
          )}
          {comparable && !loading && error === null && diff !== null && (
            <DiffRows
              credentialId={credentialId}
              // The reveal path needs a version to fetch an old secret from, and `current` is
              // not one. When the comparison starts at the live state the older side is `to`,
              // so that is the version a reveal belongs to.
              versionNumber={typeof from === 'number' ? from : typeof to === 'number' ? to : 0}
              diff={diff}
            />
          )}
        </div>
      )}
    </section>
  );
}

function PointPicker({
  label,
  value,
  points,
  onChange,
  credentialId,
}: {
  readonly label: string;
  readonly value: HistoryPointRef;
  readonly points: ReturnType<typeof historyPointsFor>;
  readonly onChange: (next: HistoryPointRef) => void;
  readonly credentialId: string;
}): React.JSX.Element {
  const id = `kh-compare-${credentialId}-${label.toLowerCase()}`;

  return (
    <label className="kh-compare__picker" htmlFor={id}>
      <span className="kh-compare__label">{label}</span>
      <select
        id={id}
        className="kh-compare__select"
        value={String(value)}
        onChange={(event) => {
          // The option values are strings; `current` is the one that is not a number, and
          // anything else has come from `points` and is therefore a version number.
          const next = event.target.value;
          onChange(next === 'current' ? 'current' : Number(next));
        }}
      >
        {points.map((point) => (
          <option key={String(point.ref)} value={String(point.ref)}>
            {point.label}
          </option>
        ))}
      </select>
    </label>
  );
}
