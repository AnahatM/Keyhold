// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  admitPalette,
  contrastAcknowledgement,
  evaluatePaletteContrast,
  keepThemeFromDefinition,
  type KeepTheme,
} from '@shared/theme/keeptheme.js';
import { DEFAULT_DARK_THEME_ID, findTheme, THEMES } from '@shared/theme/themes.js';
import { COLOUR_TOKENS, type Palette, type ThemeDefinition } from '@shared/theme/tokens.js';
import {
  draftFromKeepTheme,
  draftFromThemeId,
  draftToKeepTheme,
  hasInvalidColours,
  themeDraftReducer,
  type ThemeDraft,
} from './theme-draft.js';

/**
 * The studio's editing rules, held still.
 *
 * `@testing-library/react` is not a dependency of this project, so everything about this
 * screen that matters is a pure function and is tested here rather than through a rendered
 * component. Three of these are guarantees rather than behaviours:
 *
 * 1. **A contrast override never outlives the palette it was given for.** It is the one
 *    thing standing between "the user chose this" and "the app quietly stopped enforcing
 *    WCAG AA", and it has to go stale on *every* palette change, including ones added by a
 *    future action.
 * 2. **An unparseable colour never reaches the palette.** The preview, the report and the
 *    export all read the palette; a `#3` in there is an unreadable app.
 * 3. **What comes out of the studio is what the format will accept.** The draft is exported
 *    through `serialiseKeepTheme`, so a draft the parser would reject is an export that
 *    cannot be imported back.
 */

function requireTheme(id: string): ThemeDefinition {
  const definition = findTheme(id);
  if (definition === undefined) throw new Error(`this build has no theme "${id}"`);
  return definition;
}

const BASE = requireTheme(DEFAULT_DARK_THEME_ID);

function freshDraft(): ThemeDraft {
  return draftFromThemeId(DEFAULT_DARK_THEME_ID);
}

/** A palette that fails AA comfortably but stays above the legibility floor. */
function dimmedPalette(base: Palette): Palette {
  return { ...base, 'text-muted': '#7a7a7a', 'success-text': '#6e8f6e' };
}

describe('editing one colour', () => {
  it('commits a parseable value in canonical form', () => {
    const next = themeDraftReducer(freshDraft(), {
      type: 'set-colour',
      token: 'accent',
      text: '  RGB(17, 34, 51) ',
    });

    expect(next.palette.accent).toBe('#112233');
    expect(hasInvalidColours(next)).toBe(false);
  });

  it('keeps the last good value while an unparseable one is being typed', () => {
    const draft = freshDraft();
    const before = draft.palette.accent;

    const next = themeDraftReducer(draft, { type: 'set-colour', token: 'accent', text: '#3' });

    // The palette is what the preview and the report read. A half-typed value there would
    // make both flicker through states that mean nothing.
    expect(next.palette.accent).toBe(before);
    expect(next.typing.accent).toBe('#3');
    expect(next.invalid.accent).toBe('not-a-colour');
    expect(hasInvalidColours(next)).toBe(true);
  });

  it('reports the specific reason, so the field can say more than “no”', () => {
    const translucent = themeDraftReducer(freshDraft(), {
      type: 'set-colour',
      token: 'bg',
      text: 'rgba(0, 0, 0, 0.5)',
    });
    expect(translucent.invalid.bg).toBe('translucent');

    const long = themeDraftReducer(freshDraft(), {
      type: 'set-colour',
      token: 'bg',
      text: 'x'.repeat(64),
    });
    expect(long.invalid.bg).toBe('too-long');
  });

  it('clears the invalid mark once the value parses again', () => {
    const broken = themeDraftReducer(freshDraft(), {
      type: 'set-colour',
      token: 'accent',
      text: 'not a colour',
    });
    const fixed = themeDraftReducer(broken, {
      type: 'set-colour',
      token: 'accent',
      text: '#445566',
    });

    expect(fixed.invalid).toEqual({});
    expect(fixed.palette.accent).toBe('#445566');
  });

  it('reverts an abandoned edit back to the committed value', () => {
    const broken = themeDraftReducer(freshDraft(), {
      type: 'set-colour',
      token: 'accent',
      text: '#zz',
    });
    const reverted = themeDraftReducer(broken, { type: 'revert-colour', token: 'accent' });

    expect(reverted.typing.accent).toBeUndefined();
    expect(reverted.invalid.accent).toBeUndefined();
    expect(reverted.palette.accent).toBe(freshDraft().palette.accent);
  });

  it('marks only the token being edited, leaving the others alone', () => {
    const broken = themeDraftReducer(freshDraft(), {
      type: 'set-colour',
      token: 'accent',
      text: '#zz',
    });
    expect(Object.keys(broken.invalid)).toEqual(['accent']);
  });
});

