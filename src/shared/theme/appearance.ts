// SPDX-License-Identifier: GPL-3.0-or-later
import { applyAccent } from './accent.js';
import {
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  FALLBACK_THEME,
  findTheme,
} from './themes.js';
import { STYLE_TOKENS, type StyleDefinition } from './style-tokens.js';
import { DEFAULT_STYLE_ID, resolveStyle } from './styles.js';
import { COLOUR_TOKENS, type Palette, type ThemeDefinition } from './tokens.js';

/**
 * Everything the user can change about how Keyhold looks, and the resolution of those
 * choices into CSS custom properties.
 *
 * Appearance is **machine-scoped, not vault-scoped**: it lives in app preferences, not
 * inside the encrypted file. A vault carried to another machine should not silently
 * re-theme that machine's app, and the settings contain nothing worth encrypting.
 *
 * Every value here is independently overridable — decision D10. Density and font scale in
 * particular are accessibility settings as much as taste ones, and burying them behind a
 * single "theme" choice would be the wrong shape.
 */

// ── Density ──────────────────────────────────────────────────────────────────

export const DENSITIES = ['compact', 'comfortable', 'spacious'] as const;
export type Density = (typeof DENSITIES)[number];

/**
 * Row heights and the spacing scale, per density.
 *
 * `compact` exists for people with a thousand credentials who want to see them; `spacious`
 * exists for touch, for large displays, and for anyone who finds dense UIs hard to track.
 * The 44px floor on `comfortable` and above is the WCAG target-size guidance; `compact`
 * deliberately goes below it, which is why it is opt-in and never the default.
 */
export const DENSITY_METRICS: Record<
  Density,
  { rowHeight: string; controlHeight: string; spaceScale: number }
> = {
  compact: { rowHeight: '30px', controlHeight: '30px', spaceScale: 0.85 },
  comfortable: { rowHeight: '44px', controlHeight: '36px', spaceScale: 1 },
  spacious: { rowHeight: '56px', controlHeight: '44px', spaceScale: 1.2 },
};

// ── Type ─────────────────────────────────────────────────────────────────────

export const FONT_SCALES = [0.875, 1, 1.125, 1.25, 1.5] as const;
export type FontScale = (typeof FONT_SCALES)[number];

export const FONT_FAMILIES = ['system', 'sans', 'serif', 'mono'] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];

export const FONT_STACKS: Record<FontFamily, string> = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  sans: '"Inter", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", "Noto Serif", serif',
  mono: 'ui-monospace, "Cascadia Code", "Fira Code", Consolas, "Liberation Mono", monospace',
};

/**
 * The face used for secrets and anything the user must transcribe by eye.
 *
 * Always monospace, regardless of the body font choice. A password shown in a
 * proportional face makes `l`, `1`, `I` and `|` — and `0` versus `O` — genuinely
 * ambiguous, and people do still type these by hand into terminals and other devices.
 */
export const SECRET_FONT_STACK = FONT_STACKS.mono;

// ── The settings object ──────────────────────────────────────────────────────

export type ThemeMode = 'system' | 'light' | 'dark' | 'fixed';

