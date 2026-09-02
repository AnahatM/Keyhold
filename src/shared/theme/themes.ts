// SPDX-License-Identifier: GPL-3.0-or-later
import type { Palette, ThemeDefinition } from './tokens.js';

/**
 * The built-in themes.
 *
 * Eight complete palettes, each a deliberate design rather than a hue rotation of one
 * base. Two are ports of long-established palettes (Nord, Solarized) chosen because
 * people already know whether they like them.
 *
 * **Every palette is verified by `themes.test.ts`** against the contrast requirements in
 * `tokens.ts`. That is not a formality: several values below are darker or lighter than
 * they would "look right" at, specifically because the guard rejected the prettier
 * version. A theme that looks good and fails AA is not a theme this project ships — the
 * whole point of a password manager is reading things correctly.
 *
 * Status colours (`success`, `warning`, `danger`, `info`) stay recognisably green /
 * amber / red / blue in every theme, including the ones with unusual palettes. They carry
 * the health dashboard's meaning, and a theme that makes "breached" look decorative would
 * be actively harmful.
 */

// ── Dawn — the default light theme ────────────────────────────────────────────
const dawn: Palette = {
  bg: '#f7f7f9',
  surface: '#ffffff',
  'surface-raised': '#ffffff',
  'surface-sunken': '#f0f0f4',
  'surface-hover': '#eceef3',
  overlay: 'rgb(24, 25, 32)',

  border: '#dfe1e8',
  // #8b8fa3 reads better but lands at 2.99:1 on `bg` — a hair under the 3.0 floor
  // for a UI boundary (WCAG 2.2 SC 1.4.11). Darkened until the guard passed.
  'border-strong': '#83879c',
  'focus-ring': '#3355cc',

  text: '#1b1c22',
  'text-muted': '#55596b',
  'text-subtle': '#767b8f',
  'text-inverse': '#ffffff',

  accent: '#3355cc',
  'accent-hover': '#2a47ad',
  'accent-active': '#233c93',
  'accent-on': '#ffffff',
  'accent-subtle': '#e6ebfb',
  'accent-subtle-text': '#25409c',

  success: '#1a7f4b',
  'success-text': '#12603a',
  'success-subtle': '#e2f5eb',
  warning: '#9a6300',
  'warning-text': '#7d5000',
  'warning-subtle': '#fdf1dc',
  danger: '#c22a34',
  'danger-text': '#9c1f28',
  'danger-subtle': '#fceaec',
  info: '#0a6a94',
  'info-text': '#075673',
  'info-subtle': '#e0f1f9',
};

// ── Midnight — the default dark theme ─────────────────────────────────────────
const midnight: Palette = {
  bg: '#12131a',
  surface: '#1a1c26',
  'surface-raised': '#232634',
  'surface-sunken': '#0e0f15',
  'surface-hover': '#262a39',
  overlay: 'rgb(4, 5, 9)',

  border: '#2e3244',
  'border-strong': '#6d7590',
  'focus-ring': '#7aa2ff',

  text: '#e7e9ee',
  'text-muted': '#a8adbe',
  'text-subtle': '#858b9e',
  'text-inverse': '#12131a',

  accent: '#7aa2ff',
  'accent-hover': '#9ab8ff',
  'accent-active': '#b3c9ff',
  'accent-on': '#0e1220',
  'accent-subtle': '#1e2740',
  'accent-subtle-text': '#a9c3ff',

  success: '#4ec98a',
  'success-text': '#6fd9a3',
  'success-subtle': '#16281f',
  warning: '#e0a44a',
  'warning-text': '#eab76e',
  'warning-subtle': '#2b2216',
  danger: '#f0707c',
  'danger-text': '#f58c95',
  'danger-subtle': '#2e1a1d',
  info: '#5fb8e0',
  'info-text': '#82c9ea',
  'info-subtle': '#132630',
};

// ── Slate — a cooler, lower-contrast dark ─────────────────────────────────────
const slate: Palette = {
  bg: '#1b1f24',
  surface: '#22272e',
  'surface-raised': '#2b313a',
  'surface-sunken': '#171a1f',
  'surface-hover': '#2f3641',
  overlay: 'rgb(9, 11, 13)',

  border: '#363d47',
  'border-strong': '#79828f',
  'focus-ring': '#8fb8d8',

  text: '#e3e7ec',
  'text-muted': '#a9b2bd',
  'text-subtle': '#8b95a1',
  'text-inverse': '#1b1f24',

  accent: '#8fb8d8',
  'accent-hover': '#a8c9e3',
  'accent-active': '#c0d8ec',
  'accent-on': '#14202a',
  'accent-subtle': '#233340',
  'accent-subtle-text': '#a9cbe5',

  success: '#63c48d',
  'success-text': '#7fd3a2',
  'success-subtle': '#1a2a21',
  warning: '#dda94f',
  'warning-text': '#e8bd76',
  'warning-subtle': '#2c2618',
  danger: '#ea7b83',
  'danger-text': '#f0949b',
  'danger-subtle': '#2d1d20',
  info: '#6fb9d6',
  'info-text': '#8ecae2',
  'info-subtle': '#182a32',
};