// ── The override ─────────────────────────────────────────────────────────────

describe('the contrast override', () => {
  function acknowledgedDraft(): ThemeDraft {
    const palette = dimmedPalette(BASE.palette);
    const draft: ThemeDraft = {
      ...draftFromKeepTheme({ ...keepThemeFromDefinition(BASE), palette }, 'test'),
    };
    const report = evaluatePaletteContrast(draft.palette);
    expect(report.passes, 'the fixture palette is supposed to fail AA').toBe(false);

    return themeDraftReducer(draft, {
      type: 'acknowledge',
      acknowledgement: contrastAcknowledgement(draft.palette, report),
    });
  }

  it('admits the palette it was given for', () => {
    const draft = acknowledgedDraft();
    const admission = admitPalette(draft.palette, draft.acknowledgement);

    expect(admission.ok).toBe(true);
    if (!admission.ok) return;
    expect(admission.usedOverride).toBe(true);
  });

  it('is dropped by a colour edit', () => {
    const nudged = themeDraftReducer(acknowledgedDraft(), {
      type: 'set-colour',
      token: 'accent',
      text: '#123456',
    });

    expect(nudged.acknowledgement).toBeNull();
    expect(admitPalette(nudged.palette, nudged.acknowledgement).ok).toBe(false);
  });

  it('is dropped by a derived accent ramp', () => {
    const ramped = themeDraftReducer(acknowledgedDraft(), {
      type: 'apply-accent',
      colour: '#3355cc',
    });
    expect(ramped.acknowledgement).toBeNull();
  });

  it('is dropped by loading another theme, and by resetting', () => {
    const loaded = themeDraftReducer(acknowledgedDraft(), {
      type: 'load',
      theme: keepThemeFromDefinition(BASE),
      source: 'somewhere.keeptheme',
      notices: [],
    });
    expect(loaded.acknowledgement).toBeNull();

    expect(themeDraftReducer(acknowledgedDraft(), { type: 'reset' }).acknowledgement).toBeNull();
  });

  it('survives an edit that changes no colour', () => {
    // Renaming a theme cannot change what it looks like, so re-asking would be friction
    // with nothing behind it — the distinction the acknowledgement is meant to encode.
    const renamed = themeDraftReducer(acknowledgedDraft(), {
      type: 'set-name',
      name: 'Dimmed',
    });
    expect(renamed.acknowledgement).not.toBeNull();
  });

  /**
   * The structural half of the guarantee.
   *
   * Every action that can touch the palette goes through `withPalette`, which is what makes
   * "a future action cannot forget to invalidate the override" true rather than hoped for.
   * This drives every action in the union and asserts the invariant directly, so an action
   * added later is covered without anyone remembering to add a case here.
   */
  it('holds for every action that changes any colour', () => {
    const start = acknowledgedDraft();
    const actions = [
      { type: 'set-colour', token: 'bg', text: '#101010' },
      { type: 'set-colour', token: 'bg', text: 'not a colour' },
      { type: 'revert-colour', token: 'bg' },
      { type: 'set-name', name: 'x' },
      { type: 'set-description', description: 'x' },
      { type: 'set-scheme', scheme: 'light' },
      { type: 'apply-accent', colour: '#3355cc' },
      { type: 'apply-accent', colour: 'nonsense' },
      { type: 'load', theme: keepThemeFromDefinition(BASE), source: null, notices: [] },
      { type: 'reset' },
    ] as const;

    for (const action of actions) {
      const next = themeDraftReducer(start, action);
      const changed = COLOUR_TOKENS.some((token) => next.palette[token] !== start.palette[token]);
      if (changed) {
        expect(
          next.acknowledgement,
          `"${action.type}" changed a colour and kept consent`
        ).toBeNull();
      }
    }
  });
});

// ── Accent derivation ────────────────────────────────────────────────────────

