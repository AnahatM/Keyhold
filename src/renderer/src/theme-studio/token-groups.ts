// SPDX-License-Identifier: GPL-3.0-or-later
import type { ColourToken } from '@shared/theme/tokens.js';

/**
 * How the token vocabulary is arranged in the editor.
 *
 * This is presentation, not a second copy of the vocabulary: it says which tokens sit
 * together and what to tell someone about each group, and `token-groups.test.ts` asserts
 * that the groups cover `COLOUR_TOKENS` **exactly once each**. Adding a token to
 * `tokens.ts` without placing it here is therefore a test failure rather than a token that
 * silently becomes uneditable — which is the failure mode a hand-maintained UI list always
 * has, and the one hard rule 8 exists to prevent.
 *
 * Status colours are split into four groups rather than one because they are read one at a
 * time. Somebody adjusting "danger" is looking at three related values, not at twelve.
 */
export interface TokenGroup {
  readonly id: string;
  readonly label: string;
  /** Says what the group is FOR, so a value can be chosen rather than guessed at. */
  readonly description: string;
  readonly tokens: readonly ColourToken[];
}

export const TOKEN_GROUPS: readonly TokenGroup[] = [
  {
    id: 'surfaces',
    label: 'Surfaces',
    description: 'From the page behind everything to the card in front of it.',
    tokens: ['bg', 'surface', 'surface-raised', 'surface-sunken', 'surface-hover', 'overlay'],
  },
  {
    id: 'lines',
    label: 'Lines',
    description:
      'Dividers, input outlines, and the focus ring. The ring is how a keyboard user knows where they are.',
    tokens: ['border', 'border-strong', 'focus-ring'],
  },
  {
    id: 'text',
    label: 'Text',
    description:
      '“Subtle” is for ornament only — a keyboard hint, a separator label. Anything that must be read uses text or muted.',
    tokens: ['text', 'text-muted', 'text-subtle', 'text-inverse'],
  },
  {
    id: 'accent',
    label: 'Accent',
    description:
      'The interactive colour. “On” is the label that sits on top of it, so it contrasts with the accent, not with the page.',
    tokens: [
      'accent',
      'accent-hover',
      'accent-active',
      'accent-on',
      'accent-subtle',
      'accent-subtle-text',
    ],
  },
  {
    id: 'success',
    label: 'Success',
    description: 'Carries meaning in the health report. Keep it recognisably green.',
    tokens: ['success', 'success-text', 'success-subtle'],
  },
  {
    id: 'warning',
    label: 'Warning',
    description: 'Reused and expiring passwords. Keep it recognisably amber.',
    tokens: ['warning', 'warning-text', 'warning-subtle'],
  },
  {
    id: 'danger',
    label: 'Danger',
    description: 'Breached passwords and destructive actions. Keep it recognisably red.',
    tokens: ['danger', 'danger-text', 'danger-subtle'],
  },
  {
    id: 'info',
    label: 'Info',
    description: 'Neutral notices. Keep it distinguishable from the accent.',
    tokens: ['info', 'info-text', 'info-subtle'],
  },
];

/** Every token, in editor order. */
export const TOKENS_IN_GROUP_ORDER: readonly ColourToken[] = TOKEN_GROUPS.flatMap(
  (group) => group.tokens
);
