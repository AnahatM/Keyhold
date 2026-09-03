// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { contrastRatio, formatRatio, parseColour, type Rgb } from './contrast.js';
import {
  compositeOver,
  FILL_KINDS,
  isColourToken,
  isStyleToken,
  parseAlpha,
  referencesIn,
  STYLE_TOKENS,
  type StyleDefinition,
  type StyleToken,
} from './style-tokens.js';
import { DEFAULT_STYLE_ID, FALLBACK_STYLE, findStyle, resolveStyle, STYLES } from './styles.js';
import { THEMES } from './themes.js';
import {
  CONTRAST_REQUIREMENTS,
  type ColourToken,
  type Palette,
  type ThemeDefinition,
} from './tokens.js';

/**
 * The style guards.
 *
 * A style is not one appearance, it is eight — one per theme — and the whole reason this
 * phase needed its own guards rather than reusing the theme ones is that **the theme guards
 * are per-theme**. They verify that Dawn is readable. They cannot see that a style has made
 * Dawn's primary button 85% opaque and dragged white-on-accent under 4.5:1, because from
 * `themes.test.ts`'s point of view the palette has not changed at all.
 *
 * Four properties, and each one exists because of a specific way a style can silently break
 * an app that every existing test still passes:
 *
 *  1. **Every style resolves every token, under every theme.** A token whose value points at
 *     a colour that one palette does not define renders as nothing: an unresolved `var()`
 *     with no fallback makes the whole declaration invalid at computed-value time, so the
 *     border simply is not drawn. Nothing throws.
 *  2. **Contrast holds for every style × theme pair.** Translucency and texture are
 *     background changes that the palette does not know about.
 *  3. **No style hard-codes a colour.** Hard rule 4 does not relax for a style, and a style
 *     is exactly where the temptation is worst — a shadow "obviously" wants black.
 *  4. **Ids are unique and URL-safe.** They are persisted in settings and will end up in a
 *     `data-style` attribute and a CSS selector.
 *
 * Fault injections performed against this file, each of which failed the named test:
 * deleting `blur` from Minimalist; writing a literal hex into Flat's `shadow-md`; dropping
 * Holographic's `fill-opacity` to 60%; misspelling a reference as `--kh-colour-accent`;
 * duplicating the `flat` id.
 */

// ── Reading a value, by the convention its name states ───────────────────────

/**
 * The value shape each token must hold, derived from its name rather than listed.
 *
 * A second table of "which tokens are percentages" would be a second list, and would rot the
 * first time a token was added. The naming convention carries it instead: a token ending in
 * `-opacity` is a percentage, `-scale` is a unitless multiplier, `-width` / `-size` / `blur`
 * are lengths, and everything else is free-form CSS this cannot usefully check.
 */
function shapeOf(token: StyleToken): 'percentage' | 'number' | 'length' | 'free' {
  if (token.endsWith('-opacity')) return 'percentage';
  if (token.endsWith('-scale')) return 'number';
  if (token.endsWith('-width') || token.endsWith('-size') || token === 'blur') return 'length';
  return 'free';
}

const LENGTH = /^\d+(?:\.\d+)?(?:px|rem|em)$/;
const UNITLESS = /^\d+(?:\.\d+)?$/;

/** Hex colours and the `rgb()`/`rgba()`/`hsl()`/`hsla()` functional forms. */
const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;

// ── The contrast model ───────────────────────────────────────────────────────

/**
 * The surfaces a fill can find itself sitting on, under a given style and theme.
 *
 * Always the app background, plus one entry per colour the style's texture draws in. A
 * blueprint grid is not decoration as far as WCAG is concerned — it is a background that
 * body text lands on, and the line is the worst case rather than the gap between lines, so
 * every requirement is re-checked against it.
 */
function backdrops(style: StyleDefinition, palette: Palette): readonly Rgb[] {
  const page = parseColour(palette.bg);
  if (page === null) return [];

  const alpha = parseAlpha(style.tokens['texture-opacity']);
  if (alpha === null || alpha === 0) return [page];

  const tinted: Rgb[] = [page];
  // Deduplicated: a grid is two gradients drawn in one colour, so the same backdrop would
  // otherwise be checked twice and every failure reported twice.
  for (const colour of new Set(referencesIn(style.tokens['texture-image']).colours)) {
    if (!isColourToken(colour)) continue;
    const line = parseColour(palette[colour]);
    if (line !== null) tinted.push(compositeOver(line, page, alpha));
  }
  return tinted;
}

