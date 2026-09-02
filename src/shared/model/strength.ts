// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The shape of a password-strength estimate.
 *
 * Lives in `@shared` because the renderer renders it; the estimation itself runs in the
 * main process only, so the password never crosses the bridge and ~3 MB of dictionaries
 * never enter the renderer bundle.
 *
 * Note what does cross: a score, a label, a guess count and advice. Never the password,
 * and never anything derived from it that could narrow a search.
 */
export interface PasswordStrength {
  /** zxcvbn's 0–4 scale. */
  readonly score: 0 | 1 | 2 | 3 | 4;
  readonly label: string;
  /** Estimated guesses required. Shown to people who want the number rather than the word. */
  readonly guesses: number;
  /** Plain-English crack time, framed against a slow memory-hard hash. */
  readonly crackTime: string;
  readonly warning: string | null;
  readonly suggestions: readonly string[];
  /** Whether this clears the bar for a master password. */
  readonly meetsMasterMinimum: boolean;
}
