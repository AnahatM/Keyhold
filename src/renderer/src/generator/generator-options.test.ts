// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { GeneratorLimitsView } from '@shared/ipc/api.js';
import type { GeneratorMode } from '@shared/model/generator.js';
import {
  CAPITALISATIONS,
  CAPITALISATION_LABELS,
  GENERATOR_MODES,
  MODE_DETAILS,
  clampToRange,
  configurationKey,
  draftFromDefaults,
  limitForMode,
  optionsFromDraft,
} from './generator-options.js';

/**
 * What is worth testing here, and what is not.
 *
 * `@testing-library/react` is deliberately **not** a dependency of this project, so nothing
 * below renders a component. That is fine, because the part of this panel that could break
 * silently is not the markup — it is the arithmetic between "what the user chose" and "what
 * the engine is asked for".
 *
 * The one property that matters most: **no control may offer a value the engine would
 * refuse for being out of range, and no bound may be written down twice.** The limits used
 * throughout are deliberately *not* the engine's real ones — they are made-up numbers, so a
 * test would fail if anything in this folder ever reached for a hardcoded 8 or 256 instead
 * of the bounds it was handed.
 */

/**
 * Nothing like the engine's real limits, on purpose — and deliberately tighter than every
 * default below, so each default has to be clamped on the way out.
 *
 * If `optionsFromDraft` ever clamped against a literal, or skipped the clamp and passed a
 * default straight through, every assertion below would go red. That is the whole point of
 * passing limits in rather than importing them.
 */
const LIMITS: GeneratorLimitsView = {
  limits: {
    randomLength: { min: 11, max: 15 },
    passphraseWords: { min: 2, max: 4 },
    pronounceableLength: { min: 9, max: 12 },
    pinLength: { min: 2, max: 3 },
  },
  defaults: {
    random: {
      length: 20,
      lowercase: true,
      uppercase: true,
      digits: true,
      symbols: true,
      excludeAmbiguous: false,
      excludeCharacters: '',
      requireEachClass: true,
    },
    passphrase: { wordCount: 6, separator: '-', capitalisation: 'none', includeDigit: false },
    pronounceable: { length: 16, digits: false, symbols: false },
    pin: { length: 4 },
  },
};

describe('the mode registry', () => {
  it('lists every mode exactly once, in the order the switcher shows them', () => {
    // The Record is the completeness guard — a new mode fails to compile without an entry.
    // This is the other half: the ordered array must not fall behind it.
    const described = Object.keys(MODE_DETAILS).sort();
    expect([...GENERATOR_MODES].sort()).toEqual(described);
    expect(new Set(GENERATOR_MODES).size).toBe(GENERATOR_MODES.length);
  });

  it('gives every mode a label, a summary and a governing limit', () => {
    for (const mode of GENERATOR_MODES) {
      const detail = MODE_DETAILS[mode];
      expect(detail.label).not.toBe('');
      expect(detail.summary).not.toBe('');
      expect(detail.unit).not.toBe('');
      expect(LIMITS.limits[detail.limit]).toBeDefined();
    }
  });

  it('warns about the modes that are honestly weaker, and does not invent a warning for the ones that are not', () => {
    // Selling `pronounceable` or `pin` without their caveat would be the generator
    // flattering its own weak modes, which is the one thing this UI must not do.
    expect(MODE_DETAILS.pronounceable.caveat).not.toBeNull();
    expect(MODE_DETAILS.pin.caveat).not.toBeNull();
    expect(MODE_DETAILS.random.caveat).toBeNull();
  });

  it('labels every casing option exactly once', () => {
    expect([...CAPITALISATIONS].sort()).toEqual(Object.keys(CAPITALISATION_LABELS).sort());
    expect(new Set(Object.values(CAPITALISATION_LABELS)).size).toBe(CAPITALISATIONS.length);
  });
});

describe('clampToRange', () => {
  it('holds a value inside the bound it was given', () => {
    expect(clampToRange(1, { min: 11, max: 33 })).toBe(11);
    expect(clampToRange(999, { min: 11, max: 33 })).toBe(33);
    expect(clampToRange(20, { min: 11, max: 33 })).toBe(20);
  });

  it('rounds, because a fraction reaches a loop in the engine that counts', () => {
    expect(clampToRange(20.4, { min: 11, max: 33 })).toBe(20);
    expect(clampToRange(20.6, { min: 11, max: 33 })).toBe(21);
  });

  it('falls back to the minimum rather than passing NaN across the bridge', () => {
    expect(clampToRange(Number.NaN, { min: 11, max: 33 })).toBe(11);
    expect(clampToRange(Number.POSITIVE_INFINITY, { min: 11, max: 33 })).toBe(11);
  });
});

