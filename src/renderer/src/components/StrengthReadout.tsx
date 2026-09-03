// SPDX-License-Identifier: GPL-3.0-or-later
import type { PasswordStrength } from '@shared/model/strength.js';
// The visual language of the meter is defined once, beside the create screen's own meter.
// Importing it here rather than restyling it keeps the two looking like the same control.
import '../vault/vault-screens.css';

/**
 * The password-strength readout, wherever a master password or passphrase is chosen.
 *
 * **Everything it shows comes from the estimator.** The score, the word, the crack-time
 * estimate, the warning and the suggestions are all produced by `src/main/session/strength.ts`
 * — zxcvbn plus a length floor, run in the main process so the password never crosses the
 * bridge. Nothing here re-derives any of it. A hand-rolled length-and-character-class meter
 * is not a simpler version of this; it is a *different, wrong* answer that would tell
 * someone `P@ssw0rd1!` is excellent.
 *
 * The word comes before the bar, and the bar is never the only signal, because "Weak" is
 * unambiguous in a way a shade of orange is not (WCAG 1.4.1).
 *
 * ### One copy, and how it got here
 *
 * This lived in `onboarding/` with a note saying its score-to-tone map was a second copy of
 * `CreateVaultScreen.tsx`'s private `StrengthMeter`, and that a third surface should extract
 * rather than copy again. The settings screen's change-master-password dialog was that third
 * surface. The two were byte-identical apart from a comment, so this is now the only one and
 * both call sites import it.
 *
 * Keep it that way. Three surfaces now show a password's strength and they must agree, not
 * because agreement is tidy but because a meter that says "Strong" on one screen and "Fair"
 * on another teaches the user that the meter means nothing.
 */

function toneFor(score: PasswordStrength['score']): 'success' | 'info' | 'warning' | 'danger' {
  if (score >= 4) return 'success';
  if (score === 3) return 'info';
  if (score === 2) return 'warning';
  return 'danger';
}

export function StrengthReadout({
  strength,
}: {
  readonly strength: PasswordStrength;
}): React.JSX.Element {
  const tone = toneFor(strength.score);

  return (
    <div className="kh-strength">
      <div className="kh-strength__head">
        <span className={`kh-strength__label kh-strength__label--${tone}`}>{strength.label}</span>
        {strength.crackTime !== '' && (
          <span className="kh-strength__time">
            {/* Framed against Argon2id rather than a fast hash, and called an estimate
                because that is what it is. A crack time that pretends to precision is worse
                than one that admits its assumptions. */}
            Estimated time to crack offline: {strength.crackTime}
          </span>
        )}
      </div>

      <div
        className="kh-strength__bar"
        role="meter"
        aria-valuenow={strength.score}
        aria-valuemin={0}
        aria-valuemax={4}
        aria-label={`Password strength: ${strength.label}`}
      >
        {[0, 1, 2, 3].map((index) => (
          <span
            key={index}
            className={`kh-strength__segment${index < strength.score ? ` kh-strength__segment--${tone}` : ''}`}
          />
        ))}
      </div>

      {strength.warning !== null && strength.warning !== '' && (
        <p className="kh-strength__warning">{strength.warning}</p>
      )}
      {strength.suggestions.length > 0 && (
        <ul className="kh-strength__suggestions">
          {strength.suggestions.map((suggestion) => (
            <li key={suggestion}>{suggestion}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
