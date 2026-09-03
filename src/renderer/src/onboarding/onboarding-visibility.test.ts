// SPDX-License-Identifier: GPL-3.0-or-later
import { act, createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountReact } from '../chrome/test-dom.js';
import { INITIAL_ONBOARDING_STATE, type OnboardingState } from './onboarding-state.js';
import { storageKeyFor, writeProgress, PROGRESS_VERSION } from './onboarding-storage.js';
import {
  closeFirstRunForThisLaunch,
  forgetFirstRunDecision,
  hasNeverOpenedAVaultHere,
  isFirstRunOnThisMachine,
  shouldOfferFirstRun,
  useFirstRunGate,
  type FirstRunSession,
} from './onboarding-visibility.js';

/**
 * When the first-run flow shows.
 *
 * The flow itself has been finished and tested for a while; **the thing that was missing was
 * anything that decided to render it**, which is why this file exists and why it is written
 * as a matrix rather than as two happy-path assertions. The failure modes here are silent in
 * both directions — a tour that never appears looks identical to a tour that was never
 * built, and a tour shown to a returning user looks like a bug in the app rather than in one
 * predicate — so every state a real session can be in is named and pinned.
 *
 * The two that matter most:
 *
 * - **A vault waiting for its password is never a first run.** That state has an empty recent
 *   list (nothing has been *opened* yet) and would satisfy a naive "no vaults here" check.
 *   Covering a full-screen tour over somebody's unlock screen is the worst thing this
 *   component could do.
 * - **The decision is latched for the launch.** Creating a vault records it as opened, so a
 *   condition re-derived from the live session flips to false in the middle of the flow's own
 *   third step.
 */

const A_RECENT_VAULT: FirstRunSession['recentVaults'] = [
  {
    path: 'C:\\Users\\test\\Documents\\personal.keep',
    displayName: 'personal',
    vaultId: 'vault-aaaa-1111',
    lastOpenedAt: 1_700_000_000_000,
  },
];

function session(overrides: Partial<FirstRunSession> = {}): FirstRunSession {
  return { state: 'no-vault', recentVaults: [], ...overrides };
}

function progress(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return { ...INITIAL_ONBOARDING_STATE, ...overrides };
}

/** The record a user who skipped the tour leaves behind. */
function skipped(): OnboardingState {
  return progress({ outcome: 'dismissed' });
}

/** The record a user who walked the whole tour leaves behind. */
function finished(): OnboardingState {
  return progress({
    stepId: 'what-next',
    acknowledgedNoRecovery: true,
    vaultCreated: true,
    outcome: 'completed',
  });
}

beforeEach(() => {
  window.localStorage.clear();
  // The decision is launch-scoped by design, and a test file is many launches.
  forgetFirstRunDecision();
});

afterEach(() => {
  window.localStorage.clear();
  forgetFirstRunDecision();
  document.body.innerHTML = '';
});

// ── The condition, state by state ────────────────────────────────────────────

interface VisibilityCase {
  readonly name: string;
  readonly session: FirstRunSession;
  readonly progress: OnboardingState;
  readonly show: boolean;
}

/**
 * Every state a real session can be in, written out rather than generated.
 *
 * A generated table would have to compute the expected answer, and the only formula
 * available is the implementation — so it would agree with the code by construction and
 * catch nothing. Each row here is a claim about a person.
 */
const CASES: readonly VisibilityCase[] = [
  {
    name: 'a machine that has never held a vault, never offered the tour',
    session: session(),
    progress: progress(),
    show: true,
  },
  {
    name: 'the same machine, after the user skipped the tour',
    session: session(),
    progress: skipped(),
    show: false,
  },
  {
    name: 'the same machine, after the user finished the tour',
    session: session(),
    progress: finished(),
    show: false,
  },
  {
    name: 'a returning user on the welcome screen, with a vault in their recent list',
    session: session({ recentVaults: A_RECENT_VAULT }),
    progress: progress(),
    show: false,
  },
  {
    name: 'a vault picked from the file dialog, waiting for its password',
    // The state that makes the two clauses independent: nothing has ever been *opened*, so
    // the recent list is empty, and this person is one password away from their data.
    session: session({ state: 'locked' }),
    progress: progress(),
    show: false,
  },
  {
    name: 'a returning user at the unlock screen',
    session: session({ state: 'locked', recentVaults: A_RECENT_VAULT }),
    progress: progress(),
    show: false,
  },
  {
    name: 'an open vault',
    session: session({ state: 'unlocked', recentVaults: A_RECENT_VAULT }),
    progress: progress(),
    show: false,
  },
  {
    name: 'an open vault whose recent list has been emptied by hand',
    session: session({ state: 'unlocked' }),
    progress: progress(),
    show: false,
  },
];

describe('the show/hide condition', () => {
  for (const scenario of CASES) {
    it(`${scenario.show ? 'shows' : 'hides'} the flow for ${scenario.name}`, () => {
      expect(shouldOfferFirstRun(scenario.session, scenario.progress)).toBe(scenario.show);
    });
  }

  it('never offers the flow to anyone whose vault is waiting to be unlocked', () => {
    // Stated separately from the table because it is the guarantee, not a case: no stored
    // progress, however fresh, may put a tour in front of an unlock.
    for (const recentVaults of [[], A_RECENT_VAULT]) {
      const waiting = session({ state: 'locked', recentVaults });
      expect(hasNeverOpenedAVaultHere(waiting)).toBe(false);
      expect(shouldOfferFirstRun(waiting, progress())).toBe(false);
    }
  });

  it('treats an unlocked vault as decisive on its own', () => {
    expect(hasNeverOpenedAVaultHere(session({ state: 'unlocked' }))).toBe(false);
  });
});

