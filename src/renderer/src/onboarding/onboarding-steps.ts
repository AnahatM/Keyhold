// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The steps of the first-run flow, and the arithmetic for moving between them.
 *
 * One ordered list, exported once. The step indicator, the reducer, the resume logic and
 * the tests all read it — nothing restates "there are five steps" or hardcodes an order
 * (hard rule 8). Inserting a step here inserts it everywhere.
 *
 * The order is not arbitrary:
 *
 * 1. **welcome** — what Keyhold is, in one screen. Nobody reads a tour, so this is the only
 *    screen that is purely explanatory.
 * 2. **master-password** — the irreversible decision, taken while the user still has
 *    nothing to lose. Every gate in this flow exists to protect this step.
 * 3. **vault-file** — where the file is and what that means. It comes *after* creation
 *    because it can then point at a real path rather than a promise.
 * 4. **first-credential** — optional, and skipping is one click.
 * 5. **what-next** — the three things worth doing next, each of them a link out.
 */

export type OnboardingStepId =
  'welcome' | 'master-password' | 'vault-file' | 'first-credential' | 'what-next';

export interface OnboardingStep {
  readonly id: OnboardingStepId;
  /** The `<h2>` focus moves to when the step opens. */
  readonly heading: string;
  /** Two or three words, for the step indicator. */
  readonly shortLabel: string;
  /**
   * True when the step asks for nothing and passing it costs nothing.
   *
   * Recorded as data so the indicator can say "optional" out loud rather than leaving the
   * user to work out whether they are allowed to move on.
   */
  readonly optional: boolean;
}

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    id: 'welcome',
    heading: 'Keyhold keeps your passwords in a file you own',
    shortLabel: 'Welcome',
    optional: false,
  },
  {
    id: 'master-password',
    heading: 'Choose your master password',
    shortLabel: 'Master password',
    optional: false,
  },
  {
    id: 'vault-file',
    heading: 'Where your vault lives',
    shortLabel: 'Your file',
    optional: false,
  },
  {
    id: 'first-credential',
    // 'a credential', not 'your first credential'. The tour is re-runnable from Settings and
    // the palette, and a returning user with two hundred entries reading "your first" is
    // being told the app has not noticed them. The body copy already reads correctly either
    // way, and the one word is cheaper than making headings mode-aware for a single step.
    heading: 'Add a credential',
    shortLabel: 'First entry',
    optional: true,
  },
  {
    id: 'what-next',
    heading: 'Three things worth doing next',
    shortLabel: 'What next',
    optional: true,
  },
];

export const FIRST_STEP_ID: OnboardingStepId = 'welcome';

const INDEX_BY_ID: ReadonlyMap<OnboardingStepId, number> = new Map(
  ONBOARDING_STEPS.map((step, index) => [step.id, index])
);

/** Where a step sits in the order. `-1` for an id that is not in the list. */
export function stepIndex(id: OnboardingStepId): number {
  return INDEX_BY_ID.get(id) ?? -1;
}

/** The step at a position, or `null` when the position is off either end. */
export function stepAt(index: number): OnboardingStep | null {
  return ONBOARDING_STEPS[index] ?? null;
}

export function stepById(id: OnboardingStepId): OnboardingStep | null {
  return stepAt(stepIndex(id));
}

/**
 * Whether an arbitrary value is a step id.
 *
 * The resume path reads whatever is in `localStorage`, which a user can edit, an extension
 * can corrupt, and a future version can leave behind in an older shape. Anything that is
 * not exactly one of these ids means "start at the beginning" — never a crash, and never a
 * blank screen rendered for an id nothing matches.
 */
export function isKnownStepId(value: unknown): value is OnboardingStepId {
  return typeof value === 'string' && INDEX_BY_ID.has(value as OnboardingStepId);
}

export function nextStepId(id: OnboardingStepId): OnboardingStepId | null {
  return stepAt(stepIndex(id) + 1)?.id ?? null;
}

export function previousStepId(id: OnboardingStepId): OnboardingStepId | null {
  const index = stepIndex(id);
  return index <= 0 ? null : (stepAt(index - 1)?.id ?? null);
}

export function isLastStep(id: OnboardingStepId): boolean {
  return stepIndex(id) === ONBOARDING_STEPS.length - 1;
}

/** The last step that makes sense before a vault exists. Everything after it describes one. */
const REQUIRES_VAULT_AFTER: OnboardingStepId = 'master-password';

/**
 * Clamps a step to one the flow may legitimately be on.
 *
 * Resumed progress can point anywhere — a hand-edited `localStorage` value, a record left
 * by a build where the order was different, a vault file deleted between sessions. Steps
 * past the master password all describe a vault that exists; landing on one without a vault
 * would render a summary of a setup that never happened. Clamping is the quiet fix: the
 * user resumes at the last step that can actually be shown, rather than at an error.
 */
export function canonicalStepFor(
  stepId: OnboardingStepId,
  vaultCreated: boolean
): OnboardingStepId {
  if (vaultCreated) return stepId;
  return stepIndex(stepId) > stepIndex(REQUIRES_VAULT_AFTER) ? REQUIRES_VAULT_AFTER : stepId;
}
