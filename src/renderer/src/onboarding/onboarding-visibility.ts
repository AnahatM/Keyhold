// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useState } from 'react';
import { create } from 'zustand';
import type { SessionStatusView } from '@shared/ipc/api.js';
import type { OnboardingState } from './onboarding-state.js';
import { readProgress, shouldShowOnboarding } from './onboarding-storage.js';

/**
 * When the first-run flow shows — and, far more often, when it must not.
 *
 * This is the decision the flow was missing, and it is the one worth writing down: a tour
 * that never appears and a tour that appears to somebody who has used Keyhold for a year
 * are both silent failures. Neither throws, neither fails a build, and both are found by a
 * user rather than by us.
 *
 * ## The condition
 *
 * **This machine has never had a vault open on it, and the flow has not already been
 * finished or skipped here.**
 *
 * ## Why that one, and not the three that look like it
 *
 * | Candidate                              | Why it is wrong                                                                                                                                                                                                                                                                                        |
 * | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
 * | "No vault is open right now"           | True at every launch, for everybody. It is the welcome screen's condition, not a first run's.                                                                                                                                                                                                          |
 * | "No `.keep` file exists on this disk"   | The renderer cannot look and must not learn to: it has no Node access by design (D13). It is also the wrong question — a vault on a USB stick that has never been opened here genuinely is a first run *on this machine*.                                                                              |
 * | "They have never seen the flow"        | On its own this is a `localStorage` fact, and `localStorage` is lost to things that have nothing to do with Keyhold's history — a wiped profile, a reinstall that keeps the config file. A long-standing user would be handed the tour again, on a machine full of their vaults.                        |
 * | **"Nothing has ever been opened here"** | `recentVaults` is written by the main process the moment a vault is opened — created *or* unlocked (`SessionController.#afterOpen`) — into `preferences.json`, the machine-scoped store described in `src/main/session/preferences.ts`. Empty means nobody has ever got into a vault on this computer. |
 *
 * The two clauses of {@link hasNeverOpenedAVaultHere} are not redundant. `recentVaults`
 * only gains an entry once a vault has actually been *opened*, so a user who has picked a
 * `.keep` in the file dialog and is sitting on the unlock screen has `state === 'locked'`
 * and an empty recent list. That person is one password away from their data and must not
 * be shown a tour about creating a vault — which is the concrete form of "never block the
 * path to unlocking".
 *
 * ## Where "they have already seen it" is remembered
 *
 * In `onboarding-storage.ts`, which writes to `localStorage`. That is the right store and
 * it is deliberately **not** a vault setting: vault settings live inside the `.keep` file
 * and travel with it, so recording "onboarding done" there would suppress the first run on
 * a second machine that has never shown it — the same argument `preferences.ts` makes for
 * the network kill-switch, and the same one `appearance-store.ts` makes for the theme.
 * `localStorage` in a packaged Electron app is a file in this user's profile on this
 * machine, which is exactly the scope the fact has.
 *
 * The pairing is what makes it robust: `localStorage` remembers the *decision*, and
 * `recentVaults` — which no renderer can clear — remembers the *history*. Losing the first
 * costs at most a repeated tour; the second is what stops that tour reaching a returning
 * user.
 *
 * ## Reversing the decision is one predicate
 *
 * Everything here is a named function over facts rather than a boolean inlined at a mount
 * site. Changing "first run" to mean something else — say, offering the tour to anyone who
 * has never *completed* it — is an edit to {@link shouldOfferFirstRun} and its test, and
 * nothing else in the app has to be found first.
 */

/**
 * The scope stored progress is read under when asking "is this a first run".
 *
 * `null` is `onboarding-storage`'s pending scope — the key the flow writes to before a
 * vault has an id. A machine that has never opened a vault cannot have a record under any
 * other scope, so this is the only one worth reading.
 */
const NO_VAULT_YET = null;

/**
 * The slice of the session this decision reads.
 *
 * Narrowed to two fields rather than taking `SessionStatusView` whole, so a test can state
 * the case in one line and so it is visible at a glance that nothing else about the session
 * — not the throttle, not the clipboard, not the vault summary — is allowed to influence
 * whether a tour appears.
 */
export interface FirstRunSession {
  readonly state: SessionStatusView['state'];
  readonly recentVaults: SessionStatusView['recentVaults'];
}

/**
 * Whether this computer has ever had a vault open on it.
 *
 * The durable half of the condition, and the half a renderer cannot forge or forget.
 */
export function hasNeverOpenedAVaultHere(session: FirstRunSession): boolean {
  return session.state === 'no-vault' && session.recentVaults.length === 0;
}