// ── Nord — the well-known arctic palette ──────────────────────────────────────
const nord: Palette = {
  bg: '#2e3440',
  surface: '#343c4a',
  'surface-raised': '#3b4252',
  'surface-sunken': '#272c36',
  'surface-hover': '#434c5e',
  overlay: 'rgb(17, 20, 25)',

  border: '#4c566a',
  'border-strong': '#8b95a8',
  'focus-ring': '#88c0d0',

  text: '#eceff4',
  'text-muted': '#c3cad6',
  'text-subtle': '#a4adbd',
  'text-inverse': '#2e3440',

  accent: '#88c0d0',
  'accent-hover': '#9fd0dd',
  'accent-active': '#b6dde7',
  'accent-on': '#1d2630',
  'accent-subtle': '#33414c',
  'accent-subtle-text': '#9fd0dd',

  success: '#a3be8c',
  'success-text': '#b5cda2',
  'success-subtle': '#333d31',
  warning: '#ebcb8b',
  'warning-text': '#efd6a2',
  'warning-subtle': '#3e3828',
  danger: '#bf616a',
  // Lightened from Nord's own #d98a91, which is 4.23:1 on this surface. Error text is
  // exactly the text a user must be able to read, so it is held to 4.5:1 without exception.
  'danger-text': '#e3a1a7',
  'danger-subtle': '#3d2b2e',
  info: '#81a1c1',
  'info-text': '#a1bcd4',
  'info-subtle': '#2f3a47',
};

// ── Solarized Light ───────────────────────────────────────────────────────────
const solarizedLight: Palette = {
  bg: '#fdf6e3',
  surface: '#fffbf0',
  'surface-raised': '#fffdf7',
  'surface-sunken': '#f2ead6',
  'surface-hover': '#f0e7d1',
  overlay: 'rgb(0, 27, 34)',

  border: '#e3d9be',
  'border-strong': '#7e8c8c',
  'focus-ring': '#1e6fa8',

  text: '#073642',
  'text-muted': '#4c5f63',
  'text-subtle': '#657b83',
  'text-inverse': '#fdf6e3',

  accent: '#1e6fa8',
  'accent-hover': '#195b8a',
  'accent-active': '#154c74',
  'accent-on': '#ffffff',
  'accent-subtle': '#dfeaf3',
  'accent-subtle-text': '#155080',

  success: '#5a7000',
  'success-text': '#485a00',
  'success-subtle': '#eaf0d0',
  warning: '#9a5f00',
  'warning-text': '#7c4c00',
  'warning-subtle': '#f8ecd2',
  danger: '#c1262b',
  'danger-text': '#9b1e22',
  'danger-subtle': '#f9e3e3',
  info: '#0d6c86',
  'info-text': '#0a566b',
  'info-subtle': '#ddeef2',
};

// ── Solarized Dark ────────────────────────────────────────────────────────────
const solarizedDark: Palette = {
  bg: '#002b36',
  surface: '#01323d',
  'surface-raised': '#073642',
  'surface-sunken': '#00232c',
  'surface-hover': '#0a4150',
  overlay: 'rgb(0, 13, 17)',

  border: '#0d4b5a',
  'border-strong': '#7d9296',
  'focus-ring': '#4fb3d0',

  text: '#eee8d5',
  'text-muted': '#b5b7ab',
  'text-subtle': '#93a1a1',
  'text-inverse': '#002b36',

  accent: '#4fb3d0',
  'accent-hover': '#72c4dc',
  'accent-active': '#94d4e7',
  'accent-on': '#00222b',
  'accent-subtle': '#053d4b',
  'accent-subtle-text': '#79c8de',

  success: '#93a61a',
  'success-text': '#b3c93b',
  'success-subtle': '#152a12',
  warning: '#cb8b1a',
  'warning-text': '#dda63f',
  'warning-subtle': '#2c2412',
  danger: '#e05a5f',
  'danger-text': '#ea8286',
  'danger-subtle': '#2f1a1c',
  info: '#4fa9c9',
  'info-text': '#7cc2da',
  'info-subtle': '#04303c',
};

