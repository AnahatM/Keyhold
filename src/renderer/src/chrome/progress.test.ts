// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { progressFillPercent, progressPercent, progressValueText } from './progress.js';

describe('progressPercent', () => {
  it('clamps an overshoot instead of painting past the track', () => {
    // Import reports rows against an estimated total. A low estimate is normal, and an
    // unclamped bar would render outside its own container.
    expect(progressPercent(7, 5)).toBe(100);
  });

  it('clamps a negative value', () => {
    expect(progressPercent(-4, 10)).toBe(0);
  });

  it('survives a zero or nonsensical maximum rather than producing NaN', () => {
    // NaN reaches the DOM as `width: NaN%`, which the browser drops — a bar that silently
    // renders empty for the whole operation.
    expect(progressPercent(3, 0)).toBe(0);
    expect(progressPercent(3, Number.NaN)).toBe(0);
    expect(progressPercent(Number.POSITIVE_INFINITY, 10)).toBe(0);
  });

  it('reports the obvious cases', () => {
    expect(progressPercent(0, 10)).toBe(0);
    expect(progressPercent(5, 10)).toBe(50);
    expect(progressPercent(10, 10)).toBe(100);
  });
});

describe('progressFillPercent', () => {
  it('keeps a started operation visible rather than drawing nothing', () => {
    expect(progressFillPercent(1, 1000)).toBeGreaterThan(0.1);
  });

  it('still draws nothing at all when nothing has happened', () => {
    expect(progressFillPercent(0, 1000)).toBe(0);
  });
});

describe('progressValueText', () => {
  it('says the whole thing when there is a unit, because a bare number says nothing', () => {
    expect(progressValueText(3, 417, 'credentials')).toBe('3 of 417 credentials — 1%');
  });

  it('falls back to a percentage', () => {
    expect(progressValueText(1, 4)).toBe('25%');
  });
});