export interface AppearanceSettings {
  /**
   * `system` follows the OS and swaps between `lightThemeId` and `darkThemeId`.
   * `fixed` pins `themeId` regardless of what the OS is doing.
   */
  readonly mode: ThemeMode;
  readonly themeId: string;
  readonly lightThemeId: string;
  readonly darkThemeId: string;
  /** `null` means "use the theme's own accent". */
  readonly accentColour: string | null;
  readonly density: Density;
  readonly fontScale: FontScale;
  readonly fontFamily: FontFamily;
  /**
   * Forces reduced motion on even when the OS does not ask for it.
   *
   * The OS preference is always honoured; this can only ever add restraint, never remove
   * it. A user who has asked their system for reduced motion must never see an app
   * setting override that.
   */
  readonly reduceMotion: boolean;
  /**
   * Which material the interface is made of — see `styles.ts`.
   *
   * The second axis, and deliberately independent of `themeId`. A style decides shape,
   * elevation and translucency; a theme decides colour. Folding them into one list would mean
   * eight themes times four styles as thirty-two entries, most of which nobody wants, and it
   * would make "I like this palette but not the glass" unexpressible.
   */
  readonly styleId: string;
  /**
   * Forces every translucent surface opaque, even when the OS does not ask for it.
   *
   * The same shape as `reduceMotion`, and for the same reason: the OS preference is always
   * honoured and this can only ever add restraint. Somebody who has asked their system for
   * reduced transparency must never find an app setting overriding that.
   */
  readonly reduceTransparency: boolean;
  /** A user-authored palette, taking precedence over `themeId` when present. */
  readonly customPalette: Palette | null;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  mode: 'system',
  themeId: DEFAULT_DARK_THEME_ID,
  lightThemeId: DEFAULT_LIGHT_THEME_ID,
  darkThemeId: DEFAULT_DARK_THEME_ID,
  accentColour: null,
  density: 'comfortable',
  fontScale: 1,
  fontFamily: 'system',
  reduceMotion: false,
  styleId: DEFAULT_STYLE_ID,
  reduceTransparency: false,
  customPalette: null,
};

// ── Resolution ───────────────────────────────────────────────────────────────

export interface ResolvedAppearance {
  readonly theme: ThemeDefinition;
  readonly palette: Palette;
  readonly scheme: 'light' | 'dark';
  readonly density: Density;
  readonly fontScale: number;
  readonly fontStack: string;
  readonly reduceMotion: boolean;
  readonly style: StyleDefinition;
  readonly reduceTransparency: boolean;
}

/**
 * Turns settings plus the OS preference into a concrete palette.
 *
 * Every lookup falls back rather than failing. A settings file naming a theme that no
 * longer exists — because the user downgraded, or a theme was renamed — must not leave the
 * app with no colours at all; it should quietly render in the default and let them pick
 * again.
 */
export function resolveAppearance(
  settings: AppearanceSettings,
  systemPrefersDark: boolean,
  systemPrefersReducedMotion = false,
  systemPrefersReducedTransparency = false
): ResolvedAppearance {
  const themeId =
    settings.mode === 'system'
      ? systemPrefersDark
        ? settings.darkThemeId
        : settings.lightThemeId
      : settings.mode === 'light'
        ? settings.lightThemeId
        : settings.mode === 'dark'
          ? settings.darkThemeId
          : settings.themeId;

  const theme =
    findTheme(themeId) ??
    findTheme(systemPrefersDark ? DEFAULT_DARK_THEME_ID : DEFAULT_LIGHT_THEME_ID) ??
    FALLBACK_THEME;

  // A custom palette wins over the named theme, but still takes its scheme from it, so
  // `color-scheme` and native controls stay coherent.
  const basePalette = settings.customPalette ?? theme.palette;
  const palette = applyAccent(basePalette, settings.accentColour, theme.scheme);

  return {
    theme,
    palette,
    scheme: theme.scheme,
    density: settings.density,
    fontScale: settings.fontScale,
    fontStack: FONT_STACKS[settings.fontFamily],
    // OR, never override: an OS-level reduced-motion request is a stated access need.
    reduceMotion: settings.reduceMotion || systemPrefersReducedMotion,
    style: resolveStyle(settings.styleId),
    // Same rule, same reason. Note the fallback for reduced transparency is Flat's values
    // rather than the style's, which `toCssVariables` applies — a style cannot opt out of an
    // access need by declaring different numbers.
    reduceTransparency: settings.reduceTransparency || systemPrefersReducedTransparency,
  };
}

/**
 * The CSS custom properties for a resolved appearance.
 *
 * Returned as data rather than written to the DOM, so the same function serves the live
 * app, the theme editor's preview, and its own test.
 *
 * **Two token layers, emitted side by side.** `--kh-color-*` comes from the theme and
 * `--kh-style-*` from the UI style, and the separation is the whole point of the split: a
 * theme decides hue, a style decides material, and neither may reach into the other. They
 * are written in one pass because they land on the same element and a stylesheet reading a
 * half-applied appearance would flash.
 *
 * **Reduced transparency is applied here, not in a media query, and that is not a
 * preference.** `applyToDocument` writes these as inline styles on the root element, and an
 * inline style beats any `:root` rule — so a `@media (prefers-reduced-transparency: reduce)`
 * block would be dead the moment JavaScript ran. `base.css` carries one anyway, for the frame
 * before that happens, exactly as it already does for reduced motion.
 */