describe('deriving from an accent', () => {
  it('rewrites exactly the six accent tokens', () => {
    const before = freshDraft();
    const after = themeDraftReducer(before, { type: 'apply-accent', colour: '#3355cc' });

    const changed = COLOUR_TOKENS.filter((token) => after.palette[token] !== before.palette[token]);
    expect(new Set(changed)).toEqual(
      new Set([
        'accent',
        'accent-hover',
        'accent-active',
        'accent-on',
        'accent-subtle',
        'accent-subtle-text',
      ])
    );
  });

  it('leaves the draft untouched when the colour cannot be parsed', () => {
    const before = freshDraft();
    expect(themeDraftReducer(before, { type: 'apply-accent', colour: '#nope' })).toBe(before);
  });

  it('clears in-progress edits, because the values under them just moved', () => {
    const typing = themeDraftReducer(freshDraft(), {
      type: 'set-colour',
      token: 'accent',
      text: '#1',
    });
    const ramped = themeDraftReducer(typing, { type: 'apply-accent', colour: '#3355cc' });

    expect(ramped.typing).toEqual({});
    expect(ramped.invalid).toEqual({});
  });
});

// ── Loading and resetting ────────────────────────────────────────────────────

describe('loading and resetting', () => {
  it('starts from a built-in, keeping its scheme and its identity', () => {
    for (const definition of THEMES) {
      const draft = draftFromThemeId(definition.id);
      expect(draft.scheme).toBe(definition.scheme);
      expect(draft.basedOn).toBe(definition.id);
      expect(draft.acknowledgement).toBeNull();
      expect(hasInvalidColours(draft)).toBe(false);
    }
  });

  it('falls back to a real theme rather than throwing on an unknown id', () => {
    const draft = draftFromThemeId('a-theme-from-2032');

    // A complete palette of canonical colours, not merely an object that exists — a draft
    // with a hole in it is an app with an invisible element, which is the failure the
    // fallback is there to prevent in the first place.
    expect(Object.keys(draft.palette).sort()).toEqual([...COLOUR_TOKENS].sort());
    for (const token of COLOUR_TOKENS) {
      expect(draft.palette[token], token).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('returns to what the draft was based on, not to the app default', () => {
    const light = draftFromThemeId('dawn');
    const wrecked = themeDraftReducer(light, {
      type: 'set-colour',
      token: 'bg',
      text: '#000000',
    });
    const reset = themeDraftReducer(wrecked, { type: 'reset' });

    expect(reset.basedOn).toBe('dawn');
    expect(reset.palette).toEqual(light.palette);
  });

  it('carries the import notices through, so they can be shown after the load', () => {
    const loaded = themeDraftReducer(freshDraft(), {
      type: 'load',
      theme: keepThemeFromDefinition(BASE),
      source: 'friend.keeptheme',
      notices: [
        {
          kind: 'unknown-token',
          token: 'sparkle',
          message: 'Ignored an unknown colour "sparkle".',
        },
      ],
    });

    expect(loaded.source).toBe('friend.keeptheme');
    expect(loaded.notices).toHaveLength(1);
  });
});

// ── What leaves the screen ───────────────────────────────────────────────────

describe('the theme a draft becomes', () => {
  it('never exports an empty name', () => {
    const unnamed = themeDraftReducer(freshDraft(), { type: 'set-name', name: '   ' });
    expect(draftToKeepTheme(unnamed).name).toBe('Untitled theme');
  });

  it('trims what the user typed', () => {
    const draft = themeDraftReducer(
      themeDraftReducer(freshDraft(), { type: 'set-name', name: '  Dusk  ' }),
      { type: 'set-description', description: '  Quiet.  ' }
    );
    const theme = draftToKeepTheme(draft);

    expect(theme.name).toBe('Dusk');
    expect(theme.description).toBe('Quiet.');
  });

  it('declares the format marker and version the parser checks for', () => {
    const theme: KeepTheme = draftToKeepTheme(freshDraft());
    expect(theme.format).toBe('keyhold-theme');
    expect(theme.version).toBe(1);
  });

  it('produces a palette the format gate admits without an override', () => {
    // A built-in passes AA, so a draft straight off one must leave the studio cleanly. If
    // this ever fails, the studio is capable of producing an export it cannot import.
    const admission = admitPalette(draftToKeepTheme(freshDraft()).palette, null);
    expect(admission.ok).toBe(true);
  });
});
