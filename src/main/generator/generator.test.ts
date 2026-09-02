// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  AMBIGUOUS_CHARACTERS,
  DIGIT_CHARACTERS,
  estimateEntropyBits,
  generatePassword,
  GeneratorConfigurationError,
  LOWERCASE_CHARACTERS,
  SYMBOL_CHARACTERS,
  UPPERCASE_CHARACTERS,
} from './generator.js';
import { EFF_LARGE_WORDLIST } from './wordlist.js';

/**
 * Tests for the password generator.
 *
 * A generator fails silently or not at all. Nothing about `Kj4$mQ2..` tells you that the
 * shuffle was dropped, that an exclusion was applied to the output instead of the alphabet,
 * or that the entropy number is describing a different alphabet than the one that produced
 * it. So the tests here are aimed at the defects that leave the output *looking* correct.
 *
 * Several are probabilistic by necessity. Where that is true the margins are set at five
 * sigma or wider, so a passing suite is not luck and a failing one is not noise.
 *
 * Fault injections performed on these guards, per the testing policy — every one of them
 * run against this file before any of it was trusted:
 *
 * | Guard                                    | Defect injected                                                    | Result                                                                    |
 * | ---------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
 * | "does not concentrate the required …"    | `shuffleInPlace` dropped from `buildRandom` — naive front-loading   | Caught: `expected 0 to be greater than 90.42` (position 0 never a digit)   |
 * | "never emits an excluded character"      | Exclusions never applied to the class alphabets                     | Caught: `expected ':[DqH=_X<E245+(ZJ\|08nt16' not to contain '1'`          |
 * | "is exactly the requested length"        | Exclusions applied to the finished password instead of the alphabet | Caught: `expected 'C~R7Ts' to have a length of 8 but got 6`               |
 * | "refuses a configuration that empties …" | Emptied class silently filtered out instead of throwing             | Caught: `expected function to throw an error, but it didn't`              |
 * | "injects exactly one digit, and not …"   | Passphrase digit always appended to the first word                  | Caught: `expected 1 to be 4`                                              |
 * | "reflects the alphabet left after …"     | Entropy computed from the nominal alphabet, ignoring exclusions     | Caught: `expected 75.207… to be close to 70.277…`                         |
 *
 * **One injection found a gap worth recording.** Applying the exclusions to the finished
 * password rather than to the alphabet — the single most likely way to get this wrong — does
 * *not* fail "never emits an excluded character", because stripping the characters afterwards
 * genuinely does remove them. It fails on the length assertion instead. That is the reason
 * "is exactly the requested length" exists as a guard in its own right rather than as an
 * obvious property nobody would break: it is the only test in this file that catches that
 * defect.
 */

const ALL_CLASSES = {
  mode: 'random',
  lowercase: true,
  uppercase: true,
  digits: true,
  symbols: true,
} as const;

function countMatching(text: string, alphabet: string): number {
  return Array.from(text).filter((character) => alphabet.includes(character)).length;
}

describe('wordlist', () => {
  /**
   * The list is fetched once, by hand, and then frozen into source. Every property that
   * makes it worth using is asserted here, because a truncated download, a stray editor
   * "cleanup", or a de-duplicating refactor would all leave a list that still generates
   * plausible passphrases at a fraction of the advertised strength — 7,000 words instead of
   * 7,776 is a silent 0.15 bits per word, and nothing else in the system would notice.
   */
  it('is the EFF large wordlist, intact', () => {
    expect(EFF_LARGE_WORDLIST).toHaveLength(7776);
    expect(new Set(EFF_LARGE_WORDLIST).size).toBe(7776);

    // The four hyphenated entries are the genuine list, not a mangling. Pinning them by
    // name means a future normalisation pass has to be a deliberate decision rather than
    // an accident nobody reviews.
    const hyphenated = EFF_LARGE_WORDLIST.filter((word) => word.includes('-'));
    expect(hyphenated).toEqual(['drop-down', 'felt-tip', 't-shirt', 'yo-yo']);
    for (const word of EFF_LARGE_WORDLIST) {
      expect(word).toMatch(/^[a-z]+(-[a-z]+)?$/);
    }

    // Prefix-freedom is what lets a passphrase survive losing its separators. It is a
    // property of EFF's curation, so it is asserted rather than assumed.
    const words = new Set(EFF_LARGE_WORDLIST);
    for (const word of EFF_LARGE_WORDLIST) {
      for (let cut = 1; cut < word.length; cut += 1) {
        expect(words.has(word.slice(0, cut))).toBe(false);
      }
    }
  });
});