export function toCssVariables(resolved: ResolvedAppearance): Record<string, string> {
  const metrics = DENSITY_METRICS[resolved.density];
  const style = resolved.style;
  const variables: Record<string, string> = {};

  for (const token of COLOUR_TOKENS) {
    variables[`--kh-color-${token}`] = resolved.palette[token];
  }

  for (const token of STYLE_TOKENS) {
    variables[`--kh-style-${token}`] = style.tokens[token];
  }

  // After the loop, so it wins whatever the style declared. A style cannot opt out of an
  // access need by choosing different numbers, and forcing every surface fully opaque is by
  // definition contrast-safe: 100% opaque is exactly the un-composited case the theme
  // contrast guard already verifies.
  if (resolved.reduceTransparency) {
    variables['--kh-style-surface-opacity'] = '100%';
    variables['--kh-style-fill-opacity'] = '100%';
    variables['--kh-style-blur'] = '0px';
    variables['--kh-style-texture-opacity'] = '0%';
  }

  variables['--kh-font-body'] = resolved.fontStack;
  variables['--kh-font-secret'] = SECRET_FONT_STACK;
  // The same stack under a name that is not about secrets. Code, file paths, log output and
  // search-syntax tokens all want monospace and none of them are secret, and three
  // stylesheets were already reading `--kh-font-mono` as though it existed — it did not, so
  // they were silently rendering in the body face. Two names for one value on purpose: if
  // the secret face ever becomes user-configurable, a log excerpt must not follow it.
  variables['--kh-font-mono'] = FONT_STACKS.mono;
  variables['--kh-font-scale'] = String(resolved.fontScale);
  variables['--kh-space-scale'] = String(metrics.spaceScale);
  variables['--kh-row-height'] = metrics.rowHeight;
  variables['--kh-control-height'] = metrics.controlHeight;
  // Consumed by every transition, so one switch disables animation everywhere rather than
  // each component having to remember to check.
  variables['--kh-motion-scale'] = resolved.reduceMotion ? '0' : '1';

  return variables;
}

// ── Validation, for imported `.keeptheme` files and settings restored from disk ──

export function isValidDensity(value: unknown): value is Density {
  return typeof value === 'string' && (DENSITIES as readonly string[]).includes(value);
}

export function isValidFontScale(value: unknown): value is FontScale {
  return typeof value === 'number' && (FONT_SCALES as readonly number[]).includes(value);
}

export function isValidFontFamily(value: unknown): value is FontFamily {
  return typeof value === 'string' && (FONT_FAMILIES as readonly string[]).includes(value);
}

/**
 * Checks that an object is a complete palette.
 *
 * Used on `.keeptheme` import, where the file is user-supplied and a missing token would
 * render an invisible element rather than an obvious error.
 */
export function isCompletePalette(value: unknown): value is Palette {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return COLOUR_TOKENS.every(
    (token) => typeof candidate[token] === 'string' && candidate[token].trim() !== ''
  );
}

/**
 * Coerces arbitrary stored data into valid settings, field by field.
 *
 * A settings file can be hand-edited, written by an older build, or corrupted. Rejecting
 * the whole file for one bad field would throw away every other preference the user set;
 * falling back per field keeps what is still good.
 */
