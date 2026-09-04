// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  BREACH_UNAVAILABLE_REASONS,
  BREACH_UNKNOWN_REASONS,
  type BreachAvailability,
  type BreachReport,
} from '@shared/model/breach.js';
import { breachHeadline, breachIncompleteNote, breachUnavailable } from './breach-presentation.js';

/**
 * The sentences, tested directly rather than only through the DOM.
 *
 * The panel's own test drives these through a rendered component, which is the right way to
 * check that they reach the screen — and the wrong way to check the **ordering** inside
 * `breachHeadline`, because a component test can only exercise the combinations somebody
 * thought to mount. A fault injection that moved the clean case above the incomplete one
 * passed the component suite untouched, and that is why this file exists.
 *
 * The property every case here defends is one sentence long: **no wording may claim a clean
 * result while any record went unanswered.** `BreachStatus` has three values instead of two
 * for exactly this reason, and one careless summary line is all it takes to throw that away.
 *
 * Fault injections performed, after this file existed:
 *
 * 1. **The clean case moved above the incomplete case.** `never says nothing was found over a
 *    run that reached nothing` failed with "None of the 3 passwords checked appear in a known
 *    breach" over a sweep where every request timed out. Through the component alone this
 *    injection caught nothing.
 * 2. **`breachIncompleteNote` made to return `null` when `incompleteReason` is set.** Two
 *    cases failed — the note is the only place several of these reasons are ever explained.
 * 3. **`breachUnavailable` made to always return the `notEnabled` copy.** The kill-switch
 *    case failed, which is the one where following the advice would not have helped.
 */

function report(overrides: Partial<BreachReport> = {}): BreachReport {
  return {
    generatedAt: 1_800_000_000_000,
    checkedCount: 3,
    breachedCount: 0,
    safeCount: 3,
    unknownCount: 0,
    requestCount: 2,
    incompleteReason: null,
    results: [],
    ...overrides,
  };
}

function availability(overrides: Partial<BreachAvailability> = {}): BreachAvailability {
  return {
    networkPermitted: true,
    enabled: true,
    vaultOpen: true,
    canRun: true,
    reason: null,
    ...overrides,
  };
}

describe('the headline', () => {
  it('says a breach plainly, and says what to do', () => {
    expect(breachHeadline(report({ breachedCount: 1, safeCount: 2 }))).toContain('Change it');
    expect(breachHeadline(report({ breachedCount: 4, safeCount: 0, checkedCount: 4 }))).toContain(
      '4 passwords have appeared'
    );
  });

  it('never says nothing was found over a run that reached nothing', () => {
    // The ordering case, and the reason this file is not just the component test again. A
    // clean-first implementation produces "None of the 3 passwords checked appear in a known
    // breach" here — the single most misleading sentence this screen could show.
    const failed = report({
      checkedCount: 3,
      safeCount: 0,
      unknownCount: 3,
      incompleteReason: 'offline',
    });

    expect(breachHeadline(failed)).not.toMatch(/none of|do(es)? not appear/i);
    expect(breachHeadline(failed)).toContain('did not finish');
  });

  it('never says nothing was found when only some records went unanswered', () => {
    // The subtler half: `incompleteReason` is null — the run *finished* — and one record
    // still has no answer. A partial result is not a clean one.
    const partial = report({ checkedCount: 3, safeCount: 2, unknownCount: 1 });

    expect(breachHeadline(partial)).not.toMatch(/none of/i);
  });

  it('reports a breach ahead of an incomplete run, because it is actionable now', () => {
    const both = report({
      breachedCount: 1,
      safeCount: 0,
      unknownCount: 2,
      incompleteReason: 'timeout',
    });

    expect(breachHeadline(both)).toContain('Change it');
  });

  it('says so when there was nothing to check at all', () => {
    expect(breachHeadline(report({ checkedCount: 0, safeCount: 0 }))).toBe(
      'There were no passwords to check.'
    );
  });

  it('is clean only when every record got an answer', () => {
    expect(breachHeadline(report({ checkedCount: 3, safeCount: 3 }))).toContain(
      'None of the 3 passwords checked'
    );
    expect(breachHeadline(report({ checkedCount: 1, safeCount: 1 }))).toContain(
      'The one password checked'
    );
  });
});

describe('the incomplete note', () => {
  it('has wording for every reason the engine can produce', () => {
    // An exhaustive `Record` is a compile-time check; this is the runtime half, because a
    // blank line in a report about somebody's passwords is worse than a wrong one.
    for (const reason of BREACH_UNKNOWN_REASONS) {
      const note = breachIncompleteNote(report({ incompleteReason: reason, unknownCount: 1 }));
      expect(note, `no wording for "${reason}"`).toBeTruthy();
      expect(note?.length ?? 0).toBeGreaterThan(20);
    }
  });

  it('explains unanswered records even when the run itself reported no reason', () => {
    expect(breachIncompleteNote(report({ safeCount: 2, unknownCount: 1 }))).toContain(
      'not a complete result'
    );
  });

  it('is absent only when the run was genuinely complete', () => {
    expect(breachIncompleteNote(report())).toBeNull();
  });
});

describe('why it cannot run', () => {
  it('has wording for every reason', () => {
    for (const reason of BREACH_UNAVAILABLE_REASONS) {
      const copy = breachUnavailable(availability({ canRun: false, reason }));
      expect(copy.message.length, `no wording for "${reason}"`).toBeGreaterThan(20);
    }
  });

  it('offers no settings jump for a locked vault, because none would help', () => {
    expect(breachUnavailable(availability({ canRun: false, reason: 'locked' })).settable).toBe(
      false
    );
  });

  it('distinguishes the kill-switch from the opt-in', () => {
    // Both are "off", and following the wrong advice leaves the user exactly where they were.
    const killSwitch = breachUnavailable(availability({ canRun: false, reason: 'networkOff' }));
    const optIn = breachUnavailable(availability({ canRun: false, reason: 'notEnabled' }));

    expect(killSwitch.message).not.toBe(optIn.message);
    expect(killSwitch.message).toContain('network requests');
    expect(optIn.message).toContain('opted in');
  });
});
