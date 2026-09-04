// SPDX-License-Identifier: GPL-3.0-or-later
import {
  BREACH_UNAVAILABLE_REASONS,
  type BreachAvailability,
  type BreachReport,
  type BreachUnavailableReason,
  type BreachUnknownReason,
} from '@shared/model/breach.js';

/**
 * Turning a breach report into sentences, and keeping the honest one honest.
 *
 * Pure and outside the component for the same reason `health-presentation.ts` is: on this
 * screen the *words* are the feature. The engine's job is to produce three counts and a
 * reason; this file's job is to make sure a run that failed never reads like a run that
 * passed. A user who sees "nothing found" over a sweep where every request timed out has
 * been told the opposite of the truth by a rendering decision.
 *
 * ## The rule every function here follows
 *
 * **No sentence may claim a clean result while `unknownCount` is above zero.** That is the
 * whole reason `BreachStatus` has three values instead of two, and it would be undone by one
 * summary line that quietly treats "could not check" as "fine".
 *
 * ## Exhaustive records, not `switch` with a default
 *
 * Both maps below are `Record`s over their unions, so a new reason with no wording is a
 * compile error rather than a blank line in a report about somebody's passwords.
 */

// ── Why it cannot run ────────────────────────────────────────────────────────

export interface BreachUnavailableCopy {
  readonly message: string;
  /** Present only when there is a switch the user can actually reach. */
  readonly action: string;
  /** False when nothing on the settings screen would help — a locked vault. */
  readonly settable: boolean;
}

const UNAVAILABLE: Readonly<Record<BreachUnavailableReason, BreachUnavailableCopy>> = {
  locked: {
    message: 'No vault is open, so there are no passwords to check.',
    action: '',
    settable: false,
  },
  networkOff: {
    message:
      'Keyhold is not allowed to make network requests. While that is off, no connection can be opened at all — this check included, whatever it is set to.',
    action: 'Open network settings',
    settable: true,
  },
  notEnabled: {
    message:
      'This vault has not been opted in. The check is off by default and stays off until you turn it on for this vault.',
    action: 'Turn the check on',
    settable: true,
  },
};

export function breachUnavailable(availability: BreachAvailability): BreachUnavailableCopy {
  // `canRun` with no reason is the healthy state and should never reach here; if it somehow
  // does, the safe answer is the one that offers no capability rather than a blank panel.
  return UNAVAILABLE[availability.reason ?? 'notEnabled'];
}

// ── Why a run was incomplete ─────────────────────────────────────────────────

/**
 * One sentence per failure, written as what happened rather than as an error code.
 *
 * `disabled` is here even though the section normally hides the button in that state: a
 * switch can be turned off while a sweep is in flight, and the report that comes back then
 * has to explain itself rather than reading as a clean result.
 */
const INCOMPLETE: Readonly<Record<BreachUnknownReason, string>> = {
  disabled: 'The check was switched off before it could finish, so nothing was checked.',
  offline:
    'The service could not be reached. Nothing is wrong with your passwords — this run simply did not happen.',
  timeout: 'A request took too long and was abandoned, so the run stopped part-way.',
  rateLimited:
    'The service asked Keyhold to slow down, and asked again after it waited, so the run stopped rather than pressing on.',
  serverError: 'The service returned an error. That is their end, not yours, and not an answer.',
  badResponse:
    'The service answered with something Keyhold could not read. Deliberately not treated as “no match found”.',
  cancelled: 'The run was stopped before it finished.',
};

/** The note under the counts, or `null` when every record got a real answer. */
export function breachIncompleteNote(report: BreachReport): string | null {
  if (report.incompleteReason !== null) return INCOMPLETE[report.incompleteReason];
  if (report.unknownCount === 0) return null;
  return `${String(report.unknownCount)} password(s) did not get an answer, so this is not a complete result.`;
}

// ── The headline ─────────────────────────────────────────────────────────────

/**
 * The one line somebody reads before anything else, and the one most able to mislead.
 *
 * Ordered by what matters: a breach found is said first and plainly; an incomplete run is
 * said before any reassurance; and "nothing found" is only ever claimed over a run where
 * every record actually got an answer. A fault injection that reordered these — putting the
 * clean case first — produced "None of your passwords appear in a known breach" over a sweep
 * that reached nothing at all, which is exactly the sentence this function exists to prevent.
 */
export function breachHeadline(report: BreachReport): string {
  if (report.breachedCount > 0) {
    return report.breachedCount === 1
      ? 'One password has appeared in a known breach. Change it.'
      : `${String(report.breachedCount)} passwords have appeared in known breaches. Change them.`;
  }

  if (report.checkedCount === 0 && report.incompleteReason === null) {
    return 'There were no passwords to check.';
  }

  if (report.incompleteReason !== null || report.unknownCount > 0) {
    return report.checkedCount === 0
      ? 'Nothing was checked.'
      : 'This run did not finish, so nothing here is a clean result.';
  }

  return report.checkedCount === 1
    ? 'The one password checked does not appear in any known breach.'
    : `None of the ${String(report.checkedCount)} passwords checked appear in a known breach.`;
}

/** Every reason has copy — asserted here so the exhaustive `Record` cannot be widened away. */
export const UNAVAILABLE_REASONS_WITH_COPY: readonly BreachUnavailableReason[] =
  BREACH_UNAVAILABLE_REASONS;
