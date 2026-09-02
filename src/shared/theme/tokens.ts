// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The colour token vocabulary.
 *
 * **Every colour in Keyhold is one of these tokens. There are no hardcoded colours
 * anywhere** — that is a hard rule (decision D8), and two guard tests enforce it: every
 * token must resolve in every theme, and every declared foreground/background pair must
 * meet WCAG AA contrast in every theme.
 *
 * ## Why the palettes live in TypeScript rather than CSS
 *
 * The obvious approach is a `.css` file per theme. It was rejected because it creates a
 * **second list**: the contrast test would then have to parse CSS, or maintain its own
 * copy of the palette, and the two would disagree within a month.
 *
 * Defining themes as data means one source feeds three consumers — the CSS custom
 * properties applied at runtime, the contrast guard, and the theme editor's UI. Adding a
 * token to `COLOUR_TOKENS` makes every theme that lacks it a **type error**, which is
 * exactly the right failure mode: a missing token would otherwise render as an invisible
 * element that nobody notices until a user reports a blank panel.
 *
 * Naming: every generated custom property is `--kh-color-<token>`.
 */

export const COLOUR_TOKENS = [
  // ── Surfaces, from furthest back to nearest front ───────────────────────────
  'bg',
  'surface',
  'surface-raised',
  'surface-sunken',
  'surface-hover',
  'overlay',

  // ── Lines ───────────────────────────────────────────────────────────────────
  'border',
  'border-strong',
  'focus-ring',

  // ── Text ────────────────────────────────────────────────────────────────────
  'text',
  'text-muted',
  'text-subtle',
  'text-inverse',

  // ── Accent — the user-selectable hue ────────────────────────────────────────
  'accent',
  'accent-hover',
  'accent-active',
  /** Text placed ON an accent fill. Must contrast with `accent`, not with `bg`. */
  'accent-on',
  /** A tinted background for selected rows and chips. */
  'accent-subtle',
  'accent-subtle-text',

  // ── Status — meaning, not decoration ────────────────────────────────────────
  // These carry the health dashboard's signal (weak / expiring / breached), which is why
  // the global CLAUDE.md guidance to keep decorative labels calm matters: if tags were
  // also red and green, the real warnings would stop reading as warnings.
  'success',
  'success-text',
  'success-subtle',
  'warning',
  'warning-text',
  'warning-subtle',
  'danger',
  'danger-text',
  'danger-subtle',
  'info',
  'info-text',
  'info-subtle',
] as const;

export type ColourToken = (typeof COLOUR_TOKENS)[number];

/** A complete palette. Every token is required — a partial theme will not compile. */
export type Palette = Record<ColourToken, string>;

export interface ThemeDefinition {
  readonly id: string;
  readonly name: string;
  /** Drives the CSS `color-scheme` property, so native scrollbars and form controls match. */
  readonly scheme: 'light' | 'dark';
  readonly description: string;
  readonly palette: Palette;
}

/**
 * Pairs that must meet WCAG contrast, checked for every theme by the guard test.
 *
 * Declared here rather than inferred, because "which text sits on which background" is a
 * design fact the code cannot deduce. Anything not listed is not checked — so a new
 * text/background combination introduced in a component must be added here, and the
 * review question "what does this sit on?" has a written answer.
 */
export interface ContrastRequirement {
  readonly foreground: ColourToken;
  readonly background: ColourToken;
  /** WCAG AA: 4.5 for normal text, 3.0 for large text and for UI component boundaries. */
  readonly minimum: number;
  readonly note: string;
}

