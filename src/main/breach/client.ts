// SPDX-License-Identifier: GPL-3.0-or-later
import { setTimeout as delay } from 'node:timers/promises';
import {
  DEFAULT_BREACH_CHECK_SETTINGS,
  type BreachCheckResult,
  type BreachUnknownReason,
  type CredentialBreachResult,
} from '@shared/model/breach.js';
import { shuffleInPlace } from '../crypto/random.js';
import { passwordRange } from './hash.js';
import { parseRangeBody } from './range.js';
import {
  classifyStatus,
  classifyTransportError,
  type BreachTransport,
  type RangeResponse,
} from './transport.js';

/**
 * The Have I Been Pwned Pwned Passwords client — Keyhold's single, opt-in, off-by-default
 * exception to "this application makes no network requests".
 *
 * ## What is actually sent, in plain English
 *
 * The password is hashed with SHA-1 on this machine. The **first five hex characters** of
 * that hash — twenty bits — are sent to a public API. The service replies with every hash
 * suffix it holds that begins with those five characters, several hundred of them, and the
 * comparison happens here, offline, against that list.
 *
 * The password never leaves the machine. Neither does the full hash. Neither does anything
 * saying which account the password belongs to — no title, no username, no URL, no record
 * id, and no ordering that would let two sweeps of the same vault be recognised as the same
 * vault: the prefixes of a sweep go out in a **CSPRNG-shuffled** order (see `#run`). The
 * service cannot tell which of the ~800 passwords behind a prefix was being asked about,
 * which is what "k-anonymity" means here and why this is the one network feature that can
 * be defended at all. `hash.ts` holds the arithmetic; `https-transport.ts` holds the request.
 *
 * What an observer *does* learn is inherent and is recorded in the threat model rather than
 * denied here: that this address asked about N prefixes inside one paced window. Padding
 * hides how many candidate passwords sit behind each answer; the shuffle is what stops the
 * *sequence* itself — an ordered multiset of twenty-bit values, stable across sessions if it
 * followed the vault's record order — from being a linking handle of its own.
 *
 * ## "Off by default" is structural, not a flag
 *
 * A setting that defaults to false is one forgotten `if` away from being on. So the off
 * state here is **the absence of the capability**:
 *
 *   - The client takes a `BreachTransport`. Construct it with none — `new
 *     PwnedPasswordsClient()` — and there is nothing it can send with.
 *   - There is no fallback. It does not lazily import a transport, construct a default one,
 *     or reach for `fetch`. In fact this module imports nothing that can make a request:
 *     the real transport lives in `https-transport.ts`, which nothing here references.
 *     `no-network.test.ts` enforces that by reading the source of every file here.
 *   - With no transport, a check returns `unknown` / `disabled` **without hashing the
 *     password at all**. Not "computes the prefix and then declines to send it" — it never
 *     touches the password. `no-network.test.ts` spies on `passwordRange` and asserts it is
 *     never called, because that is the difference between a feature that is off and a
 *     feature that is merely quiet.
 *
 * Turning the setting on is what causes a transport to be built and handed in, at the
 * composition root. Nothing further down the stack can turn the network on.
 *
 * ## Three answers, and why the third one matters most
 *
 * `breached`, `safe`, `unknown`. Every failure — no transport, offline, DNS failure, a
 * timeout, a 429, a 5xx, a body that is not a suffix list — lands on `unknown` with a
 * reason. **None of them can produce `safe`.** A user who reads "not found in any breach"
 * about a password nobody managed to check is worse off than one who was told nothing, and
 * the failure mode that produces it is a single missing `else`.
 *
 * ## Sweeping a vault without abusing a free service
 *
 * A vault of 3,000 records is not 3,000 requests. Passwords are grouped by prefix, so
 * duplicated passwords collapse to one lookup and unrelated passwords sharing a prefix ride
 * along with it; ranges already fetched this session are reused; requests are spaced by a
 * configurable interval; a 429 is honoured once and then stops the run rather than being
 * retried into the ground; and a run that has failed several times consecutively gives up
 * instead of grinding through thousands of doomed requests at ten seconds each.
 *
 * ## Nothing is persisted, and nothing is logged
 *
 * No result is written to disk, no hash is stored, and no "this password was breached" flag
 * is kept anywhere — a stored flag is a stored fact about a password, and it would outlive
 * both the password and the user's opt-in. The range cache is memory-only, bounded, and
 * dropped by `clearCache()` — **an obligation of whoever holds the client, and today
 * unwired**; see that method. There is no logging in this directory at all, and a property
 * test asserts that nothing returned from it contains a password, a hash, a suffix or a
 * prefix.
 */