describe('random mode', () => {
  it('includes every enabled class when requireEachClass is on', () => {
    // Length 8 is the tightest case the bounds allow: four guaranteed characters and four
    // free ones. Probabilistic, so it runs many times rather than once.
    for (let i = 0; i < 400; i += 1) {
      const { password } = generatePassword({ ...ALL_CLASSES, length: 8, requireEachClass: true });
      expect(countMatching(password, LOWERCASE_CHARACTERS)).toBeGreaterThan(0);
      expect(countMatching(password, UPPERCASE_CHARACTERS)).toBeGreaterThan(0);
      expect(countMatching(password, DIGIT_CHARACTERS)).toBeGreaterThan(0);
      expect(countMatching(password, SYMBOL_CHARACTERS)).toBeGreaterThan(0);
    }
  });

  /**
   * **The anti-bias guard, and the most important test in this file.**
   *
   * The obvious `requireEachClass` implementation pushes one character per class onto the
   * front of the array and fills the rest, so the guaranteed digit lands at a fixed index in
   * every password it ever produces. The output still contains a digit, still has the right
   * length, still passes every other test here — and an attacker who knows the settings gets
   * a per-position alphabet of 10 instead of 27 at that index.
   *
   * The configuration is chosen to make the defect unmissable: excluding nine of the ten
   * digits leaves a digit class of size one, so a digit appearing at a position is
   * overwhelmingly the *guaranteed* digit rather than a freely drawn one. Under a correct
   * shuffle the guaranteed character is uniform over the 20 positions; under the naive
   * implementation one position holds it every single time.
   *
   * The ±45% band is roughly six standard deviations at this sample size, so a false
   * failure is not a realistic concern, while the defect overshoots the band by an order
   * of magnitude.
   */
  it('does not concentrate the required characters at the start', () => {
    const SAMPLES = 2000;
    const LENGTH = 20;
    const digitsAtPosition = new Array<number>(LENGTH).fill(0);

    for (let i = 0; i < SAMPLES; i += 1) {
      const { password } = generatePassword({
        mode: 'random',
        length: LENGTH,
        lowercase: true,
        uppercase: false,
        digits: true,
        symbols: false,
        excludeCharacters: '012345689',
        requireEachClass: true,
      });
      Array.from(password).forEach((character, index) => {
        if (DIGIT_CHARACTERS.includes(character)) {
          digitsAtPosition[index] = (digitsAtPosition[index] ?? 0) + 1;
        }
      });
    }

    // Measured against the observed total rather than a modelled one, so the assertion is
    // about *uniformity across positions* and not about the expected digit count.
    const total = digitsAtPosition.reduce((sum, count) => sum + count, 0);
    const mean = total / LENGTH;
    expect(mean).toBeGreaterThan(100);

    for (const count of digitsAtPosition) {
      expect(count).toBeGreaterThan(mean * 0.55);
      expect(count).toBeLessThan(mean * 1.45);
    }
  });

  /**
   * Exclusions have to shrink the alphabet, not the output. A generator that draws from the
   * full alphabet and strips the unwanted characters afterwards produces a password that is
   * both shorter than requested and weaker than reported, and looks entirely normal.
   */
  it('never emits an excluded character', () => {
    const custom = '$%^&aeiouZ';
    const forbidden = Array.from(AMBIGUOUS_CHARACTERS + custom);
    for (let i = 0; i < 500; i += 1) {
      const { password } = generatePassword({
        ...ALL_CLASSES,
        length: 24,
        excludeAmbiguous: true,
        excludeCharacters: custom,
        requireEachClass: true,
      });
      for (const character of forbidden) {
        expect(password).not.toContain(character);
      }
    }
  });

  it('is exactly the requested length', () => {
    for (const length of [8, 13, 20, 64, 256]) {
      for (const requireEachClass of [true, false]) {
        const { password } = generatePassword({
          ...ALL_CLASSES,
          length,
          requireEachClass,
          excludeAmbiguous: true,
          excludeCharacters: 'aeiouAEIOU2468!@#$',
        });
        expect(password).toHaveLength(length);
      }
    }
  });

  it('refuses a configuration that empties a class rather than weakening the password', () => {
    // Digits are on and every digit is excluded. Dropping the class silently would produce
    // a password that satisfies neither the settings nor the entropy figure shown beside it.
    const impossible = {
      ...ALL_CLASSES,
      length: 20,
      excludeCharacters: DIGIT_CHARACTERS,
    } as const;
    expect(() => generatePassword(impossible)).toThrow(GeneratorConfigurationError);
    expect(() => generatePassword(impossible)).toThrow(/digits/);
    // The estimate must refuse the same configurations the generator refuses; a UI that
    // could price a password it cannot produce is worse than one that cannot price it.
    expect(() => estimateEntropyBits(impossible)).toThrow(GeneratorConfigurationError);

    expect(() =>
      generatePassword({
        mode: 'random',
        lowercase: false,
        uppercase: false,
        digits: false,
        symbols: false,
      })
    ).toThrow(GeneratorConfigurationError);

    expect(() => generatePassword({ mode: 'random', length: 4 })).toThrow(
      GeneratorConfigurationError
    );
  });
});

