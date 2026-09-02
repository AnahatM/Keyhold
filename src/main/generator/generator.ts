// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  GeneratedPassword,
  GeneratorMode,
  GeneratorOptions,
  GeneratorDefaults,
  GeneratorLimitName,
  GeneratorRange,
  PassphraseGeneratorOptions,
  PinGeneratorOptions,
  PronounceableGeneratorOptions,
  RandomGeneratorOptions,
  WordCapitalisation,
} from '@shared/model/generator.js';
import { randomChoice, randomInt, shuffleInPlace } from '../crypto/random.js';
import { EFF_LARGE_WORDLIST } from './wordlist.js';

/**
 * The password generator.
 *
 * Four modes, one CSPRNG, and one number that has to be true. Everything here exists to
 * protect that last part: the entropy figure Keyhold shows is the entropy of the search
 * space the configuration actually defines, not of the one it nominally describes.
 *
 * Three things follow from that, and they are the reason this file is not thirty lines:
 *
 *  - **Exclusions are applied to the alphabet before generation, never to the output
 *    afterwards.** Filtering afterwards silently shortens the password, which is both a
 *    broken promise about length and a quiet loss of entropy no one measures.
 *
 *  - **`requireEachClass` shuffles.** The obvious implementation places one character per
 *    class at the front and fills the rest, which makes position 0 a lowercase letter and
 *    position 3 a symbol in every password it ever produces. That is not a cosmetic
 *    complaint: it hands an attacker a per-position alphabet far smaller than the full one.
 *
 *  - **`requireEachClass` also *costs* entropy, and the figure says so.** Constraining the
 *    output to strings containing every class removes candidates from the space. The
 *    reduction is tiny at realistic lengths and it is still subtracted, because a generator
 *    that rounds its own guarantees in its own favour is not one to trust.
 *
 * `estimateEntropyBits` and `generatePassword` share one planning step, so the number
 * reported and the password produced can never be describing different configurations.
 */

/** Inclusive bounds for every numeric option. The UI clamps to these; the generator enforces them. */
export const GENERATOR_LIMITS = {
  randomLength: { min: 8, max: 256 },
  passphraseWords: { min: 3, max: 20 },
  pronounceableLength: { min: 8, max: 256 },
  pinLength: { min: 4, max: 32 },
} as const satisfies Readonly<Record<GeneratorLimitName, GeneratorRange>>;

/**
 * What every unspecified option means.
 *
 * Twenty characters with all four classes is well past anything a credible attacker reaches
 * offline, and six EFF words (≈77.5 bits) is the memorable equivalent. Both defaults assume
 * the password is going into the vault and will be pasted, not typed.
 */
export const GENERATOR_DEFAULTS = {
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
  passphrase: {
    wordCount: 6,
    separator: '-',
    capitalisation: 'none',
    includeDigit: false,
  },
  pronounceable: { length: 16, digits: false, symbols: false },
  pin: { length: 6 },
} as const satisfies GeneratorDefaults;

export const LOWERCASE_CHARACTERS = 'abcdefghijklmnopqrstuvwxyz';
export const UPPERCASE_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const DIGIT_CHARACTERS = '0123456789';

/**
 * The symbol alphabet.
 *
 * Deliberately excludes the space, the backslash, the backtick and both quote marks. Those
 * five are the ones that turn a working password into a support ticket: they get eaten by
 * shells, mangled by CSV exports, and rejected by a long tail of login forms. Twenty-eight
 * symbols still buy 6.55 bits per character, so nothing meaningful is given up.
 */
export const SYMBOL_CHARACTERS = '!@#$%^&*()-_=+[]{}<>?,.;:/|~';

/**
 * Glyphs that get misread rather than mistyped.
 *
 * `l`/`I`/`1`/`|` and `O`/`0`/`o` are the pairs that actually cost people an evening when a
 * password is read off a screen, dictated over a phone, or copied from a printed recovery
 * sheet. Removing them is a real entropy loss — seven characters out of ninety — and it is
 * priced into the reported figure rather than waved away.
 */
