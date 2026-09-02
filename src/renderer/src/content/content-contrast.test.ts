// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { contrastBetween } from '@shared/theme/contrast.js';
import { THEMES } from '@shared/theme/themes.js';
import { CONTRAST_REQUIREMENTS, type ColourToken } from '@shared/theme/tokens.js';

/**
 * Contrast for the one colour pair `content.css` introduces that the shared guard does not
 * already cover.
 *
 * The design-system rule is that a new text-on-background combination goes into
 * `CONTRAST_REQUIREMENTS`, so that "what does this sit on?" has a written answer and the
 * theme guard checks it in every theme. This file is that check, kept beside the CSS that
 * created the need for it, because the alternative — a pair nothing verifies — is exactly
 * the hole the theme guard exists to close.
 *
 * **This list should be folded into `CONTRAST_REQUIREMENTS` and this file deleted** the
 * next time `src/shared/theme/tokens.ts` is edited. It is here rather than there only
 * because the two were written by different hands at the same time.
 *
 * Every other pair the help viewer uses — text and muted text on `bg`, `surface` and
 * `surface-raised`, the three status texts on their tints, `accent-subtle-text` on
 * `accent-subtle`, `border-strong` as a rule — is already declared and already checked.
 */

interface ExtraRequirement {
  readonly foreground: ColourToken;
  readonly background: ColourToken;
  readonly minimum: number;
  readonly note: string;
}

const EXTRA_REQUIREMENTS: readonly ExtraRequirement[] = [
  {
    foreground: 'text-muted',
    background: 'surface-hover',
    minimum: 4.5,
    // The one-line summary under each title in the help index, while the row is hovered.
    note: 'secondary text on a hovered row',
  },
];

describe('the help viewer’s colour pairs', () => {
  it('are not already declared in the shared requirements', () => {
    // If one of these turns up in CONTRAST_REQUIREMENTS, it has been folded in and the
    // entry here is now a duplicate list — which is the thing this project bans.
    for (const extra of EXTRA_REQUIREMENTS) {
      const declared = CONTRAST_REQUIREMENTS.some(
        (requirement) =>
          requirement.foreground === extra.foreground && requirement.background === extra.background
      );
      expect(declared, `${extra.foreground} on ${extra.background} is already checked`).toBe(false);
    }
  });

  it('meet WCAG AA in every theme', () => {
    for (const theme of THEMES) {
      for (const { foreground, background, minimum, note } of EXTRA_REQUIREMENTS) {
        const ratio = contrastBetween(theme.palette[foreground], theme.palette[background]);
        expect(ratio, `${theme.id}: ${foreground} on ${background} did not parse`).not.toBeNull();
        expect(
          ratio ?? 0,
          `${theme.id}: ${foreground} on ${background} (${note})`
        ).toBeGreaterThanOrEqual(minimum);
      }
    }
  });
});
