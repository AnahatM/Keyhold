// SPDX-License-Identifier: GPL-3.0-or-later
import {
  contrastRatio,
  formatRatio,
  gradeContrast,
  parseColour,
  type Rgb,
  type WcagLevel,
} from './contrast.js';
import { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID, findTheme } from './themes.js';
import {
  COLOUR_TOKENS,
  CONTRAST_REQUIREMENTS,
  type ColourToken,
  type ContrastRequirement,
  type Palette,
  type ThemeDefinition,
} from './tokens.js';

/**
 * The `.keeptheme` format: a plaintext, shareable theme file.
 *
 * A `.keeptheme` holds **no vault data and never should** — it is a name, a scheme, a base
 * theme, and a map of the token vocabulary in `tokens.ts` to colour literals. It is not
 * encrypted because there is nothing in it worth encrypting, and that is a deliberate,
 * stated property rather than an omission: people are expected to post these on the
 * internet and hand them to each other.
 *
 * ## Why the format is deliberately NOT "just CSS"
 *
 * The obvious design is to let a theme be a stylesheet — `:root { --kh-color-bg: … }` — and
 * paste it into a `<style>` element. Every part of that is wrong here:
 *
 *  - **CSS is executable in the ways that matter.** `url()` fetches (this app makes zero
 *    network requests by design — hard rule 5), `@import` fetches, `image-set()` fetches,
 *    and a stylesheet can restyle or hide any element in the app, including the parts of
 *    Settings a user would need to undo the theme. A theme file arriving from a stranger
 *    must not be able to reach the network or move the furniture.
 *  - **`var()` chains and `calc()` are computation.** A value that resolves at paint time
 *    cannot be contrast-checked before it is applied, which is exactly the guarantee this
 *    file exists to preserve. A ratio can only be measured against a concrete colour.
 *  - **A stylesheet has no schema.** "Which tokens are missing" is unanswerable, so a theme
 *    with three tokens missing renders as an app with three invisible elements and looks
 *    broken rather than incomplete.
 *
 * So the format is a **fixed set of token names mapping to validated colour literals, and
 * nothing else**. Anything unrecognised is dropped, and — the part that matters most —
 * every accepted colour is re-serialised from parsed RGB into `#rrggbb` before it can reach
 * a stylesheet. The string that eventually lands in `style.setProperty` is one *we* wrote,
 * not one the file supplied, so even a bug in the validator cannot turn into a CSS
 * injection.
 *
 * ## What a hostile file is checked for, in order
 *
 * | Problem                     | Response                                                    |
 * | --------------------------- | ----------------------------------------------------------- |
 * | Not JSON / not an object    | Rejected                                                     |
 * | Wrong `format` marker       | Rejected                                                     |
 * | Newer `version`             | Rejected, naming the version — never mis-parsed as v1        |
 * | Bad name / scheme           | Rejected, naming the field                                   |
 * | Unknown token               | **Ignored, with a warning naming it**                        |
 * | Missing token               | **Filled from the named base theme, with a warning**         |
 * | Unparseable / translucent   | **Rejected, naming every offending token** — never defaulted |
 * | Fails WCAG AA               | Rejected unless explicitly and informedly acknowledged       |
 * | Fails the legibility floor  | Rejected. No override exists                                 |
 *
 * The missing/unparseable split is the interesting one. An **absent** key is a theme that
 * is incomplete — possibly on purpose, and certainly the shape a v1 file will have when a
 * later Keyhold adds a token — so it is filled from the base and reported. A **present but
 * broken** value is an author mistake, and silently replacing it would hide the typo while
 * shipping a colour they never chose.
 *
 * See `docs/06-UI-Design-System/00-Tokens-And-Themes.md` §8.
 */

// ── Constants ────────────────────────────────────────────────────────────────

export const KEEPTHEME_FORMAT = 'keyhold-theme';
export const KEEPTHEME_FORMAT_VERSION = 1;
export const KEEPTHEME_EXTENSION = 'keeptheme';