export const AMBIGUOUS_CHARACTERS = 'Il1|O0o';

/**
 * The consonants and vowels used by pronounceable mode.
 *
 * `q`, `x` and `y` are dropped: strict alternation happily produces `qixuqy`, which is
 * neither pronounceable nor memorable and therefore fails the only thing this mode is for.
 */
const PRONOUNCEABLE_CONSONANTS = 'bcdfghjklmnprstvwz';
const PRONOUNCEABLE_VOWELS = 'aeiou';

/** How many digits and symbols pronounceable mode appends when they are switched on. */
const PRONOUNCEABLE_DIGIT_COUNT = 2;
const PRONOUNCEABLE_SYMBOL_COUNT = 1;

/** Below this, alternation stops producing anything a person would call a word. */
const MINIMUM_PRONOUNCEABLE_LETTERS = 4;

/**
 * The alphabets above are written as strings because that is how a human reads and reviews
 * them; the draw helpers want arrays. `Array.from` rather than a spread or `.split('')`
 * because both of those mishandle characters outside the BMP — irrelevant for these
 * constants, but `excludeCharacters` is arbitrary user input and gets the same treatment,
 * so a pasted emoji cannot desynchronise the exclusion set from the alphabet it filters.
 */
function toCharacters(source: string): readonly string[] {
  return Array.from(source);
}

// Split once here rather than on every character of a 256-character password.
const DIGIT_LIST = toCharacters(DIGIT_CHARACTERS);
const SYMBOL_LIST = toCharacters(SYMBOL_CHARACTERS);
const CONSONANT_LIST = toCharacters(PRONOUNCEABLE_CONSONANTS);
const VOWEL_LIST = toCharacters(PRONOUNCEABLE_VOWELS);

/**
 * A configuration that cannot produce what it promises.
 *
 * Every one of these is a refusal rather than a downgrade. The failure mode this class
 * exists to prevent is a generator that quietly hands back a weaker password than the
 * settings claim — an over-restrictive exclusion list silently dropping a character class
 * is invisible in the output and invisible in the entropy number, which is exactly the kind
 * of defect nobody finds.
 */
export class GeneratorConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeneratorConfigurationError';
  }
}

function requireInRange(value: number, range: GeneratorRange, label: string): number {
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw new GeneratorConfigurationError(
      `${label} must be a whole number from ${range.min} to ${range.max}, but was ${value}.`
    );
  }
  return value;
}

/**
 * One enabled character class, after exclusions.
 *
 * The name is carried so a refusal can say *which* class was emptied. It never carries the
 * excluded characters themselves — not because they are secret, but because an error
 * message that echoes user input back is a habit worth not having in this codebase.
 */
interface ResolvedClass {
  readonly name: string;
  readonly characters: readonly string[];
}

interface ResolvedRandom {
  readonly length: number;
  readonly classes: readonly ResolvedClass[];
  readonly alphabet: readonly string[];
  readonly requireEachClass: boolean;
}