/**
 * What a background token actually resolves to on screen, under a style, over a backdrop.
 *
 * `FILL_KINDS` governs *fills* — a `background-color` — and never a text or icon colour, so
 * this is applied to the background half of a requirement and never to the foreground.
 * `bg` itself is the backdrop: there is nothing behind the page to composite it over.
 */
function effectiveBackground(
  style: StyleDefinition,
  palette: Palette,
  token: ColourToken,
  backdrop: Rgb
): Rgb | null {
  if (token === 'bg') return backdrop;

  const kind = FILL_KINDS[token];
  const fill = parseColour(palette[token]);
  if (fill === null) return null;
  if (kind === 'opaque') return fill;

  const alpha = parseAlpha(
    kind === 'surface' ? style.tokens['surface-opacity'] : style.tokens['fill-opacity']
  );
  return alpha === null ? null : compositeOver(fill, backdrop, alpha);
}

// ── The registry ─────────────────────────────────────────────────────────────

describe('the style registry', () => {
  it('ships the four documented styles with unique ids', () => {
    expect(STYLES).toHaveLength(4);
    expect(new Set(STYLES.map((style) => style.id)).size).toBe(4);
  });

  it('uses ids that are safe in a URL, a CSS selector and a data attribute', () => {
    // They are persisted in settings and will end up in `[data-style="…"]`. A capital or a
    // space would work in JSON and fail in a selector, which is the worst place to find out.
    for (const style of STYLES) {
      expect(style.id, `"${style.id}" is not a safe id`).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    }
  });

  it('gives every style a name and a summary worth showing in settings', () => {
    for (const style of STYLES) {
      expect(style.name.length, `${style.id} needs a name`).toBeGreaterThan(0);
      expect(style.summary.length, `${style.id} needs a real summary`).toBeGreaterThan(20);
    }
  });

  it('keeps Flat, so choosing a style is never a one-way door', () => {
    // The point of naming the existing look rather than replacing it: a user who tries
    // Holographic and dislikes it has somewhere to go back to that is exactly where they
    // started, not an approximation of it.
    expect(findStyle('flat')).toBeDefined();
  });

  it('points its default at a style that exists', () => {
    expect(findStyle(DEFAULT_STYLE_ID)).toBeDefined();
  });

  it('falls back to the plainest style, not the fanciest', () => {
    // "We do not know what you asked for" should not be answered with translucency and a
    // backdrop filter.
    expect(FALLBACK_STYLE).toBe(findStyle('flat'));
    expect(FALLBACK_STYLE.tokens.blur).toBe('0px');
    expect(FALLBACK_STYLE.tokens['surface-opacity']).toBe('100%');
  });

  it('resolves an unknown id rather than leaving the app with no material at all', () => {
    expect(resolveStyle('a-style-that-was-deleted').id).toBe(DEFAULT_STYLE_ID);
    expect(resolveStyle('neumorphic').id).toBe('neumorphic');
  });
});

// ── Property 1: every style resolves every token, under every theme ──────────

