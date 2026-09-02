// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ACCENT_PRESETS, applyAccent, deriveAccentRamp, mix } from './accent.js';
import { contrastBetween, formatRatio } from './contrast.js';
import { THEMES } from './themes.js';

/**
 * The accent picker is the one place a **user** can produce a colour combination the
 * build-time theme guard never saw. That makes this the guard for runtime-generated
 * colour, and it is the reason the derivation measures contrast instead of assuming it.
 *
 * The case that motivates the whole file: a naive "accent-on is always white" gives
 * white-on-yellow at about 1.6:1 the moment someone picks a bright accent, and nothing at
 * build time can catch it.
 */

/** The accent tokens that carry a contrast requirement, and what they sit on. */
const ACCENT_REQUIREMENTS = [
  { fg: 'accent-on', bg: 'accent', min: 4.5, note: 'label on a primary button' },
  { fg: 'accent-on', bg: 'accent-hover', min: 4.5, note: 'label on a hovered button' },
  { fg: 'accent-on', bg: 'accent-active', min: 4.5, note: 'label on a pressed button' },
  { fg: 'accent-subtle-text', bg: 'accent-subtle', min: 4.5, note: 'text in a selected row' },
] as const;

/**
 * Colours chosen specifically to break a naive implementation: pure yellow and pure white
 * defeat "always use white text"; pure black and navy defeat "always use black"; and the
 * mid-greys sit at the awkward point where neither extreme comfortably wins.
 */
const HOSTILE_COLOURS = [
  '#ffff00', // pure yellow — the classic white-on-yellow failure
  '#00ff00', // pure green — very high luminance
  '#ffffff', // white
  '#000000', // black
  '#808080', // mid grey, the genuinely hard case
  '#7f7f7f',
  '#00008b', // navy — very low luminance
  '#ff69b4',
  '#00ffff', // cyan
  '#ff0000',
];

describe('every preset stays readable in every theme', () => {
  const presets = ACCENT_PRESETS.filter((p) => p.colour !== '');
  const cases = THEMES.flatMap((theme) =>
    presets.flatMap((preset) => ACCENT_REQUIREMENTS.map((req) => ({ theme, preset, req })))
  );

  it.each(
    cases.map(({ theme, preset, req }) => [
      `${theme.id} + ${preset.name}: ${req.fg} on ${req.bg}`,
      theme,
      preset,
      req,
    ])
  )('%s', (_label, theme, preset, req) => {
    const palette = applyAccent(theme.palette, preset.colour, theme.scheme);
    const ratio = contrastBetween(palette[req.fg], palette[req.bg]);

    expect(ratio).not.toBeNull();
    expect(
      ratio!,
      `${theme.id} + ${preset.name} — ${req.fg} on ${req.bg} is ${formatRatio(ratio!)}, ` +
        `needs ${req.min}:1 (${req.note})`
    ).toBeGreaterThanOrEqual(req.min);
  });
});

describe('hostile accent colours cannot make the UI unreadable', () => {
  const cases = THEMES.flatMap((theme) =>
    HOSTILE_COLOURS.flatMap((colour) => ACCENT_REQUIREMENTS.map((req) => ({ theme, colour, req })))
  );

  it.each(
    cases.map(({ theme, colour, req }) => [
      `${theme.id} + ${colour}: ${req.fg} on ${req.bg}`,
      theme,
      colour,
      req,
    ])
  )('%s', (_label, theme, colour, req) => {
    const palette = applyAccent(theme.palette, colour, theme.scheme);
    const ratio = contrastBetween(palette[req.fg], palette[req.bg]);
    expect(ratio!, `${theme.id} + ${colour} — ${req.fg} on ${req.bg}`).toBeGreaterThanOrEqual(
      req.min
    );
  });
});

describe('the accent stays usable as a border and an icon', () => {
  it.each(
    THEMES.flatMap((theme) =>
      HOSTILE_COLOURS.map((colour) => [`${theme.id} + ${colour}`, theme, colour] as const)
    )
  )('%s reaches 3:1 against the background', (_label, theme, colour) => {
    // WCAG 2.2 SC 1.4.11: non-text UI components need 3:1. The accent is used as a focus
    // outline and an icon fill, not only as a button fill.
    const palette = applyAccent(theme.palette, colour, theme.scheme);
    const ratio = contrastBetween(palette.accent, palette.bg);
    expect(ratio!).toBeGreaterThanOrEqual(3);
  });
});