function resolveRandom(options: RandomGeneratorOptions): ResolvedRandom {
  const defaults = GENERATOR_DEFAULTS.random;
  const length = requireInRange(
    options.length ?? defaults.length,
    GENERATOR_LIMITS.randomLength,
    'Password length'
  );

  // Both exclusion sources are folded into one set and applied to the class alphabets
  // *before* anything is drawn. This is the whole reason exclusions cannot change the
  // length or quietly diverge from the entropy figure.
  const excluded = new Set<string>(
    toCharacters(
      ((options.excludeAmbiguous ?? defaults.excludeAmbiguous) ? AMBIGUOUS_CHARACTERS : '') +
        (options.excludeCharacters ?? defaults.excludeCharacters)
    )
  );

  const requested: { name: string; source: string }[] = [];
  if (options.lowercase ?? defaults.lowercase) {
    requested.push({ name: 'lowercase letters', source: LOWERCASE_CHARACTERS });
  }
  if (options.uppercase ?? defaults.uppercase) {
    requested.push({ name: 'uppercase letters', source: UPPERCASE_CHARACTERS });
  }
  if (options.digits ?? defaults.digits) {
    requested.push({ name: 'digits', source: DIGIT_CHARACTERS });
  }
  if (options.symbols ?? defaults.symbols) {
    requested.push({ name: 'symbols', source: SYMBOL_CHARACTERS });
  }

  if (requested.length === 0) {
    throw new GeneratorConfigurationError(
      'Random passwords need at least one character class. Enable lowercase, uppercase, digits or symbols.'
    );
  }

  const classes = requested.map(({ name, source }): ResolvedClass => {
    const characters = toCharacters(source).filter((character) => !excluded.has(character));
    if (characters.length === 0) {
      throw new GeneratorConfigurationError(
        `The exclusions remove every one of the ${name}, so that class could not appear at all. Allow at least one, or turn the class off.`
      );
    }
    return { name, characters };
  });

  const requireEachClass = options.requireEachClass ?? defaults.requireEachClass;
  if (requireEachClass && length < classes.length) {
    throw new GeneratorConfigurationError(
      `A ${length}-character password cannot contain one of each of ${classes.length} classes. Lengthen it, or turn off "require each class".`
    );
  }

  // The four classes are disjoint, so concatenating them is the alphabet with no duplicate
  // characters — which matters, because a duplicate would inflate log2(alphabet.length).
  return { length, classes, alphabet: classes.flatMap((c) => c.characters), requireEachClass };
}

/**
 * log2 of the fraction of the unconstrained space that `requireEachClass` leaves standing.
 *
 * Inclusion-exclusion over the enabled classes: subtract the strings missing class A, and
 * those missing B, then add back the ones missing both, and so on. Returns 0 bits — no
 * correction — when nothing is required.
 *
 * This is an upper bound on the entropy of what is actually sampled, not an identity. The
 * place-and-shuffle draw is supported on exactly this constrained set but is not perfectly
 * uniform over it, so the true figure is a hair lower still. Stating the bound is honest;
 * stating the unconstrained number would not be, and the gap here is measured in
 * hundredths of a bit at any length a person would use.
 */
function requireEachClassBits(resolved: ResolvedRandom): number {
  const classCount = resolved.classes.length;
  if (!resolved.requireEachClass || classCount <= 1) return 0;

  const alphabetSize = resolved.alphabet.length;
  let survivingFraction = 0;

  for (let subset = 0; subset < 1 << classCount; subset += 1) {
    let removed = 0;
    let members = 0;
    for (const [index, characterClass] of resolved.classes.entries()) {
      if ((subset & (1 << index)) !== 0) {
        removed += characterClass.characters.length;
        members += 1;
      }
    }
    const sign = members % 2 === 0 ? 1 : -1;
    survivingFraction += sign * ((alphabetSize - removed) / alphabetSize) ** resolved.length;
  }

  if (survivingFraction <= 0) {
    throw new GeneratorConfigurationError(
      'No password of this length can contain every required character class.'
    );
  }
  return Math.log2(survivingFraction);
}

function randomEntropyBits(resolved: ResolvedRandom): number {
  return resolved.length * Math.log2(resolved.alphabet.length) + requireEachClassBits(resolved);
}

function buildRandom(resolved: ResolvedRandom): string {
  const characters: string[] = [];

  // One guaranteed character per class first, then the free positions. Placing them here
  // and shuffling afterwards is the point: the naive version leaves them at indices
  // 0..classes.length-1 in every password it produces.
  if (resolved.requireEachClass) {
    for (const characterClass of resolved.classes) {
      characters.push(randomChoice(characterClass.characters));
    }
  }
  while (characters.length < resolved.length) {
    characters.push(randomChoice(resolved.alphabet));
  }

  return shuffleInPlace(characters).join('');
}

