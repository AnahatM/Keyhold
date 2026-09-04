// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The shape of a Have I Been Pwned breach check, and the vocabulary its outcomes are
 * described in.
 *
 * Lives in `@shared` because the health dashboard renders these outcomes: it needs the
 * status names to label them, the reasons to explain a failure in plain English, and the
 * report shape to draw it. **The check itself runs in the main process only** — see
 * `src/main/breach/` — because that is the only place a password exists.
 *
 * **This file is types and declarative constants. No logic, and no Node imports** — it is
 * compiled into the renderer bundle, which has no Node at all and must never gain the
 * ability to originate a request.
 *
 * ## Why this is the one exception to "zero network"
 *
 * Keyhold makes no network requests. This is the single documented exception, and it is
 * only defensible because of **k-anonymity**, which is worth stating precisely:
 *
 *   1. The password is hashed locally with SHA-1.
 *   2. Only the **first five hex characters** of that hash are sent — 20 bits.
 *   3. The service answers with every hash suffix it holds beginning with those five
 *      characters: several hundred to a thousand of them.
 *   4. The comparison happens here, offline, against that list.
 *
 * So the service never sees the password, never sees the full hash, and cannot tell which
 * of the ~800 candidates behind the prefix was being asked about — let alone which account
 * it belongs to, which is never sent in any form. A network observer learns that Keyhold
 * asked about *something*. That residual leak is recorded in the threat model
 * (`docs/00-Overview/03-Threat-Model.md`, §2) rather than hidden.
 *
 * It is still off by default, because "we thought about it and it is probably fine" is not
 * a decision to make on a user's behalf in a password manager.
 *
 * ## Three states, never two
 *
 * `breached` · `safe` · `unknown`. The third is not a nicety. If a lookup that failed —
 * offline, timed out, rate-limited, garbled — were reported as `safe`, a user would read
 * "no breaches found" and believe something nobody actually checked. Every failure path in
 * `src/main/breach/` therefore lands on `unknown` with a reason, and the UI must render
 * that visibly differently from a clean result.
 */

// ── Status ───────────────────────────────────────────────────────────────────

export const BREACH_STATUSES = ['breached', 'safe', 'unknown'] as const;
export type BreachStatus = (typeof BREACH_STATUSES)[number];

/**
 * Why a check could not produce an answer.
 *
 * Kept as a closed union rather than a free-form message so the UI can phrase each one
 * itself, and — more importantly — so no failure path can ever smuggle a fragment of a
 * password, a hash or a prefix into a human-readable string that then crosses the bridge.
 *
 *   disabled       No transport was supplied, so the client did nothing. This is the
 *                  default state of the whole feature. See `PwnedPasswordsClient`.
 *   offline        The service could not be reached at all — no route, DNS failure,
 *                  connection refused, TLS failure. All one thing to a user.
 *   timeout        A request was abandoned at its deadline rather than left hanging.
 *   rateLimited    The service asked us to slow down (HTTP 429) and said so again after
 *                  we waited. The run stops there rather than hammering it.
 *   serverError    HTTP 5xx. Their problem, not ours, and not an answer.
 *   badResponse    A 4xx, or a body that is not a suffix list. Deliberately **not**
 *                  treated as "no match found" — see `parseRangeBody`.
 *   cancelled      The caller aborted the run.
 */
export const BREACH_UNKNOWN_REASONS = [
  'disabled',
  'offline',
  'timeout',
  'rateLimited',
  'serverError',
  'badResponse',
  'cancelled',
] as const;
export type BreachUnknownReason = (typeof BREACH_UNKNOWN_REASONS)[number];

// ── One password's result ────────────────────────────────────────────────────

/**
 * The outcome of checking one password, as it exists **inside the main process**.
 *
 * `count` is the number of times the exact password appears in the corpus. It is genuinely
 * useful — "seen 3 times" and "seen 24 million times" are different advice — but it is also
 * a fact *about* a password, so it does not cross the bridge unreduced. `BreachProjection`
 * is the shape that does.
 */
