// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The first-run flow.
 *
 * A barrel because the host mounts one component and asks one question — "is there a first
 * run to run?" — and neither of those should require knowing which file inside here answers
 * it. Everything else is internal.
 */

export { OnboardingFlow, type OnboardingFlowProps } from './OnboardingFlow.js';

export {
  isOnboardingActiveFor,
  shouldShowOnboarding,
  readProgress,
  clearProgress,
  storageKeyFor,
} from './onboarding-storage.js';

export type { FirstCredentialDraft, OnboardingState } from './onboarding-state.js';
export type { OnboardingStepId } from './onboarding-steps.js';