export const CONTRAST_REQUIREMENTS: readonly ContrastRequirement[] = [
  // ── Body text on every surface it can land on ───────────────────────────────
  { foreground: 'text', background: 'bg', minimum: 4.5, note: 'body text on the app background' },
  { foreground: 'text', background: 'surface', minimum: 4.5, note: 'body text on a panel' },
  {
    foreground: 'text',
    background: 'surface-raised',
    minimum: 4.5,
    note: 'body text on a card or menu',
  },
  {
    foreground: 'text',
    background: 'surface-sunken',
    minimum: 4.5,
    note: 'text typed into an input',
  },
  {
    foreground: 'text',
    background: 'surface-hover',
    minimum: 4.5,
    note: 'body text on a hovered row',
  },

  // ── Secondary text. Still has to be readable; "muted" is not a licence for grey-on-grey.
  { foreground: 'text-muted', background: 'bg', minimum: 4.5, note: 'secondary text' },
  {
    foreground: 'text-muted',
    background: 'surface',
    minimum: 4.5,
    note: 'secondary text on a panel',
  },
  {
    foreground: 'text-muted',
    background: 'surface-raised',
    minimum: 4.5,
    note: 'secondary text on a card',
  },

  // `text-subtle` is for non-essential ornament (a separator label, a keyboard hint).
  // Held to 3.0 rather than 4.5 deliberately, and never used for anything a user must read.
  { foreground: 'text-subtle', background: 'bg', minimum: 3, note: 'incidental labels' },
  { foreground: 'text-subtle', background: 'surface', minimum: 3, note: 'incidental labels' },

  // ── Accent ─────────────────────────────────────────────────────────────────
  {
    foreground: 'accent-on',
    background: 'accent',
    minimum: 4.5,
    note: 'label on a primary button',
  },
  {
    foreground: 'accent-on',
    background: 'accent-hover',
    minimum: 4.5,
    note: 'label on a hovered primary button',
  },
  {
    foreground: 'accent-on',
    background: 'accent-active',
    minimum: 4.5,
    note: 'label on a pressed primary button',
  },
  {
    foreground: 'accent-subtle-text',
    background: 'accent-subtle',
    minimum: 4.5,
    note: 'text in a selected row or chip',
  },
  {
    foreground: 'accent',
    background: 'bg',
    minimum: 3,
    note: 'accent used as a border or icon — UI component contrast',
  },

  // ── Status text on its own tint, and on the plain background ───────────────
  {
    foreground: 'success-text',
    background: 'success-subtle',
    minimum: 4.5,
    note: 'success message',
  },
  {
    foreground: 'success-text',
    background: 'surface',
    minimum: 4.5,
    note: 'success text on a panel',
  },
  {
    foreground: 'warning-text',
    background: 'warning-subtle',
    minimum: 4.5,
    note: 'warning message',
  },
  {
    foreground: 'warning-text',
    background: 'surface',
    minimum: 4.5,
    note: 'warning text on a panel',
  },
  { foreground: 'danger-text', background: 'danger-subtle', minimum: 4.5, note: 'error message' },
  { foreground: 'danger-text', background: 'surface', minimum: 4.5, note: 'error text on a panel' },
  {
    foreground: 'info-text',
    background: 'info-subtle',
    minimum: 4.5,
    note: 'informational message',
  },
  { foreground: 'info-text', background: 'surface', minimum: 4.5, note: 'info text on a panel' },

  // ── Non-text contrast, WCAG 2.2 SC 1.4.11 ──────────────────────────────────
  {
    foreground: 'border-strong',
    background: 'bg',
    minimum: 3,
    note: 'an input outline must be visible',
  },
  {
    foreground: 'border-strong',
    background: 'surface',
    minimum: 3,
    note: 'an input outline on a panel',
  },
  {
    foreground: 'focus-ring',
    background: 'bg',
    minimum: 3,
    note: 'the focus indicator — keyboard users cannot navigate without it',
  },
  {
    foreground: 'focus-ring',
    background: 'surface',
    minimum: 3,
    note: 'the focus indicator on a panel',
  },
  {
    foreground: 'focus-ring',
    background: 'surface-raised',
    minimum: 3,
    note: 'the focus indicator inside a menu or dialog',
  },
];
