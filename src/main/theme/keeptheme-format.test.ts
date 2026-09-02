// SPDX-License-Identifier: GPL-3.0-or-later
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrastRatio, parseColour } from '@shared/theme/contrast.js';
import {
  admitPalette,
  contrastAcknowledgement,
  ESCAPE_FLOOR_MINIMUM,
  ESCAPE_FLOOR_REQUIREMENTS,
  evaluateEscapeFloor,
  evaluatePaletteContrast,
  KEEPTHEME_FORMAT,
  KEEPTHEME_FORMAT_VERSION,
  KEEPTHEME_MAX_BYTES,
  keepThemeFromDefinition,
  normaliseColour,
  normalisePalette,
  parseKeepTheme,
  serialiseKeepTheme,
  suggestKeepThemeFileName,
  type KeepTheme,
} from '@shared/theme/keeptheme.js';
import { FALLBACK_THEME, THEMES } from '@shared/theme/themes.js';
import { COLOUR_TOKENS, CONTRAST_REQUIREMENTS, type Palette } from '@shared/theme/tokens.js';

/**
 * The `.keeptheme` format, tested the way a format that reads files from strangers has to
 * be: every built-in round-trips exactly, and every category of hostile or broken file is
 * refused in a way that names what is wrong.
 *
 * These live under `src/main/theme` rather than beside `keeptheme.ts` because that is where
 * this slice's tests were scoped to; the module under test is pure, so the node project runs
 * it either way.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

function paletteOf(id: string): Palette {
  const theme = THEMES.find((candidate) => candidate.id === id);
  if (theme === undefined) throw new Error(`no theme ${id}`);
  return normalisePalette(theme.palette);
}

/** A theme object whose palette can be doctored per test. */
function themeFile(overrides: Partial<Record<string, unknown>> = {}): string {
  const base = keepThemeFromDefinition(FALLBACK_THEME, 'Test Theme');
  return JSON.stringify({
    format: KEEPTHEME_FORMAT,
    version: KEEPTHEME_FORMAT_VERSION,
    name: base.name,
    description: base.description,
    scheme: base.scheme,
    basedOn: base.basedOn,
    palette: base.palette,
    ...overrides,
  });
}

// ── Round trip ───────────────────────────────────────────────────────────────

describe('serialise / parse round trip', () => {
  it('round-trips every built-in theme with an identical palette', () => {
    for (const definition of THEMES) {
      const theme = keepThemeFromDefinition(definition);
      const result = parseKeepTheme(serialiseKeepTheme(theme));

      expect(result.ok, `${definition.id} should round-trip: ${JSON.stringify(result)}`).toBe(true);
      if (!result.ok) continue;

      expect(result.theme, `${definition.id} should be unchanged`).toEqual(theme);
      expect(result.warnings, `${definition.id} should produce no warnings`).toEqual([]);
      expect(result.acceptedWithContrastOverride).toBe(false);
    }
  });

  it('preserves the exact colour of every built-in token through canonicalisation', () => {
    // The canonical form is `#rrggbb`, so `overlay: rgb(24, 25, 32)` is rewritten. That
    // must be a change of notation and never a change of colour.
    for (const definition of THEMES) {
      for (const token of COLOUR_TOKENS) {
        const original = parseColour(definition.palette[token]);
        const canonical = parseColour(normalisePalette(definition.palette)[token]);
        expect(canonical, `${definition.id}/${token}`).toEqual(original);
      }
    }
  });

  it('writes the palette in token order so two theme files diff line by line', () => {
    const serialised = serialiseKeepTheme(keepThemeFromDefinition(FALLBACK_THEME));
    const written = Object.keys(
      (JSON.parse(serialised) as { palette: Record<string, string> }).palette
    );
    expect(written).toEqual([...COLOUR_TOKENS]);
  });

  it('ends with a newline and declares the current format version', () => {
    const serialised = serialiseKeepTheme(keepThemeFromDefinition(FALLBACK_THEME));
    expect(serialised.endsWith('\n')).toBe(true);
    expect(JSON.parse(serialised)).toMatchObject({
      format: KEEPTHEME_FORMAT,
      version: KEEPTHEME_FORMAT_VERSION,
    });
  });
});

// ── Structural rejection ─────────────────────────────────────────────────────