/**
 * A hard ceiling on a theme file.
 *
 * A complete theme serialises to roughly 1.5 KB. 64 KB is generous by two orders of
 * magnitude and still small enough that a malicious multi-megabyte "theme" is refused
 * before `JSON.parse` is asked to allocate it.
 */
export const KEEPTHEME_MAX_BYTES = 64 * 1024;

export const KEEPTHEME_MAX_NAME_LENGTH = 80;
export const KEEPTHEME_MAX_DESCRIPTION_LENGTH = 240;

/** A colour literal is never long. Anything longer is not a colour, whatever it is. */
const MAX_COLOUR_LENGTH = 32;

// ── Colour validation ────────────────────────────────────────────────────────

export type ColourRejectionReason = 'too-long' | 'translucent' | 'not-a-colour';

export type NormaliseColourResult =
  | { readonly ok: true; readonly hex: string }
  | { readonly ok: false; readonly reason: ColourRejectionReason };

const HEX_WITH_ALPHA = /^#(?:[0-9a-f]{4}|[0-9a-f]{8})$/;
const RGB_FUNCTION =
  /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?<alpha>[0-9.]+)\s*)?\)$/;

/**
 * Formats parsed channels back to `#rrggbb`.
 *
 * `accent.ts` has an identical private helper. Duplicating six lines of hex formatting is
 * the lesser evil against widening that module's public surface, which exists to derive an
 * accent ramp and nothing else.
 */
function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b]
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

/**
 * Validates one colour literal and returns it in canonical `#rrggbb` form.
 *
 * Accepts exactly what `contrast.ts` can measure — `#rgb`, `#rrggbb`, `rgb()`, `rgba()` —
 * plus fully-opaque `#rgba` / `#rrggbbaa`, which are stripped to their opaque equivalent.
 *
 * **Translucency is refused rather than silently flattened.** A contrast ratio cannot be
 * computed through transparency without knowing what is behind it, so a translucent token
 * would be a value the AA guard cannot honestly grade. The palette is a set of colours, not
 * colours-with-compositing: `overlay` is opaque and the scrim's translucency lives in
 * `chrome.css` as an `opacity`, which is the same decision made from the other end.
 */
export function normaliseColour(value: string): NormaliseColourResult {
  const text = value.trim().toLowerCase();
  if (text.length === 0) return { ok: false, reason: 'not-a-colour' };
  if (text.length > MAX_COLOUR_LENGTH) return { ok: false, reason: 'too-long' };

  let candidate = text;

  const hexAlpha = HEX_WITH_ALPHA.exec(candidate);
  if (hexAlpha !== null) {
    const isShortForm = candidate.length === 5;
    const alpha = isShortForm ? candidate.slice(4, 5).repeat(2) : candidate.slice(7, 9);
    if (alpha !== 'ff') return { ok: false, reason: 'translucent' };
    candidate = isShortForm ? candidate.slice(0, 4) : candidate.slice(0, 7);
  }

  const rgbFunction = RGB_FUNCTION.exec(candidate);
  if (rgbFunction !== null) {
    const alpha = rgbFunction.groups?.alpha;
    if (alpha !== undefined && Number.parseFloat(alpha) !== 1) {
      return { ok: false, reason: 'translucent' };
    }
  }

  const rgb = parseColour(candidate);
  if (rgb === null) return { ok: false, reason: 'not-a-colour' };
  return { ok: true, hex: toHex(rgb) };
}

export function describeColourRejection(reason: ColourRejectionReason): string {
  switch (reason) {
    case 'too-long':
      return 'is too long to be a colour';
    case 'translucent':
      return 'is translucent — a palette colour must be opaque, because contrast cannot be measured through transparency';
    case 'not-a-colour':
      return 'is not a colour Keyhold understands (use #rgb, #rrggbb or rgb(r, g, b))';
  }
}

/**
 * Best-effort canonicalisation of a whole palette.
 *
 * Values that do not parse are passed through untouched — this is used when serialising a
 * palette that is already trusted (a built-in, or a draft the editor has validated), and
 * losing a value here would be worse than emitting one the reader will then reject by name.
 */
