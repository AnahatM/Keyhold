// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { coercePreferences, DEFAULT_PREFERENCES } from './preferences.js';

/**
 * How a stored preference is read back, for the two switches whose defaults disagree.
 *
 * `preferences.json` is an ordinary file on disk that anything can corrupt, truncate or
 * predate. Every field here has to decide what a missing or nonsense value means, and for
 * these two the answer is the opposite of each other on purpose.
 */

/**
 * The screen-capture default, which runs the other way from the kill-switch beside it.
 *
 * `networkAllowed` reads a missing or corrupt value as **off**, because a kill-switch that
 * fails open is not one. `blockScreenCapture` reads the same conditions as **on**, for the
 * mirror-image reason: the failure that costs something is a password ending up in a screen
 * recording, not a screenshot somebody has to take twice.
 *
 * Fault injection: `!== false` changed to `=== true`. Both cases below fail — a preferences
 * file written by any build before this one has no such key, so every existing install would
 * have silently lost the protection on upgrade.
 */
describe('blockScreenCapture', () => {
  it('is on by default', () => {
    expect(DEFAULT_PREFERENCES.blockScreenCapture).toBe(true);
  });

  it('reads a missing key as on, so an upgrade does not silently lose it', () => {
    expect(coercePreferences({}).blockScreenCapture).toBe(true);
    expect(coercePreferences({ blockScreenCapture: null }).blockScreenCapture).toBe(true);
    expect(coercePreferences({ blockScreenCapture: 'yes' }).blockScreenCapture).toBe(true);
  });

  it('is off only when it says so exactly', () => {
    expect(coercePreferences({ blockScreenCapture: false }).blockScreenCapture).toBe(false);
  });
});
