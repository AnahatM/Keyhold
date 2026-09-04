// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import type { SecretRef } from '@shared/model/credential.js';
import { Button } from '../components/Button.js';
import { useCredentials } from './credential-store.js';
import { Icon } from '../components/Icon.js';

/**
 * A field whose value the renderer does not have until it asks.
 *
 * This is the user-facing shape of decision D13. The list and detail views render from the
 * safe projection, which carries `hasPassword` and `passwordLength` but never the password
 * itself. When someone clicks reveal or copy, *this* component makes a single scoped IPC
 * request for that one value.
 *
 * Three properties it has to hold:
 *
 * **The revealed value never leaves this component.** It is not put into a store, not
 * cached, and not passed up. Caching reveals would quietly rebuild the bulk-secrets store
 * the whole architecture exists to avoid.
 *
 * **It is dropped on unmount and on hide.** Callers give this component a `key` derived
 * from the record and field it points at, so navigating to another record unmounts it
 * outright rather than resetting state in an effect — React's own answer to "reset when a
 * prop changes", and the one that cannot leave a stale value on screen for a frame.
 *
 * **The masked state is honest about length.** Rendering a fixed number of dots would tell
 * the user their 8-character password and their 40-character passphrase look identical,
 * which makes the mask useless for spotting a field that did not save.
 */

export interface SecretFieldProps {
  readonly label: string;
  readonly credentialId: string;
  readonly secretRef: SecretRef;
  /** From the projection — whether there is anything to reveal at all. */
  readonly hasValue: boolean;
  /** From the projection. Drives the mask width, so it stays honest. */
  readonly length: number;
  /** Multiline fields (notes) render in a box rather than a row. */
  readonly multiline?: boolean;
}

export function SecretField({
  label,
  credentialId,
  secretRef,
  hasValue,
  length,
  multiline = false,
}: SecretFieldProps): React.JSX.Element {
  const { reveal, copy } = useCredentials();

  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (): Promise<void> => {
    if (value !== null) {
      setValue(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setValue(await reveal(secretRef));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not reveal this value.');
    } finally {
      setBusy(false);
    }
  };

  const onCopy = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const ok = await copy(secretRef, credentialId);
      setCopied(ok);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not copy this value.');
    } finally {
      setBusy(false);
    }
  };

  if (!hasValue) {
    return (
      <div className="kh-secret-field">
        <span className="kh-secret-field__label">{label}</span>
        <span className="kh-secret-field__empty">Not set</span>
      </div>
    );
  }

  return (
    <div className={`kh-secret-field${multiline ? ' kh-secret-field--multiline' : ''}`}>
      <span className="kh-secret-field__label">{label}</span>

      <div className="kh-secret-field__value">
        {value === null ? (
          // A mask of the real length: a fixed number of dots would make an 8-character
          // password and a 40-character passphrase indistinguishable.
          <span className="kh-secret kh-secret-field__mask" aria-label={`${label}, hidden`}>
            {'•'.repeat(Math.min(length, 48))}
          </span>
        ) : (
          <span className="kh-secret kh-secret-field__revealed" data-selectable="true">
            {value}
          </span>
        )}
      </div>

      <div className="kh-secret-field__actions">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          iconOnlyLabel={value === null ? `Show ${label}` : `Hide ${label}`}
          onClick={() => {
            void toggle();
          }}
        >
          <Icon name={value === null ? 'reveal' : 'hide'} size="sm" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          iconOnlyLabel={`Copy ${label}`}
          onClick={() => {
            void onCopy();
          }}
        >
          ⧉
        </Button>
      </div>

      {/*
       * Announced to assistive tech, because the visible feedback for a copy is a brief
       * state change on an icon button — invisible to a screen-reader user, who would
       * otherwise have no way to know whether the copy happened.
       */}
      <span className="kh-visually-hidden" aria-live="polite">
        {copied ? `${label} copied to the clipboard. It will be cleared shortly.` : ''}
        {value !== null ? `${label} revealed.` : ''}
      </span>

      {error !== null && (
        <p className="kh-secret-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A plain, non-secret field.
 *
 * Lives beside `SecretField` on purpose: seeing the two together in one file makes the
 * boundary obvious to anyone adding a field, and makes "which of these am I writing?" a
 * question they have to answer.
 *
 * The copy path here is the browser clipboard, not the brokered one — a username is not a
 * secret and clearing someone's clipboard because they copied one would be interference.
 * It does need a `catch`, though: `applySessionHardening` denies web permissions, and while
 * `clipboard-sanitized-write` is now the one documented exception, a rejected `writeText`
 * must show something rather than becoming an unhandled rejection and a button that
 * silently does nothing.
 */
export function PlainField({
  label,
  value,
  copyable = false,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly copyable?: boolean;
  readonly mono?: boolean;
}): React.JSX.Element | null {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (value === '') return null;

  return (
    <div className="kh-secret-field">
      <span className="kh-secret-field__label">{label}</span>
      <div className="kh-secret-field__value">
        <span className={mono ? 'kh-secret' : ''} data-selectable="true">
          {value}
        </span>
      </div>
      {copyable && (
        <div className="kh-secret-field__actions">
          <Button
            variant="ghost"
            size="sm"
            iconOnlyLabel={`Copy ${label}`}
            onClick={() => {
              // A non-secret value goes through the ordinary clipboard, with no auto-clear
              // timer — clearing someone's clipboard because they copied a username would
              // be interference, not protection.
              setError(null);
              void navigator.clipboard.writeText(value).then(
                () => {
                  setCopied(true);
                },
                () => {
                  // Never echo the value into the failure; a clipboard error is about the
                  // clipboard. Same wording as the generator's, so the two do not describe
                  // one condition two ways.
                  setCopied(false);
                  setError('Keyhold could not reach the clipboard.');
                }
              );
            }}
          >
            ⧉
          </Button>
        </div>
      )}
      <span className="kh-visually-hidden" aria-live="polite">
        {copied ? `${label} copied.` : ''}
      </span>
      {error !== null && (
        <p className="kh-secret-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