export interface BreachCheckResult {
  readonly status: BreachStatus;
  /** Occurrences in the corpus. `0` for `safe` and for `unknown`; never negative. */
  readonly count: number;
  /** Non-null if and only if `status` is `unknown`. */
  readonly reason: BreachUnknownReason | null;
}

/**
 * One record's result, still carrying the exact count.
 *
 * **Main-process only.** It is declared here rather than in `src/main/breach/` so that this
 * file can hold the whole vocabulary in one place and say, next to each shape, whether it
 * crosses the bridge. This one does not: `toBreachProjection` in
 * `src/main/breach/projection.ts` is what turns it into something that may.
 */
export interface CredentialBreachResult extends BreachCheckResult {
  readonly credentialId: string;
}

// ── What may cross to the renderer ───────────────────────────────────────────

/**
 * Exposure bands, coarsest-first in severity terms.
 *
 * The renderer gets a band rather than the exact count, and the reason is the same one that
 * made health cluster ids synthetic counters instead of hashes (decision D13): an exact
 * corpus count is a near-unique fingerprint. There are hundreds of millions of passwords in
 * the corpus but very few of them appear *exactly* 3,861,493 times, so an exact count
 * crossing into the semi-trusted renderer would be a stable handle that narrows a search for
 * the password itself. A band of four buckets narrows it to tens of millions of candidates,
 * which is to say not at all.
 *
 * The advice the user needs — "change this now" versus "change this" — survives the
 * reduction completely, so nothing is lost by making it.
 */
export const BREACH_EXPOSURE_BANDS = ['none', 'low', 'high', 'severe'] as const;
export type BreachExposureBand = (typeof BREACH_EXPOSURE_BANDS)[number];

/**
 * Band boundaries, published so the dashboard's wording is arguable rather than magic.
 *
 * `low` (1–9) is still a breach and still means change it; the band exists because a
 * password appearing nine times is plausibly one person's leak, while one appearing a
 * hundred thousand times is in every cracking dictionary on earth and will be tried first.
 */
export const BREACH_BAND_THRESHOLDS: Readonly<Record<'high' | 'severe', number>> = {
  high: 10,
  severe: 100_000,
};

/** The renderer-facing outcome for one record. Carries no count and no hash. */
export interface BreachProjection {
  readonly credentialId: string;
  readonly status: BreachStatus;
  readonly band: BreachExposureBand;
  readonly reason: BreachUnknownReason | null;
}

// ── A whole-vault run ────────────────────────────────────────────────────────

/**
 * The result of sweeping a vault.
 *
 * Deliberately reports `unknownCount` alongside the other two: a run where a third of the
 * records could not be reached is not a clean bill of health, and a summary that only said
 * "2 breached" would read as though the other 98 had been cleared.
 */
export interface BreachReport {
  /** The `now` the caller supplied. The report is a pure function of its inputs and this. */
  readonly generatedAt: number;
  readonly checkedCount: number;
  readonly breachedCount: number;
  readonly safeCount: number;
  readonly unknownCount: number;
  /** Distinct prefixes actually requested. Far below `checkedCount` on a real vault. */
  readonly requestCount: number;
  /**
   * Why the run was incomplete, if it was — the first failure that stopped it, or the
   * reason shared by the unknown results. `null` when every record got a real answer.
   */
  readonly incompleteReason: BreachUnknownReason | null;
  readonly results: readonly BreachProjection[];
}

// ── Whether it can run at all ────────────────────────────────────────────────

/**
 * Why the breach check cannot run, or `null` when it can.
 *
 * A closed union, and ordered by how the answer is decided — the first thing that is false
 * is the reason. That ordering is the reason this is a union rather than three booleans the
 * UI would have to prioritise itself: with three booleans, two surfaces would eventually
 * disagree about which of "locked" and "switched off" to mention first, and the user would
 * be told to change a setting that would not have helped.
 *
 *   locked         No vault is open, so there are no passwords to check.
 *   networkOff     The machine-scoped kill-switch is down. It dominates everything: while
 *                  it is off, no part of this app may make a request, and turning the
 *                  vault's own setting on would change nothing.
 *   notEnabled     The vault's own opt-in has never been given. The default, and the one
 *                  the user is *meant* to meet — it is what the consent step exists for.
 */