export function normalisePalette(palette: Palette): Palette {
  const result: Record<string, string> = {};
  for (const token of COLOUR_TOKENS) {
    const normalised = normaliseColour(palette[token]);
    result[token] = normalised.ok ? normalised.hex : palette[token];
  }
  return result as Palette;
}

// ── Contrast measurement ─────────────────────────────────────────────────────

/**
 * One measured requirement.
 *
 * `verdict` is a word, not a colour and not a boolean the UI has to translate. The contrast
 * report is the accessibility screen; signalling pass/fail by colour alone there would be a
 * WCAG 1.4.1 failure in the very panel that exists to report WCAG failures.
 */
export interface ContrastFinding {
  readonly requirement: ContrastRequirement;
  readonly foreground: ColourToken;
  readonly background: ColourToken;
  readonly foregroundValue: string;
  readonly backgroundValue: string;
  readonly minimum: number;
  readonly ratio: number;
  readonly ratioText: string;
  readonly minimumText: string;
  readonly grade: WcagLevel;
  readonly passes: boolean;
  readonly verdict: 'Pass' | 'Fail';
}

export interface ContrastReport {
  readonly findings: readonly ContrastFinding[];
  readonly failures: readonly ContrastFinding[];
  /** The single worst pair, for a one-line summary. `null` only when there are no pairs. */
  readonly worst: ContrastFinding | null;
  readonly passes: boolean;
}

/**
 * Measures one pair.
 *
 * The ratio comes from `contrast.ts` and nowhere else. There is deliberately no arithmetic
 * in this file: a second implementation of the WCAG luminance formula that drifted by a
 * rounding step would make the studio's live report disagree with the guard test that
 * blocks a theme, and the user would be told two different things about the same colours.
 * `keeptheme-format.test.ts` asserts both the agreement and the absence of the constants.
 */
function measurePair(palette: Palette, requirement: ContrastRequirement): ContrastFinding {
  const foregroundValue = palette[requirement.foreground];
  const backgroundValue = palette[requirement.background];
  const foreground = parseColour(foregroundValue);
  const background = parseColour(backgroundValue);

  // A palette reaching here should already be canonical hex, but the studio can also hand
  // over a draft mid-edit. An unmeasurable pair is reported as the worst possible ratio
  // rather than skipped: "we could not check this" must never read as "this is fine".
  const ratio =
    foreground === null || background === null ? 1 : contrastRatio(foreground, background);
  const passes = ratio >= requirement.minimum;

  return {
    requirement,
    foreground: requirement.foreground,
    background: requirement.background,
    foregroundValue,
    backgroundValue,
    minimum: requirement.minimum,
    ratio,
    ratioText: formatRatio(ratio),
    minimumText: formatRatio(requirement.minimum),
    grade: gradeContrast(ratio),
    passes,
    verdict: passes ? 'Pass' : 'Fail',
  };
}

/**
 * Grades a palette against a set of requirements — by default every one in `tokens.ts`.
 *
 * The requirement list is a parameter so the legibility floor below can reuse this rather
 * than measuring pairs its own way.
 */
export function evaluatePaletteContrast(
  palette: Palette,
  requirements: readonly ContrastRequirement[] = CONTRAST_REQUIREMENTS
): ContrastReport {
  const findings = requirements.map((requirement) => measurePair(palette, requirement));
  const failures = findings.filter((finding) => !finding.passes);

  let worst: ContrastFinding | null = null;
  for (const finding of findings) {
    // Ranked by how far short of its own minimum it falls, not by raw ratio: a 3.2:1 pair
    // that needed 4.5 is a worse problem than a 3.1:1 pair that only needed 3.
    if (worst === null || finding.ratio / finding.minimum < worst.ratio / worst.minimum) {
      worst = finding;
    }
  }

  return { findings, failures, worst, passes: failures.length === 0 };
}

// ── The legibility floor: the one thing a user may not consent to ────────────

