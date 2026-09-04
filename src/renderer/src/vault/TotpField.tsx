// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SecretRef } from '@shared/model/credential.js';
import type { TotpCodeView } from '@shared/model/totp.js';
import { Button } from '../components/Button.js';
import { Icon } from '../components/Icon.js';
import { useCredentials } from './credential-store.js';
import './totp-field.css';

/**
 * A one-time code, its countdown, and the refresh nobody should have to think about.
 *
 * The engine has existed since Phase 8 and nothing rendered it: an `otp-secret` custom field
 * showed as a hidden blob you could reveal to see an `otpauth://` URI. Every competitor shows
 * six digits and a ring, so this was a feature Keyhold had built and never handed over.
 *
 * Three decisions worth stating:
 *
 * **The seed never crosses.** The renderer asks for a *code* and gets six digits plus an
 * absolute expiry. It has no way to compute the next one, which is why the refresh below is a
 * round trip rather than arithmetic — and why a compromised renderer cannot mint codes for
 * an account it has already stopped being able to read.
 *
 * **The countdown is derived from an absolute deadline**, not from a duration handed over at
 * fetch time. A remaining-seconds number is already stale by the length of the round trip,
 * and a ring that says 29 when the truth is 27 is how somebody types a code that has died.
 *
 * **It refreshes itself when the window closes, and not before.** One timer per field, armed
 * for the exact moment of expiry. Polling every second would make a reveal-audited IPC call
 * sixty times a minute per field; a code that silently went stale would be worse.
 */

export interface TotpFieldProps {
  readonly label: string;
  readonly credentialId: string;
  readonly fieldId: string;
  /** Injectable for tests; defaults to the bridge. */
  readonly fetchCode?: (
    credentialId: string,
    fieldId: string
  ) => Promise<{ ok: true; value: TotpCodeView | null } | { ok: false; message: string }>;
  /**
   * The ref a copy goes through, so the code reaches the **brokered** clipboard with its
   * auto-clear timer rather than being written directly. A one-time code is a live
   * authentication factor; leaving it on the clipboard until something else overwrites it
   * would be the one secret in this app that escapes the clearing rule.
   */
  readonly onCopyRef: SecretRef;
}

const bridgeFetch: NonNullable<TotpFieldProps['fetchCode']> = (credentialId, fieldId) =>
  window.keyhold.totp.code(credentialId, fieldId);

/** Grouped as `123 456`, which is how every authenticator shows six digits and how eyes read them. */
function grouped(secretCode: string): string {
  if (secretCode.length !== 6) return secretCode;
  return `${secretCode.slice(0, 3)} ${secretCode.slice(3)}`;
}

export function TotpField({
  label,
  credentialId,
  fieldId,
  fetchCode = bridgeFetch,
  onCopyRef,
}: TotpFieldProps): React.JSX.Element {
  const { copy } = useCredentials();
  const [code, setCode] = useState<TotpCodeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const result = await fetchCode(credentialId, fieldId);
    if (result.ok) {
      setCode(result.value);
      setError(null);
    } else {
      setError(result.message);
    }
  }, [fetchCode, credentialId, fieldId]);

  useEffect(() => {
    let live = true;
    const start = async (): Promise<void> => {
      await load();
      if (!live) return;
    };
    void start();
    return () => {
      live = false;
    };
  }, [load]);

  // One timer, armed for the exact moment the window closes. The 250 ms of slack is not
  // superstition: `expiresAt` is the main process's clock, the renderer's may be a hair
  // behind, and refetching a moment early returns the same code rather than a stale one.
  useEffect(() => {
    if (code === null) return;

    const tick = (): void => {
      const left = code.expiresAt - Date.now();
      setRemainingMs(Math.max(0, left));
      if (left <= 0) {
        void load();
        return;
      }
      timer.current = setTimeout(tick, Math.min(1000, left + 250));
    };
    tick();

    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [code, load]);

  if (error !== null) {
    return (
      <div className="kh-totp kh-totp--error">
        <span className="kh-totp__label">{label}</span>
        <span className="kh-totp__error">{error}</span>
      </div>
    );
  }

  if (code === null) {
    return (
      <div className="kh-totp">
        <span className="kh-totp__label">{label}</span>
        <span className="kh-totp__code kh-totp__code--waiting">······</span>
      </div>
    );
  }

  const seconds = Math.ceil(remainingMs / 1000);
  const fraction = Math.max(0, Math.min(1, remainingMs / (code.periodSeconds * 1000)));
  // Under six seconds the code is about to change, and typing it is about to fail. Said with
  // a class rather than by hiding it: hiding a code somebody is mid-way through typing is
  // worse than letting them see it run out.
  const expiring = seconds <= 5;

  return (
    <div className={`kh-totp${expiring ? ' kh-totp--expiring' : ''}`}>
      <div className="kh-totp__head">
        <span className="kh-totp__label">{label}</span>
        {code.issuer !== null && <span className="kh-totp__issuer">{code.issuer}</span>}
        {code.issuerMismatch && (
          <span className="kh-totp__mismatch" title="This field names two different services.">
            <Icon name="warning" size="sm" /> two names
          </span>
        )}
      </div>

      <div className="kh-totp__row">
        <span
          className="kh-totp__code kh-secret"
          // Announced as one unit rather than digit by digit, and re-announced when it
          // changes, so a screen-reader user is not left reading a code that has expired.
          aria-live="polite"
          aria-label={`One-time code ${code.secretCode}, ${String(seconds)} seconds left`}
        >
          {grouped(code.secretCode)}
        </span>

        <span
          className="kh-totp__ring"
          style={{ '--kh-totp-fraction': String(fraction) } as React.CSSProperties}
          aria-hidden
        />
        <span className="kh-totp__seconds">{seconds}s</span>

        <Button
          variant="ghost"
          size="sm"
          icon="clipboard"
          iconOnlyLabel={`Copy ${label}`}
          onClick={() => {
            void copy(onCopyRef, credentialId);
          }}
        />
      </div>
    </div>
  );
}
