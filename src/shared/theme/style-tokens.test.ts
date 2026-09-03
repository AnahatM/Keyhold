// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { contrastRatio, parseColour } from './contrast.js';
import {
  compositeOver,
  effectiveFill,
  FADEABLE_LINE_TOKENS,
  FILL_KINDS,
  isColourToken,
  isCompleteStyleTokens,
  isStyleToken,
  parseAlpha,
  referencesIn,
  STYLE_TOKENS,
} from './style-tokens.js';
import { STYLES } from './styles.js';
import { THEMES } from './themes.js';
import { COLOUR_TOKENS, CONTRAST_REQUIREMENTS } from './tokens.js';

/**
 * The material vocabulary, and the maths the style guards are built on.
 *
 * `styles.test.ts` checks the styles. This checks the machinery that checks the styles —
 * which matters more than it sounds, because every guard over there is only as honest as
 * `referencesIn` and `compositeOver` are. A compositing function that quietly returned the
 * top colour unchanged would make every translucency check pass, for every style, forever.
 */

const flat = STYLES.find((style) => style.id === 'flat')!;
const dawn = THEMES.find((theme) => theme.id === 'dawn')!;

describe('the token vocabulary', () => {
  it('names every token once, in kebab-case', () => {
    expect(new Set(STYLE_TOKENS).size).toBe(STYLE_TOKENS.length);
    for (const token of STYLE_TOKENS) {
      expect(token, `"${token}" is not kebab-case`).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    }
  });

  it('shares no name with a colour token, so the two prefixes can never be confused', () => {
    // `--kh-color-border` and `--kh-style-border-width` are readable side by side. A
    // `--kh-style-accent` next to `--kh-color-accent` would not be, and a reviewer skimming
    // a rule would have to look up which axis it belongs to.
    const colours = new Set<string>(COLOUR_TOKENS);
    for (const token of STYLE_TOKENS) {
      expect(colours.has(token), `"${token}" collides with a colour token`).toBe(false);
    }
  });

  it('recognises its own tokens and rejects invented ones', () => {
    expect(isStyleToken('blur')).toBe(true);
    expect(isStyleToken('bg')).toBe(false);
    expect(isColourToken('accent')).toBe(true);
    expect(isColourToken('accent-image')).toBe(false);
  });
});

describe('completeness', () => {
  it('accepts every built-in material set', () => {
    for (const style of STYLES) expect(isCompleteStyleTokens(style.tokens)).toBe(true);
  });

  it('rejects a set missing even one token', () => {
    for (const token of STYLE_TOKENS) {
      const partial = { ...flat.tokens } as Record<string, unknown>;
      delete partial[token];
      expect(isCompleteStyleTokens(partial), `should reject a set missing ${token}`).toBe(false);
    }
  });

  it('rejects an empty string, which would drop the declaration rather than set it', () => {
    expect(isCompleteStyleTokens({ ...flat.tokens, blur: '' })).toBe(false);
    expect(isCompleteStyleTokens({ ...flat.tokens, blur: '   ' })).toBe(false);
  });

  it('rejects things that are not objects at all', () => {
    expect(isCompleteStyleTokens(null)).toBe(false);
    expect(isCompleteStyleTokens('flat')).toBe(false);
    expect(isCompleteStyleTokens(42)).toBe(false);
  });
});

describe('what a style may fade', () => {
  /*
   * The accessibility invariant of this whole phase, stated as a test rather than as a
   * comment somebody can forget to read. `border-strong` is what an input outline is drawn
   * in and is held to 3:1 by SC 1.4.11; `focus-ring` is the only thing telling a keyboard
   * user where they are. Neither has headroom in the shipped palettes — Dawn's
   * `border-strong` was darkened until it cleared 3.0 by a hair — so fading either by any
   * amount at all puts a theme below AA.
   */
  it('never fades a required boundary or the focus ring', () => {
    expect(FADEABLE_LINE_TOKENS).not.toContain('border-strong');
    expect(FADEABLE_LINE_TOKENS).not.toContain('focus-ring');
  });

  it('fades only colours that no contrast requirement depends on', () => {
    // The reason the list above is safe, checked rather than asserted. Anything fadeable
    // must appear on neither side of any declared pair, or a style could move a ratio the
    // contrast guard believes it has already verified.
    const guarded = new Set<string>();
    for (const requirement of CONTRAST_REQUIREMENTS) {
      guarded.add(requirement.foreground);
      guarded.add(requirement.background);
    }
    for (const token of FADEABLE_LINE_TOKENS) {
      expect(guarded.has(token), `"${token}" is fadeable but carries a contrast requirement`).toBe(
        false
      );
    }
  });

  it('never fades text', () => {
    // A style may make a fill translucent. It may never make what is written on it
    // translucent — that is unreadable for exactly the people who can least afford it.
    for (const token of [
      'text',
      'text-muted',
      'text-subtle',
      'text-inverse',
      'accent-on',
    ] as const) {
      expect(FILL_KINDS[token], `${token} must never be faded`).toBe('opaque');
    }
  });

  it('classifies the app background as opaque, because nothing is behind it', () => {
    expect(FILL_KINDS.bg).toBe('opaque');
  });

  it('classifies every colour token and nothing else', () => {
    // Drift in both directions, the same check `themes.test.ts` makes over a palette. A key
    // left behind after a colour is renamed classifies nothing; a colour with no key would
    // be read as `undefined` by the contrast guard and silently checked as opaque — which
    // is to say, not checked at all.
    const colours = new Set<string>(COLOUR_TOKENS);
    for (const key of Object.keys(FILL_KINDS)) {
      expect(colours.has(key), `FILL_KINDS has an unknown token "${key}"`).toBe(true);
    }
    expect(Object.keys(FILL_KINDS)).toHaveLength(COLOUR_TOKENS.length);
  });
});