/**
 * The ratio below which a theme stops being a preference and becomes a lockout.
 *
 * 3:1 is the WCAG 2.2 SC 1.4.11 floor for a UI component boundary. Below it, body text on a
 * surface is not "low contrast", it is approaching invisible.
 */
export const ESCAPE_FLOOR_MINIMUM = 3;

/**
 * The pairs a user needs in order to undo their own theme.
 *
 * This is a **subset of `CONTRAST_REQUIREMENTS` at a lower bar**, not a second list: the
 * same pairs, re-stated with the different question they answer. `CONTRAST_REQUIREMENTS`
 * asks "is this comfortably readable?"; these four ask "can you still find Settings and
 * change it back?". `keeptheme-format.test.ts` asserts every pair here is also declared in
 * `tokens.ts`, so dropping one there cannot leave a floor pair orphaned.
 *
 * `focus-ring` on `bg` is in the list because a keyboard-only user with no visible focus
 * indicator cannot reach the control that would fix the theme, however readable the text is.
 */
export const ESCAPE_FLOOR_REQUIREMENTS: readonly ContrastRequirement[] = [
  {
    foreground: 'text',
    background: 'bg',
    minimum: ESCAPE_FLOOR_MINIMUM,
    note: 'body text on the app background — below this the app is unreadable, not merely uncomfortable',
  },
  {
    foreground: 'text',
    background: 'surface',
    minimum: ESCAPE_FLOOR_MINIMUM,
    note: 'body text on a panel — Settings is a panel',
  },
  {
    foreground: 'text',
    background: 'surface-raised',
    minimum: ESCAPE_FLOOR_MINIMUM,
    note: 'body text in a dialog — the confirmation that undoes the theme is a dialog',
  },
  {
    foreground: 'focus-ring',
    background: 'bg',
    minimum: ESCAPE_FLOOR_MINIMUM,
    note: 'the focus indicator — a keyboard user cannot reach Settings without it',
  },
];

export function evaluateEscapeFloor(palette: Palette): ContrastReport {
  return evaluatePaletteContrast(palette, ESCAPE_FLOOR_REQUIREMENTS);
}

// ── Informed consent, made checkable ─────────────────────────────────────────

/** FNV-1a, 32-bit. Deterministic and dependency-free; see `contrastAcknowledgement`. */
function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * A short token identifying **this exact palette and this exact set of failures**.
 *
 * To accept a theme that fails AA, a caller must hand back the token for the report it
 * displayed. That is what makes the override *informed* in code rather than by convention:
 *
 *  - It cannot be a stored boolean. There is no "don't warn me about themes again" that a
 *    future settings screen could add by accident, because the token is derived from the
 *    palette and changes with every edit.
 *  - It goes stale on any change. Acknowledge a theme, nudge one colour, and the consent no
 *    longer applies — which is right, because the failures may now be different ones.
 *  - It goes stale when `CONTRAST_REQUIREMENTS` changes, since the failures feed the digest.
 *    A theme admitted under an older, laxer rule set is re-asked about, not grandfathered.
 *
 * **This is not a security control.** The renderer is semi-trusted and could compute the
 * token without showing anyone anything; a user editing `localStorage` by hand can do as
 * they like with their own machine. It is a design guard against *our own* future UI taking
 * the shortcut, which is how an accessibility guarantee actually dies.
 */
export function contrastAcknowledgement(palette: Palette, report: ContrastReport): string {
  const canonical = [
    `keeptheme-contrast/${KEEPTHEME_FORMAT_VERSION}`,
    ...COLOUR_TOKENS.map((token) => `${token}=${palette[token]}`),
    '--',
    ...report.failures.map(
      (finding) =>
        `${finding.foreground}>${finding.background}@${finding.ratioText}<${finding.minimumText}`
    ),
  ].join('\n');
  return fnv1a32(canonical);
}