// ── Rose — a warm light theme ─────────────────────────────────────────────────
const rose: Palette = {
  bg: '#fdf6f6',
  surface: '#ffffff',
  'surface-raised': '#ffffff',
  'surface-sunken': '#f7eced',
  'surface-hover': '#f7eaec',
  overlay: 'rgb(38, 20, 24)',

  border: '#ecdadd',
  'border-strong': '#9c8286',
  'focus-ring': '#b03060',

  text: '#251a1d',
  'text-muted': '#635155',
  'text-subtle': '#826c71',
  'text-inverse': '#ffffff',

  accent: '#b03060',
  'accent-hover': '#932751',
  'accent-active': '#7b2143',
  'accent-on': '#ffffff',
  'accent-subtle': '#fae3ea',
  'accent-subtle-text': '#8e2750',

  success: '#1a7a52',
  'success-text': '#135c3e',
  'success-subtle': '#e0f3ea',
  warning: '#985e00',
  'warning-text': '#7b4c00',
  'warning-subtle': '#fbeed9',
  danger: '#bd2b3c',
  'danger-text': '#98212f',
  'danger-subtle': '#fbe7ea',
  info: '#0d6489',
  'info-text': '#0a5170',
  'info-subtle': '#e0eff6',
};

// ── High Contrast — an accessibility theme, not a dark theme ──────────────────
//
// Deliberately harsh. Pure black and white, saturated status colours, and a focus ring
// that is impossible to miss. Aimed at low vision and at bright-sunlight use, where the
// pleasant low-contrast greys of every other theme become unreadable.
const highContrast: Palette = {
  bg: '#000000',
  surface: '#000000',
  'surface-raised': '#141414',
  'surface-sunken': '#000000',
  'surface-hover': '#242424',
  overlay: 'rgb(0, 0, 0)',

  border: '#7a7a7a',
  'border-strong': '#ffffff',
  'focus-ring': '#ffe100',

  text: '#ffffff',
  'text-muted': '#e6e6e6',
  'text-subtle': '#c4c4c4',
  'text-inverse': '#000000',

  accent: '#ffe100',
  'accent-hover': '#ffec5c',
  'accent-active': '#fff495',
  'accent-on': '#000000',
  'accent-subtle': '#2e2800',
  'accent-subtle-text': '#ffe100',

  success: '#00e676',
  'success-text': '#00e676',
  'success-subtle': '#00250f',
  warning: '#ffb300',
  'warning-text': '#ffb300',
  'warning-subtle': '#2b1e00',
  danger: '#ff5c6b',
  'danger-text': '#ff8b95',
  'danger-subtle': '#2e0007',
  info: '#4fc3f7',
  'info-text': '#7fd4fa',
  'info-subtle': '#002230',
};

export const THEMES: readonly ThemeDefinition[] = [
  {
    id: 'dawn',
    name: 'Dawn',
    scheme: 'light',
    description: 'A clean, neutral light theme. The default when your system is set to light.',
    palette: dawn,
  },
  {
    id: 'midnight',
    name: 'Midnight',
    scheme: 'dark',
    description: 'A deep blue-grey dark theme. The default when your system is set to dark.',
    palette: midnight,
  },
  {
    id: 'slate',
    name: 'Slate',
    scheme: 'dark',
    description: 'Cooler and softer than Midnight, for long sessions.',
    palette: slate,
  },
  {
    id: 'nord',
    name: 'Nord',
    scheme: 'dark',
    description: 'The arctic, north-bluish palette.',
    palette: nord,
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    scheme: 'light',
    description: "Ethan Schoonover's low-contrast light palette.",
    palette: solarizedLight,
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    scheme: 'dark',
    description: "Ethan Schoonover's low-contrast dark palette.",
    palette: solarizedDark,
  },
  {
    id: 'rose',
    name: 'Rose',
    scheme: 'light',
    description: 'A warm light theme with a deep pink accent.',
    palette: rose,
  },
  {
    id: 'high-contrast',
    name: 'High Contrast',
    scheme: 'dark',
    description:
      'Maximum contrast for low vision or bright sunlight. Not subtle, and not meant to be.',
    palette: highContrast,
  },
];

/**
 * A theme that is guaranteed to exist, for the last step of every fallback chain.
 *
 * Exported as a value rather than reached for via `THEMES[0]` so the type system knows it
 * is defined. `THEMES[0]` is `ThemeDefinition | undefined` under `noUncheckedIndexedAccess`,
 * and the assertion needed to say otherwise is exactly the kind that hides real bugs.
 */
export const FALLBACK_THEME: ThemeDefinition = {
  id: 'midnight',
  name: 'Midnight',
  scheme: 'dark',
  description: 'A deep blue-grey dark theme. The default when your system is set to dark.',
  palette: midnight,
};

export const DEFAULT_LIGHT_THEME_ID = 'dawn';
export const DEFAULT_DARK_THEME_ID = 'midnight';

export function findTheme(id: string): ThemeDefinition | undefined {
  return THEMES.find((theme) => theme.id === id);
}
