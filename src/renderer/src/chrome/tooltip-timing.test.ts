// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  createTooltipGroup,
  openDelayMs,
  TOOLTIP_OPEN_DELAY_MS,
  TOOLTIP_WARM_WINDOW_MS,
} from './tooltip-timing.js';

const T0 = 500_000;

describe('tooltip timing', () => {
  it('opens immediately on keyboard focus', () => {
    // The failure this prevents: a tooltip that only ever appears on hover is invisible to
    // a keyboard user, so the only explanation of an icon-only button never reaches them.
    // A delay on focus would also mean `aria-describedby` resolved to nothing at exactly
    // the moment a screen reader was reading the control.
    expect(openDelayMs('focus', null, T0)).toBe(0);
  });

  it('makes a pointer rest on the trigger before opening', () => {
    expect(openDelayMs('pointer', null, T0)).toBe(TOOLTIP_OPEN_DELAY_MS);
  });

  it('opens instantly for a second tooltip within the warm window', () => {
    expect(openDelayMs('pointer', T0, T0 + TOOLTIP_WARM_WINDOW_MS - 1)).toBe(0);
  });

  it('goes cold again once the warm window has passed', () => {
    expect(openDelayMs('pointer', T0, T0 + TOOLTIP_WARM_WINDOW_MS + 1)).toBe(TOOLTIP_OPEN_DELAY_MS);
  });
});

describe('a tooltip group', () => {
  it('shares warmth between its members and can be reset', () => {
    const group = createTooltipGroup();

    expect(group.openDelayMs('pointer', T0)).toBe(TOOLTIP_OPEN_DELAY_MS);

    group.noteClosed(T0 + 1_000);
    expect(group.openDelayMs('pointer', T0 + 1_100)).toBe(0);

    group.reset();
    expect(group.openDelayMs('pointer', T0 + 1_100)).toBe(TOOLTIP_OPEN_DELAY_MS);
  });

  it('is independent of every other group', () => {
    const a = createTooltipGroup();
    const b = createTooltipGroup();
    a.noteClosed(T0);
    expect(b.openDelayMs('pointer', T0 + 10)).toBe(TOOLTIP_OPEN_DELAY_MS);
  });
});