// ── Reading the machine's own record ─────────────────────────────────────────

describe('the machine-scoped record', () => {
  it('offers the flow when this machine has never stored anything', () => {
    expect(isFirstRunOnThisMachine(session())).toBe(true);
  });

  it('does not offer it again once the user has skipped it', () => {
    // Written under the pending scope — the only scope a machine with no vault can have.
    writeProgress(null, skipped());
    expect(isFirstRunOnThisMachine(session())).toBe(false);
  });

  it('does not offer it again once the user has finished it', () => {
    writeProgress(null, finished());
    expect(isFirstRunOnThisMachine(session())).toBe(false);
  });

  it('does not decide anything before the session has loaded', () => {
    expect(isFirstRunOnThisMachine(null)).toBe(false);
    // And crucially, has not latched that "no" — the answer is still open.
    expect(isFirstRunOnThisMachine(session())).toBe(true);
  });

  it('offers the flow rather than trusting a record that contradicts itself', () => {
    // `coerceProgress` rejects "completed without the acknowledgement" outright. A hostile
    // or damaged record must not be able to suppress the one screen that explains that
    // there is no recovery.
    window.localStorage.setItem(
      storageKeyFor(null),
      `{"version":${PROGRESS_VERSION},"stepId":"what-next","acknowledgedNoRecovery":false,"vaultCreated":true,"firstCredentialSaved":false,"outcome":"completed"}`
    );
    expect(isFirstRunOnThisMachine(session())).toBe(true);
  });
});

// ── The launch latch ─────────────────────────────────────────────────────────

describe('the decision is taken once per launch', () => {
  it('survives the vault being created underneath it', () => {
    expect(isFirstRunOnThisMachine(session())).toBe(true);

    // What the session looks like one moment later: creating a vault opens it, so the main
    // process has already recorded it as a recent vault. Re-deriving here would tear the
    // flow down on its own third step.
    const afterCreation = session({ state: 'unlocked', recentVaults: A_RECENT_VAULT });
    expect(isFirstRunOnThisMachine(afterCreation)).toBe(true);
  });

  it('is closed for the rest of the launch once the flow exits', () => {
    expect(isFirstRunOnThisMachine(session())).toBe(true);
    closeFirstRunForThisLaunch();
    expect(isFirstRunOnThisMachine(session())).toBe(false);
  });

  it('asks again on the next launch', () => {
    closeFirstRunForThisLaunch();
    expect(isFirstRunOnThisMachine(session())).toBe(false);

    forgetFirstRunDecision();
    expect(isFirstRunOnThisMachine(session())).toBe(true);
  });

  it('re-reads storage on the next launch, so a skip taken now still holds then', () => {
    expect(isFirstRunOnThisMachine(session())).toBe(true);
    writeProgress(null, skipped());
    forgetFirstRunDecision();
    expect(isFirstRunOnThisMachine(session())).toBe(false);
  });
});

// ── The mount-site hook ──────────────────────────────────────────────────────

/**
 * The smallest thing that can be asked what the gate says.
 *
 * `createElement` rather than JSX so this file can stay `.ts` beside the `.ts` module it
 * tests. The gate's answer is rendered as the button's own text, so reading it back is a
 * plain DOM read with no typing games.
 */
function Probe({ session: current }: { readonly session: FirstRunSession | null }): ReactElement {
  const gate = useFirstRunGate(current);
  return createElement(
    'button',
    { type: 'button', onClick: gate.close },
    gate.show ? 'showing' : 'hidden'
  );
}

function showing(container: HTMLElement): boolean {
  return container.querySelector('button')?.textContent === 'showing';
}

function exit(container: HTMLElement): void {
  act(() => {
    container.querySelector('button')?.click();
  });
}

describe('useFirstRunGate', () => {
  it('waits for the session, then shows, and holds through the vault being created', () => {
    const tree = mountReact(createElement(Probe, { session: null }));
    expect(showing(tree.container)).toBe(false);

    tree.render(createElement(Probe, { session: session() }));
    expect(showing(tree.container)).toBe(true);

    tree.render(
      createElement(Probe, {
        session: session({ state: 'unlocked', recentVaults: A_RECENT_VAULT }),
      })
    );
    expect(showing(tree.container)).toBe(true);

    tree.unmount();
  });

  it('never shows for a returning user', () => {
    const tree = mountReact(
      createElement(Probe, { session: session({ recentVaults: A_RECENT_VAULT }) })
    );
    expect(showing(tree.container)).toBe(false);
    tree.unmount();
  });

  it('closes on exit, and stays closed across a remount', () => {
    const tree = mountReact(createElement(Probe, { session: session() }));
    expect(showing(tree.container)).toBe(true);

    exit(tree.container);
    expect(showing(tree.container)).toBe(false);
    tree.unmount();

    // A remount within the same launch — StrictMode's double mount, or the tree above it
    // re-rendering — must not put the flow back on screen.
    const again = mountReact(createElement(Probe, { session: session() }));
    expect(showing(again.container)).toBe(false);
    again.unmount();
  });
});