describe('every style defines every token', () => {
  it.each(STYLES.map((style) => [style.id, style] as const))('%s', (_id, style) => {
    for (const token of STYLE_TOKENS) {
      const value = style.tokens[token];
      expect(value, `${style.id} is missing "${token}"`).toBeDefined();
      expect(value.trim().length, `${style.id}.${token} is empty`).toBeGreaterThan(0);
    }
  });

  it('defines no key that is not a token, and no token that no style sets', () => {
    const tokens = new Set<string>(STYLE_TOKENS);
    for (const style of STYLES) {
      for (const key of Object.keys(style.tokens)) {
        expect(tokens.has(key), `${style.id} has an unknown token "${key}"`).toBe(true);
      }
      expect(Object.keys(style.tokens)).toHaveLength(STYLE_TOKENS.length);
    }
  });

  it.each(STYLES.map((style) => [style.id, style] as const))(
    '%s holds the value shape each token name promises',
    (_id, style) => {
      for (const token of STYLE_TOKENS) {
        const value = style.tokens[token];
        switch (shapeOf(token)) {
          case 'percentage':
            expect(
              parseAlpha(value),
              `${style.id}.${token} = "${value}" is not a percentage`
            ).not.toBeNull();
            break;
          case 'number':
            expect(value, `${style.id}.${token} = "${value}" is not a unitless number`).toMatch(
              UNITLESS
            );
            break;
          case 'length':
            expect(value, `${style.id}.${token} = "${value}" is not a length`).toMatch(LENGTH);
            break;
          case 'free':
            break;
        }
      }
    }
  );

  it.each(STYLES.map((style) => [style.id, style] as const))(
    '%s references only tokens that exist',
    (_id, style) => {
      // The cross-theme half of "resolves under every theme": a colour reference is checked
      // against COLOUR_TOKENS, and every theme is type-forced to define all of those, so a
      // reference that resolves here resolves in all eight. `others` must be empty rather
      // than merely known — a style token reaching for a `base.css` property could not be
      // verified from here, and this file cannot silently allow what it cannot check.
      for (const token of STYLE_TOKENS) {
        const references = referencesIn(style.tokens[token]);

        for (const colour of references.colours) {
          expect(
            isColourToken(colour),
            `${style.id}.${token} → --kh-color-${colour} does not exist`
          ).toBe(true);
        }
        for (const other of references.styles) {
          expect(
            isStyleToken(other),
            `${style.id}.${token} → --kh-style-${other} does not exist`
          ).toBe(true);
        }
        expect(
          references.others,
          `${style.id}.${token} references a property outside the two token layers`
        ).toEqual([]);
      }
    }
  );

  it.each(
    THEMES.flatMap((theme) => STYLES.map((style) => [`${style.id} × ${theme.id}`, style, theme]))
  )('%s resolves every colour a token reaches for', (_label, style, theme) => {
    const definition = style as StyleDefinition;
    const palette = (theme as ThemeDefinition).palette;

    for (const token of STYLE_TOKENS) {
      for (const colour of referencesIn(definition.tokens[token]).colours) {
        if (!isColourToken(colour)) continue;
        expect(
          parseColour(palette[colour]),
          `${definition.id}.${token} reads --kh-color-${colour}, which is not a colour in this theme`
        ).not.toBeNull();
      }
    }
  });
});

// ── Property 3: no style hard-codes a colour ─────────────────────────────────

describe('the colour rule, inside the style layer', () => {
  it('no style token contains a colour literal', () => {
    // `tools/no-hardcoded-colours.test.ts` sweeps the source tree and would catch this too.
    // It is repeated here because the failure it produces there says "a file contains a
    // colour", and the failure it produces here says which style and which token — and
    // because a style is the one place where writing a literal black feels reasonable.
    const violations: string[] = [];
    for (const style of STYLES) {
      for (const token of STYLE_TOKENS) {
        if (COLOUR_LITERAL.test(style.tokens[token])) {
          violations.push(`${style.id}.${token} = ${style.tokens[token]}`);
        }
      }
    }
    expect(violations, 'colour literals in the style layer').toEqual([]);
  });

  it('reaches every colour through a colour token instead', () => {
    // The other half: a shadow that is drawn at all but mentions no colour token is either
    // invisible or picking up the inherited text colour by accident — `box-shadow` with no
    // colour defaults to `currentColor`, which is a genuinely surprising way for an
    // elevation to end up bright red on a validation message. `none` is exempt because
    // Minimalist means it: no shadow, rather than a shadow in no colour.
    for (const style of STYLES) {
      for (const token of ['shadow-sm', 'shadow-md', 'shadow-lg', 'shadow-inset'] as const) {
        if (style.tokens[token] === 'none') continue;
        expect(
          referencesIn(style.tokens[token]).colours.length,
          `${style.id}.${token} draws in no palette colour`
        ).toBeGreaterThan(0);
      }
    }
  });

  it('gives a texture a colour to draw in, or no texture at all', () => {
    // A texture with no colour reference would sail past the contrast pass below, because
    // that pass has nothing to composite. Silence there would mean "checked and fine".
    for (const style of STYLES) {
      const image = style.tokens['texture-image'];
      const opacity = parseAlpha(style.tokens['texture-opacity']) ?? 0;
      if (image === 'none' || opacity === 0) continue;
      expect(
        referencesIn(image).colours.length,
        `${style.id} draws a texture in no palette colour`
      ).toBeGreaterThan(0);
    }
  });

  it('lets an accent gradient reach only for colours something already checks', () => {
    // An accent gradient becomes the background under `accent-on`. Restricting it to colours
    // that `CONTRAST_REQUIREMENTS` already declares as backgrounds is what keeps the
    // translucency pass below sufficient — a gradient stop in an unchecked colour would be a
    // background no test has ever looked at, and gradients are the one thing this file
    // genuinely cannot model.
    const declared = new Set<string>(CONTRAST_REQUIREMENTS.map((r) => r.background));
    for (const style of STYLES) {
      for (const colour of referencesIn(style.tokens['accent-image']).colours) {
        expect(
          declared.has(colour),
          `${style.id}.accent-image mixes ${colour}, which no contrast requirement covers`
        ).toBe(true);
      }
    }
  });
});

