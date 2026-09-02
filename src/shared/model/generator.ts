// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The shape of a password-generation request and its result.
 *
 * Lives in `@shared` because the renderer draws the generator's controls and therefore has
 * to describe a configuration; it does not live here because the renderer generates
 * anything. Generation runs in the main process only, on the CSPRNG in
 * `src/main/crypto/random.ts`, for the same reason every other secret is produced there:
 * the renderer has no business holding a source of key material.
 *
 * **`GeneratedPassword.password` is secret material.** It is the one field in this file
 * that must never be logged, persisted outside the vault, or held in renderer state beyond
 * the reveal TTL. Everything else — the mode, the entropy, the options — is safe to show,
 * store, and put in a bug report.
 *
 * Every option is optional. A partial configuration is a valid configuration; the
 * generator fills the gaps from `GENERATOR_DEFAULTS`, which is the single source of truth
 * for what "unspecified" means. Types-only by design: no Node import appears here, so this
 * file compiles unchanged in the renderer's browser build.
 */

export type GeneratorMode = 'random' | 'passphrase' | 'pronounceable' | 'pin';

/**
 * How a passphrase's words are cased.
 *
 * `none` leaves the wordlist's own lowercase; `first` capitalises the first letter of every
 * word; `all` uppercases everything. None of the three adds a single bit — the transform is
 * deterministic and the attacker knows which one was used — so this is a legibility
 * setting, and the entropy figure is deliberately unaffected by it.
 */
export type WordCapitalisation = 'none' | 'first' | 'all';

/**
 * Uniform random characters over a configured alphabet. The strongest of the four modes and
 * the default for anything a human will never have to retype.
 */
export interface RandomGeneratorOptions {
  readonly mode: 'random';
  readonly length?: number;
  readonly lowercase?: boolean;
  readonly uppercase?: boolean;
  readonly digits?: boolean;
  readonly symbols?: boolean;
  /** Drops the glyphs that get misread off a screen or a printed recovery sheet. */
  readonly excludeAmbiguous?: boolean;
  /** Extra characters to remove, for the site that rejects them. Applied before generation. */
  readonly excludeCharacters?: string;
  /** Guarantees at least one character from every enabled class. Slightly lowers entropy. */
  readonly requireEachClass?: boolean;
}

/** Diceware over the EFF large wordlist — the mode to use when a human must remember it. */
export interface PassphraseGeneratorOptions {
  readonly mode: 'passphrase';
  readonly wordCount?: number;
  readonly separator?: string;
  readonly capitalisation?: WordCapitalisation;
  /** Appends one digit to one randomly chosen word, for the site that demands a number. */
  readonly includeDigit?: boolean;
}

/**
 * Alternating consonants and vowels — memorable, and materially weaker per character than
 * `random`. The returned `entropyBits` says exactly how much weaker.
 */
export interface PronounceableGeneratorOptions {
  readonly mode: 'pronounceable';
  readonly length?: number;
  readonly digits?: boolean;
  readonly symbols?: boolean;
}

/** Digits only, for door codes, SIMs and bank telephone lines. Weak on purpose. */
export interface PinGeneratorOptions {
  readonly mode: 'pin';
  readonly length?: number;
}

export type GeneratorOptions =
  | RandomGeneratorOptions
  | PassphraseGeneratorOptions
  | PronounceableGeneratorOptions
  | PinGeneratorOptions;

export interface GeneratedPassword {
  /** Secret material. Treated like any other secret: never logged, never persisted here. */
  readonly password: string;
  /**
   * log2 of the search space the configuration actually defines — after exclusions, and
   * after any narrowing that `requireEachClass` imposes. Not an estimate of how good the
   * password looks; a statement about how many candidates an attacker must enumerate.
   */
  readonly entropyBits: number;
  readonly mode: GeneratorMode;
}

/** An inclusive integer bound, as reported to the UI so the controls cannot offer an invalid value. */
export interface GeneratorRange {
  readonly min: number;
  readonly max: number;
}

/**
 * The names of the numeric bounds the engine enforces.
 *
 * The *values* live in `src/main/generator/generator.ts`, beside the code that enforces
 * them; only the shape is declared here, because the shape is what the IPC contract and
 * the UI controls need to agree on. Declaring the values twice would be a second list.
 */
export type GeneratorLimitName =
  'randomLength' | 'passphraseWords' | 'pronounceableLength' | 'pinLength';

/** What every unspecified option means, per mode. */
export interface GeneratorDefaults {
  readonly random: Required<Omit<RandomGeneratorOptions, 'mode'>>;
  readonly passphrase: Required<Omit<PassphraseGeneratorOptions, 'mode'>>;
  readonly pronounceable: Required<Omit<PronounceableGeneratorOptions, 'mode'>>;
  readonly pin: Required<Omit<PinGeneratorOptions, 'mode'>>;
}
