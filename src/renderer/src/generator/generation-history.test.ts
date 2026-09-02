// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  MAX_SECRET_HISTORY,
  findSecretHistoryEntry,
  pushSecretHistory,
  type SecretHistoryEntry,
} from './generation-history.js';

/**
 * The cap is the security-relevant part.
 *
 * This list holds plaintext passwords. Everything else about it — the ordering, the
 * de-duplication — is convenience; the cap is what stops a long session from accumulating
 * an unbounded pile of secret material in renderer memory. So it is tested as a property
 * over many pushes rather than as one assertion about six entries.
 */

function entry(id: string, secret: string): SecretHistoryEntry {
  return { id, secret, entropyBits: 100, mode: 'random' };
}

describe('pushSecretHistory', () => {
  it('puts the newest first, because that is the one someone is looking for', () => {
    const history = pushSecretHistory(pushSecretHistory([], entry('a', 'AAA')), entry('b', 'BBB'));
    expect(history.map((item) => item.id)).toEqual(['b', 'a']);
  });

  it('never grows past the cap, however many are pushed', () => {
    let history: readonly SecretHistoryEntry[] = [];
    for (let index = 0; index < 200; index += 1) {
      history = pushSecretHistory(history, entry(`id-${index}`, `secret-${index}`));
      expect(history.length).toBeLessThanOrEqual(MAX_SECRET_HISTORY);
    }
    expect(history.length).toBe(MAX_SECRET_HISTORY);
    // The oldest are gone, not merely hidden.
    expect(history.map((item) => item.id)).toEqual([
      'id-199',
      'id-198',
      'id-197',
      'id-196',
      'id-195',
    ]);
  });

  it('honours a smaller cap, and an empty one holds nothing at all', () => {
    const two = pushSecretHistory(
      pushSecretHistory(pushSecretHistory([], entry('a', 'A'), 2), entry('b', 'B'), 2),
      entry('c', 'C'),
      2
    );
    expect(two.map((item) => item.id)).toEqual(['c', 'b']);
    expect(pushSecretHistory([], entry('a', 'A'), 0)).toEqual([]);
  });

  it('does not show the same password twice', () => {
    // A six-digit PIN collides often enough within five draws to matter, and two identical
    // rows with two "put this back" buttons read as a bug.
    const history = pushSecretHistory(
      pushSecretHistory(pushSecretHistory([], entry('a', 'SAME')), entry('b', 'OTHER')),
      entry('c', 'SAME')
    );
    expect(history.map((item) => item.id)).toEqual(['c', 'b']);
  });

  it('does not mutate the list it was given', () => {
    const original = pushSecretHistory([], entry('a', 'AAA'));
    pushSecretHistory(original, entry('b', 'BBB'));
    expect(original.map((item) => item.id)).toEqual(['a']);
  });
});

describe('findSecretHistoryEntry', () => {
  it('finds an entry by id, and returns null rather than undefined for a miss', () => {
    const history = pushSecretHistory([], entry('a', 'AAA'));
    expect(findSecretHistoryEntry(history, 'a')?.secret).toBe('AAA');
    expect(findSecretHistoryEntry(history, 'nope')).toBeNull();
  });
});
