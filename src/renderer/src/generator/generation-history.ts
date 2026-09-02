// SPDX-License-Identifier: GPL-3.0-or-later
import type { GeneratorMode } from '@shared/model/generator.js';

/**
 * The last few passwords this panel produced, so a good one is not lost to one more click
 * on Regenerate.
 *
 * ## What this is allowed to be
 *
 * Every entry holds **secret material** — which is why the type, the field and every
 * function here carry `secret` in the name, per the naming rule in `CLAUDE.md`. The rules
 * that keep it bounded:
 *
 * - It lives in component state and nowhere else. Not a store, not `localStorage`, not the
 *   session, not a log.
 * - It is capped, so a long session cannot accumulate an unbounded pile of passwords.
 * - It dies with the panel, and it is emptied when the vault locks — a lock means the
 *   contents are off the screen, and a list of freshly generated passwords is exactly the
 *   sort of thing someone locks their vault to hide.
 *
 * A JavaScript string cannot be wiped, so scope is the only control available: the shorter
 * the list lives and the smaller it is, the less there is to lose. That is what the cap and
 * the lock clearing are for.
 */

/**
 * How many are kept.
 *
 * Five is enough to recover the one you scrolled past and small enough that the list stays
 * a glanceable strip rather than a screenful of secrets.
 */
export const MAX_SECRET_HISTORY = 5;

export interface SecretHistoryEntry {
  /**
   * A key for the list. Assigned by the caller from a counter — never derived from the
   * password, because a React key reaches the DOM and a secret must not.
   */
  readonly id: string;
  /** Secret material. */
  readonly secret: string;
  readonly entropyBits: number;
  readonly mode: GeneratorMode;
}

/**
 * Adds one entry, newest first, and enforces the cap.
 *
 * Any earlier entry holding the same password is dropped rather than left as a duplicate.
 * That is not a theoretical case: a six-digit PIN collides often enough within five draws
 * to matter, and two identical rows with two "restore" buttons read as a bug.
 */
export function pushSecretHistory(
  history: readonly SecretHistoryEntry[],
  entry: SecretHistoryEntry,
  cap: number = MAX_SECRET_HISTORY
): readonly SecretHistoryEntry[] {
  if (cap <= 0) return [];
  const withoutDuplicate = history.filter((existing) => existing.secret !== entry.secret);
  return [entry, ...withoutDuplicate].slice(0, cap);
}

/** The entry with this id, or `null`. Used to put an earlier password back on screen. */
export function findSecretHistoryEntry(
  history: readonly SecretHistoryEntry[],
  id: string
): SecretHistoryEntry | null {
  return history.find((entry) => entry.id === id) ?? null;
}