/**
 * The whole decision, as a pure function of the two facts it rests on.
 *
 * Pure so every state in the matrix can be pinned down in a test without a DOM, a mock
 * process or a storage stub — the same reason `onboarding-state.ts` is pure.
 */
export function shouldOfferFirstRun(session: FirstRunSession, progress: OnboardingState): boolean {
  return hasNeverOpenedAVaultHere(session) && shouldShowOnboarding(progress);
}

/**
 * The launch's answer, remembered.
 *
 * **The latch is not a convenience, it is the correctness.** `recentVaults` gains its entry
 * the instant the vault is created — creating a vault opens it, so `#afterOpen` records it —
 * which means a host that re-derived this from the live session on every render would
 * unmount the flow midway through its own third step, at the exact moment the thing it
 * exists to do succeeded. The user would land in the vault having never been shown where
 * their file lives.
 *
 * "Is this a first run" is therefore a property of the *launch*, not of the current session,
 * and it is stored the way launch-scoped facts should be: answered once, from the first
 * session that can answer it, and never re-asked.
 *
 * `null` means "not answered yet", which is distinct from "answered: no".
 */
let launchDecision: boolean | null = null;

/**
 * The same decision, taken against this machine's stored progress, once per launch.
 *
 * A `null` session — status has not come back from the main process yet — is **not** a first
 * run and does not latch anything. Guessing during boot would flash a tour over the top of an
 * ordinary launch for a frame, which is worse than showing it a moment later.
 */
export function isFirstRunOnThisMachine(session: FirstRunSession | null): boolean {
  if (launchDecision !== null) return launchDecision;
  if (session === null) return false;
  launchDecision = shouldOfferFirstRun(session, readProgress(NO_VAULT_YET));
  return launchDecision;
}

/**
 * Takes the flow down for the rest of this launch.
 *
 * Separate from the persisted outcome on purpose. The flow writes "dismissed" to storage
 * itself, and that is what survives a restart; this is what stops the gate reopening if the
 * host remounts — under StrictMode's double mount in development, or simply because the tree
 * above it re-rendered — in the window before that write is read back.
 */
export function closeFirstRunForThisLaunch(): void {
  launchDecision = false;
}

/**
 * Forgets the launch decision, so the next call asks the question again.
 *
 * Written for tests, where a file is many launches and each case has to start from nothing.
 *
 * It is **not** on its own a "run the tour again": that would also have to clear the stored
 * progress, and it would still — correctly — refuse on a machine that already has a vault,
 * because that is not a first run. Re-running the tour is an explicit mount of
 * `OnboardingFlow`, which is exactly what the flow's callback-only design is for.
 */
export function forgetFirstRunDecision(): void {
  launchDecision = null;
}

export interface FirstRunGate {
  /** Whether the host should be rendering `OnboardingFlow`. */
  readonly show: boolean;
  /** Closes the flow. Wire it to `OnboardingFlow`'s `onExit`. */
  readonly close: () => void;
}

/**
 * The mount-site hook: one call, one boolean, one way to close it.
 *
 * The decision is read during render rather than set from an effect. It is a pure read of a
 * value that is computed at most once per launch — idempotent, so StrictMode's double render
 * cannot change the answer — and doing it here rather than in an effect is what keeps the
 * gate from rendering one frame of the wrong screen before correcting itself.
 */
export function useFirstRunGate(session: FirstRunSession | null): FirstRunGate {
  const [closed, setClosed] = useState(false);
  const open = isFirstRunOnThisMachine(session);

  const close = useCallback(() => {
    closeFirstRunForThisLaunch();
    setClosed(true);
  }, []);

  return { show: open && !closed, close };
}

/**
 * The re-run switch.
 *
 * A store rather than state on a screen, because two places open the tour — a palette
 * command and a button in Settings — and they are on opposite sides of the tree. State held
 * by either would mean a second switch, and the two would disagree the first time somebody
 * added a third entry point.
 *
 * Deliberately separate from {@link useFirstRunGate}. The first run is decided once per
 * launch from what is on this machine, and must not be re-openable; a re-run is an explicit
 * act, available whenever a vault is open, and writes nothing. Folding them into one flag
 * would make "the tour is showing" ambiguous about which of the two is on screen, and the
 * flow behaves differently in each.
 */
export interface TourGate {
  readonly open: boolean;
  readonly show: () => void;
  readonly close: () => void;
}

export const useTourGate = create<TourGate>((set) => ({
  open: false,
  show: () => {
    set({ open: true });
  },
  close: () => {
    set({ open: false });
  },
}));