export type ThemeAdmission =
  | { readonly ok: true; readonly report: ContrastReport; readonly usedOverride: boolean }
  | {
      readonly ok: false;
      readonly reason: 'illegible';
      readonly report: ContrastReport;
      readonly floor: ContrastReport;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'unacknowledged';
      readonly report: ContrastReport;
      readonly acknowledgement: string;
      readonly message: string;
    };

/**
 * The single gate every palette passes through before it can be applied or exported.
 *
 * ## The decision: a failing theme is rejected by default, and admissible only with an
 * explicit, per-theme acknowledgement — except below the legibility floor, where no
 * override exists at all.
 *
 * Three tiers, and the reasoning for each:
 *
 * **1. Passes AA → accepted.** Nothing to decide.
 *
 * **2. Fails AA but clears the floor → refused, unless acknowledged.** A hard refusal was
 * the first instinct and it is wrong, for two reasons that are not "it's their choice":
 *
 *   - *WCAG AA is a population floor, not an individual optimum.* Keyhold already ships
 *     `high-contrast` precisely because access needs differ. They differ in the other
 *     direction too: photophobia, migraine, and Irlen-type sensitivity make maximum
 *     contrast genuinely painful, and the palette that works for such a user can fail a
 *     4.5:1 check while being the *more* accessible choice for them. An app that refuses
 *     outright is not protecting that person, it is overruling them.
 *   - *A hard refusal routes around the check.* The palette is persisted in
 *     `localStorage`, and a determined user who is told "no" edits it there, or ships a
 *     patched build. They then get the theme with **no report, no warning and no floor** —
 *     strictly worse than the same theme admitted through a gate that told them exactly
 *     what was wrong. Refusing the honest path only removes our chance to inform.
 *
 * So the choice is offered, and the burden is on the app to make it *informed*: the
 * acknowledgement is per-theme, derived from the palette, and impossible to give without
 * the failing pairs having been computed — the studio renders them, named and rated, before
 * the checkbox that produces the token exists. "It's their choice" is only an acceptable
 * answer once the choice is real, and a choice made without seeing the consequences is not.
 *
 * **3. Fails the legibility floor → refused outright, no override.** Consent to a bad theme
 * is real; consent to a theme that traps you is not, because **you cannot revoke it**. A
 * palette with `text` at 1.4:1 on `bg` leaves a user unable to read the Settings screen that
 * would undo it — the decision becomes irreversible at the moment it is made, which is the
 * one thing genuine consent cannot survive. This is the same reasoning as the app never
 * shipping an "auto-lock: never" that cannot be turned back on.
 */
export function admitPalette(palette: Palette, acknowledgement: string | null): ThemeAdmission {
  const report = evaluatePaletteContrast(palette);
  const floor = evaluateEscapeFloor(palette);

  if (!floor.passes) {
    const pairs = floor.failures
      .map((finding) => `${finding.foreground} on ${finding.background} (${finding.ratioText})`)
      .join(', ');
    return {
      ok: false,
      reason: 'illegible',
      report,
      floor,
      message: `This theme cannot be used: ${pairs} — below ${formatRatio(ESCAPE_FLOOR_MINIMUM)} you could not read the screen that changes it back.`,
    };
  }

  if (report.passes) return { ok: true, report, usedOverride: false };

  const expected = contrastAcknowledgement(palette, report);
  if (acknowledgement === expected) return { ok: true, report, usedOverride: true };

  return {
    ok: false,
    reason: 'unacknowledged',
    report,
    acknowledgement: expected,
    message: `This theme fails ${report.failures.length} contrast check${report.failures.length === 1 ? '' : 's'}. Review them and confirm before using it.`,
  };
}

// ── The file ─────────────────────────────────────────────────────────────────

export interface KeepTheme {
  readonly format: typeof KEEPTHEME_FORMAT;
  readonly version: number;
  readonly name: string;
  /** May be empty. Always present in the file so the shape never varies. */
  readonly description: string;
  readonly scheme: 'light' | 'dark';
  /** The built-in theme any missing token is filled from. */
  readonly basedOn: string;
  readonly palette: Palette;
}