interface ResolvedPassphrase {
  readonly wordCount: number;
  readonly separator: string;
  readonly capitalisation: WordCapitalisation;
  readonly includeDigit: boolean;
}

function resolvePassphrase(options: PassphraseGeneratorOptions): ResolvedPassphrase {
  const defaults = GENERATOR_DEFAULTS.passphrase;
  return {
    wordCount: requireInRange(
      options.wordCount ?? defaults.wordCount,
      GENERATOR_LIMITS.passphraseWords,
      'Word count'
    ),
    separator: options.separator ?? defaults.separator,
    capitalisation: options.capitalisation ?? defaults.capitalisation,
    includeDigit: options.includeDigit ?? defaults.includeDigit,
  };
}

/**
 * Diceware entropy, straight from the list size — 12.925 bits a word, so four words is 51.7
 * and six is 77.5.
 *
 * Capitalisation contributes nothing and is not counted: the transform is deterministic and
 * public. Digit injection contributes `log2(10 × wordCount)` because both the digit and the
 * word it lands on are chosen at random and both are visible in the output.
 */
function passphraseEntropyBits(resolved: ResolvedPassphrase): number {
  const wordBits = resolved.wordCount * Math.log2(EFF_LARGE_WORDLIST.length);
  const digitBits = resolved.includeDigit
    ? Math.log2(DIGIT_CHARACTERS.length * resolved.wordCount)
    : 0;
  return wordBits + digitBits;
}

function capitalise(word: string, style: WordCapitalisation): string {
  switch (style) {
    case 'none':
      return word;
    case 'first':
      return word.charAt(0).toUpperCase() + word.slice(1);
    case 'all':
      return word.toUpperCase();
  }
}

function buildPassphrase(resolved: ResolvedPassphrase): string {
  // Which word receives the digit is drawn up front so it is one uniform choice over the
  // word positions, and so no word ever gets two.
  const digitTarget = resolved.includeDigit ? randomInt(resolved.wordCount) : -1;

  const words: string[] = [];
  for (let i = 0; i < resolved.wordCount; i += 1) {
    let word = capitalise(randomChoice(EFF_LARGE_WORDLIST), resolved.capitalisation);
    if (i === digitTarget) word += randomChoice(DIGIT_LIST);
    words.push(word);
  }

  return words.join(resolved.separator);
}

interface ResolvedPronounceable {
  readonly letterCount: number;
  readonly digitCount: number;
  readonly symbolCount: number;
}

function resolvePronounceable(options: PronounceableGeneratorOptions): ResolvedPronounceable {
  const defaults = GENERATOR_DEFAULTS.pronounceable;
  const length = requireInRange(
    options.length ?? defaults.length,
    GENERATOR_LIMITS.pronounceableLength,
    'Password length'
  );

  const digitCount = (options.digits ?? defaults.digits) ? PRONOUNCEABLE_DIGIT_COUNT : 0;
  const symbolCount = (options.symbols ?? defaults.symbols) ? PRONOUNCEABLE_SYMBOL_COUNT : 0;
  const letterCount = length - digitCount - symbolCount;

  if (letterCount < MINIMUM_PRONOUNCEABLE_LETTERS) {
    throw new GeneratorConfigurationError(
      `A pronounceable password needs at least ${MINIMUM_PRONOUNCEABLE_LETTERS} letters, and this configuration leaves ${letterCount}. Lengthen it, or turn off digits or symbols.`
    );
  }
  return { letterCount, digitCount, symbolCount };
}

/**
 * Pronounceable entropy, reported honestly because it is the weak one.
 *
 * **This mode trades entropy for memorability, and the trade is steep.** Alternation fixes
 * which positions may hold a consonant and which a vowel, so each pair of characters is
 * worth log2(18) + log2(5) ≈ 6.49 bits — about 3.25 bits per character against 5.95 for
 * lowercase-plus-digits and 6.55 for the full random alphabet. A sixteen-character
 * pronounceable password is roughly as strong as a nine-character random one.
 *
 * The digits and the symbol are appended at a known position rather than shuffled in, which
 * is the second half of the same trade: `mekabo42!` is far easier to hold in your head than
 * `me4kab!o2`, and a fixed position contributes no entropy at all. None is claimed for it.
 *
 * Use this for a password that has to be spoken or typed on a games console. For anything
 * going into the vault, `random` costs nothing and is worth twice as much.
 */
