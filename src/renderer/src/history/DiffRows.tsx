// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import type { VersionedField } from '@shared/model/credential.js';
import type { DiffSide, FieldDiffProjection } from '@shared/model/history.js';
import { Button } from '../components/Button.js';
import { useCredentials } from '../vault/credential-store.js';
import { fieldLabel } from './origin-labels.js';

/**
 * One "before → after" per changed field.
 *
 * The rule this component exists to honour: **a secret side is a length until the user asks
 * for it**, and asking goes through the broker one value at a time, exactly like revealing
 * a live password. Nothing here caches a revealed value beyond the row that is showing it,
 * and switching away drops it.
 */

/** The mask for a secret of known length, capped so a 200-character password is not a wall. */
function mask(length: number): string {
  if (length === 0) return 'empty';
  return '•'.repeat(Math.min(length, 24)) + (length > 24 ? '…' : '');
}

function describe(side: DiffSide): string {
  switch (side.kind) {
    case 'secret':
      return mask(side.length);
    case 'questions':
      return side.questions.length === 0
        ? 'none'
        : side.questions.map((question) => question.question).join(' · ');
    case 'custom':
      return side.fields.length === 0
        ? 'none'
        : side.fields
            .map((field) =>
              // A non-secret custom value shows; a secret one shows its label and a mask,
              // which is the same trade the live detail pane makes.
              field.isSecret || field.value === undefined
                ? `${field.label}: ••••`
                : `${field.label}: ${field.value}`
            )
            .join(' · ');
    case 'value': {
      const { value } = side;
      if (value === null) return 'none';
      if (typeof value === 'boolean') return value ? 'yes' : 'no';
      // Every number in `DiffValue` is a timestamp — `expiresAt` — except
      // `rotationIntervalDays`, which the caller labels, so a bare date reads correctly in
      // context and a bare integer would not.
      if (typeof value === 'number') return new Date(value).toLocaleDateString();
      if (typeof value === 'string') return value === '' ? 'empty' : value;
      // Narrowed on the property rather than with `Array.isArray`, which does not remove a
      // `readonly` array from a union.
      if ('kind' in value) return value.value ?? value.kind;
      return value.length === 0 ? 'none' : value.join(', ');
    }
  }
}

export function DiffRows({
  credentialId,
  versionNumber,
  diff,
}: {
  readonly credentialId: string;
  readonly versionNumber: number;
  readonly diff: readonly FieldDiffProjection[];
}): React.JSX.Element {
  if (diff.length === 0) {
    return <p className="kh-timeline__status">Nothing changed in this version.</p>;
  }

  return (
    <dl className="kh-diff">
      {diff.map((entry) => (
        <div key={entry.field} className="kh-diff__row">
          <dt className="kh-diff__field">{fieldLabel(entry.field)}</dt>
          <dd className="kh-diff__values">
            <span className="kh-diff__before">{describe(entry.before)}</span>
            <span className="kh-diff__arrow" aria-hidden="true">
              →
            </span>
            <span className="kh-diff__after">{describe(entry.after)}</span>
            {entry.isSecret && (
              <SecretSide
                credentialId={credentialId}
                versionNumber={versionNumber}
                field={entry.field}
              />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Reveals and copies the previous value of a secret field.
 *
 * Only `password` and `notes` are addressable this way — a historic security answer or
 * custom value needs an id the diff row does not carry, and guessing one would fetch the
 * wrong secret rather than fail. For those, restoring the version is the honest route, and
 * the button is simply absent rather than present and broken.
 */
function SecretSide({
  credentialId,
  versionNumber,
  field,
}: {
  readonly credentialId: string;
  readonly versionNumber: number;
  readonly field: VersionedField;
}): React.JSX.Element | null {
  const { copy, reveal } = useCredentials();
  const [value, setValue] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (field !== 'password' && field !== 'notes') return null;

  const ref =
    field === 'password'
      ? ({ kind: 'historic-password', credentialId, versionNumber } as const)
      : ({ kind: 'historic-notes', credentialId, versionNumber } as const);

  const toggle = async (): Promise<void> => {
    if (value !== null) {
      setValue(null);
      return;
    }
    setError(null);
    try {
      setValue((await reveal(ref)) ?? '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read that value.');
    }
  };

  const onCopy = async (): Promise<void> => {
    if (await copy(ref, credentialId)) {
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
      }, 2_000);
    }
  };

  return (
    <span className="kh-diff__secret">
      {value !== null && (
        <code className="kh-secret" data-selectable="true">
          {value === '' ? 'empty' : value}
        </code>
      )}
      <Button variant="ghost" onClick={() => void toggle()}>
        {value === null ? 'Reveal old value' : 'Hide'}
      </Button>
      <Button variant="ghost" onClick={() => void onCopy()}>
        {copied ? 'Copied' : 'Copy old value'}
      </Button>
      {/* Announced rather than only coloured: a copy confirmation that only changes a
          button's label is invisible to a screen reader that was not focused on it. */}
      <span aria-live="polite" className="kh-visually-hidden">
        {copied ? 'Old value copied to the clipboard' : ''}
      </span>
      {error !== null && (
        <span role="alert" className="kh-timeline__status--error">
          {error}
        </span>
      )}
    </span>
  );
}
