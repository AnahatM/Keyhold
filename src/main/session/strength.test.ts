// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { estimateStrength, MINIMUM_MASTER_LENGTH, MINIMUM_MASTER_SCORE } from './strength.js';

/**
 * Master-password strength.
 *
 * The point of these tests is not that zxcvbn works — that is upstream's problem — but
 * that **Keyhold's use of it produces the right verdicts**, in particular for the passwords
 * a password-manager user is disproportionately likely to reach for. The `userInputs`
 * wiring is the part that is ours, and it is the part that would silently stop working.
 */

describe('obviously bad passwords are rejected', () => {
  it.each([
    ['password', 'the single most common password there is'],
    ['12345678', 'a keyboard run'],
    ['qwertyui', 'a keyboard pattern'],
    ['letmein', 'a dictionary phrase'],
    ['aaaaaaaa', 'a repeat'],
  ])('%s — %s', async (password) => {
    const result = await estimateStrength(password);
    expect(result.meetsMasterMinimum).toBe(false);
    expect(result.score).toBeLessThan(MINIMUM_MASTER_SCORE);
  });

  it('rejects the classic that a character-class checker would pass', async () => {
    // Upper, lower, digit, symbol, ten characters — a naive meter calls this excellent.
    // It is among the first few thousand guesses any real attacker makes, which is exactly
    // why zxcvbn is worth its 3 MB.
    const result = await estimateStrength('P@ssw0rd1!');
    expect(result.meetsMasterMinimum).toBe(false);
  });
});

describe('app-specific words are caught, not just dictionary ones', () => {
  // These come through `userInputs`, so zxcvbn matches them with its own machinery —
  // catching l33t substitutions and reversals that a substring check would miss.
  it.each(['keyhold', 'Keyh0ld!', 'vault123', 'masterpassword'])(
    '%s does not clear the bar',
    async (password) => {
      const result = await estimateStrength(password);
      expect(result.meetsMasterMinimum).toBe(false);
    }
  );

  it('scores a Keyhold-derived password below the same password without it', async () => {
    // The wiring under test: if `userInputs` were dropped, these two would score alike.
    const withTerm = await estimateStrength('Keyhold-tiger-9!');
    const without = await estimateStrength('Zafrila-tiger-9!');
    expect(withTerm.guesses).toBeLessThan(without.guesses);
  });
});

describe('genuinely strong passwords are accepted', () => {
  it.each([
    'correct horse battery staple',
    'xkcd-purple-monkey-dishwasher-97',
    'Th3-Quick~Brown+Fox^Jumps',
    'brisk-antler-mosaic-tundra-vault9', // contains "vault" but is long enough to survive
  ])('%s clears the bar', async (password) => {
    const result = await estimateStrength(password);
    expect(result.meetsMasterMinimum).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(MINIMUM_MASTER_SCORE);
  });

  it('does not demand the maximum score', () => {
    // Deliberate: requiring score 4 pushes people to write the password on a note beside
    // the machine, which is a worse outcome than a merely-strong passphrase they remember.
    expect(MINIMUM_MASTER_SCORE).toBe(3);
  });
});

describe('the length floor, which the score alone does not provide', () => {
  it('rejects a short password that zxcvbn is otherwise content with', async () => {
    // zxcvbn scores `MyVault2024` at 3 — fine for an ordinary site login, not fine for
    // the single key to every credential someone owns. A score judges patterns; length
    // judges the search space, and for the master password both have to hold.
    const result = await estimateStrength('MyVault2024');
    expect(result.score).toBeGreaterThanOrEqual(MINIMUM_MASTER_SCORE);
    expect(result.meetsMasterMinimum).toBe(false);
  });

  it('rejects a strong-but-short password', async () => {
    const result = await estimateStrength('7#kQ!zR2');
    expect(result.meetsMasterMinimum).toBe(false);
  });

  it('is a floor, not a target — twelve, not sixteen', () => {
    // Pushing the floor higher mostly succeeds at making people write the password down.
    expect(MINIMUM_MASTER_LENGTH).toBe(12);
  });
});

describe('what comes back', () => {
  it('returns an empty result for an empty password rather than a score of "very weak"', async () => {
    // An empty field has not been judged yet. Showing "Very weak" before a single
    // keystroke reads as the app shouting at the user for existing.
    const result = await estimateStrength('');
    expect(result.score).toBe(0);
    expect(result.crackTime).toBe('');
    expect(result.meetsMasterMinimum).toBe(false);
  });

  it('gives a human crack time that grows with strength', async () => {
    const weak = await estimateStrength('password1');
    const strong = await estimateStrength('xkcd-purple-monkey-dishwasher-97');

    expect(weak.crackTime).not.toBe('');
    expect(strong.crackTime).not.toBe('');
    expect(strong.guesses).toBeGreaterThan(weak.guesses);
  });

  it('offers advice on a weak password', async () => {
    const result = await estimateStrength('P@ssw0rd1!');
    expect(result.warning !== null || result.suggestions.length > 0).toBe(true);
  });

  it('never returns the password or anything reversible in the result', async () => {
    // This crosses IPC to the renderer, which must not hold secret material (D13).
    const password = 'a-very-distinctive-passphrase-9182';
    const result = await estimateStrength(password);

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(password);
    expect(serialised).not.toContain('distinctive');
  });

  it('labels every score band', async () => {
    for (const password of ['a', 'password', 'Trombone7!', 'correct horse battery staple']) {
      const result = await estimateStrength(password);
      expect(result.label.length).toBeGreaterThan(0);
    }
  });
});