function pronounceableEntropyBits(resolved: ResolvedPronounceable): number {
  const consonants = Math.ceil(resolved.letterCount / 2);
  const vowels = Math.floor(resolved.letterCount / 2);
  return (
    consonants * Math.log2(PRONOUNCEABLE_CONSONANTS.length) +
    vowels * Math.log2(PRONOUNCEABLE_VOWELS.length) +
    resolved.digitCount * Math.log2(DIGIT_CHARACTERS.length) +
    resolved.symbolCount * Math.log2(SYMBOL_CHARACTERS.length)
  );
}

function buildPronounceable(resolved: ResolvedPronounceable): string {
  let output = '';
  for (let i = 0; i < resolved.letterCount; i += 1) {
    output += randomChoice(i % 2 === 0 ? CONSONANT_LIST : VOWEL_LIST);
  }
  for (let i = 0; i < resolved.digitCount; i += 1) {
    output += randomChoice(DIGIT_LIST);
  }
  for (let i = 0; i < resolved.symbolCount; i += 1) {
    output += randomChoice(SYMBOL_LIST);
  }
  return output;
}

function resolvePin(options: PinGeneratorOptions): number {
  return requireInRange(
    options.length ?? GENERATOR_DEFAULTS.pin.length,
    GENERATOR_LIMITS.pinLength,
    'PIN length'
  );
}

/** One planned generation: what it will be worth, and how to produce it. */
interface GenerationPlan {
  readonly mode: GeneratorMode;
  readonly entropyBits: number;
  readonly build: () => string;
}

/**
 * The single place a configuration is validated and priced.
 *
 * Both public entry points go through here, so `estimateEntropyBits` can never report a
 * number for a configuration that `generatePassword` would reject, and neither can drift
 * from the other as the modes change.
 */
function plan(options: GeneratorOptions): GenerationPlan {
  switch (options.mode) {
    case 'random': {
      const resolved = resolveRandom(options);
      return {
        mode: 'random',
        entropyBits: randomEntropyBits(resolved),
        build: () => buildRandom(resolved),
      };
    }
    case 'passphrase': {
      const resolved = resolvePassphrase(options);
      return {
        mode: 'passphrase',
        entropyBits: passphraseEntropyBits(resolved),
        build: () => buildPassphrase(resolved),
      };
    }
    case 'pronounceable': {
      const resolved = resolvePronounceable(options);
      return {
        mode: 'pronounceable',
        entropyBits: pronounceableEntropyBits(resolved),
        build: () => buildPronounceable(resolved),
      };
    }
    case 'pin': {
      const length = resolvePin(options);
      return {
        mode: 'pin',
        // A PIN is weak by construction — four digits is 13.3 bits, which any machine
        // exhausts instantly. The number is reported plainly so the UI can say so.
        entropyBits: length * Math.log2(DIGIT_CHARACTERS.length),
        build: () => {
          let output = '';
          for (let i = 0; i < length; i += 1) output += randomChoice(DIGIT_LIST);
          return output;
        },
      };
    }
  }
}

/**
 * The entropy of a *configuration*, without generating anything.
 *
 * Lets the UI show the strength of the settings as they are being changed, and lets a
 * caller refuse a configuration before it produces a password with it. Throws on a
 * configuration that cannot be honoured, for the same reason `generatePassword` does.
 */
export function estimateEntropyBits(options: GeneratorOptions): number {
  return plan(options).entropyBits;
}

export function generatePassword(options: GeneratorOptions): GeneratedPassword {
  const planned = plan(options);
  return { password: planned.build(), entropyBits: planned.entropyBits, mode: planned.mode };
}
