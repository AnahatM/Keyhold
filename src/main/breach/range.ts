// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Parsing a Pwned Passwords range response, defensively.
 *
 * The body is a plain-text list, one entry per line:
 *
 * ```
 * 003D68EB55068C33ACE09247EE4C639306B:3
 * 012C192B2F16F82EA0EB9EF18D9D539B0DD:1
 * ```
 *
 * — a thirty-five character hex suffix, a colon, and how many times the password with that
 * full hash appears in the corpus. Whether our password is in there is decided by looking
 * for our own suffix in that list, entirely offline.
 *
 * ## The failure direction is the whole point of this file
 *
 * There are two ways to not find a suffix in a list: because it genuinely is not there, and
 * because what came back was not a list. The first means "this password is not in the
 * corpus". The second means "we do not know". Conflating them reports a captive-portal
 * login page, a proxy error, or a truncated body as **good news**, and a user who reads
 * "not found in any breach" believes something nobody checked.
 *
 * So parsing here is strict on purpose. This format is machine-generated and completely
 * uniform: every non-blank line matches one shape. A single line that does not is enough to
 * conclude that we are not looking at what we think we are looking at, and the honest answer
 * from that point is `malformed` — never a match count, and never zero.
 *
 * ## Padding rows and why a count of zero is not a match
 *
 * Requests are sent with `Add-Padding: true`, so the service mixes in randomly generated
 * suffixes that are not in the corpus, each with a count of **0**. Those rows exist to make
 * every response roughly the same size (see `https-transport.ts` for why that matters), and
 * they are not answers. `0` therefore means "not present" wherever it appears, including in
 * the vanishingly unlikely case that a padding row collides with the suffix being sought.
 *
 * ## Nothing in this file is logged, thrown with, or returned
 *
 * The parse result carries a count and a fault name. It never carries the body, a line from
 * the body, the suffix that was searched for, or a prefix. A "malformed response: <body>"
 * error message would put an attacker-controlled blob — and, next to it in the same log
 * line, the prefix that identifies which passwords it concerns — somewhere permanent.
 */

/** Beyond this the body is not a range response, and reading it is someone's DoS. */
export const MAX_RANGE_BODY_BYTES = 1024 * 1024;

/**
 * A well-formed entry line, anchored at both ends.
 *
 * Case-insensitive on the hex: the service answers in upper case today, and matching on
 * that would be an undocumented dependency on a detail that costs nothing to be robust
 * against. Counts are capped at fifteen digits so a body claiming a count of four hundred
 * digits cannot turn into `Infinity` and then into a `breached` verdict on a number that
 * was never a number.
 */
const ENTRY_LINE = /^([0-9A-Fa-f]{35}):(\d{1,15})$/;

/** Why a body could not be read as a suffix list. Names only — never content. */
export const RANGE_FAULTS = ['oversized', 'empty', 'unparseableLine'] as const;
export type RangeFault = (typeof RANGE_FAULTS)[number];

export type RangeParse =
  | {
      readonly kind: 'ok';
      /** Occurrences of the sought suffix. `0` means it is genuinely not in the corpus. */
      readonly count: number;
      /** Entries the body contained, padding included. Useful for sanity, never secret. */
      readonly entryCount: number;
    }
  | { readonly kind: 'malformed'; readonly fault: RangeFault };

/**
 * Looks for `suffix` in a range response body.
 *
 * Matching is **case-insensitive**, in both directions: the body is normalised to upper
 * case and so is the suffix, so neither a lower-case response nor a lower-case caller can
 * turn a real match into a silent miss. Hex is hex; the case carries no meaning and must
 * not be allowed to carry a verdict.
 *
 * Where a suffix appears more than once with different counts — which should be impossible,
 * and would mean the body is not what it claims — the **largest** wins. Between two readings
 * of an already-suspect body, the one that tells the user to change their password is the
 * one that cannot hurt them.
 */
export function parseRangeBody(body: string, suffix: string): RangeParse {
  if (body.length > MAX_RANGE_BODY_BYTES) return { kind: 'malformed', fault: 'oversized' };

  const wanted = suffix.toUpperCase();
  let entryCount = 0;
  let count = 0;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    // Blank lines are formatting, not content: a trailing newline is normal and a body
    // separated by blank lines is still perfectly readable.
    if (line === '') continue;

    const match = ENTRY_LINE.exec(line);
    // Strict, and deliberately so — see the header. One line we cannot read means the
    // whole body is untrustworthy, and the honest verdict is "unknown".
    if (match === null) return { kind: 'malformed', fault: 'unparseableLine' };

    entryCount += 1;
    if (match[1]?.toUpperCase() !== wanted) continue;

    // `\d{1,15}` guarantees this parses to a safe integer, so no NaN check is reachable.
    const parsed = Number.parseInt(match[2] ?? '0', 10);
    if (parsed > count) count = parsed;
  }

  // An empty body is not "no matches". A real range response always has entries — with
  // padding on, hundreds of them — so nothing at all means the response was not one.
  if (entryCount === 0) return { kind: 'malformed', fault: 'empty' };

  return { kind: 'ok', count, entryCount };
}