describe('passphrase mode', () => {
  it('produces the requested words, separator and capitalisation', () => {
    // The separator is a full stop, not the default hyphen: four entries in the EFF list are
    // themselves hyphenated, so splitting on '-' would not recover the words.
    const { password } = generatePassword({ mode: 'passphrase', wordCount: 5, separator: '.' });
    const words = password.split('.');
    expect(words).toHaveLength(5);
    const list = new Set(EFF_LARGE_WORDLIST);
    for (const word of words) expect(list.has(word)).toBe(true);

    const multiCharacter = generatePassword({
      mode: 'passphrase',
      wordCount: 4,
      separator: '::',
    }).password;
    expect(multiCharacter.split('::')).toHaveLength(4);

    const first = generatePassword({
      mode: 'passphrase',
      wordCount: 4,
      separator: '.',
      capitalisation: 'first',
    }).password;
    for (const word of first.split('.')) expect(word).toMatch(/^[A-Z][a-z-]*$/);

    const all = generatePassword({
      mode: 'passphrase',
      wordCount: 4,
      separator: '.',
      capitalisation: 'all',
    }).password;
    expect(all).toBe(all.toUpperCase());
  });

  /**
   * Digit injection has the same positional trap as `requireEachClass`: appending to the
   * first word every time is invisible in a single sample and removes the log2(wordCount)
   * the entropy figure claims for it.
   */
  it('injects exactly one digit, and not always onto the same word', () => {
    const seenPositions = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      const { password } = generatePassword({
        mode: 'passphrase',
        wordCount: 4,
        separator: '.',
        includeDigit: true,
      });
      const words = password.split('.');
      expect(countMatching(password, DIGIT_CHARACTERS)).toBe(1);
      words.forEach((word, index) => {
        if (countMatching(word, DIGIT_CHARACTERS) > 0) seenPositions.add(index);
      });
    }
    // Four positions, 200 draws: missing one has probability (3/4)^200, which is zero for
    // every practical purpose. Anything less than all four is a fixed-position bug.
    expect(seenPositions.size).toBe(4);
  });
});

