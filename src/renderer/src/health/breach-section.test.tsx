// SPDX-License-Identifier: GPL-3.0-or-later
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { BreachAvailability, BreachReport } from '@shared/model/breach.js';
import { mountReact, type MountedTree } from '../chrome/test-dom.js';
import { HealthDashboard } from './HealthDashboard.js';
import { buildReport } from './health-fixture.js';
import type { HealthRecordRef } from './health-presentation.js';

/**
 * The breach panel, and the two promises it has to keep on screen.
 *
 * **Nothing reaches the network unless a person asks.** The panel is rendered by opening a
 * screen; the request is made by pressing a button. Those must stay different events, and the
 * first case here is the only thing in the repository that checks it from the outside.
 *
 * **A failed run never reads as a clean one.** The engine reports `unknownCount` separately
 * on purpose, and the whole value of that decision is lost if one summary line folds it in.
 *
 * Fault injections performed:
 *
 * 1. **`run` called from a `useEffect` on mount**, which is how every other panel in this app
 *    works and is exactly the mistake to make here. `makes no request until somebody presses
 *    the button` failed. Without that case, a sweep on open would have looked like a feature.
 * 2. **The unavailable branch replaced with a disabled button.** `names the switch that is
 *    off instead of showing a dead control` failed. A disabled control with a tooltip teaches
 *    people to keep clicking; a sentence naming the switch is something they can act on.
 * 3. **`breachHeadline`'s clean case moved above the incomplete case.** `never calls a failed
 *    run clean` failed with "None of the 3 passwords checked appear in a known breach" over a
 *    run that reached nothing — the single worst sentence this screen could produce.
 * 4. **The `requestCount` line deleted.** Caught nothing: no case asserted it, and it is not
 *    a safety property. Added one anyway, because "how many requests did that make?" is a
 *    question a user of a zero-network app is owed a real answer to, and a silently dropped
 *    answer is how it stops being answered.
 */

const RECORDS: readonly HealthRecordRef[] = [
  { id: 'a', title: 'Example Bank', username: 'alice', email: '' },
  { id: 'b', title: 'Example Mail', username: 'alice', email: '' },
];

const HEALTH = buildReport([{ id: 'a', title: 'Example Bank' }]);

/** Deliberately does nothing: these callbacks are not what any case here is about. */
function noop(): void {
  return;
}

/** Flushes the microtasks the availability query and the sweep resolve on. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(element: HTMLElement): void {
  act(() => {
    element.click();
  });
}

function checkNowButton(tree: MountedTree): HTMLButtonElement | undefined {
  return [...tree.container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent.includes('Check now')
  );
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

let mounted: MountedTree | null = null;
let runCount = 0;
let availabilityCount = 0;

function mount(input: {
  readonly availability?: BreachAvailability;
  /** Answered from the second question onward, so a re-query is observable. */
  readonly availabilityAfterRun?: BreachAvailability;
  readonly report?: BreachReport;
  /** When set, the run answers with a failure result instead of a report. */
  readonly runFailure?: string;
  /** When set, the bridge call *rejects* — a different path from a failure result. */
  readonly runRejects?: boolean;
}): MountedTree {
  const tree = mountReact(
    <HealthDashboard
      records={RECORDS}
      onSelectCredential={noop}
      analyse={() => Promise.resolve({ ok: true, value: HEALTH })}
      onOpenSettings={noop}
      breachAvailability={() => {
        availabilityCount += 1;
        const answer =
          availabilityCount > 1 && input.availabilityAfterRun !== undefined
            ? input.availabilityAfterRun
            : (input.availability ?? availability());
        return Promise.resolve({ ok: true, value: answer });
      }}
      breachRun={() => {
        runCount += 1;
        if (input.runRejects === true) return Promise.reject(new Error('the bridge went away'));
        if (input.runFailure !== undefined) {
          return Promise.resolve({
            ok: false as const,
            code: 'UNKNOWN' as const,
            message: input.runFailure,
            recoverable: true,
          });
        }
        return Promise.resolve({ ok: true, value: input.report ?? report() });
      }}
    />
  );
  mounted = tree;
  return tree;
}

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  runCount = 0;
  availabilityCount = 0;
  document.body.innerHTML = '';
});