export type KeepThemeWarning =
  | { readonly kind: 'unknown-token'; readonly token: string; readonly message: string }
  | {
      readonly kind: 'missing-token';
      readonly token: ColourToken;
      readonly filledFrom: string;
      readonly message: string;
    }
  | {
      readonly kind: 'unknown-base';
      readonly requested: string;
      readonly usedInstead: string;
      readonly message: string;
    };

export interface InvalidColour {
  readonly token: ColourToken;
  readonly value: string;
  readonly reason: ColourRejectionReason;
  readonly message: string;
}

export type KeepThemeRejection =
  | { readonly kind: 'too-large'; readonly message: string }
  | { readonly kind: 'not-json'; readonly message: string }
  | { readonly kind: 'not-a-theme'; readonly message: string }
  | { readonly kind: 'future-version'; readonly version: number; readonly message: string }
  | { readonly kind: 'invalid-field'; readonly field: string; readonly message: string }
  | {
      readonly kind: 'invalid-colours';
      readonly colours: readonly InvalidColour[];
      readonly message: string;
    }
  | {
      readonly kind: 'illegible';
      readonly report: ContrastReport;
      readonly floor: ContrastReport;
      readonly message: string;
    }
  | {
      readonly kind: 'contrast';
      readonly report: ContrastReport;
      readonly acknowledgement: string;
      /** Carried so the caller can preview and report on it without re-parsing. */
      readonly theme: KeepTheme;
      readonly warnings: readonly KeepThemeWarning[];
      readonly message: string;
    };

export type KeepThemeParseResult =
  | {
      readonly ok: true;
      readonly theme: KeepTheme;
      readonly warnings: readonly KeepThemeWarning[];
      readonly contrast: ContrastReport;
      readonly acceptedWithContrastOverride: boolean;
    }
  | { readonly ok: false; readonly rejection: KeepThemeRejection };

export interface ParseKeepThemeOptions {
  /**
   * The token from `contrastAcknowledgement`, echoed back by a caller that has shown the
   * user the failing pairs. Anything else — including `true`, a stored flag, or a token for
   * a different palette — leaves the theme rejected.
   */
  readonly acknowledgement?: string | null;
}

/** Serialises to canonical form: fixed key order, canonical colours, trailing newline. */
export function serialiseKeepTheme(theme: KeepTheme): string {
  const palette: Record<string, string> = {};
  const canonical = normalisePalette(theme.palette);
  // Written in `COLOUR_TOKENS` order rather than whatever order the object happens to hold,
  // so two theme files diff against each other line by line.
  for (const token of COLOUR_TOKENS) palette[token] = canonical[token];

  return `${JSON.stringify(
    {
      format: KEEPTHEME_FORMAT,
      version: KEEPTHEME_FORMAT_VERSION,
      name: theme.name,
      description: theme.description,
      scheme: theme.scheme,
      basedOn: theme.basedOn,
      palette,
    },
    null,
    2
  )}\n`;
}

/** A built-in theme as an editable starting point. */
export function keepThemeFromDefinition(definition: ThemeDefinition, name?: string): KeepTheme {
  return {
    format: KEEPTHEME_FORMAT,
    version: KEEPTHEME_FORMAT_VERSION,
    name: name ?? definition.name,
    description: definition.description,
    scheme: definition.scheme,
    basedOn: definition.id,
    palette: normalisePalette(definition.palette),
  };
}

function defaultBaseThemeId(scheme: 'light' | 'dark'): string {
  return scheme === 'dark' ? DEFAULT_DARK_THEME_ID : DEFAULT_LIGHT_THEME_ID;
}

/**
 * True if the text contains a C0 control character or DEL.
 *
 * Checked with a loop rather than a regex so no control-character class has to be written
 * (and disabled past `no-control-regex`) in a file that validates hostile input.
 */
