// SPDX-License-Identifier: GPL-3.0-or-later

import type { PasswordStrength } from '@shared/model/strength.js';
import './export.css';

/**
 * The strength of the passphrase a parcel is sealed under.
 *
 * A near-twin of the meter on `CreateVaultScreen`, and that duplication is a known debt
 * rather than an accident: that one is a private function inside a screen component, and
 * this module may not edit that file. The fix is to lift a single `StrengthMeter` into
 * `src/renderer/src/components/` and have both call it — recorded in the export dialog's
 * handover notes rather than left for someone to rediscover.
 *
 * The rules it does share are the ones that matter: the **word comes before the bar**,
 * because "Weak" is unambiguous in a way that a shade of orange is not (WCAG 1.4.1), and
 * the bar is a `role="meter"` with a real accessible name rather than four coloured divs.
 */
export interface PassphraseStrengthProps {
  readonly strength: PasswordStrength;
}

function toneFor(score: PasswordStrength['score']): string {
  if (score >= 4) return 'success';
  if (score === 3) return 'info';
  if (score === 2) return 'warning';
  return 'danger';
}

export function PassphraseStrength({ strength }: PassphraseStrengthProps): React.JSX.Element {
  const tone = toneFor(strength.score);

  return (
    <div className="kh-export-strength">
      <p className="kh-export-strength__head">
        <span className={`kh-export-strength__label kh-export-strength__label--${tone}`}>
          {strength.label}
        </span>
        {strength.crackTime !== '' && (
          <span className="kh-export-strength__time">
            Estimated time to crack offline: {strength.crackTime}
          </span>
        )}
      </p>

      <div
        className="kh-export-strength__bar"
        role="meter"
        aria-valuenow={strength.score}
        aria-valuemin={0}
        aria-valuemax={4}
        aria-label={`Passphrase strength: ${strength.label}`}
      >
        {[0, 1, 2, 3].map((index) => (
          <span
            key={index}
            className={`kh-export-strength__segment${
              index < strength.score ? ` kh-export-strength__segment--${tone}` : ''
            }`}
          />
        ))}
      </div>

      {strength.warning !== null && strength.warning !== '' && (
        <p className="kh-export-strength__warning">{strength.warning}</p>
      )}
      {strength.suggestions.length > 0 && (
        <ul className="kh-export-strength__suggestions">
          {strength.suggestions.map((suggestion) => (
            <li key={suggestion}>{suggestion}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