describe('reading references out of a token value', () => {
  it('splits colour, style and everything else apart', () => {
    const references = referencesIn(
      'linear-gradient(var(--kh-color-accent), var(--kh-style-blur), var(--kh-space-3))'
    );
    expect(references.colours).toEqual(['accent']);
    expect(references.styles).toEqual(['blur']);
    expect(references.others).toEqual(['--kh-space-3']);
  });

  it('finds every occurrence, not just the first', () => {
    const references = referencesIn(
      'color-mix(in srgb, var(--kh-color-border) 60%, transparent) var(--kh-color-accent) ' +
        'var( --kh-color-border )'
    );
    expect(references.colours).toEqual(['border', 'accent', 'border']);
  });

  it('finds nothing in a value that references nothing', () => {
    expect(referencesIn('none')).toEqual({ colours: [], styles: [], others: [] });
  });

  it('catches the near-miss spellings, which is the point of collecting `others` at all', () => {
    // `--kh-colour-accent` resolves to nothing. An unresolved var() with no fallback drops
    // the entire declaration silently, so this is the failure that has to be loud.
    expect(referencesIn('var(--kh-colour-accent)').others).toEqual(['--kh-colour-accent']);
    expect(referencesIn('var(--kh-color-accent)').others).toEqual([]);
  });
});

describe('alpha parsing', () => {
  it('reads a percentage into a fraction', () => {
    expect(parseAlpha('100%')).toBe(1);
    expect(parseAlpha('0%')).toBe(0);
    expect(parseAlpha('94%')).toBeCloseTo(0.94, 10);
    expect(parseAlpha('12.5%')).toBeCloseTo(0.125, 10);
    expect(parseAlpha('  90%  ')).toBeCloseTo(0.9, 10);
  });

  it('refuses anything that is not a percentage in range', () => {
    // Stored as percentages so they drop straight into color-mix(). A bare `0.94` would be
    // a valid custom-property value and a silently broken colour mix.
    for (const value of ['', '0.94', '94', '101%', '-5%', 'none', '94 %']) {
      expect(parseAlpha(value), `"${value}" should not parse`).toBeNull();
    }
  });
});

describe('compositing', () => {
  const white = parseColour('#ffffff')!;
  const black = parseColour('#000000')!;

  it('returns the top colour at full alpha and the bottom at zero', () => {
    expect(compositeOver(white, black, 1)).toEqual(white);
    expect(compositeOver(white, black, 0)).toEqual(black);
  });

  it('lands halfway at half alpha', () => {
    expect(compositeOver(white, black, 0.5)).toEqual({ r: 128, g: 128, b: 128 });
  });

  it('moves contrast in the direction a translucent fill actually moves it', () => {
    // The property the guards depend on: white text on a fill that is fading toward a light
    // page gets *harder* to read, and the number has to know that.
    const opaque = contrastRatio(white, parseColour('#3355cc')!);
    const translucent = contrastRatio(
      white,
      compositeOver(parseColour('#3355cc')!, parseColour('#f7f7f9')!, 0.85)
    );
    expect(translucent).toBeLessThan(opaque);
  });

  it('composites a palette fill over the app background', () => {
    const fill = effectiveFill(dawn.palette, 'accent', '50%');
    expect(fill).not.toBeNull();
    expect(fill).toEqual(
      compositeOver(parseColour(dawn.palette.accent)!, parseColour(dawn.palette.bg)!, 0.5)
    );
  });

  it('returns null rather than a wrong answer for an unusable alpha', () => {
    expect(effectiveFill(dawn.palette, 'accent', 'none')).toBeNull();
  });
});
