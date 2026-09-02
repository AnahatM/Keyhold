// SPDX-License-Identifier: GPL-3.0-or-later
import type { GeneratorLimitsView } from '@shared/ipc/api.js';
import type {
  GeneratorDefaults,
  GeneratorLimitName,
  GeneratorMode,
  GeneratorOptions,
  GeneratorRange,
  WordCapitalisation,
} from '@shared/model/generator.js';

/**
 * The generator panel's draft, and the pure step that turns it into a request.
 *
 * ## Why the draft holds all four modes at once
 *
 * Switching from `random` to `passphrase` and back must not silently reset the length and
 * the character classes someone just set. Keeping one settled configuration per mode makes
 * the switcher a view control rather than a destructive one, and it makes this whole file
 * a pure function of "what the user has chosen" — which is the part worth testing.
 *
 * ## Where the numbers come from
 *
 * **Nowhere in this folder.** Every bound and every default arrives from
 * `generator.limits()`, which reports the engine's own `GENERATOR_LIMITS` and
 * `GENERATOR_DEFAULTS` across the IPC contract. A `min={8}` typed into a slider would be a
 * second list, and it would disagree with the engine the first time either changed. The
 * clamp here exists to keep a control honest against the bounds it was *given*, not to
 * restate them.
 */

/** What a mode is called, what it is for, and the caveat it must not be sold without. */
export interface ModeDetail {
  readonly label: string;
  /** One line: what this mode is for. */
  readonly summary: string;
  /**
   * The honest qualification, or `null` when there is nothing to warn about.
   *
   * Written from `docs/05-Features/00-Password-Generator.md` and deliberately not softened:
   * pronounceable really is worth about half of `random` per character, and a PIN really is
   * weak by construction. A generator that flatters its own weaker modes is not one to
   * trust about its stronger ones.
   */
  readonly caveat: string | null;
  /** Which fetched limit governs this mode's numeric control. */
  readonly limit: GeneratorLimitName;
  /** The noun the numeric control counts, for its spoken value. */
  readonly unit: string;
}

/**
 * A `Record` rather than an array, so adding a mode to `GeneratorMode` fails to compile
 * here until it has a label, a summary and a limit. A missing entry would otherwise render
 * as an unlabelled button that produces nothing.
 */
export const MODE_DETAILS = {
  random: {
    label: 'Random',
    summary:
      'Uniform random characters. The strongest option, and the right default for a password you will paste rather than type.',
    caveat: null,
    limit: 'randomLength',
    unit: 'characters',
  },
  passphrase: {
    label: 'Passphrase',
    summary:
      'Words drawn from the EFF large wordlist — the mode to use when a person has to remember it or read it aloud.',
    caveat:
      'Capitalisation adds nothing to the entropy figure: the transform is deterministic and an attacker knows which one was used.',
    limit: 'passphraseWords',
    unit: 'words',
  },
  pronounceable: {
    label: 'Pronounceable',
    summary: 'Alternating consonants and vowels, so it can be spoken or typed on a games console.',
    caveat:
      'Materially weaker per character than Random — roughly half. Sixteen characters here are worth about nine random ones. Any digits and the symbol are appended at fixed positions and are counted as worth nothing.',
    limit: 'pronounceableLength',
    unit: 'characters',
  },
  pin: {
    label: 'PIN',
    summary: 'Digits only, for door codes, SIMs and telephone banking.',
    caveat:
      'Weak on purpose. Ten possibilities per digit is a search any machine finishes instantly, so use this only where a longer secret is not accepted.',
    limit: 'pinLength',
    unit: 'digits',
  },
} as const satisfies Record<GeneratorMode, ModeDetail>;

/**
 * The order the switcher shows the modes in — strongest first.
 *
 * Separate from `MODE_DETAILS` because a `Record` carries completeness but not intent about
 * order. A test asserts the two agree, so a mode cannot be added to one and forgotten in
 * the other.
 */