describe('pronounceable and pin modes', () => {
  it('alternates consonants and vowels, then appends the extras', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(generatePassword({ mode: 'pronounceable', length: 12 }).password).toMatch(
        /^([bcdfghjklmnprstvwz][aeiou]){6}$/
      );
      // Length stays exact once digits and a symbol take three of the fifteen characters.
      expect(
        generatePassword({ mode: 'pronounceable', length: 15, digits: true, symbols: true })
          .password
      ).toMatch(/^([bcdfghjklmnprstvwz][aeiou]){6}\d{2}[^a-zA-Z0-9]$/);
    }
  });

  it('generates PINs of digits only', () => {
    for (const length of [4, 6, 32]) {
      expect(generatePassword({ mode: 'pin', length }).password).toMatch(
        new RegExp(`^\\d{${length}}$`)
      );
    }
    expect(() => generatePassword({ mode: 'pin', length: 3 })).toThrow(GeneratorConfigurationError);
  });
});

describe('entropy', () => {
  /**
   * The figure is the product Keyhold actually sells — "this password is worth N bits" is a
   * claim, and a wrong one is worse than none. These are checked against arithmetic done
   * independently of the implementation, including one literal, so a change of base or a
   * mis-sized alphabet cannot pass.
   */
  it('matches the arithmetic for known configurations', () => {
    const lowerAndDigits = estimateEntropyBits({
      mode: 'random',
      length: 16,
      lowercase: true,
      uppercase: false,
      digits: true,
      symbols: false,
      requireEachClass: false,
    });
    expect(lowerAndDigits).toBeCloseTo(16 * Math.log2(36), 10);
    expect(lowerAndDigits).toBeCloseTo(82.72, 2);

    expect(estimateEntropyBits({ mode: 'passphrase', wordCount: 4 })).toBeCloseTo(51.7, 1);
    expect(estimateEntropyBits({ mode: 'passphrase', wordCount: 6 })).toBeCloseTo(
      6 * Math.log2(7776),
      10
    );
    expect(estimateEntropyBits({ mode: 'pin', length: 6 })).toBeCloseTo(6 * Math.log2(10), 10);

    // 18 consonants and 5 vowels in strict alternation: worth roughly half a random
    // password of the same length, which is the trade this mode exists to make.
    const pronounceable = estimateEntropyBits({ mode: 'pronounceable', length: 16 });
    expect(pronounceable).toBeCloseTo(8 * Math.log2(18) + 8 * Math.log2(5), 10);
    expect(pronounceable).toBeLessThan(0.6 * estimateEntropyBits({ ...ALL_CLASSES, length: 16 }));
  });

  it('reflects the alphabet left after exclusions, not the nominal one', () => {
    // Twenty-one letters remain once the vowels are excluded. Reporting 16 × log2(26) here
    // would overstate the password by more than three bits.
    expect(
      estimateEntropyBits({
        mode: 'random',
        length: 16,
        lowercase: true,
        uppercase: false,
        digits: false,
        symbols: false,
        excludeCharacters: 'aeiou',
        requireEachClass: false,
      })
    ).toBeCloseTo(16 * Math.log2(21), 10);
  });

  /**
   * `requireEachClass` narrows the search space, so it must cost bits rather than earn them.
   * The cost is small — a fraction of a bit at any sensible length — but a sign error here
   * would be a generator advertising a *stronger* password for a weaker guarantee.
   */
  it('charges for the requireEachClass constraint instead of ignoring it', () => {
    const free = estimateEntropyBits({ ...ALL_CLASSES, length: 20, requireEachClass: false });
    const constrained = estimateEntropyBits({ ...ALL_CLASSES, length: 20, requireEachClass: true });
    expect(constrained).toBeLessThan(free);
    expect(free - constrained).toBeLessThan(0.5);
  });

  it('reports the same figure it generated with', () => {
    const options = { ...ALL_CLASSES, length: 32, excludeAmbiguous: true } as const;
    const result = generatePassword(options);
    expect(result.mode).toBe('random');
    expect(result.entropyBits).toBe(estimateEntropyBits(options));
  });
});
