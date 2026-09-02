// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { EMPTY_STATE_KINDS, EMPTY_STATE_PRESETS } from './empty-state-presets.js';

/**
 * The guard that ships with the registry (hard rule 9).
 *
 * It cannot check that the copy is *good*, but it can check the two things that silently
 * rot: an entry added without a next step, and two views that end up saying the same
 * sentence because one was copy-pasted from the other.
 */

describe('empty-state presets', () => {
  it('gives every kind an icon, a heading and an explanation', () => {
    for (const kind of EMPTY_STATE_KINDS) {
      const preset = EMPTY_STATE_PRESETS[kind];
      expect(preset.icon, kind).not.toBe('');
      expect(preset.title, kind).not.toBe('');
      expect(preset.description.length, kind).toBeGreaterThan(20);
    }
  });

  it('never repeats a heading between two different views', () => {
    const titles = EMPTY_STATE_KINDS.map((kind) => EMPTY_STATE_PRESETS[kind].title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('marks exactly the empty state that is good news', () => {
    // An empty health dashboard means nothing is weak, reused, old or breached. It is the
    // only screen in this app where "there is nothing here" is a result worth celebrating.
    const positive = EMPTY_STATE_KINDS.filter(
      (kind) => EMPTY_STATE_PRESETS[kind].tone === 'success'
    );
    expect(positive).toEqual(['no-health-issues']);
  });
});
