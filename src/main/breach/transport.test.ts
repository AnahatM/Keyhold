// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { BREACH_UNKNOWN_REASONS, type BreachUnknownReason } from '@shared/model/breach.js';
import {
  classifyStatus,
  classifyTransportError,
  MAX_RETRY_AFTER_SECONDS,
  parseRetryAfterSeconds,
} from './transport.js';

/**
 * Tests for the pure half of the transport layer: turning what came back — or what was
 * thrown instead — into one of Keyhold's reasons.
 *
 * The property underneath every case here is one line long and is the reason the feature is
 * safe to ship: **no input to either classifier can produce anything but a reason**, and a
 * reason always means `unknown`. There is no path from a network failure to `safe`.
 */

describe('classifyStatus', () => {
  it('accepts only 200 as an answer', () => {
    expect(classifyStatus(200)).toBeNull();
  });

  it('maps 429 to rateLimited, so the run can back off rather than retry blindly', () => {
    expect(classifyStatus(429)).toBe('rateLimited');
  });

  it('maps every 5xx to serverError', () => {
    for (const status of [500, 502, 503, 504, 599]) {
      expect(classifyStatus(status), String(status)).toBe('serverError');
    }
  });

  it('maps everything else — including a 2xx that is not 200 — to badResponse', () => {
    for (const status of [201, 204, 301, 302, 304, 400, 401, 403, 404, 418, 451]) {
      expect(classifyStatus(status), String(status)).toBe('badResponse');
    }
  });

  it('never returns a reason outside the closed union', () => {
    for (let status = 100; status < 600; status += 1) {
      const reason = classifyStatus(status);
      if (reason !== null) expect(BREACH_UNKNOWN_REASONS).toContain(reason);
    }
  });
});

describe('classifyTransportError', () => {
  /** `fetch` wraps the real failure in a TypeError and hangs the socket error off `cause`. */
  function fetchFailure(code: string): TypeError {
    return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
  }

  it('reads an abort or a deadline as a timeout', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';

    expect(classifyTransportError(abort)).toBe('timeout');
    expect(classifyTransportError(timeout)).toBe('timeout');
  });

  it('reads socket and header deadlines as a timeout, not as being offline', () => {
    for (const code of [
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
    ]) {
      expect(classifyTransportError(fetchFailure(code)), code).toBe('timeout');
    }
  });

  it('reads a DNS failure as offline', () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN']) {
      expect(classifyTransportError(fetchFailure(code)), code).toBe('offline');
    }
  });

  it('reads a refused, reset or unreachable connection as offline', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE']) {
      expect(classifyTransportError(fetchFailure(code)), code).toBe('offline');
    }
  });

  it('reads a TLS failure as offline', () => {
    expect(classifyTransportError(fetchFailure('CERT_HAS_EXPIRED'))).toBe('offline');
  });

  /**
   * The default is not a shrug. Every branch of this function returns a reason, so every
   * branch produces `unknown` — the direction that cannot mislead — and `fetch` rejects for
   * network-layer reasons and essentially nothing else.
   */
  it('never produces anything but a reason, whatever it is handed', () => {
    const nonsense: unknown[] = [
      undefined,
      null,
      'a string',
      42,
      {},
      { cause: null },
      { cause: { code: 12345 } },
      new Error('unhelpful'),
      Symbol('x'),
      [],
    ];
    for (const value of nonsense) {
      const reason: BreachUnknownReason = classifyTransportError(value);
      expect(BREACH_UNKNOWN_REASONS, String(value?.toString?.() ?? value)).toContain(reason);
    }
  });

  it('does not let an error message escape into the reason', () => {
    const reason = classifyTransportError(new Error('connecting to prefix 5BAA6 failed'));
    expect(reason).toBe('offline');
    expect(JSON.stringify(reason)).not.toContain('5BAA6');
  });
});

describe('parseRetryAfterSeconds', () => {
  const NOW = 1_800_000_000_000;

  it('reads the delay-seconds form', () => {
    expect(parseRetryAfterSeconds('5', NOW)).toBe(5);
    expect(parseRetryAfterSeconds('  12  ', NOW)).toBe(12);
    expect(parseRetryAfterSeconds('0', NOW)).toBe(0);
  });

  it('reads the HTTP-date form', () => {
    const at = new Date(NOW + 5_000).toUTCString();
    expect(parseRetryAfterSeconds(at, NOW)).toBe(5);
  });

  /**
   * The header's resolution is one second, and it is the sender's, not ours.
   *
   * `new Date(NOW + 4_200).toUTCString()` is the string `NOW + 4 seconds`: an HTTP-date
   * cannot express a fraction, so `toUTCString` drops it — exactly as a real server would.
   * Expecting `5` from that would be asserting that we round up a two-hundred-millisecond
   * wait the service never asked for, and it was the assertion that was wrong rather than
   * the arithmetic.
   */
  it('takes the header at its own one-second resolution', () => {
    expect(parseRetryAfterSeconds(new Date(NOW + 4_200).toUTCString(), NOW)).toBe(4);
  });

  /**
   * Where the fraction genuinely comes from — and why the rounding goes up.
   *
   * The date names a whole second; `now` is part-way through one. Rounding down would have
   * us retry *before* the moment the service named, which is how a client that is trying to
   * be polite gets itself blocked. Ceiling waits a fraction of a second too long instead,
   * which costs nothing at all.
   */
  it('rounds a part-second wait up rather than down', () => {
    const at = new Date(NOW + 5_000).toUTCString();
    expect(parseRetryAfterSeconds(at, NOW + 200)).toBe(5);
    expect(parseRetryAfterSeconds(at, NOW + 999)).toBe(5);
  });

  it('treats a date already in the past as "retry now"', () => {
    const at = new Date(NOW - 60_000).toUTCString();
    expect(parseRetryAfterSeconds(at, NOW)).toBe(0);
  });

  /**
   * A sweep must not be able to be parked for hours by one header. Anything past the cap
   * comes back as the cap, and the client treats a still-rate-limited run as a reason to
   * stop rather than to wait.
   */
  it('clamps an enormous delay to the cap, in both forms', () => {
    expect(parseRetryAfterSeconds('86400', NOW)).toBe(MAX_RETRY_AFTER_SECONDS);
    expect(parseRetryAfterSeconds(new Date(NOW + 86_400_000).toUTCString(), NOW)).toBe(
      MAX_RETRY_AFTER_SECONDS
    );
  });

  it('returns null for an absent, empty or unreadable header', () => {
    for (const header of [null, '', '   ', 'soon', 'NaN', '-5', '1.5', '99999999999999999999']) {
      expect(parseRetryAfterSeconds(header, NOW), String(header)).toBeNull();
    }
  });
});