export const GENERATOR_MODES = [
  'random',
  'passphrase',
  'pronounceable',
  'pin',
] as const satisfies readonly GeneratorMode[];

/**
 * The word-casing choices, labelled by example rather than by name.
 *
 * "Capitalised" is clearer as `Capitalised` than as `first`, and showing the shape of the
 * output is the fastest way to say what the setting does. Same `Record` + ordered-array
 * pairing as the modes, guarded by the same test.
 */
export const CAPITALISATION_LABELS = {
  none: 'lowercase',
  first: 'Capitalised',
  all: 'UPPERCASE',
} as const satisfies Record<WordCapitalisation, string>;

export const CAPITALISATIONS = [
  'none',
  'first',
  'all',
] as const satisfies readonly WordCapitalisation[];

/**
 * One settled configuration per mode, plus which one is showing.
 *
 * Extends `GeneratorDefaults` rather than restating its four members: the defaults the main
 * process sends *are* the shape of a complete draft, so the type cannot drift from what
 * arrives over the bridge.
 */
export interface GeneratorDraft extends GeneratorDefaults {
  readonly mode: GeneratorMode;
}

export function draftFromDefaults(
  defaults: GeneratorDefaults,
  mode: GeneratorMode = 'random'
): GeneratorDraft {
  return {
    mode,
    random: { ...defaults.random },
    passphrase: { ...defaults.passphrase },
    pronounceable: { ...defaults.pronounceable },
    pin: { ...defaults.pin },
  };
}

/**
 * Holds a value inside a bound that came from the engine.
 *
 * Rounds as well as clamps, because a range input reports a string and a stored draft can
 * outlive a limit change — a fractional length reaches code in the engine that loops
 * `while (i < length)`.
 */
export function clampToRange(value: number, range: GeneratorRange): number {
  if (!Number.isFinite(value)) return range.min;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/** The limit that governs a mode's numeric control. */
export function limitForMode(
  mode: GeneratorMode,
  limits: GeneratorLimitsView['limits']
): GeneratorRange {
  return limits[MODE_DETAILS[mode].limit];
}

/**
 * The draft, as the request the engine will be sent.
 *
 * Every option is passed explicitly rather than omitted-to-default: the panel shows the
 * user a value for each one, so sending a partial configuration would mean the screen and
 * the request could describe different things.
 */
export function optionsFromDraft(
  draft: GeneratorDraft,
  limits: GeneratorLimitsView['limits']
): GeneratorOptions {
  switch (draft.mode) {
    case 'random': {
      const random = draft.random;
      return {
        mode: 'random',
        length: clampToRange(random.length, limits.randomLength),
        lowercase: random.lowercase,
        uppercase: random.uppercase,
        digits: random.digits,
        symbols: random.symbols,
        excludeAmbiguous: random.excludeAmbiguous,
        excludeCharacters: random.excludeCharacters,
        requireEachClass: random.requireEachClass,
      };
    }
    case 'passphrase': {
      const passphrase = draft.passphrase;
      return {
        mode: 'passphrase',
        wordCount: clampToRange(passphrase.wordCount, limits.passphraseWords),
        separator: passphrase.separator,
        capitalisation: passphrase.capitalisation,
        includeDigit: passphrase.includeDigit,
      };
    }
    case 'pronounceable': {
      const pronounceable = draft.pronounceable;
      return {
        mode: 'pronounceable',
        length: clampToRange(pronounceable.length, limits.pronounceableLength),
        digits: pronounceable.digits,
        symbols: pronounceable.symbols,
      };
    }
    case 'pin':
      return { mode: 'pin', length: clampToRange(draft.pin.length, limits.pinLength) };
  }
}

/**
 * A stable string for a configuration, used to tell one from another.
 *
 * Two jobs: it is the dependency an estimate is debounced against, and it is what marks a
 * password on screen as having been made with settings the user has since changed. Safe to
 * keep and compare — a configuration is metadata, never secret material.
 */
export function configurationKey(options: GeneratorOptions): string {
  return JSON.stringify(options);
}