/** One record's password, ready to be checked. Never leaves the main process. */
export interface BreachCheckInput {
  readonly credentialId: string;
  /** Named for what it is, per the project's secret-naming convention. */
  readonly secretPassword: string;
}

export interface BreachRunOptions {
  readonly signal?: AbortSignal | undefined;
}

/**
 * What a sweep produced.
 *
 * `requestCount` is reported rather than inferred because "how many requests did checking
 * my vault actually make?" is a question a user of a zero-network application is entitled
 * to a real answer to, and because it is the assertion that proves deduplication works.
 */
export interface BreachRunSummary {
  readonly results: readonly CredentialBreachResult[];
  /** Requests actually sent, retries included. Far below the record count on a real vault. */
  readonly requestCount: number;
  /** Why the run was incomplete, if it was. `null` when every record got a real answer. */
  readonly incompleteReason: BreachUnknownReason | null;
}

export interface PwnedPasswordsClientOptions {
  /**
   * **Omit this and the client does nothing.** There is no default and no fallback; see
   * the file header. Only the code acting on the user's opt-in should pass one.
   */
  readonly transport?: BreachTransport | undefined;
  readonly requestIntervalMs?: number | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly maxCachedRanges?: number | undefined;
  /** Injected in tests so a paced sweep runs instantly instead of in real seconds. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Injected in tests. Used only for request pacing, never for a reported timestamp. */
  readonly now?: (() => number) | undefined;
}

/**
 * Consecutive prefix failures before a run gives up.
 *
 * A machine that is offline fails every request identically, and grinding through 3,000 of
 * them at a ten-second timeout apiece is forty minutes of a spinner for an answer that was
 * available after the third. Three is enough to ride out a single flaky response without
 * pretending a dead network might recover on request 2,999.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Backoff after a 429 that arrived without a usable `Retry-After`. */
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 2_000;

/**
 * Ranges kept in memory.
 *
 * Each cached body is tens of kilobytes once padded, so this is a few megabytes at the
 * ceiling — worth it to make re-opening the dashboard free, not worth letting grow without
 * limit. Bodies are cached rather than parsed maps because the string is smaller than the
 * `Map` built from it, and because re-parsing on a hit means a cached answer and a fresh one
 * are computed by exactly the same code.
 */
const DEFAULT_MAX_CACHED_RANGES = 128;

interface PreparedEntry {
  readonly credentialId: string;
  readonly suffix: string;
  /**
   * Where this record sat in `inputs`.
   *
   * Requests go out in a random order (see `#run`) and results are handed back in the
   * caller's order. Keeping the two orders separate means the privacy property costs the
   * caller nothing: a dashboard still renders records in the order it asked about them.
   */
  readonly inputIndex: number;
}

/** A completed prefix fetch: a body, or the reason there isn't one. */
type RangeOutcome =
  | { readonly body: string }
  | { readonly reason: BreachUnknownReason; readonly retryAfterSeconds?: number | null };

const unknownResult = (reason: BreachUnknownReason): BreachCheckResult => ({
  status: 'unknown',
  count: 0,
  reason,
});