describe('derivation behaviour', () => {
  const dawn = THEMES.find((t) => t.id === 'dawn')!;
  const midnight = THEMES.find((t) => t.id === 'midnight')!;

  it('never produces an unreadable label, whatever colour is chosen', () => {
    // The specific failure this module exists to prevent: white-on-yellow at ~1.6:1.
    // The guarantee is about the RATIO, not about which of black or white wins — the
    // label direction is fixed by the scheme, and the accent moves to suit it.
    for (const theme of [dawn, midnight]) {
      for (const colour of ['#ffff00', '#00ff00', '#ffffff', '#000000', '#808080']) {
        const ramp = deriveAccentRamp(colour, theme.palette, theme.scheme)!;
        expect(
          contrastBetween(ramp['accent-on'], ramp.accent)!,
          `${theme.id} + ${colour}`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('uses a dark label in dark themes and a light one in light themes', () => {
    // Convention, and the reason the derivation can always succeed: the label sits at the
    // opposite extreme from the direction the accent moves, so both constraints improve
    // together instead of pulling against each other.
    expect(deriveAccentRamp('#3355cc', midnight.palette, 'dark')!['accent-on']).toBe('#000000');
    expect(deriveAccentRamp('#3355cc', dawn.palette, 'light')!['accent-on']).toBe('#ffffff');
  });

  it('leaves a colour that already has enough contrast alone', () => {
    // Pushing a perfectly good colour around would be a worse outcome than leaving it.
    const ramp = deriveAccentRamp('#3355cc', dawn.palette, 'light')!;
    expect(ramp.accent).toBe('#3355cc');
  });

  it('adjusts a colour that does not, rather than accepting it', () => {
    // A very pale accent on a near-white background: unusable as a border.
    const ramp = deriveAccentRamp('#fffbe6', dawn.palette, 'light')!;
    expect(ramp.accent).not.toBe('#fffbe6');
    expect(contrastBetween(ramp.accent, dawn.palette.bg)!).toBeGreaterThanOrEqual(3);
  });

  it('makes hover and active read as more emphatic, never faded, in both schemes', () => {
    for (const [theme, scheme] of [
      [dawn, 'light'],
      [midnight, 'dark'],
    ] as const) {
      const ramp = deriveAccentRamp('#3355cc', theme.palette, scheme)!;
      const label = ramp['accent-on'];

      const rest = contrastBetween(label, ramp.accent)!;
      const hover = contrastBetween(label, ramp['accent-hover'])!;
      const active = contrastBetween(label, ramp['accent-active'])!;

      // Monotonic against the LABEL. This is the property that matters: pressing a button
      // must never make its own text harder to read, and it is exactly what a fixed
      // "emphasis" direction gets wrong in one of the two schemes.
      expect(hover, `${scheme}: hover vs rest`).toBeGreaterThan(rest);
      expect(active, `${scheme}: active vs hover`).toBeGreaterThan(hover);
    }
  });

  it('produces a subtle tint close to the surface, not a second solid fill', () => {
    const ramp = deriveAccentRamp('#3355cc', dawn.palette, 'light')!;
    // A selected row should read as tinted, not as a coloured block.
    expect(contrastBetween(ramp['accent-subtle'], dawn.palette.surface)!).toBeLessThan(2);
  });

  it('returns null for input that is not a colour', () => {
    expect(deriveAccentRamp('nonsense', dawn.palette, 'light')).toBeNull();
    expect(deriveAccentRamp('', dawn.palette, 'light')).toBeNull();
  });

  it('leaves the palette untouched when no accent is chosen or it is unparseable', () => {
    expect(applyAccent(dawn.palette, null, 'light')).toEqual(dawn.palette);
    expect(applyAccent(dawn.palette, 'not-a-colour', 'light')).toEqual(dawn.palette);
  });

  it('touches only the six accent tokens, never anything else', () => {
    // A subset assertion, not an equality one: a derived value can legitimately match what
    // the theme already had (dawn's accent-on is white, and white is what a light theme
    // derives), and that is not a bug.
    const accentTokens = new Set([
      'accent',
      'accent-active',
      'accent-hover',
      'accent-on',
      'accent-subtle',
      'accent-subtle-text',
    ]);
    const applied = applyAccent(dawn.palette, '#b03060', 'light');
    const changed = Object.keys(applied).filter(
      (key) => applied[key as keyof typeof applied] !== dawn.palette[key as keyof typeof applied]
    );

    expect(changed.length).toBeGreaterThan(0);
    for (const key of changed) expect(accentTokens.has(key), `${key} must not change`).toBe(true);
  });
});

describe('mix', () => {
  it('returns the endpoints exactly', () => {
    const a = { r: 0, g: 0, b: 0 };
    const b = { r: 255, g: 255, b: 255 };
    expect(mix(a, b, 0)).toEqual(a);
    expect(mix(a, b, 1)).toEqual(b);
  });

  it('clamps out-of-range amounts rather than extrapolating', () => {
    const a = { r: 0, g: 0, b: 0 };
    const b = { r: 100, g: 100, b: 100 };
    expect(mix(a, b, -1)).toEqual(a);
    expect(mix(a, b, 2)).toEqual(b);
  });
});