describe('draftFromDefaults', () => {
  it('takes every value from the fetched defaults', () => {
    const draft = draftFromDefaults(LIMITS.defaults);
    expect(draft.mode).toBe('random');
    expect(draft.random).toEqual(LIMITS.defaults.random);
    expect(draft.passphrase).toEqual(LIMITS.defaults.passphrase);
    expect(draft.pronounceable).toEqual(LIMITS.defaults.pronounceable);
    expect(draft.pin).toEqual(LIMITS.defaults.pin);
  });

  it('copies rather than aliasing, so editing one mode cannot mutate the fetched defaults', () => {
    const draft = draftFromDefaults(LIMITS.defaults);
    expect(draft.random).not.toBe(LIMITS.defaults.random);
    expect(draft.pin).not.toBe(LIMITS.defaults.pin);
  });
});

describe('optionsFromDraft', () => {
  it('sends the mode the draft is showing, and only that mode’s settings', () => {
    for (const mode of GENERATOR_MODES) {
      const options = optionsFromDraft(
        { ...draftFromDefaults(LIMITS.defaults), mode },
        LIMITS.limits
      );
      expect(options.mode).toBe(mode);
    }
  });

  it('clamps every numeric option to the bound the engine reported', () => {
    const draft = draftFromDefaults(LIMITS.defaults);

    // Every default sits outside the invented bounds above, so an unclamped implementation
    // would send the default straight through — 20, 6, 16, 4 rather than the four maxima.
    const random = optionsFromDraft({ ...draft, mode: 'random' }, LIMITS.limits);
    expect(random).toMatchObject({ mode: 'random', length: LIMITS.limits.randomLength.max });

    const tooLong = optionsFromDraft(
      { ...draft, mode: 'random', random: { ...draft.random, length: 900 } },
      LIMITS.limits
    );
    expect(tooLong).toMatchObject({ length: LIMITS.limits.randomLength.max });

    const words = optionsFromDraft({ ...draft, mode: 'passphrase' }, LIMITS.limits);
    expect(words).toMatchObject({ wordCount: LIMITS.limits.passphraseWords.max });

    const pronounceable = optionsFromDraft({ ...draft, mode: 'pronounceable' }, LIMITS.limits);
    expect(pronounceable).toMatchObject({ length: LIMITS.limits.pronounceableLength.max });

    const pin = optionsFromDraft({ ...draft, mode: 'pin' }, LIMITS.limits);
    expect(pin).toMatchObject({ length: LIMITS.limits.pinLength.max });
  });

  it('carries every non-numeric setting through untouched', () => {
    const draft = draftFromDefaults(LIMITS.defaults);
    const options = optionsFromDraft(
      {
        ...draft,
        mode: 'random',
        random: {
          ...draft.random,
          lowercase: false,
          symbols: false,
          excludeAmbiguous: true,
          excludeCharacters: '<>&',
          requireEachClass: false,
        },
      },
      LIMITS.limits
    );

    expect(options).toEqual({
      mode: 'random',
      length: LIMITS.limits.randomLength.max,
      lowercase: false,
      uppercase: true,
      digits: true,
      symbols: false,
      excludeAmbiguous: true,
      excludeCharacters: '<>&',
      requireEachClass: false,
    });
  });

  it('keeps each mode’s settings while another mode is showing', () => {
    // Switching to PIN and back must not have reset the length someone just set.
    const draft = draftFromDefaults(LIMITS.defaults);
    const edited = { ...draft, random: { ...draft.random, length: 13 } };

    expect(optionsFromDraft({ ...edited, mode: 'pin' }, LIMITS.limits).mode).toBe('pin');
    expect(optionsFromDraft({ ...edited, mode: 'random' }, LIMITS.limits)).toMatchObject({
      length: 13,
    });
  });
});

describe('limitForMode', () => {
  it('resolves the bound the mode’s numeric control is drawn against', () => {
    expect(limitForMode('random', LIMITS.limits)).toEqual(LIMITS.limits.randomLength);
    expect(limitForMode('passphrase', LIMITS.limits)).toEqual(LIMITS.limits.passphraseWords);
    expect(limitForMode('pronounceable', LIMITS.limits)).toEqual(LIMITS.limits.pronounceableLength);
    expect(limitForMode('pin', LIMITS.limits)).toEqual(LIMITS.limits.pinLength);
  });
});

describe('configurationKey', () => {
  it('separates configurations that differ, and matches ones that do not', () => {
    const draft = draftFromDefaults(LIMITS.defaults);
    const first = configurationKey(optionsFromDraft(draft, LIMITS.limits));
    const same = configurationKey(optionsFromDraft({ ...draft }, LIMITS.limits));
    const other = configurationKey(
      optionsFromDraft({ ...draft, random: { ...draft.random, length: 12 } }, LIMITS.limits)
    );

    expect(same).toBe(first);
    expect(other).not.toBe(first);
  });

  it('changes when the mode changes, so a password from another mode reads as out of date', () => {
    const draft = draftFromDefaults(LIMITS.defaults);
    const modes: readonly GeneratorMode[] = GENERATOR_MODES;
    const keys = modes.map((mode) =>
      configurationKey(optionsFromDraft({ ...draft, mode }, LIMITS.limits))
    );
    expect(new Set(keys).size).toBe(modes.length);
  });
});
