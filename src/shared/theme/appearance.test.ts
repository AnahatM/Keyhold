// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  coerceAppearance,
  DEFAULT_APPEARANCE,
  DENSITY_METRICS,
  exportTheme,
  importTheme,
  isCompletePalette,
  KEEPTHEME_VERSION,
  resolveAppearance,
  SECRET_FONT_STACK,
  toCssVariables,
  type AppearanceSettings,
} from './appearance.js';
import { THEMES } from './themes.js';
import { COLOUR_TOKENS } from './tokens.js';

/**
 * Appearance resolution and `.keeptheme` round-tripping.
 *
 * Two themes run through everything here: what happens when settings are *wrong* (an
 * unknown theme id, a hand-edited file, an older build's format), and whether an
 * accessibility preference can ever be silently discarded.
 */

const settings = (overrides: Partial<AppearanceSettings> = {}): AppearanceSettings => ({
  ...DEFAULT_APPEARANCE,
  ...overrides,
});

const dawn = THEMES.find((t) => t.id === 'dawn')!;
const nord = THEMES.find((t) => t.id === 'nord')!;

describe('resolving the theme', () => {
  it('follows the OS in system mode', () => {
    expect(resolveAppearance(settings({ mode: 'system' }), true).theme.scheme).toBe('dark');
    expect(resolveAppearance(settings({ mode: 'system' }), false).theme.scheme).toBe('light');
  });

  it('ignores the OS in fixed mode', () => {
    const fixed = settings({ mode: 'fixed', themeId: 'nord' });
    expect(resolveAppearance(fixed, true).theme.id).toBe('nord');
    expect(resolveAppearance(fixed, false).theme.id).toBe('nord');
  });

  it('honours explicit light and dark modes regardless of the OS', () => {
    expect(resolveAppearance(settings({ mode: 'light' }), true).scheme).toBe('light');
    expect(resolveAppearance(settings({ mode: 'dark' }), false).scheme).toBe('dark');
  });

  it('uses the chosen theme for each side of the system toggle', () => {
    const custom = settings({ mode: 'system', lightThemeId: 'rose', darkThemeId: 'nord' });
    expect(resolveAppearance(custom, false).theme.id).toBe('rose');
    expect(resolveAppearance(custom, true).theme.id).toBe('nord');
  });

  it('falls back to a default rather than rendering with no colours at all', () => {
    // A settings file naming a theme that no longer exists — a downgrade, or a rename.
    // Leaving the app with an empty palette would be a blank screen.
    const broken = settings({ mode: 'fixed', themeId: 'a-theme-that-was-deleted' });
    const resolved = resolveAppearance(broken, true);
    expect(resolved.theme).toBeDefined();
    expect(resolved.palette.bg).toBeTruthy();
  });

  it('applies a custom palette over the named theme', () => {
    const palette = { ...dawn.palette, bg: '#123456' };
    const resolved = resolveAppearance(settings({ customPalette: palette }), false);
    expect(resolved.palette.bg).toBe('#123456');
  });

  it('applies the accent on top of whichever palette won', () => {
    const resolved = resolveAppearance(
      settings({ mode: 'fixed', themeId: 'dawn', accentColour: '#b03060' }),
      false
    );
    expect(resolved.palette.accent).not.toBe(dawn.palette.accent);
  });
});

describe('reduced motion is never overridden', () => {
  it('is on when the OS asks for it, even if the app setting is off', () => {
    // An OS-level reduced-motion request is a stated access need. An app toggle may add
    // restraint; it must never remove it.
    const resolved = resolveAppearance(settings({ reduceMotion: false }), false, true);
    expect(resolved.reduceMotion).toBe(true);
  });

  it('is on when the app asks for it, even if the OS has not', () => {
    expect(resolveAppearance(settings({ reduceMotion: true }), false, false).reduceMotion).toBe(
      true
    );
  });

  it('is off only when neither asks', () => {
    expect(resolveAppearance(settings({ reduceMotion: false }), false, false).reduceMotion).toBe(
      false
    );
  });

  it('collapses the motion scale to zero, so one switch stops every transition', () => {
    const vars = toCssVariables(resolveAppearance(settings(), false, true));
    expect(vars['--kh-motion-scale']).toBe('0');
  });
});

describe('CSS variables', () => {
  it('emits every colour token', () => {
    const vars = toCssVariables(resolveAppearance(settings(), true));
    for (const token of COLOUR_TOKENS) {
      expect(vars[`--kh-color-${token}`], `--kh-color-${token} missing`).toBeTruthy();
    }
  });

  it('emits the density metrics', () => {
    for (const density of ['compact', 'comfortable', 'spacious'] as const) {
      const vars = toCssVariables(resolveAppearance(settings({ density }), true));
      expect(vars['--kh-row-height']).toBe(DENSITY_METRICS[density].rowHeight);
      expect(vars['--kh-space-scale']).toBe(String(DENSITY_METRICS[density].spaceScale));
    }
  });

  it('always uses a monospace face for secrets, whatever the body font is', () => {
    // Proportional faces make l/1/I and 0/O genuinely ambiguous, and people do still
    // retype passwords by eye into terminals and other devices.
    for (const fontFamily of ['system', 'sans', 'serif', 'mono'] as const) {
      const vars = toCssVariables(resolveAppearance(settings({ fontFamily }), true));
      expect(vars['--kh-font-secret']).toBe(SECRET_FONT_STACK);
    }
  });

  it('keeps comfortable and spacious at or above the 44px target-size floor', () => {
    // WCAG 2.2 target size. `compact` deliberately goes below, which is why it is opt-in
    // and never the default.
    expect(Number.parseInt(DENSITY_METRICS.comfortable.rowHeight, 10)).toBeGreaterThanOrEqual(44);
    expect(Number.parseInt(DENSITY_METRICS.spacious.rowHeight, 10)).toBeGreaterThanOrEqual(44);
    expect(DEFAULT_APPEARANCE.density).not.toBe('compact');
  });
});