export function coerceAppearance(value: unknown): AppearanceSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_APPEARANCE;
  const raw = value as Record<string, unknown>;

  const mode = raw.mode;
  return {
    mode:
      mode === 'system' || mode === 'light' || mode === 'dark' || mode === 'fixed'
        ? mode
        : DEFAULT_APPEARANCE.mode,
    themeId: typeof raw.themeId === 'string' ? raw.themeId : DEFAULT_APPEARANCE.themeId,
    lightThemeId:
      typeof raw.lightThemeId === 'string' ? raw.lightThemeId : DEFAULT_APPEARANCE.lightThemeId,
    darkThemeId:
      typeof raw.darkThemeId === 'string' ? raw.darkThemeId : DEFAULT_APPEARANCE.darkThemeId,
    accentColour: typeof raw.accentColour === 'string' ? raw.accentColour : null,
    density: isValidDensity(raw.density) ? raw.density : DEFAULT_APPEARANCE.density,
    fontScale: isValidFontScale(raw.fontScale) ? raw.fontScale : DEFAULT_APPEARANCE.fontScale,
    fontFamily: isValidFontFamily(raw.fontFamily) ? raw.fontFamily : DEFAULT_APPEARANCE.fontFamily,
    reduceMotion: typeof raw.reduceMotion === 'boolean' ? raw.reduceMotion : false,
    // Not validated against the registry here, deliberately, for the same reason `themeId` is
    // not: `resolveStyle` falls back at the point of use, so a settings file naming a style
    // that was renamed or removed renders in Flat and lets the user pick again, rather than
    // being silently rewritten to a default they never chose.
    styleId: typeof raw.styleId === 'string' ? raw.styleId : DEFAULT_APPEARANCE.styleId,
    reduceTransparency:
      typeof raw.reduceTransparency === 'boolean' ? raw.reduceTransparency : false,
    customPalette: isCompletePalette(raw.customPalette) ? raw.customPalette : null,
  };
}

// ── `.keeptheme` ─────────────────────────────────────────────────────────────

export const KEEPTHEME_VERSION = 1;

/** An exported theme. Plain JSON — it holds no secrets and is not encrypted. */
export interface KeepThemeFile {
  readonly format: 'keyhold-theme';
  readonly version: number;
  readonly name: string;
  readonly scheme: 'light' | 'dark';
  readonly palette: Palette;
}

export function exportTheme(name: string, scheme: 'light' | 'dark', palette: Palette): string {
  const file: KeepThemeFile = {
    format: 'keyhold-theme',
    version: KEEPTHEME_VERSION,
    name,
    scheme,
    palette,
  };
  return JSON.stringify(file, null, 2);
}

export type ThemeImportResult =
  | { readonly ok: true; readonly theme: KeepThemeFile }
  | { readonly ok: false; readonly reason: string };

/**
 * Parses a `.keeptheme` file.
 *
 * Returns a reason rather than throwing, because the only caller is a UI that has to
 * explain what is wrong with the file the user just picked.
 */
export function importTheme(contents: string): ThemeImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    return { ok: false, reason: 'This file is not valid JSON.' };
  }

  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'This file does not contain a theme.' };
  }

  const candidate = raw as Record<string, unknown>;
  if (candidate.format !== 'keyhold-theme') {
    return { ok: false, reason: 'This is not a Keyhold theme file.' };
  }
  if (typeof candidate.version !== 'number' || candidate.version > KEEPTHEME_VERSION) {
    return {
      ok: false,
      reason: `This theme was made by a newer version of Keyhold (format ${String(candidate.version)}).`,
    };
  }
  if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
    return { ok: false, reason: 'This theme has no name.' };
  }
  if (candidate.scheme !== 'light' && candidate.scheme !== 'dark') {
    return { ok: false, reason: 'This theme does not say whether it is light or dark.' };
  }
  if (!isCompletePalette(candidate.palette)) {
    // Naming the missing tokens matters: a theme author needs to know which, and a
    // "palette is incomplete" message sends them hunting through 30 values.
    const missing = COLOUR_TOKENS.filter(
      (token) => typeof (candidate.palette as Record<string, unknown> | null)?.[token] !== 'string'
    );
    return {
      ok: false,
      reason: `This theme is missing ${missing.length} colour${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`,
    };
  }

  return {
    ok: true,
    theme: {
      format: 'keyhold-theme',
      version: candidate.version,
      name: candidate.name,
      scheme: candidate.scheme,
      palette: candidate.palette,
    },
  };
}
