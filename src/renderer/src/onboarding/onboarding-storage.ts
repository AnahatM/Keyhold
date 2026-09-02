// SPDX-License-Identifier: GPL-3.0-or-later
import {
  INITIAL_ONBOARDING_STATE,
  reconcileResumedState,
  type OnboardingOutcome,
  type OnboardingState,
} from './onboarding-state.js';
import { isKnownStepId } from './onboarding-steps.js';

/**
 * Remembering where someone got to, and — far more importantly — **not** remembering
 * anything they typed.
 *
 * ## The rule
 *
 * This module writes exactly six values: a version, a step id, three booleans and an
 * outcome. It never spreads an object into the payload and never serialises a value it did
 * not name itself. A master password, a confirmation, a credential draft, a title, a URL —
 * none of them can reach `localStorage` through here, because there is no code path that
 * would carry them. That is a structural guarantee rather than a discipline, and
 * `onboarding-storage.test.ts` plants markers in a state object to prove it holds even when
 * the caller hands over something with extra fields on it.
 *
 * `localStorage` in a packaged Electron app is an ordinary file in the user profile,
 * readable by anything that can read the profile and surviving long after a vault is
 * deleted. It is the right place for "which step were you on" and the wrong place for
 * anything else.
 *
 * ## Failure is normal, not exceptional
 *
 * Every access is wrapped. Storage throws outright in some contexts, returns stale data
 * from an older build in others, and can be edited by hand at any time. Every one of those
 * means the same thing here: **start at the beginning.** A first-run flow that crashes on a
 * corrupt progress record is a first-run flow that cannot be run at all.
 */

const STORAGE_PREFIX = 'keyhold.onboarding.';

/** Bumped when the stored shape changes. An older record is ignored, never migrated. */
export const PROGRESS_VERSION = 1;

/** The key used before a vault exists — the flow has nothing else to be scoped by yet. */
const PENDING_SCOPE = 'new-vault';

const OUTCOMES: readonly OnboardingOutcome[] = ['active', 'completed', 'dismissed'];

function isOutcome(value: unknown): value is OnboardingOutcome {
  return typeof value === 'string' && OUTCOMES.includes(value as OnboardingOutcome);
}

/**
 * The `localStorage` key for one vault's progress.
 *
 * Scoped per vault so two vaults cannot share a record: someone who sets up a second vault
 * should be walked through it, not dropped at "what next" because a different vault
 * finished the flow last week. The scope is percent-encoded so a vault id containing a
 * separator cannot collide with a differently-named one.
 *
 * `null` — no vault yet — gets its own fixed scope rather than an empty one, so the pending
 * record is a named thing that can be found and cleaned up.
 */
export function storageKeyFor(vaultKey: string | null): string {
  const scope = vaultKey === null || vaultKey.trim() === '' ? PENDING_SCOPE : vaultKey;
  return `${STORAGE_PREFIX}${encodeURIComponent(scope)}`;
}

/**
 * Validates a parsed record, returning `null` for anything that is not exactly right.
 *
 * Deliberately strict. The two consistency checks at the end are the ones worth reading:
 *
 * - **A completed flow must carry the acknowledgement.** Otherwise a hand-edited record
 *   could mark setup finished for a vault whose owner was never told it cannot be
 *   recovered. Rejecting the record costs a repeated tour; accepting it costs a vault.
 * - **A step past the master password must have a vault.** The position is clamped rather
 *   than rejected elsewhere, but a record claiming both is internally contradictory and is
 *   more likely to be damage than an honest older shape.
 */
export function coerceProgress(raw: unknown): OnboardingState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;

  const record = raw as Record<string, unknown>;
  if (record.version !== PROGRESS_VERSION) return null;

  const stepId = record.stepId;
  if (!isKnownStepId(stepId)) return null;

  const acknowledgedNoRecovery = record.acknowledgedNoRecovery;
  const vaultCreated = record.vaultCreated;
  const firstCredentialSaved = record.firstCredentialSaved;
  if (
    typeof acknowledgedNoRecovery !== 'boolean' ||
    typeof vaultCreated !== 'boolean' ||
    typeof firstCredentialSaved !== 'boolean'
  ) {
    return null;
  }

  const outcome = record.outcome;
  if (!isOutcome(outcome)) return null;

  if (outcome === 'completed' && !acknowledgedNoRecovery) return null;

  return { stepId, acknowledgedNoRecovery, vaultCreated, firstCredentialSaved, outcome };
}

/**
 * The stored progress for a vault, or a fresh start.
 *
 * There is one return path for "no record", "unreadable storage", "not JSON", "wrong
 * shape", "wrong version" and "internally contradictory", and it is
 * {@link INITIAL_ONBOARDING_STATE}. Nothing here can throw.
 */
export function readProgress(vaultKey: string | null): OnboardingState {
  // No initialiser: the `catch` returns rather than falling through, so the only value this
  // ever holds is the one the `try` assigned.
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(storageKeyFor(vaultKey));
  } catch {
    // Storage disabled by policy, a private context, a quota error on read. Not an error.
    return INITIAL_ONBOARDING_STATE;
  }
  if (raw === null) return INITIAL_ONBOARDING_STATE;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return INITIAL_ONBOARDING_STATE;
  }

  const progress = coerceProgress(parsed);
  return progress === null ? INITIAL_ONBOARDING_STATE : reconcileResumedState(progress);
}

/**
 * Persists progress.
 *
 * Every field is named. Nothing is spread. If a future field is added to
 * {@link OnboardingState} it does not become persisted by accident — it has to be written
 * here on purpose, which is the moment somebody asks whether it should be.
 */
export function writeProgress(vaultKey: string | null, state: OnboardingState): void {
  const payload = {
    version: PROGRESS_VERSION,
    stepId: state.stepId,
    acknowledgedNoRecovery: state.acknowledgedNoRecovery,
    vaultCreated: state.vaultCreated,
    firstCredentialSaved: state.firstCredentialSaved,
    outcome: state.outcome,
  };

  try {
    window.localStorage.setItem(storageKeyFor(vaultKey), JSON.stringify(payload));
  } catch {
    // The flow works fine without persistence; it just forgets. Never surface this — a
    // storage failure is not a reason to interrupt someone setting up a password manager.
  }
}

export function clearProgress(vaultKey: string | null): void {
  try {
    window.localStorage.removeItem(storageKeyFor(vaultKey));
  } catch {
    // Nothing to do and nothing to say.
  }
}

/**
 * Re-scopes a record when the vault it belongs to acquires an identity.
 *
 * The flow starts before a vault exists, under the pending scope, and the vault id only
 * arrives once the file has been created. Without this, the pending record would be
 * orphaned — and the next first run would resume someone else's half-finished tour.
 */
export function moveProgress(fromVaultKey: string | null, toVaultKey: string | null): void {
  if (storageKeyFor(fromVaultKey) === storageKeyFor(toVaultKey)) return;
  writeProgress(toVaultKey, readProgress(fromVaultKey));
  clearProgress(fromVaultKey);
}

/** Whether the flow should be shown at all. Both "finished" and "skipped" mean no. */
export function shouldShowOnboarding(state: OnboardingState): boolean {
  return state.outcome === 'active';
}

/** The mount-site question: is there a first run to run? */
export function isOnboardingActiveFor(vaultKey: string | null): boolean {
  return shouldShowOnboarding(readProgress(vaultKey));
}