describe('coercing stored settings', () => {
  it('returns the defaults for junk', () => {
    expect(coerceAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(coerceAppearance('nonsense')).toEqual(DEFAULT_APPEARANCE);
    expect(coerceAppearance(42)).toEqual(DEFAULT_APPEARANCE);
  });

  it('keeps the good fields and replaces only the bad ones', () => {
    // Rejecting the whole file for one bad field would discard every other preference the
    // user had set.
    const coerced = coerceAppearance({
      mode: 'fixed',
      themeId: 'nord',
      density: 'not-a-density',
      fontScale: 99,
      fontFamily: 'comic-sans',
      reduceMotion: 'yes',
    });

    expect(coerced.mode).toBe('fixed');
    expect(coerced.themeId).toBe('nord');
    expect(coerced.density).toBe(DEFAULT_APPEARANCE.density);
    expect(coerced.fontScale).toBe(DEFAULT_APPEARANCE.fontScale);
    expect(coerced.fontFamily).toBe(DEFAULT_APPEARANCE.fontFamily);
    expect(coerced.reduceMotion).toBe(false);
  });

  it('drops an incomplete custom palette rather than rendering invisible elements', () => {
    expect(coerceAppearance({ customPalette: { bg: '#000000' } }).customPalette).toBeNull();
  });

  it('keeps a complete custom palette', () => {
    expect(coerceAppearance({ customPalette: nord.palette }).customPalette).toEqual(nord.palette);
  });
});

describe('.keeptheme round trip', () => {
  it('exports and re-imports a palette unchanged', () => {
    const json = exportTheme('My Theme', 'dark', nord.palette);
    const result = importTheme(json);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.name).toBe('My Theme');
    expect(result.theme.scheme).toBe('dark');
    expect(result.theme.palette).toEqual(nord.palette);
  });

  it('exports readable JSON, so a theme can be edited in a text editor', () => {
    const json = exportTheme('My Theme', 'dark', nord.palette);
    expect(json).toContain('\n');
    expect(JSON.parse(json)).toHaveProperty('format', 'keyhold-theme');
    expect(JSON.parse(json)).toHaveProperty('version', KEEPTHEME_VERSION);
  });

  it('explains each way a file can be wrong, rather than failing generically', () => {
    // The only caller is a UI that must tell the user what is wrong with the file they
    // just picked.
    expect(importTheme('not json')).toMatchObject({ ok: false, reason: /not valid JSON/ });
    expect(importTheme('[]')).toMatchObject({ ok: false, reason: /does not contain a theme/ });
    expect(importTheme('{"format":"something-else"}')).toMatchObject({
      ok: false,
      reason: /not a Keyhold theme/,
    });
    expect(importTheme(JSON.stringify({ format: 'keyhold-theme', version: 99 }))).toMatchObject({
      ok: false,
      reason: /newer version/,
    });
    expect(
      importTheme(JSON.stringify({ format: 'keyhold-theme', version: 1, name: '' }))
    ).toMatchObject({ ok: false, reason: /no name/ });
    expect(
      importTheme(
        JSON.stringify({ format: 'keyhold-theme', version: 1, name: 'x', scheme: 'beige' })
      )
    ).toMatchObject({ ok: false, reason: /light or dark/ });
  });

  it('names the missing colours, so a theme author knows which to add', () => {
    const partial = { ...nord.palette } as Record<string, unknown>;
    delete partial.accent;
    delete partial['danger-text'];

    const result = importTheme(
      JSON.stringify({
        format: 'keyhold-theme',
        version: 1,
        name: 'Partial',
        scheme: 'dark',
        palette: partial,
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('accent');
    expect(result.reason).toContain('danger-text');
  });

  it('accepts a theme file written by an older format version', () => {
    const older = JSON.stringify({
      format: 'keyhold-theme',
      version: 1,
      name: 'Old',
      scheme: 'dark',
      palette: nord.palette,
    });
    expect(importTheme(older).ok).toBe(true);
  });
});

describe('palette completeness checks', () => {
  it('accepts every built-in palette', () => {
    for (const theme of THEMES) expect(isCompletePalette(theme.palette)).toBe(true);
  });

  it('rejects a palette missing even one token', () => {
    for (const token of COLOUR_TOKENS) {
      const partial = { ...dawn.palette } as Record<string, unknown>;
      delete partial[token];
      expect(isCompletePalette(partial), `should reject a palette missing ${token}`).toBe(false);
    }
  });

  it('rejects an empty string as a colour', () => {
    expect(isCompletePalette({ ...dawn.palette, accent: '' })).toBe(false);
  });
});