function hasControlCharacters(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function readString(
  raw: Record<string, unknown>,
  field: string,
  maximumLength: number,
  required: boolean
):
  { readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string } {
  const value = raw[field];
  if (value === undefined || value === null) {
    return required
      ? { ok: false, message: `This theme has no ${field}.` }
      : { ok: true, value: '' };
  }
  if (typeof value !== 'string') {
    return { ok: false, message: `This theme's ${field} is not text.` };
  }

  const trimmed = value.trim();
  if (required && trimmed === '') return { ok: false, message: `This theme has no ${field}.` };
  if (trimmed.length > maximumLength) {
    return {
      ok: false,
      message: `This theme's ${field} is longer than ${maximumLength} characters.`,
    };
  }
  if (hasControlCharacters(trimmed)) {
    return { ok: false, message: `This theme's ${field} contains characters that are not text.` };
  }
  return { ok: true, value: trimmed };
}

/**
 * Parses a `.keeptheme` file, treating it as hostile.
 *
 * Returns a reason rather than throwing: every caller is a UI that has to explain what is
 * wrong with the file the user just picked.
 */
export function parseKeepTheme(
  contents: string,
  options: ParseKeepThemeOptions = {}
): KeepThemeParseResult {
  // Characters, not bytes — always ≤ the UTF-8 byte length, so this can only be stricter
  // than the reader's own cap. It exists to protect callers that never touched a file.
  if (contents.length > KEEPTHEME_MAX_BYTES) {
    return {
      ok: false,
      rejection: {
        kind: 'too-large',
        message: `A theme file cannot be larger than ${KEEPTHEME_MAX_BYTES / 1024} KB.`,
      },
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    return { ok: false, rejection: { kind: 'not-json', message: 'This file is not valid JSON.' } };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      rejection: { kind: 'not-a-theme', message: 'This file does not contain a theme.' },
    };
  }

  const candidate = raw as Record<string, unknown>;

  if (candidate.format !== KEEPTHEME_FORMAT) {
    return {
      ok: false,
      rejection: { kind: 'not-a-theme', message: 'This is not a Keyhold theme file.' },
    };
  }

  const version = candidate.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return {
      ok: false,
      rejection: {
        kind: 'invalid-field',
        field: 'version',
        message: 'This theme does not say which format version it uses.',
      },
    };
  }
  if (version > KEEPTHEME_FORMAT_VERSION) {
    // Refused rather than read as v1. A later format may reuse a key with a new meaning,
    // and guessing produces a theme the author never wrote.
    return {
      ok: false,
      rejection: {
        kind: 'future-version',
        version,
        message: `This theme was made by a newer version of Keyhold (theme format ${version}; this build understands ${KEEPTHEME_FORMAT_VERSION}).`,
      },
    };
  }

  const name = readString(candidate, 'name', KEEPTHEME_MAX_NAME_LENGTH, true);
  if (!name.ok) {
    return {
      ok: false,
      rejection: { kind: 'invalid-field', field: 'name', message: name.message },
    };
  }

  const description = readString(candidate, 'description', KEEPTHEME_MAX_DESCRIPTION_LENGTH, false);
  if (!description.ok) {
    return {
      ok: false,
      rejection: { kind: 'invalid-field', field: 'description', message: description.message },
    };
  }

  const scheme = candidate.scheme;
  if (scheme !== 'light' && scheme !== 'dark') {
    return {
      ok: false,
      rejection: {
        kind: 'invalid-field',
        field: 'scheme',
        message: 'This theme does not say whether it is light or dark.',
      },
    };
  }

  const warnings: KeepThemeWarning[] = [];

  // ── The base theme every missing token is filled from ──────────────────────
  const requestedBase = candidate.basedOn;
  const fallbackBaseId = defaultBaseThemeId(scheme);
  let baseId = fallbackBaseId;

  if (typeof requestedBase === 'string' && requestedBase.trim() !== '') {
    const found = findTheme(requestedBase.trim());
    if (found === undefined) {
      warnings.push({
        kind: 'unknown-base',
        requested: requestedBase.trim(),
        usedInstead: fallbackBaseId,
        message: `This theme is based on "${requestedBase.trim()}", which this build does not have. Missing colours were taken from ${fallbackBaseId} instead.`,
      });
    } else {
      baseId = found.id;
    }
  }

  const base = findTheme(baseId);
  if (base === undefined) {
    return {
      ok: false,
      rejection: {
        kind: 'invalid-field',
        field: 'basedOn',
        message: 'This build has no theme to fall back to.',
      },
    };
  }
  const basePalette = normalisePalette(base.palette);

  // ── The palette ────────────────────────────────────────────────────────────
  const rawPalette = candidate.palette;
  if (typeof rawPalette !== 'object' || rawPalette === null || Array.isArray(rawPalette)) {
    return {
      ok: false,
      rejection: {
        kind: 'invalid-field',
        field: 'palette',
        message: 'This theme has no colours in it.',
      },
    };
  }
  const paletteRecord = rawPalette as Record<string, unknown>;

  const known = new Set<string>(COLOUR_TOKENS);
  for (const key of Object.keys(paletteRecord)) {
    if (!known.has(key)) {
      // Dropped, not rejected: this is exactly what an older build sees when it opens a
      // theme written by a newer one, and refusing would make the format un-evolvable.
      warnings.push({
        kind: 'unknown-token',
        token: key,
        message: `Ignored an unknown colour "${key}". This theme may have been made for a newer version of Keyhold.`,
      });
    }
  }

  const palette: Record<string, string> = {};
  const invalid: InvalidColour[] = [];

  for (const token of COLOUR_TOKENS) {
    const value = paletteRecord[token];

    if (value === undefined || value === null) {
      palette[token] = basePalette[token];
      warnings.push({
        kind: 'missing-token',
        token,
        filledFrom: base.id,
        message: `Missing colour "${token}" — filled in from ${base.name}.`,
      });
      continue;
    }

    if (typeof value !== 'string') {
      invalid.push({
        token,
        value: typeof value,
        reason: 'not-a-colour',
        message: `"${token}" is not text.`,
      });
      continue;
    }

    const normalised = normaliseColour(value);
    if (!normalised.ok) {
      // Echoed back so the author can find the typo, truncated so a hostile file cannot
      // push an essay into the UI.
      const shown = value.length > 40 ? `${value.slice(0, 40)}…` : value;
      invalid.push({
        token,
        value: shown,
        reason: normalised.reason,
        message: `"${token}": "${shown}" ${describeColourRejection(normalised.reason)}.`,
      });
      continue;
    }

    palette[token] = normalised.hex;
  }

  if (invalid.length > 0) {
    // Every offender is named at once. Reporting the first alone turns fixing a theme into
    // a game of whack-a-mole across thirty values.
    return {
      ok: false,
      rejection: {
        kind: 'invalid-colours',
        colours: invalid,
        message: `${invalid.length} colour${invalid.length === 1 ? '' : 's'} in this theme could not be read: ${invalid.map((entry) => entry.token).join(', ')}.`,
      },
    };
  }

  const theme: KeepTheme = {
    format: KEEPTHEME_FORMAT,
    version: KEEPTHEME_FORMAT_VERSION,
    name: name.value,
    description: description.value,
    scheme,
    basedOn: base.id,
    palette: palette as Palette,
  };

  const admission = admitPalette(theme.palette, options.acknowledgement ?? null);
  if (!admission.ok) {
    if (admission.reason === 'illegible') {
      return {
        ok: false,
        rejection: {
          kind: 'illegible',
          report: admission.report,
          floor: admission.floor,
          message: admission.message,
        },
      };
    }
    return {
      ok: false,
      rejection: {
        kind: 'contrast',
        report: admission.report,
        acknowledgement: admission.acknowledgement,
        theme,
        warnings,
        message: admission.message,
      },
    };
  }

  return {
    ok: true,
    theme,
    warnings,
    contrast: admission.report,
    acceptedWithContrastOverride: admission.usedOverride,
  };
}

/** A safe, predictable file name for a theme. Never derived straight from user text. */
export function suggestKeepThemeFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${slug === '' ? 'theme' : slug}.${KEEPTHEME_EXTENSION}`;
}
