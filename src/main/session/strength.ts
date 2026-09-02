// SPDX-License-Identifier: GPL-3.0-or-later
import type { PasswordStrength } from '@shared/model/strength.js';

/**
 * Master-password strength estimation.
 *
 * Uses **zxcvbn**, which earns its dependency because the naive alternative is actively
 * misleading. Counting character classes tells a user that `P@ssw0rd1!` is excellent —
 * four classes, ten characters — when it is among the first few thousand guesses any real
 * attacker makes. zxcvbn matches dictionaries, keyboard patterns, dates, repeats and l33t
 * substitutions, and reports a guess count rather than a vibe.
 *
 * Two deliberate choices:
 *
 * **It runs in the main process only.** The password never crosses the bridge, and ~3 MB
 * of dictionaries never enter the renderer bundle. What comes back is a score, a label and
 * advice — nothing derived from the password that could narrow a search.
 *
 * **It is loaded lazily.** The dictionaries are only needed on the two screens where a
 * password is being *chosen*, never on unlock, and never in a session that only reads
 * credentials.
 */

interface ZxcvbnResultLike {
  readonly guesses: number;
  readonly score: 0 | 1 | 2 | 3 | 4;
  readonly feedback: { warning?: string | null; suggestions?: string[] };
}

interface Checker {
  check(password: string, userInputs?: (string | number)[]): ZxcvbnResultLike;
}

let checker: Checker | null = null;

async function load(): Promise<Checker> {
  if (checker !== null) return checker;

  const [core, common] = await Promise.all([
    import('@zxcvbn-ts/core'),
    import('@zxcvbn-ts/language-common'),
  ]);

  checker = new core.ZxcvbnFactory({
    dictionary: { ...common.dictionary },
    graphs: common.adjacencyGraphs,
  });

  return checker;
}

/**
 * Terms that are specifically poor choices *here* and that a general dictionary will not
 * flag on its own.
 *
 * Passed as zxcvbn's `userInputs`, so they are matched with the same machinery as its own
 * dictionaries — catching `Keyh0ld!`, `vault123` and reversals — rather than by a
 * substring check that any small mutation defeats. Someone protecting a password vault
 * reaches for these far more often than chance.
 */
const CONTEXT_TERMS: (string | number)[] = [
  'keyhold',
  'keep',
  'vault',
  'master',
  'masterpassword',
  'password',
  'passwords',
  'manager',
];

/**
 * Guesses per second assumed for an offline attacker.
 *
 * Computed from zxcvbn's guess count rather than taken from its own crack-time fields,
 * because Keyhold knows something zxcvbn does not: the vault is protected by **Argon2id at
 * 64 MiB and roughly half a second per attempt on ordinary hardware**.
 *
 * Memory hardness is what sets this figure. Against a fast hash like SHA-256 a GPU farm
 * manages billions of guesses per second; against Argon2 at 64 MiB each parallel attempt
 * needs its own 64 MiB of fast memory, and memory bandwidth — not compute — becomes the
 * ceiling. 10,000/s is a deliberately pessimistic estimate for a well-resourced attacker:
 * generous enough that the number shown to the user is not falsely reassuring, and
 * grounded enough that it is not theatre.
 *
 * This is an estimate and the UI says so. It is here, named and explained, rather than
 * buried as a magic constant, precisely because a crack-time figure is the kind of claim
 * that should be arguable.
 */
const OFFLINE_GUESSES_PER_SECOND = 10_000;

function describeCrackTime(seconds: number): string {
  const MINUTE = 60;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const YEAR = 365 * DAY;

  if (seconds < MINUTE) return 'less than a minute';
  if (seconds < HOUR) return `about ${Math.round(seconds / MINUTE)} minutes`;
  if (seconds < DAY) return `about ${Math.round(seconds / HOUR)} hours`;
  if (seconds < 30 * DAY) return `about ${Math.round(seconds / DAY)} days`;
  if (seconds < YEAR) return `about ${Math.round(seconds / DAY / 30)} months`;
  if (seconds < 1_000 * YEAR) return `about ${Math.round(seconds / YEAR)} years`;
  if (seconds < 1e6 * YEAR) return 'thousands of years';
  return 'longer than anyone will be trying';
}

const LABELS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: 'Very weak',
  1: 'Weak',
  2: 'Fair',
  3: 'Strong',
  4: 'Very strong',
};

/**
 * The floor for a master password.
 *
 * Score 3, not 4, deliberately. Demanding the maximum pushes people toward writing the
 * password on a note beside the machine, which is a worse outcome than a merely-strong
 * passphrase they can actually remember. Score 3 already means roughly 10^10 guesses,
 * against a hash that costs 64 MiB and half a second per attempt.
 */
export const MINIMUM_MASTER_SCORE = 3;

/**
 * A hard length floor for the master password, on top of the score.
 *
 * zxcvbn scores `MyVault2024` at 3 — reasonable for an ordinary site login, and not
 * reasonable for the single key to every credential someone owns. A score is a statement
 * about *patterns*; length is a statement about the search space, and for the one password
 * that protects everything else both should have to hold.
 *
 * Twelve rather than sixteen because this is a floor, not a target: the score requirement
 * already rejects twelve characters of dictionary words, and pushing the floor higher
 * mostly succeeds at making people write the password down.
 */
export const MINIMUM_MASTER_LENGTH = 12;

export const EMPTY_STRENGTH: PasswordStrength = {
  score: 0,
  label: LABELS[0],
  guesses: 0,
  crackTime: '',
  warning: null,
  suggestions: [],
  meetsMasterMinimum: false,
};

export async function estimateStrength(password: string): Promise<PasswordStrength> {
  if (password === '') return EMPTY_STRENGTH;

  const zxcvbn = await load();
  const result = zxcvbn.check(password, CONTEXT_TERMS);

  // Half the guess space on average, not all of it — an attacker expects to find the
  // password halfway through, not at the end.
  const seconds = result.guesses / 2 / OFFLINE_GUESSES_PER_SECOND;

  return {
    score: result.score,
    label: LABELS[result.score],
    guesses: result.guesses,
    crackTime: describeCrackTime(seconds),
    warning: result.feedback.warning ?? null,
    suggestions: result.feedback.suggestions ?? [],
    meetsMasterMinimum:
      result.score >= MINIMUM_MASTER_SCORE && password.length >= MINIMUM_MASTER_LENGTH,
  };
}