// ── Property 2: contrast holds for every style × theme pair ──────────────────

describe('WCAG AA contrast, for every style under every theme', () => {
  const cases = STYLES.flatMap((style) =>
    THEMES.map((theme) => [`${style.id} × ${theme.id}`, style, theme] as const)
  );

  it.each(cases)('%s', (_label, style, theme) => {
    const failures: string[] = [];

    for (const backdrop of backdrops(style, theme.palette)) {
      for (const requirement of CONTRAST_REQUIREMENTS) {
        const foreground = parseColour(theme.palette[requirement.foreground]);
        const background = effectiveBackground(
          style,
          theme.palette,
          requirement.background,
          backdrop
        );

        if (foreground === null || background === null) {
          failures.push(`${requirement.foreground} on ${requirement.background}: unparseable`);
          continue;
        }

        const ratio = contrastRatio(foreground, background);
        if (ratio < requirement.minimum) {
          failures.push(
            `${requirement.foreground} on ${requirement.background} is ${formatRatio(ratio)}, ` +
              `needs ${requirement.minimum}:1 — ${requirement.note}`
          );
        }
      }
    }

    expect(
      failures,
      `${style.id} under ${theme.id}: translucency or texture has taken these pairs below AA. ` +
        `The dials are surface-opacity (${style.tokens['surface-opacity']}), ` +
        `fill-opacity (${style.tokens['fill-opacity']}) and ` +
        `texture-opacity (${style.tokens['texture-opacity']}).`
    ).toEqual([]);
  });

  it('is a real check — an opaque style leaves every ratio exactly where the theme put it', () => {
    // Keeps the pass above honest. If `effectiveBackground` were subtly wrong, the guard
    // could pass by computing nothing; this pins the boundary case to the theme guard's own
    // numbers, so the two agree where they must.
    const opaque = findStyle('flat')!;
    for (const theme of THEMES) {
      for (const requirement of CONTRAST_REQUIREMENTS) {
        const direct = contrastRatio(
          parseColour(theme.palette[requirement.foreground])!,
          parseColour(theme.palette[requirement.background])!
        );
        const modelled = contrastRatio(
          parseColour(theme.palette[requirement.foreground])!,
          effectiveBackground(
            opaque,
            theme.palette,
            requirement.background,
            parseColour(theme.palette.bg)!
          )!
        );
        expect(
          modelled,
          `${theme.id}: ${requirement.foreground}/${requirement.background}`
        ).toBeCloseTo(direct, 10);
      }
    }
  });

  it('would notice a style that went too far, which is the only reason to trust it', () => {
    // Fault injection, kept rather than performed once and described. A hypothetical style
    // with a 60% accent fill must fail somewhere, or the pass above proves nothing.
    const reckless: StyleDefinition = {
      ...findStyle('holographic')!,
      tokens: { ...findStyle('holographic')!.tokens, 'fill-opacity': '60%' },
    };

    const broken = THEMES.filter((theme) =>
      CONTRAST_REQUIREMENTS.some((requirement) => {
        const background = effectiveBackground(
          reckless,
          theme.palette,
          requirement.background,
          parseColour(theme.palette.bg)!
        );
        if (background === null) return true;
        const foreground = parseColour(theme.palette[requirement.foreground]);
        return foreground !== null && contrastRatio(foreground, background) < requirement.minimum;
      })
    );

    expect(broken.length, 'a 60% accent fill should break at least one theme').toBeGreaterThan(0);
  });
});