describe('a file that is not a theme', () => {
  it('rejects text that is not JSON', () => {
    const result = parseKeepTheme('not json at all');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe('not-json');
  });

  it('rejects JSON that is not an object', () => {
    for (const contents of ['[]', '"a string"', '42', 'null']) {
      const result = parseKeepTheme(contents);
      expect(result.ok, contents).toBe(false);
      if (result.ok) continue;
      expect(result.rejection.kind, contents).toBe('not-a-theme');
    }
  });

  it('rejects a file without the format marker', () => {
    const result = parseKeepTheme(JSON.stringify({ version: 1, name: 'x' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe('not-a-theme');
  });

  it('rejects a newer format version by number rather than guessing at it', () => {
    const result = parseKeepTheme(themeFile({ version: KEEPTHEME_FORMAT_VERSION + 1 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe('future-version');
    if (result.rejection.kind !== 'future-version') return;
    expect(result.rejection.version).toBe(KEEPTHEME_FORMAT_VERSION + 1);
    expect(result.rejection.message).toContain(String(KEEPTHEME_FORMAT_VERSION + 1));
  });

  it('rejects a non-integer or absent version', () => {
    for (const version of [0, -1, 1.5, '1', undefined]) {
      const result = parseKeepTheme(themeFile({ version }));
      expect(result.ok, String(version)).toBe(false);
      if (result.ok) continue;
      expect(result.rejection.kind, String(version)).toBe('invalid-field');
    }
  });

  it('rejects a missing, empty, over-long or control-character name', () => {
    for (const name of [undefined, '', '   ', 'x'.repeat(200), 'bad\u0007name']) {
      const result = parseKeepTheme(themeFile({ name }));
      expect(result.ok, JSON.stringify(name)).toBe(false);
      if (result.ok) continue;
      expect(result.rejection.kind).toBe('invalid-field');
      if (result.rejection.kind !== 'invalid-field') continue;
      expect(result.rejection.field).toBe('name');
    }
  });

  it('rejects a theme that does not say whether it is light or dark', () => {
    const result = parseKeepTheme(themeFile({ scheme: 'twilight' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe('invalid-field');
    if (result.rejection.kind !== 'invalid-field') return;
    expect(result.rejection.field).toBe('scheme');
  });

  it('rejects a file with no palette at all', () => {
    for (const palette of [undefined, 'blue', []]) {
      const result = parseKeepTheme(themeFile({ palette }));
      expect(result.ok, JSON.stringify(palette)).toBe(false);
      if (result.ok) continue;
      expect(result.rejection.kind).toBe('invalid-field');
    }
  });

  it('refuses a file larger than the cap before parsing it', () => {
    const result = parseKeepTheme(' '.repeat(KEEPTHEME_MAX_BYTES + 1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe('too-large');
  });
});

// ── Missing tokens fall back; unknown tokens are ignored ─────────────────────

describe('an incomplete theme', () => {
  it('fills a missing token from the named base theme and says which', () => {
    const base = paletteOf('nord');
    const palette: Record<string, string> = { ...base };
    delete palette['surface-hover'];

    const result = parseKeepTheme(themeFile({ basedOn: 'nord', scheme: 'dark', palette }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.theme.palette['surface-hover']).toBe(base['surface-hover']);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ kind: 'missing-token', token: 'surface-hover', filledFrom: 'nord' })
    );
  });

  it('names every missing token, not just the first', () => {
    const palette: Record<string, string> = { ...paletteOf('nord') };
    delete palette.accent;
    delete palette['accent-hover'];
    delete palette.warning;

    const result = parseKeepTheme(themeFile({ basedOn: 'nord', palette }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const missing = result.warnings
      .filter((warning) => warning.kind === 'missing-token')
      .map((warning) => warning.token);
    expect(new Set(missing)).toEqual(new Set(['accent', 'accent-hover', 'warning']));
  });

  it('falls back to the scheme default when the base theme is unknown', () => {
    const result = parseKeepTheme(themeFile({ basedOn: 'a-theme-from-2032' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ kind: 'unknown-base', requested: 'a-theme-from-2032' })
    );
    expect(result.theme.basedOn).toBe('midnight');
  });

  it('ignores an unknown token with a warning naming it', () => {
    const result = parseKeepTheme(
      themeFile({ palette: { ...paletteOf('midnight'), 'sparkle-glow': '#ff00ff' } })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.warnings).toContainEqual(
      expect.objectContaining({ kind: 'unknown-token', token: 'sparkle-glow' })
    );
    expect(Object.keys(result.theme.palette)).toEqual([...COLOUR_TOKENS]);
  });
});

// ── Malformed colours ────────────────────────────────────────────────────────

describe('a malformed colour', () => {
  it('rejects the theme and names the token, rather than defaulting it', () => {
    const result = parseKeepTheme(
      themeFile({ palette: { ...paletteOf('midnight'), accent: 'chartreuse-ish' } })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe('invalid-colours');
    if (result.rejection.kind !== 'invalid-colours') return;
    expect(result.rejection.colours).toHaveLength(1);
    expect(result.rejection.colours[0]?.token).toBe('accent');
    expect(result.rejection.message).toContain('accent');
  });

  it('names every bad colour at once', () => {
    const result = parseKeepTheme(
      themeFile({
        palette: { ...paletteOf('midnight'), accent: '#gg0000', text: 'red', border: 42 },
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.rejection.kind !== 'invalid-colours') throw new Error('wrong rejection');
    expect(result.rejection.colours.map((entry) => entry.token).sort()).toEqual([
      'accent',
      'border',
      'text',
    ]);
  });

  it('refuses anything executable or referential rather than trying to resolve it', () => {
    const hostile = [
      'var(--kh-color-bg)',
      'url(https://example.invalid/x.png)',
      'calc(1px)',
      'color-mix(in srgb, red, blue)',
      'linear-gradient(red, blue)',
      'red; background: url(http://x)',
      'expression(alert(1))',
      '#fff}body{display:none',
      'rgb(0,0,0);}',
    ];
    for (const value of hostile) {
      expect(normaliseColour(value), value).toMatchObject({ ok: false });
    }
  });

  it('refuses translucency, because a ratio cannot be measured through it', () => {
    for (const value of ['rgba(0, 0, 0, 0.5)', '#00000080', '#0007']) {
      expect(normaliseColour(value), value).toMatchObject({ ok: false, reason: 'translucent' });
    }
    // A fully opaque alpha is notation, not transparency, so it is accepted and stripped.
    expect(normaliseColour('#112233ff')).toEqual({ ok: true, hex: '#112233' });
    expect(normaliseColour('rgba(17, 34, 51, 1)')).toEqual({ ok: true, hex: '#112233' });
  });

  it('refuses an absurdly long value before parsing it', () => {
    expect(normaliseColour(`#${'a'.repeat(500)}`)).toMatchObject({ ok: false, reason: 'too-long' });
  });

  it('canonicalises every accepted form to #rrggbb', () => {
    expect(normaliseColour('#ABC')).toEqual({ ok: true, hex: '#aabbcc' });
    expect(normaliseColour('  #AaBbCc  ')).toEqual({ ok: true, hex: '#aabbcc' });
    expect(normaliseColour('rgb(170, 187, 204)')).toEqual({ ok: true, hex: '#aabbcc' });
  });
});

// ── The contrast report ──────────────────────────────────────────────────────

describe('the contrast report', () => {
  it('agrees exactly with contrast.ts for every pair of every theme', () => {
    for (const definition of THEMES) {
      const palette = normalisePalette(definition.palette);
      const report = evaluatePaletteContrast(palette);

      expect(report.findings).toHaveLength(CONTRAST_REQUIREMENTS.length);

      for (const finding of report.findings) {
        const foreground = parseColour(palette[finding.foreground]);
        const background = parseColour(palette[finding.background]);
        if (foreground === null || background === null) throw new Error('unparseable built-in');

        // Not `toBeCloseTo`. The report and the guard must produce the SAME number, because
        // a theme sitting at 4.4999 has to be told the same thing by both.
        expect(finding.ratio, `${definition.id}: ${finding.foreground}/${finding.background}`).toBe(
          contrastRatio(foreground, background)
        );
        expect(finding.passes).toBe(finding.ratio >= finding.minimum);
        expect(finding.verdict).toBe(finding.passes ? 'Pass' : 'Fail');
      }
    }
  });

  it('does not reimplement the WCAG maths anywhere in the format or the studio', async () => {
    // The luminance coefficients and the sRGB transfer constants. If any of these appear
    // outside contrast.ts, someone has written a second implementation that will drift.
    const forbidden = ['0.2126', '0.7152', '0.0722', '0.04045', '1.055', '12.92'];

    const files = [
      join(REPO_ROOT, 'src', 'shared', 'theme', 'keeptheme.ts'),
      ...(await readdir(join(REPO_ROOT, 'src', 'renderer', 'src', 'theme-studio')))
        .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
        .map((name) => join(REPO_ROOT, 'src', 'renderer', 'src', 'theme-studio', name)),
    ];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const constant of forbidden) {
        expect(source.includes(constant), `${file} must not contain ${constant}`).toBe(false);
      }
    }
  });

  it('reports every built-in theme as passing', () => {
    for (const definition of THEMES) {
      const report = evaluatePaletteContrast(normalisePalette(definition.palette));
      expect(report.passes, `${definition.id}: ${JSON.stringify(report.failures)}`).toBe(true);
      expect(report.failures).toEqual([]);
    }
  });

  it('treats an unmeasurable pair as the worst case rather than skipping it', () => {
    const broken = { ...paletteOf('midnight'), text: 'not-a-colour' };
    const report = evaluatePaletteContrast(broken);
    const finding = report.findings.find(
      (candidate) => candidate.foreground === 'text' && candidate.background === 'bg'
    );
    expect(finding?.ratio).toBe(1);
    expect(finding?.passes).toBe(false);
  });

  it('ranks the worst pair by how far it falls short of its own minimum', () => {
    const report = evaluatePaletteContrast(paletteOf('midnight'));
    expect(report.worst).not.toBeNull();
    for (const finding of report.findings) {
      if (report.worst === null) break;
      expect(finding.ratio / finding.minimum).toBeGreaterThanOrEqual(
        report.worst.ratio / report.worst.minimum
      );
    }
  });
});

// ── The legibility floor and the informed override ───────────────────────────

describe('the legibility floor', () => {
  it('only names pairs that tokens.ts also declares', () => {
    for (const requirement of ESCAPE_FLOOR_REQUIREMENTS) {
      const declared = CONTRAST_REQUIREMENTS.some(
        (candidate) =>
          candidate.foreground === requirement.foreground &&
          candidate.background === requirement.background
      );
      expect(
        declared,
        `${requirement.foreground}/${requirement.background} must also be a declared requirement`
      ).toBe(true);
      expect(requirement.minimum).toBe(ESCAPE_FLOOR_MINIMUM);
    }
  });

  it('passes for every built-in theme', () => {
    for (const definition of THEMES) {
      expect(evaluateEscapeFloor(normalisePalette(definition.palette)).passes, definition.id).toBe(
        true
      );
    }
  });

  it('refuses an illegible theme outright, with no override available', () => {
    // Text one shade off its own background: readable to nobody, and it would hide the
    // Settings screen that changes it back.
    const palette = { ...paletteOf('midnight'), text: '#131419' };

    const direct = admitPalette(palette, null);
    expect(direct.ok).toBe(false);
    if (direct.ok) return;
    expect(direct.reason).toBe('illegible');

    // Even a correctly computed acknowledgement does not open this door.
    const forged = contrastAcknowledgement(palette, evaluatePaletteContrast(palette));
    expect(admitPalette(palette, forged).ok).toBe(false);

    const parsed = parseKeepTheme(themeFile({ palette }), { acknowledgement: forged });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.rejection.kind).toBe('illegible');
  });
});

describe('a theme that fails WCAG AA', () => {
  /** Muted text pushed to ~3.4:1 on the background: legible, but under the 4.5 bar. */
  function nearMissPalette(): Palette {
    return { ...paletteOf('midnight'), 'text-muted': '#767c8c' };
  }

  it('is rejected by default, with the failures named', () => {
    const palette = nearMissPalette();
    const result = parseKeepTheme(themeFile({ palette }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe('contrast');
    if (result.rejection.kind !== 'contrast') return;

    expect(result.rejection.report.failures.length).toBeGreaterThan(0);
    for (const failure of result.rejection.report.failures) {
      expect(failure.foreground).toBe('text-muted');
      expect(failure.verdict).toBe('Fail');
    }
    // The theme is carried along so the UI can preview and report on it without re-parsing.
    expect(result.rejection.theme.palette['text-muted']).toBe('#767c8c');
  });

  it('is accepted when the acknowledgement for that exact palette is supplied', () => {
    const palette = nearMissPalette();
    const rejected = parseKeepTheme(themeFile({ palette }));
    expect(rejected.ok).toBe(false);
    if (rejected.ok || rejected.rejection.kind !== 'contrast') return;

    const accepted = parseKeepTheme(themeFile({ palette }), {
      acknowledgement: rejected.rejection.acknowledgement,
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.acceptedWithContrastOverride).toBe(true);
    expect(accepted.contrast.passes).toBe(false);
  });

  it('does not accept a blanket flag, a stale token, or another theme\u2019s token', () => {
    const palette = nearMissPalette();
    const report = evaluatePaletteContrast(palette);
    const valid = contrastAcknowledgement(palette, report);

    for (const supplied of ['true', 'yes', '', 'deadbeef', valid.toUpperCase()]) {
      expect(
        parseKeepTheme(themeFile({ palette }), { acknowledgement: supplied }).ok,
        supplied
      ).toBe(false);
    }

    // A token for a different palette is not consent to this one.
    const other: Palette = { ...palette, 'text-subtle': '#70768a' };
    const otherToken = contrastAcknowledgement(other, evaluatePaletteContrast(other));
    expect(otherToken).not.toBe(valid);
    expect(parseKeepTheme(themeFile({ palette }), { acknowledgement: otherToken }).ok).toBe(false);
  });

  it('goes stale the moment any colour changes', () => {
    const palette = nearMissPalette();
    const token = contrastAcknowledgement(palette, evaluatePaletteContrast(palette));

    const nudged: Palette = { ...palette, accent: '#7ba3ff' };
    expect(admitPalette(nudged, token).ok).toBe(false);
    expect(contrastAcknowledgement(nudged, evaluatePaletteContrast(nudged))).not.toBe(token);
  });

  it('is deterministic for the same palette', () => {
    const palette = nearMissPalette();
    const report = evaluatePaletteContrast(palette);
    expect(contrastAcknowledgement(palette, report)).toBe(
      contrastAcknowledgement({ ...palette }, evaluatePaletteContrast({ ...palette }))
    );
  });

  it('needs no acknowledgement when the theme passes', () => {
    const admission = admitPalette(paletteOf('dawn'), null);
    expect(admission.ok).toBe(true);
    if (!admission.ok) return;
    expect(admission.usedOverride).toBe(false);
  });
});

// ── File naming ──────────────────────────────────────────────────────────────

describe('suggestKeepThemeFileName', () => {
  it('produces a safe name from anything a user can type', () => {
    expect(suggestKeepThemeFileName('My Theme')).toBe('my-theme.keeptheme');
    expect(suggestKeepThemeFileName('../../etc/passwd')).toBe('etc-passwd.keeptheme');
    expect(suggestKeepThemeFileName('C:\\Windows\\System32')).toBe('c-windows-system32.keeptheme');
    expect(suggestKeepThemeFileName('🎨🎨🎨')).toBe('theme.keeptheme');
    expect(suggestKeepThemeFileName('x'.repeat(200)).length).toBeLessThanOrEqual(
      40 + '.keeptheme'.length
    );
  });

  it('never yields a name containing a path separator', () => {
    for (const name of ['a/b', 'a\\b', '..', '.', 'a:b']) {
      const suggested = suggestKeepThemeFileName(name);
      expect(suggested).not.toContain('/');
      expect(suggested).not.toContain('\\');
    }
  });
});

// ── The whole thing, end to end ──────────────────────────────────────────────

describe('a theme edited by hand', () => {
  it('survives a realistic hand-edit: comments removed, keys reordered, colours in mixed forms', () => {
    const base = paletteOf('dawn');
    const palette: Record<string, string> = {};
    for (const token of [...COLOUR_TOKENS].reverse()) palette[token] = base[token];
    palette.accent = 'RGB(51, 85, 204)';
    palette.bg = '#F7F7F9';

    const result = parseKeepTheme(
      themeFile({ name: 'Hand Edited', scheme: 'light', basedOn: 'dawn', palette })
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.theme.palette.accent).toBe('#3355cc');
    expect(result.theme.palette.bg).toBe('#f7f7f9');
  });

  it('re-exports to a file that imports back identically', () => {
    const original: KeepTheme = keepThemeFromDefinition(FALLBACK_THEME, 'Round Trip');
    const once = parseKeepTheme(serialiseKeepTheme(original));
    expect(once.ok).toBe(true);
    if (!once.ok) return;

    const twice = parseKeepTheme(serialiseKeepTheme(once.theme));
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.theme).toEqual(once.theme);
  });
});
