// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { THEMES } from '@shared/theme/themes.js';
import { COLOUR_TOKENS } from '@shared/theme/tokens.js';
import { DEFAULT_TAG_COLOUR, TAG_COLOUR_TOKENS, isTagColour } from './tag-colours.js';

/**
 * The guard that ships with the tag colour vocabulary.
 *
 * Three properties, each of which would otherwise be an invisible defect: a token that no
 * theme defines renders as nothing, a status token stolen for decoration makes the health
 * dashboard's real warnings stop reading as warnings, and a validator that accepts a raw
 * colour puts a value in the vault that no theme owns.
 */

describe('the tag colour vocabulary', () => {
  it('is a subset of the theme vocabulary', () => {
    for (const token of TAG_COLOUR_TOKENS) {
      expect(COLOUR_TOKENS).toContain(token);
    }
  });

  it('resolves in every theme', () => {
    for (const theme of THEMES) {
      for (const token of TAG_COLOUR_TOKENS) {
        expect(theme.palette[token], `${theme.id} is missing ${token}`).toMatch(/\S/);
      }
    }
  });

  it('borrows no status token', () => {
    // tokens.ts says it at the point it declares them: these carry the health dashboard's
    // signal. A vault where tags are also red and green is a vault where a breached
    // password's warning is just one more chip.
    const status = COLOUR_TOKENS.filter((token) => /^(success|warning|danger)/.test(token));
    expect(status.length).toBeGreaterThan(0);
    for (const token of status) {
      expect(TAG_COLOUR_TOKENS as readonly string[]).not.toContain(token);
    }
  });

  it('offers no colour that would render an invisible chip', () => {
    for (const surface of ['bg', 'surface', 'surface-raised', 'surface-sunken', 'overlay']) {
      expect(TAG_COLOUR_TOKENS as readonly string[]).not.toContain(surface);
    }
  });

  it('has a default that is one of its own members and is not the accent', () => {
    expect(TAG_COLOUR_TOKENS as readonly string[]).toContain(DEFAULT_TAG_COLOUR);
    // The accent is the selection colour; a brand-new tag wearing it looks pre-selected.
    expect(DEFAULT_TAG_COLOUR).not.toBe('accent');
  });

  it('rejects a raw colour, an unknown token, and a non-string', () => {
    for (const value of ['#ff0000', 'red', 'rgb(1,2,3)', 'success', 'bg', '', 7, null, {}]) {
      expect(isTagColour(value)).toBe(false);
    }
    for (const token of TAG_COLOUR_TOKENS) {
      expect(isTagColour(token)).toBe(true);
    }
  });
});