export const BREACH_UNAVAILABLE_REASONS = ['locked', 'networkOff', 'notEnabled'] as const;
export type BreachUnavailableReason = (typeof BREACH_UNAVAILABLE_REASONS)[number];

/**
 * What the dashboard needs to know before it offers a button.
 *
 * Both switches are reported, not only the verdict, because the user has to be told *which*
 * one to change — and because "the kill-switch is down" and "you have not opted in" call for
 * different sentences and different links. `canRun` is derived here rather than in the
 * renderer so the app has one answer to the question rather than one per screen.
 */
export interface BreachAvailability {
  /**
   * What `NetworkPolicy` answered — **not** the stored `networkAllowed` preference.
   *
   * The name is different on purpose, and `network-policy.test.ts` is why. That guard fails
   * any module outside `NetworkPolicy` that branches on `networkAllowed`, and it failed this
   * file, correctly: a field with that name being tested in a conditional is
   * indistinguishable, to a reader or to a regex, from a second module deciding whether the
   * network may be used. It is not one — the decision has already been made and this is the
   * verdict travelling — and the way to say so is to stop calling it by the preference's
   * name rather than to add an exemption. The guard's own header argues that exemption lists
   * are how a check stops checking; this keeps it sharp enough to catch the real thing.
   */
  readonly networkPermitted: boolean;
  /** The open vault's own opt-in. False when no vault is open. */
  readonly enabled: boolean;
  readonly vaultOpen: boolean;
  readonly canRun: boolean;
  readonly reason: BreachUnavailableReason | null;
}

/**
 * The single derivation of "can this run", used by the main process and asserted in tests.
 *
 * In `shared/` rather than in main because the renderer's tests build availability objects
 * too, and a second implementation of this rule is exactly how a dashboard comes to offer a
 * button that does nothing. Rule 8.
 */
export function breachAvailability(input: {
  /** `NetworkPolicy.allowsNetwork()`. See the note on `BreachAvailability` for the name. */
  readonly networkPermitted: boolean;
  readonly enabled: boolean;
  readonly vaultOpen: boolean;
}): BreachAvailability {
  const reason: BreachUnavailableReason | null = !input.vaultOpen
    ? 'locked'
    : !input.networkPermitted
      ? 'networkOff'
      : !input.enabled
        ? 'notEnabled'
        : null;

  return {
    networkPermitted: input.networkPermitted,
    enabled: input.enabled,
    vaultOpen: input.vaultOpen,
    canRun: reason === null,
    reason,
  };
}

// ── The setting ──────────────────────────────────────────────────────────────

/**
 * The user-facing switch, per decision D10 (every feature ships a setting).
 *
 * `enabled: false` is the default and the code does not merely *read* it as false — the
 * client is constructed with no transport unless something explicitly hands it one, so the
 * off state is the absence of the capability rather than a flag someone might forget to
 * check. See the header of `src/main/breach/client.ts`.
 */
export interface BreachCheckSettings {
  /** Off. Turning this on is what causes a transport to be constructed at all. */
  readonly enabled: boolean;
  /**
   * Milliseconds between requests during a sweep. The range API is free, unauthenticated
   * and run at someone else's expense; a client that fires as fast as it can is abusing it.
   */
  readonly requestIntervalMs: number;
  /** Per-request deadline. A hung request must not hold a sweep open indefinitely. */
  readonly requestTimeoutMs: number;
}

export const DEFAULT_BREACH_CHECK_SETTINGS: BreachCheckSettings = {
  enabled: false,
  requestIntervalMs: 100,
  requestTimeoutMs: 10_000,
};
