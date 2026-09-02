// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { COLOUR_TOKENS } from '@shared/theme/tokens.js';
import { TOKEN_GROUPS, TOKENS_IN_GROUP_ORDER } from './token-groups.js';

/**
 * The guard hard rule 8 asks for: the editor's arrangement of the token vocabulary is a
 * *view* of `COLOUR_TOKENS`, never a second copy of it.
 *
 * Without this, adding a token to `tokens.ts` and forgetting to place it here produces a
 * colour that exists, is applied, is contrast-checked — and cannot be edited, with nothing
 * anywhere saying so. That is the exact failure mode a hand-maintained UI list always has,
 * and the only way to catch it is to assert the two lists against each other.
 */

describe('the editor covers the token vocabulary', () => {
  it('places every token exactly once', () => {
    // Sorted comparison, not order-sensitive: the editor deliberately groups by purpose
    // rather than following `COLOUR_TOKENS`, so only membership is the shared fact.
    expect([...TOKENS_IN_GROUP_ORDER].sort()).toEqual([...COLOUR_TOKENS].sort());
  });

  it('never lists a token twice', () => {
    expect(new Set(TOKENS_IN_GROUP_ORDER).size).toBe(TOKENS_IN_GROUP_ORDER.length);
  });

  it('names no token that tokens.ts does not declare', () => {
    const known = new Set<string>(COLOUR_TOKENS);
    for (const token of TOKENS_IN_GROUP_ORDER) {
      expect(known.has(token), `"${token}" is not a declared colour token`).toBe(true);
    }
  });
});

describe('the groups themselves', () => {
  it('have unique ids, so React keys and any future anchor link stay stable', () => {
    const ids = TOKEN_GROUPS.map((group) => group.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('are never empty, and every one says what it is for', () => {
    for (const group of TOKEN_GROUPS) {
      expect(group.tokens.length, `group "${group.id}" is empty`).toBeGreaterThan(0);
      expect(group.label.trim()).not.toBe('');
      // The description is the only thing telling someone what a value should mean before
      // they pick it. A group without one is a fieldset of forty hex codes.
      expect(group.description.trim(), `group "${group.id}" has no description`).not.toBe('');
    }
  });
});