describe('the breach panel', () => {
  it('makes no request until somebody presses the button', async () => {
    const tree = mount({});
    await settle();

    expect(runCount, 'opening the dashboard must not reach the network').toBe(0);
    expect(tree.container.textContent).toContain('Check now');
  });

  it('runs when the button is pressed, and only then', async () => {
    const tree = mount({});
    await settle();

    const button = checkNowButton(tree);
    expect(button, 'no "Check now" button was rendered').toBeDefined();

    click(button!);
    await settle();

    expect(runCount).toBe(1);
  });

  it('names the switch that is off instead of showing a dead control', async () => {
    const tree = mount({
      availability: availability({
        networkPermitted: false,
        enabled: false,
        canRun: false,
        reason: 'networkOff',
      }),
    });
    await settle();

    expect(tree.container.textContent).toContain('not allowed to make network requests');
    expect(tree.container.textContent).not.toContain('Check now');
  });

  it('distinguishes "you have not opted in" from "the kill-switch is down"', async () => {
    const tree = mount({
      availability: availability({ enabled: false, canRun: false, reason: 'notEnabled' }),
    });
    await settle();

    expect(tree.container.textContent).toContain('has not been opted in');
    expect(tree.container.textContent).not.toContain('not allowed to make network requests');
  });
});

describe('what it says about a result', () => {
  it('never calls a failed run clean', async () => {
    const tree = mount({
      report: report({
        checkedCount: 3,
        safeCount: 0,
        unknownCount: 3,
        incompleteReason: 'offline',
      }),
    });
    await settle();
    click(checkNowButton(tree)!);
    await settle();

    const text = tree.container.textContent;
    expect(text).toContain('did not finish');
    expect(text).not.toMatch(/None of the .* appear in a known breach/);
    expect(text).toContain('could not be reached');
  });

  it('says plainly when a password was found, and how many', async () => {
    const tree = mount({
      report: report({ checkedCount: 3, breachedCount: 2, safeCount: 1 }),
    });
    await settle();
    click(checkNowButton(tree)!);
    await settle();

    expect(tree.container.textContent).toContain('2 passwords have appeared in known breaches');
  });

  it('shows the failure when a run fails, and does not show a report', async () => {
    // The error branch had no test. It matters more than an ordinary error path: the panel's
    // whole job is to never let a run that did not happen read like a clean one, and a
    // rejected bridge call is the most complete way for a run not to happen.
    const tree = mount({ runFailure: 'The service could not be reached.' });
    await settle();
    click(checkNowButton(tree)!);
    await settle();

    expect(tree.container.textContent).toContain('The service could not be reached.');
    // No counts, no headline — nothing that could be read as an answer.
    expect(tree.container.querySelector('.kh-breach__result')).toBeNull();
  });

  it('stops spinning when the bridge call rejects, so the button works again', async () => {
    // A **rejection**, not a failure result, and the distinction is the whole point: a failure
    // result flows through the ordinary path and clears `running` on the way past. Only a
    // throw skips it — which is why `running` is cleared in a `finally`. Without that, one
    // rejected call leaves the button disabled for the rest of the session with no way back
    // except reopening the screen.
    //
    // The first version of this case used a failure result and could not distinguish anything;
    // fault injection said so by not running at all, which is its own kind of finding.
    const tree = mount({ runRejects: true });
    await settle();
    click(checkNowButton(tree)!);
    await settle();

    expect(checkNowButton(tree)?.disabled).toBe(false);
    // And it says something. Writing this case found that a rejection escaped unhandled and
    // the panel showed nothing at all — the button stopped spinning, no message appeared, and
    // the user had no way to tell whether a check had run.
    expect(tree.container.textContent).toContain('could not be started');
  });

  it('re-asks whether it may still run, after a run finishes', async () => {
    // The two switches can move underneath a long sweep — the kill-switch is one click away on
    // another screen. Re-asking is what stops the panel offering a button that would now be
    // refused. Asserted through the *rendered* state rather than the call count, because a
    // re-query whose answer is ignored is the same bug from the user's side.
    const tree = mount({
      availabilityAfterRun: availability({ enabled: false, canRun: false, reason: 'notEnabled' }),
    });
    await settle();
    expect(checkNowButton(tree)).toBeDefined();

    click(checkNowButton(tree)!);
    await settle();

    expect(availabilityCount).toBeGreaterThan(1);
    expect(checkNowButton(tree)).toBeUndefined();
    expect(tree.container.textContent).toContain('has not been opted in');
  });

  it('reports how many requests it made', async () => {
    // Not a safety property, and worth a case anyway: a user of an app that promises zero
    // network is owed a real number, and it is also what shows the k-anonymity sharing
    // working — far below the record count on any real vault.
    const tree = mount({ report: report({ requestCount: 2 }) });
    await settle();
    click(checkNowButton(tree)!);
    await settle();

    expect(tree.container.textContent).toContain('2 requests were made');
  });
});