/**
 * Whether the caller has cancelled.
 *
 * A function rather than the same expression written inline, because `aborted` looks like an
 * ordinary readonly property to the type checker: once it has been read as `false`, every
 * later check in the same block is narrowed to dead code and rejected. It is in fact the one
 * property here that changes underneath a running function, which is exactly what makes the
 * check *after* an `await` the important one — and putting it behind a call is what keeps
 * those checks alive rather than optimised away by narrowing.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export class PwnedPasswordsClient {
  readonly #transport: BreachTransport | null;
  readonly #requestIntervalMs: number;
  readonly #requestTimeoutMs: number;
  readonly #maxCachedRanges: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;

  /** prefix → response body. Memory only; never written anywhere. */
  readonly #ranges = new Map<string, string>();

  /** Earliest time the next request may be sent. Paces across calls, not just within one. */
  #nextRequestAt = 0;

  constructor(options: PwnedPasswordsClientOptions = {}) {
    this.#transport = options.transport ?? null;
    this.#requestIntervalMs =
      options.requestIntervalMs ?? DEFAULT_BREACH_CHECK_SETTINGS.requestIntervalMs;
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_BREACH_CHECK_SETTINGS.requestTimeoutMs;
    this.#maxCachedRanges = options.maxCachedRanges ?? DEFAULT_MAX_CACHED_RANGES;
    this.#sleep = options.sleep ?? ((ms) => delay(ms));
    this.#now = options.now ?? Date.now;
  }

  /** Whether this client can reach the network at all. False unless a transport was given. */
  get enabled(): boolean {
    return this.#transport !== null;
  }

  /** Ranges held in memory. Diagnostic; says nothing about any password. */
  get cachedRangeCount(): number {
    return this.#ranges.size;
  }

  /**
   * Drops every cached range. **The lock path must call this, and today nothing does.**
   *
   * The cache is per-client and outlives a sweep on purpose — reopening the dashboard should
   * not re-ask the service the same questions — so it is not self-cleaning, and a client held
   * across a lock/unlock cycle would carry it over. The cached keys are the prefixes of
   * passwords in the vault that was open: a partial twenty-bit fingerprint of that vault,
   * sitting in main-process memory after the event whose entire meaning is that nothing
   * derived from the vault is still there.
   *
   * So this is not dead code and it is not a convenience — it is half of an obligation whose
   * other half belongs at the composition root, next to where the DEK is destroyed
   * (`SessionController.lock()`), together with the guard that proves it happens. Discarding
   * the whole client on lock satisfies it equally well. Recorded in
   * `docs/05-Features/07-Breach-Check.md` §7 as outstanding, because a wiring obligation with
   * no caller is exactly the kind that gets lost between a module and its composition root.
   */
  clearCache(): void {
    this.#ranges.clear();
  }

  /**
   * Checks one password.
   *
   * Returns the exact corpus count, which is why this is a main-process API: the count is a
   * fact about a password, and it is reduced to a band before anything crosses to the
   * renderer. See `BREACH_EXPOSURE_BANDS` and `projection.ts`.
   *
   * An empty password is `unknown` rather than `safe`: the empty string does have a SHA-1
   * and does appear in the corpus, but "you have not set a password yet" is not a breach
   * finding, and the health rules already flag it as `incomplete`.
   */
  async check(secretPassword: string, options: BreachRunOptions = {}): Promise<BreachCheckResult> {
    // The password is not hashed on this path. "Off" means the password is not touched.
    if (this.#transport === null) return unknownResult('disabled');
    if (secretPassword === '') return unknownResult('badResponse');

    const { results } = await this.#run([{ credentialId: '', secretPassword }], options);
    const only = results[0];
    if (only === undefined) return unknownResult('cancelled');
    return { status: only.status, count: only.count, reason: only.reason };
  }

  /**
   * Checks many passwords, sharing one lookup between every password in the same range.
   *
   * Records with no password are skipped entirely rather than reported: there is nothing to
   * check, and reporting them would inflate the "could not check" count with records that
   * were never checkable.
   */
  async checkMany(
    inputs: readonly BreachCheckInput[],
    options: BreachRunOptions = {}
  ): Promise<BreachRunSummary> {
    if (this.#transport === null) {
      return {
        results: inputs
          .filter((input) => input.secretPassword !== '')
          .map((input) => ({ credentialId: input.credentialId, ...unknownResult('disabled') })),
        requestCount: 0,
        incompleteReason: 'disabled',
      };
    }
    return this.#run(inputs, options);
  }

  // ── The run ────────────────────────────────────────────────────────────────

  async #run(
    inputs: readonly BreachCheckInput[],
    options: BreachRunOptions
  ): Promise<BreachRunSummary> {
    // Grouping by prefix is the whole reason a 3,000-record vault is not 3,000 requests:
    // duplicated passwords collapse into one entry list, and unrelated passwords that
    // happen to share a prefix are answered by the same response.
    const byPrefix = new Map<string, PreparedEntry[]>();
    inputs.forEach((input, inputIndex) => {
      if (input.secretPassword === '') return;
      const { prefix, suffix } = passwordRange(input.secretPassword);
      const entry: PreparedEntry = { credentialId: input.credentialId, suffix, inputIndex };
      const bucket = byPrefix.get(prefix);
      if (bucket === undefined) byPrefix.set(prefix, [entry]);
      else bucket.push(entry);
    });

    /**
     * The order the prefixes go out in — **randomised, and that is a privacy control.**
     *
     * A `Map` iterates in insertion order, so walking `byPrefix` directly would send the
     * prefixes in the order the records appear in the vault. That order is stable: the same
     * vault swept a month later, from a different address, would emit very nearly the same
     * ordered sequence, and an ordered multiset of a few hundred twenty-bit values is a
     * strong handle for linking two sweeps to one vault. `Add-Padding` hides *how many*
     * candidates sit behind each prefix and the count of requests is inherent — but the
     * order is not inherent, and unshuffled it hands back exactly the grouping the rest of
     * the design is spent denying.
     *
     * `shuffleInPlace` is the project's CSPRNG-backed Fisher-Yates, via `randomInt`'s
     * rejection sampling. A biased shuffle would leak a little of the original order back,
     * and `Math.random()` is banned project-wide for precisely this class of use.
     */
    const order = shuffleInPlace([...byPrefix]);

    /** Results as they are produced, tagged so they can be restored to the caller's order. */
    const collected: { readonly at: number; readonly result: CredentialBreachResult }[] = [];
    let requestCount = 0;
    let consecutiveFailures = 0;
    /** Set once the run has given up; every remaining record inherits it. */
    let stoppedBy: BreachUnknownReason | null = null;

    const record = (entries: readonly PreparedEntry[], result: BreachCheckResult): void => {
      for (const entry of entries) {
        collected.push({
          at: entry.inputIndex,
          result: { credentialId: entry.credentialId, ...result },
        });
      }
    };

    for (const [prefix, entries] of order) {
      if (stoppedBy !== null) {
        record(entries, unknownResult(stoppedBy));
        continue;
      }
      if (isAborted(options.signal)) {
        stoppedBy = 'cancelled';
        record(entries, unknownResult('cancelled'));
        continue;
      }

      const cached = this.#ranges.get(prefix);
      let outcome: RangeOutcome;
      if (cached === undefined) {
        const before = requestCount;
        outcome = await this.#fetchRange(prefix, options.signal, () => {
          requestCount += 1;
        });
        // Only successes are cached. A transient failure that stuck for the whole session
        // would turn one bad moment into a vault that cannot be checked again until restart.
        if ('body' in outcome) this.#remember(prefix, outcome.body);
        // Defensive: a transport that answered without us counting would break the claim
        // `requestCount` makes. It cannot happen, and it is cheap to make sure.
        if (requestCount === before && 'body' in outcome) requestCount += 1;
      } else {
        outcome = { body: cached };
      }

      if ('reason' in outcome) {
        record(entries, unknownResult(outcome.reason));

        // A 429 stops the run outright. The service has asked us twice to go away, and a
        // client that keeps asking after that is why free services stop being free.
        if (outcome.reason === 'rateLimited' || outcome.reason === 'cancelled') {
          stoppedBy = outcome.reason;
          continue;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) stoppedBy = outcome.reason;
        continue;
      }

      consecutiveFailures = 0;
      for (const entry of entries) {
        const parsed = parseRangeBody(outcome.body, entry.suffix);
        // A body we cannot read is `unknown`. It is never "no match found" — see `range.ts`.
        record(
          [entry],
          parsed.kind === 'malformed'
            ? unknownResult('badResponse')
            : { status: parsed.count > 0 ? 'breached' : 'safe', count: parsed.count, reason: null }
        );
      }
    }

    // Back into the caller's order. Sorted rather than pre-placed because records with no
    // password are skipped entirely, so `inputIndex` is sparse and there is no slot to fill.
    const results = collected
      .sort((left, right) => left.at - right.at)
      .map((entry) => entry.result);

    return { results, requestCount, incompleteReason: stoppedBy ?? firstUnknownReason(results) };
  }

  // ── One range ──────────────────────────────────────────────────────────────

  /** Fetches a range, honouring one `Retry-After` if the service asks. Never throws. */
  async #fetchRange(
    prefix: string,
    signal: AbortSignal | undefined,
    countRequest: () => void
  ): Promise<RangeOutcome> {
    const first = await this.#fetchOnce(prefix, signal, countRequest);
    if (!('reason' in first) || first.reason !== 'rateLimited') return first;

    // One retry, at the interval the service itself asked for. `retryAfterSeconds` is
    // already clamped by `parseRetryAfterSeconds`, so this cannot become an unbounded wait.
    const retryAfter = first.retryAfterSeconds;
    await this.#sleep(
      retryAfter === null || retryAfter === undefined
        ? DEFAULT_RATE_LIMIT_BACKOFF_MS
        : retryAfter * 1000
    );
    if (isAborted(signal)) return { reason: 'cancelled' };

    const second = await this.#fetchOnce(prefix, signal, countRequest);
    // Whatever the second attempt says, a repeated 429 is reported as `rateLimited` and
    // stops the run. There is no third attempt.
    return second;
  }

  async #fetchOnce(
    prefix: string,
    signal: AbortSignal | undefined,
    countRequest: () => void
  ): Promise<RangeOutcome> {
    const transport = this.#transport;
    if (transport === null) return { reason: 'disabled' };

    await this.#pace();
    if (isAborted(signal)) return { reason: 'cancelled' };

    let response: RangeResponse;
    try {
      countRequest();
      response = await transport.fetchRange(prefix, this.#requestSignal(signal));
    } catch (error) {
      // The caller's own abort is not a network failure and must not be reported as one.
      if (isAborted(signal)) return { reason: 'cancelled' };
      // Whatever the transport threw stays here. Only a reason from the closed union
      // escapes, so no message, stack or cause can carry a prefix out of this module.
      return { reason: classifyTransportError(error) };
    }

    const statusFault = classifyStatus(response.status);
    if (statusFault !== null) {
      return { reason: statusFault, retryAfterSeconds: response.retryAfterSeconds };
    }
    return { body: response.body };
  }

  /**
   * The signal handed to the transport: the caller's, plus our own deadline.
   *
   * The deadline is ours rather than the transport's because a hung request must not be able
   * to hold a whole sweep open, and a transport supplied from outside cannot be trusted to
   * enforce a limit it was never told about.
   */
  #requestSignal(signal: AbortSignal | undefined): AbortSignal {
    const timeout = AbortSignal.timeout(this.#requestTimeoutMs);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  }

  /**
   * Waits until the next request is due.
   *
   * The gate is a timestamp rather than a "sleep between iterations", so pacing holds across
   * separate `check` calls as well as within one sweep — twenty single checks fired from the
   * UI in quick succession are spaced exactly as a sweep of twenty would be.
   */
  async #pace(): Promise<void> {
    const wait = this.#nextRequestAt - this.#now();
    if (wait > 0) await this.#sleep(wait);
    this.#nextRequestAt = this.#now() + this.#requestIntervalMs;
  }

  #remember(prefix: string, body: string): void {
    if (this.#maxCachedRanges <= 0) return;
    // Insertion-ordered eviction: the oldest range goes first. A sweep walks prefixes once,
    // so recency and insertion order are the same thing here and an LRU would buy nothing.
    while (this.#ranges.size >= this.#maxCachedRanges) {
      const oldest: string | undefined = this.#ranges.keys().next().value;
      if (oldest === undefined) break;
      this.#ranges.delete(oldest);
    }
    this.#ranges.set(prefix, body);
  }
}

/** The reason to show when a run finished but some records still have no answer. */
function firstUnknownReason(
  results: readonly CredentialBreachResult[]
): BreachUnknownReason | null {
  for (const result of results) {
    if (result.reason !== null) return result.reason;
  }
  return null;
}
