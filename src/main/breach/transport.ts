// SPDX-License-Identifier: GPL-3.0-or-later
import type { BreachUnknownReason } from '@shared/model/breach.js';

/**
 * The seam between the breach client and the network — a contract, and the pure logic for
 * turning what comes back over it into one of Keyhold's three answers.
 *
 * **There is no network code in this file.** That lives in `https-transport.ts`, which is
 * the only module in the codebase permitted to name `fetch`, and which nothing here imports.
 * The separation is load-bearing rather than tidy: `client.ts` depends on the *interface*
 * below and on nothing that can originate a request, so a client built with no transport is
 * not merely configured off — it holds no reference to any code that could reach the
 * network. `no-network.test.ts` enforces that by reading the source of every file in this
 * directory.
 *
 * ## The contract is narrow on purpose
 *
 * `fetchRange` takes a five-character prefix. Not a URL, not a password, not a hash, not a
 * record id, not an options bag that could grow one. A transport implementation is handed
 * twenty bits of a hash and nothing else, so no implementation — including a hostile one
 * substituted by a compromised dependency — can be given anything more than that to send.
 *
 * ## An HTTP error is a returned value; a network failure is a thrown one
 *
 * That split follows `fetch`: a 429 or a 503 is a completed exchange with a status, while a
 * DNS failure or a refused connection never got that far. Both end at the same place — an
 * `unknown` result with a reason — but keeping them distinct means the client never has to
 * guess whether it spoke to the service at all.
 */

/** One completed HTTP exchange. Bodies are read only for 2xx; see `https-transport.ts`. */
export interface RangeResponse {
  readonly status: number;
  /** The response body, or `''` for a status whose body we deliberately do not read. */
  readonly body: string;
  /** `Retry-After`, already normalised to whole seconds. `null` when absent or nonsense. */
  readonly retryAfterSeconds: number | null;
}

export interface BreachTransport {
  /**
   * Requests the suffix list for one range prefix.
   *
   * @param prefix Five upper-case hex characters. The **only** thing that is transmitted.
   * @param signal Abort signal for the caller's deadline. An implementation that ignores
   *   this can hang a whole sweep, so honouring it is part of the contract, not an extra.
   */
  fetchRange(prefix: string, signal: AbortSignal): Promise<RangeResponse>;
}

// ── Classification ───────────────────────────────────────────────────────────

/**
 * What an HTTP status means, or `null` if it means "read the body".
 *
 * Only 200 is an answer. Every other status — including a 304 or a 3xx that somehow
 * survived `redirect: 'error'` — is `badResponse`, because this API has exactly one success
 * shape and anything else is a conversation with something that is not it.
 */
export function classifyStatus(status: number): BreachUnknownReason | null {
  if (status === 200) return null;
  if (status === 429) return 'rateLimited';
  if (status >= 500) return 'serverError';
  return 'badResponse';
}

/**
 * Error codes that mean "the request timed out", as distinct from "it could not start".
 *
 * Worth separating because the advice differs: a timeout suggests trying again, while a
 * refused connection or a failed lookup usually means the machine is offline or something
 * on the path is blocking the request, and retrying will not help.
 */
const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

function errorCode(error: unknown): string | null {
  // `fetch` wraps the real failure: the thrown TypeError carries the socket error as its
  // `cause`. Reading only the top-level object would see "fetch failed" and nothing else.
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    if (candidate !== null && typeof candidate === 'object' && 'code' in candidate) {
      const code = (candidate as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
  }
  return null;
}

/**
 * What a thrown transport failure means.
 *
 * Everything unrecognised lands on `offline`, which is the honest default: `fetch` rejects
 * for network-layer reasons and essentially nothing else, so an unfamiliar rejection is far
 * more likely to be a novel connectivity failure than anything else. It is a safe default in
 * the only sense that matters here — every branch returns a reason, so every branch produces
 * `unknown`, and no error path can ever arrive at `safe`.
 *
 * Caller cancellation is **not** classified here. The client checks its own signal first,
 * because only it can tell an abandoned-by-the-user request from one that hit its deadline.
 */
export function classifyTransportError(error: unknown): BreachUnknownReason {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';

  const code = errorCode(error);
  if (code !== null && TIMEOUT_CODES.has(code)) return 'timeout';

  return 'offline';
}

// ── Retry-After ──────────────────────────────────────────────────────────────

/** Longer than this and we are not waiting; the run stops and reports `rateLimited`. */
export const MAX_RETRY_AFTER_SECONDS = 60;

/**
 * `Retry-After` as whole seconds, in both of the forms RFC 9110 permits: a delay in
 * seconds, or an HTTP date.
 *
 * Clamped at both ends. A negative or absurd value is a header we do not trust, and an
 * honest but enormous one ("try again in six hours") is not something to block a sweep on —
 * the caller treats anything beyond the cap as a reason to stop rather than to wait.
 *
 * `now` is a parameter so the date form is testable without freezing the clock.
 */
export function parseRetryAfterSeconds(header: string | null, now: number): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;

  if (/^\d{1,9}$/.test(trimmed)) {
    return Math.min(Number.parseInt(trimmed, 10), MAX_RETRY_AFTER_SECONDS);
  }

  // Every HTTP-date form RFC 9110 permits begins with a day name, so anything that does not
  // start with a letter is not a date and must not be handed to `Date.parse`. That function
  // is famously willing: it reads `-5` as March 2001 and `1.5` as January 2001, both of
  // which are in the past, which would silently turn a nonsense header into "retry now".
  if (!/^[A-Za-z]/.test(trimmed)) return null;

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;

  const seconds = Math.ceil((at - now) / 1000);
  if (seconds <= 0) return 0;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}
