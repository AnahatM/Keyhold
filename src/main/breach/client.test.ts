// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { passwordRange } from './hash.js';
import { PwnedPasswordsClient, type BreachCheckInput } from './client.js';
import type { BreachTransport, RangeResponse } from './transport.js';

/**
 * Tests for the sweep: what it answers, how many times it asks, and what it does when the
 * asking goes wrong.
 *
 * **Every test here runs against an injected fake transport.** Nothing in this file can make
 * a request, and `no-network.test.ts` proves the module could not make one on its own even if
 * a test forgot to inject anything.
 *
 * Three properties are worth more than the rest:
 *
 * - **No failure produces `safe`.** Offline, timed out, rate-limited, 5xx, 4xx, a body that
 *   is not a suffix list — each has its own case below, and each asserts `unknown` rather
 *   than merely "not the count we expected". A user who reads "not found in any breach" about
 *   a password nobody managed to check is worse off than one who was told nothing.
 * - **A vault of records is not a request per record.** Duplicated passwords and unrelated
 *   passwords sharing a prefix collapse into one lookup, cached ranges are reused, and a run
 *   that is clearly doomed stops instead of grinding through thousands of doomed requests.
 * - **Nothing that comes back out names a password.** Asserted as a property over the whole
 *   returned structure, against the password, its full digest, its prefix and its suffix.
 */

// ── A fake service ───────────────────────────────────────────────────────────

/** Passwords the fake corpus knows about, and how many times it claims to have seen them. */
const CORPUS: Readonly<Record<string, number>> = {
  password: 3_861_493,
  hunter2: 7,
};

/** A password the fake corpus has never heard of. Its lookups come back padding-only. */
const UNBREACHED = 'a-password-nobody-has-ever-chosen-4f2c';

const paddingRow = (character: string): string => `${character.repeat(35)}:0`;

/**
 * A range response for one prefix, built the way the real service builds one.
 *
 * Padding rows are always present because requests go out with `Add-Padding: true`, so a
 * prefix with no corpus entry still comes back as a non-empty list — which is what makes
 * "no match in a real list" (`safe`) distinguishable from "not a list at all" (`unknown`).
 */
function corpusBody(prefix: string): string {
  const lines: string[] = [];

  for (const [secretPassword, count] of Object.entries(CORPUS)) {
    const range = passwordRange(secretPassword);
    if (range.prefix === prefix) lines.push(`${range.suffix}:${count}`);
  }

  lines.push(paddingRow('0'), paddingRow('F'), paddingRow('A'));
  return lines.join('\r\n');
}

const ok = (body: string): RangeResponse => ({ status: 200, body, retryAfterSeconds: null });

type Reply = RangeResponse | Error;

interface Fake {
  readonly transport: BreachTransport;
  /** Every prefix asked for, in order, retries included. */
  readonly prefixes: readonly string[];
}

/**
 * A transport that answers from a script.
 *
 * `reply` receives the prefix and how many requests have already been made, so a test can
 * say "fail the first two, then answer" without holding its own counter.
 */
function fakeTransport(reply: (prefix: string, callIndex: number) => Reply): Fake {
  const prefixes: string[] = [];

  return {
    prefixes,
    transport: {
      fetchRange(prefix: string, signal: AbortSignal): Promise<RangeResponse> {
        // A real transport rejects on an aborted signal. Honouring it here is what makes the
        // cancellation tests mean anything.
        if (signal.aborted) {
          const aborted = new Error('aborted');
          aborted.name = 'AbortError';
          return Promise.reject(aborted);
        }

        const index = prefixes.length;
        prefixes.push(prefix);
        const outcome = reply(prefix, index);
        return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
      },
    },
  };
}

/** Answers every prefix truthfully from the fake corpus. */
const honestTransport = (): Fake => fakeTransport((prefix) => ok(corpusBody(prefix)));

/**
 * A clock that only moves when the client sleeps.
 *
 * Pacing is real behaviour worth asserting — a client that fires as fast as it can is abusing
 * a free service — but asserting it against the wall clock would mean a test suite that takes
 * as long as the pacing it is testing.
 */
function virtualClock(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  readonly waits: readonly number[];
} {
  const waits: number[] = [];
  let current = 0;

  return {
    waits,
    now: () => current,
    sleep: (ms: number): Promise<void> => {
      waits.push(ms);
      current += ms;
      return Promise.resolve();
    },
  };
}

function inputs(...passwords: readonly string[]): readonly BreachCheckInput[] {
  return passwords.map((secretPassword, index) => ({
    credentialId: `c${String(index)}`,
    secretPassword,
  }));
}

// ── The three answers ────────────────────────────────────────────────────────

describe('one password', () => {
  it('reports a breached password with its corpus count', async () => {
    const fake = honestTransport();
    const client = new PwnedPasswordsClient({ transport: fake.transport });

    expect(await client.check('password')).toEqual({
      status: 'breached',
      count: CORPUS.password,
      reason: null,
    });
  });

  it('reports a password the corpus does not hold as safe', async () => {
    const fake = honestTransport();
    const client = new PwnedPasswordsClient({ transport: fake.transport });

    expect(await client.check(UNBREACHED)).toEqual({ status: 'safe', count: 0, reason: null });
  });

  it('sends the prefix and nothing else', async () => {
    const fake = honestTransport();
    await new PwnedPasswordsClient({ transport: fake.transport }).check('password');

    expect(fake.prefixes).toEqual([passwordRange('password').prefix]);
    expect(fake.prefixes[0]).toMatch(/^[0-9A-F]{5}$/);
  });

  /**
   * The empty string does have a SHA-1 and does appear in the corpus, but "you have not set
   * a password yet" is not a breach finding — the health rules already flag it as incomplete,
   * and reporting it as breached here would be a second, worse-worded copy of that.
   */
  it('does not report an empty password as breached', async () => {
    const fake = honestTransport();
    const result = await new PwnedPasswordsClient({ transport: fake.transport }).check('');

    expect(result.status).toBe('unknown');
    expect(fake.prefixes).toEqual([]);
  });
});

// ── Not one request per record ───────────────────────────────────────────────

describe('sweeping a vault without abusing a free service', () => {
  it('makes one request for many records sharing a password', async () => {
    const fake = honestTransport();
    const client = new PwnedPasswordsClient({ transport: fake.transport, requestIntervalMs: 0 });

    const summary = await client.checkMany(inputs('password', 'password', 'password', 'password'));

    expect(summary.requestCount).toBe(1);
    expect(fake.prefixes).toHaveLength(1);
    expect(summary.results).toHaveLength(4);
    for (const result of summary.results) expect(result.status).toBe('breached');
  });

  it('makes one request per distinct prefix, not per record', async () => {
    const fake = honestTransport();
    const client = new PwnedPasswordsClient({ transport: fake.transport, requestIntervalMs: 0 });

    const summary = await client.checkMany(inputs('password', 'hunter2', UNBREACHED, 'password'));

    expect(summary.requestCount).toBe(3);
    expect(new Set(fake.prefixes).size).toBe(3);
  });

  it('reuses a range it already fetched this session', async () => {
    const fake = honestTransport();
    const client = new PwnedPasswordsClient({ transport: fake.transport, requestIntervalMs: 0 });

    await client.checkMany(inputs('password'));
    const second = await client.checkMany(inputs('password'));

    expect(fake.prefixes).toHaveLength(1);
    expect(second.requestCount).toBe(0);
    expect(second.results[0]?.status).toBe('breached');
  });

  it('forgets every cached range when the cache is cleared', async () => {
    const fake = honestTransport();
    const client = new PwnedPasswordsClient({ transport: fake.transport, requestIntervalMs: 0 });

    await client.checkMany(inputs('password'));
    expect(client.cachedRangeCount).toBe(1);

    client.clearCache();
    expect(client.cachedRangeCount).toBe(0);

    await client.checkMany(inputs('password'));
    expect(fake.prefixes).toHaveLength(2);
  });

  it('keeps the cache bounded rather than growing for the life of the process', async () => {
    const fake = honestTransport();
    const client = new PwnedPasswordsClient({
      transport: fake.transport,
      requestIntervalMs: 0,
      maxCachedRanges: 2,
    });

    await client.checkMany(inputs('password', 'hunter2', UNBREACHED));

    expect(client.cachedRangeCount).toBe(2);
  });

  it('caches nothing at all when told to cache nothing', async () => {
    const fake = honestTransport();
    const client = new PwnedPasswordsClient({
      transport: fake.transport,
      requestIntervalMs: 0,
      maxCachedRanges: 0,
    });

    await client.checkMany(inputs('password'));
    await client.checkMany(inputs('password'));

    expect(client.cachedRangeCount).toBe(0);
    expect(fake.prefixes).toHaveLength(2);
  });

  it('spaces requests by the configured interval', async () => {
    const clock = virtualClock();
    const fake = honestTransport();
    const client = new PwnedPasswordsClient({
      transport: fake.transport,
      requestIntervalMs: 250,
      sleep: clock.sleep,
      now: clock.now,
    });

    await client.checkMany(inputs('password', 'hunter2', UNBREACHED));

    // Three requests, two gaps. The first goes out immediately; there is nothing to be
    // polite about before the first request of a session.
    expect(clock.waits).toEqual([250, 250]);
  });

  it('paces across separate calls, not only within one sweep', async () => {
    const clock = virtualClock();
    const fake = honestTransport();
    const client = new PwnedPasswordsClient({
      transport: fake.transport,
      requestIntervalMs: 250,
      sleep: clock.sleep,
      now: clock.now,
    });

    await client.check('password');
    await client.check('hunter2');

    expect(clock.waits).toEqual([250]);
  });

  it('skips records with no password rather than reporting them', async () => {
    const fake = honestTransport();
    const client = new PwnedPasswordsClient({ transport: fake.transport, requestIntervalMs: 0 });

    const summary = await client.checkMany(inputs('password', '', ''));

    expect(summary.results).toHaveLength(1);
    expect(summary.incompleteReason).toBeNull();
  });
});

// ── The order the prefixes go out in ─────────────────────────────────────────

/**
 * The sequence of prefixes is itself a fingerprint, unless it is shuffled.
 *
 * `byPrefix` is a `Map`, and a `Map` iterates in insertion order, so a sweep that walked it
 * directly would send prefixes in the order records appear in the vault — the same ordered
 * sequence every time, from every address, for as long as the vault keeps its shape. An
 * ordered multiset of a few hundred twenty-bit values links two sweeps a month apart back to
 * one vault, which is the grouping `client.ts`, `hash.ts` and `07-Breach-Check.md` all say
 * does not happen. `Add-Padding` does not help: it hides how many candidates sit behind an
 * answer, not the order the questions were asked in.
 *
 * So: the same vault, swept repeatedly, must not produce the same request order — while the
 * *set* of prefixes, the request count and the caller's result order all stay exactly as
 * they were. Those three are asserted alongside, because a "shuffle" that also dropped or
 * duplicated a prefix would pass a test that only looked at ordering.
 */
describe('a sweep does not emit a recognisable sequence', () => {
  /** Enough distinct prefixes that two shuffles agreeing by chance is ~1 in 12!. */
  const VAULT = Array.from({ length: 12 }, (_, index) => `sweep-order-password-${String(index)}`);

  const sweep = async (): Promise<readonly string[]> => {
    const fake = honestTransport();
    // No cache: a cached range is never re-requested, which would flatten the second sweep
    // into no requests at all and make the comparison vacuous.
    const client = new PwnedPasswordsClient({
      transport: fake.transport,
      requestIntervalMs: 0,
      maxCachedRanges: 0,
    });
    await client.checkMany(inputs(...VAULT));
    return fake.prefixes;
  };

  it('asks about one prefix per password, so the ordering test is not vacuous', () => {
    const prefixes = VAULT.map((secretPassword) => passwordRange(secretPassword).prefix);
    expect(new Set(prefixes).size).toBe(VAULT.length);
  });

  it('sends the same vault in a different order every time', async () => {
    const orders = new Set<string>();
    for (let attempt = 0; attempt < 5; attempt += 1) orders.add((await sweep()).join(','));

    // Five identical shuffles of twelve items would be a ~1-in-10^17 coincidence; in
    // practice this fails if and only if the order is not being randomised at all.
    expect(orders.size).toBeGreaterThan(1);
  });

  it('asks about exactly the same prefixes, once each, whatever the order', async () => {
    const expected = [
      ...VAULT.map((secretPassword) => passwordRange(secretPassword).prefix),
    ].sort();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect([...(await sweep())].sort()).toEqual(expected);
    }
  });

  it('returns results in the caller’s order, not the order they were asked in', async () => {
    const fake = honestTransport();
    const client = new PwnedPasswordsClient({ transport: fake.transport, requestIntervalMs: 0 });

    // Blanks interleaved: they are skipped rather than reported, so the surviving ids must
    // still come back in the caller's order with the gaps closed up.
    const summary = await client.checkMany(inputs(VAULT[0]!, '', ...VAULT.slice(1, 6), ''));

    expect(summary.results.map((result) => result.credentialId)).toEqual([
      'c0',
      'c2',
      'c3',
      'c4',
      'c5',
      'c6',
    ]);
  });
});

// ── Every failure is "unknown", and none of them is "safe" ───────────────────

describe('a failure is never good news', () => {
  const failures: readonly (readonly [name: string, reply: Reply, reason: string])[] = [
    ['a 500', { status: 500, body: '', retryAfterSeconds: null }, 'serverError'],
    ['a 503', { status: 503, body: '', retryAfterSeconds: null }, 'serverError'],
    ['a 404', { status: 404, body: '', retryAfterSeconds: null }, 'badResponse'],
    ['a 403', { status: 403, body: '', retryAfterSeconds: null }, 'badResponse'],
    ['a 204', { status: 204, body: '', retryAfterSeconds: null }, 'badResponse'],
    ['a redirect that survived', { status: 302, body: '', retryAfterSeconds: null }, 'badResponse'],
    ['an HTML error page', ok('<html><body>Gateway Timeout</body></html>'), 'badResponse'],
    ['a captive portal login', ok('Sign in to the hotel network to continue.'), 'badResponse'],
    ['an empty 200', ok(''), 'badResponse'],
    ['a truncated body', ok(`${'A'.repeat(35)}:1\n${'B'.repeat(20)}`), 'badResponse'],
  ];

  for (const [name, reply, reason] of failures) {
    it(`reports ${name} as unknown, never as safe`, async () => {
      const fake = fakeTransport(() => reply);
      const result = await new PwnedPasswordsClient({ transport: fake.transport }).check(
        'password'
      );

      expect(result.status).toBe('unknown');
      expect(result.reason).toBe(reason);
      expect(result.count).toBe(0);
    });
  }

  it('reports a dead network as offline', async () => {
    const dns = new TypeError('fetch failed', {
      cause: Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }),
    });
    const fake = fakeTransport(() => dns);

    const result = await new PwnedPasswordsClient({ transport: fake.transport }).check('password');
    expect(result).toEqual({ status: 'unknown', count: 0, reason: 'offline' });
  });

  it('reports a request that hit its deadline as a timeout', async () => {
    const timedOut = new Error('the operation timed out');
    timedOut.name = 'TimeoutError';
    const fake = fakeTransport(() => timedOut);

    const result = await new PwnedPasswordsClient({ transport: fake.transport }).check('password');
    expect(result.reason).toBe('timeout');
  });

  /**
   * A transient failure is not cached.
   *
   * Caching one would turn a single bad moment into a vault that cannot be checked again
   * until the process restarts — and the user would have no way to tell that from a vault
   * that genuinely could not be reached.
   */
  it('does not cache a failure', async () => {
    const fake = fakeTransport((_prefix, index) =>
      index === 0 ? new Error('boom') : ok(corpusBody(passwordRange('password').prefix))
    );
    const client = new PwnedPasswordsClient({ transport: fake.transport, requestIntervalMs: 0 });

    expect((await client.check('password')).status).toBe('unknown');
    expect((await client.check('password')).status).toBe('breached');
  });

  it('gives up rather than grinding through a whole vault against a dead network', async () => {
    const fake = fakeTransport(() => new Error('offline'));
    const client = new PwnedPasswordsClient({ transport: fake.transport, requestIntervalMs: 0 });

    const summary = await client.checkMany(
      inputs('password', 'hunter2', UNBREACHED, 'letmein', 'qwerty', 'dragon', 'monkey')
    );

    // Every record still gets an answer; only the asking stops.
    expect(summary.results.length).toBeGreaterThan(fake.prefixes.length);
    expect(fake.prefixes.length).toBeLessThanOrEqual(3);
    expect(summary.incompleteReason).toBe('offline');
    for (const result of summary.results) expect(result.status).toBe('unknown');
  });

  it('does not give up because of failures scattered among successes', async () => {
    // One failure, then successes, then another: the counter resets on every success, so a
    // flaky connection completes the sweep rather than being treated as a dead one.
    const fake = fakeTransport((prefix, index) =>
      index === 0 ? new Error('flaky') : ok(corpusBody(prefix))
    );
    const client = new PwnedPasswordsClient({ transport: fake.transport, requestIntervalMs: 0 });

    const summary = await client.checkMany(
      inputs('password', 'hunter2', UNBREACHED, 'letmein', 'qwerty')
    );

    expect(summary.results.filter((result) => result.status === 'unknown')).toHaveLength(1);
    expect(fake.prefixes.length).toBeGreaterThan(3);
  });
});

// ── Being asked to go away ───────────────────────────────────────────────────

describe('rate limiting', () => {
  const rateLimited = (retryAfterSeconds: number | null): RangeResponse => ({
    status: 429,
    body: '',
    retryAfterSeconds,
  });

  it('waits exactly as long as the service asked, once', async () => {
    const clock = virtualClock();
    const fake = fakeTransport((prefix, index) =>
      index === 0 ? rateLimited(5) : ok(corpusBody(prefix))
    );
    const client = new PwnedPasswordsClient({
      transport: fake.transport,
      requestIntervalMs: 0,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect((await client.check('password')).status).toBe('breached');
    expect(clock.waits).toContain(5_000);
  });

  it('falls back to its own backoff when the header said nothing usable', async () => {
    const clock = virtualClock();
    const fake = fakeTransport((prefix, index) =>
      index === 0 ? rateLimited(null) : ok(corpusBody(prefix))
    );
    const client = new PwnedPasswordsClient({
      transport: fake.transport,
      requestIntervalMs: 0,
      sleep: clock.sleep,
      now: clock.now,
    });

    await client.check('password');
    expect(clock.waits).toContain(2_000);
  });

  /**
   * Two 429s and the run stops.
   *
   * The service has asked us to go away twice. A client that keeps asking after that is why
   * free services stop being free, and there is no third attempt anywhere in the code.
   */
  it('stops the whole run after a second 429 rather than retrying into the ground', async () => {
    const clock = virtualClock();
    const fake = fakeTransport(() => rateLimited(1));
    const client = new PwnedPasswordsClient({
      transport: fake.transport,
      requestIntervalMs: 0,
      sleep: clock.sleep,
      now: clock.now,
    });

    const summary = await client.checkMany(
      inputs('password', 'hunter2', UNBREACHED, 'letmein', 'qwerty')
    );

    // Two attempts at the first prefix, and then nothing at all.
    expect(fake.prefixes).toHaveLength(2);
    expect(summary.incompleteReason).toBe('rateLimited');
    expect(summary.results).toHaveLength(5);
    for (const result of summary.results) expect(result.status).toBe('unknown');
  });
});

// ── Cancellation ─────────────────────────────────────────────────────────────

describe('cancelling a run', () => {
  it('makes no request at all when it was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    const fake = honestTransport();
    const client = new PwnedPasswordsClient({ transport: fake.transport, requestIntervalMs: 0 });

    const summary = await client.checkMany(inputs('password', 'hunter2'), {
      signal: controller.signal,
    });

    expect(fake.prefixes).toEqual([]);
    expect(summary.requestCount).toBe(0);
    expect(summary.incompleteReason).toBe('cancelled');
  });

  it('stops mid-sweep and reports cancellation, not a network failure', async () => {
    const controller = new AbortController();
    const fake = fakeTransport((prefix, index) => {
      if (index === 0) return ok(corpusBody(prefix));
      controller.abort();
      return ok(corpusBody(prefix));
    });
    const client = new PwnedPasswordsClient({ transport: fake.transport, requestIntervalMs: 0 });

    const summary = await client.checkMany(
      inputs('password', 'hunter2', UNBREACHED, 'letmein', 'qwerty'),
      { signal: controller.signal }
    );

    expect(summary.incompleteReason).toBe('cancelled');
    // The abort is reported as a cancellation, never as `offline` or `timeout` — the user
    // stopped it, and telling them their connection failed would be a lie.
    const unknowns = summary.results.filter((result) => result.status === 'unknown');
    expect(unknowns.length).toBeGreaterThan(0);
    for (const result of unknowns) expect(result.reason).toBe('cancelled');
  });
});

// ── Nothing comes back out ───────────────────────────────────────────────────

describe('nothing returned names a password, a hash, a prefix or a suffix', () => {
  const SAMPLES = ['password', 'hunter2', UNBREACHED, 'Tr0ub4dor&3', 'ünïcøde-pässwörd', '🔐🔐🔐'];

  it('holds for a successful sweep', async () => {
    const fake = honestTransport();
    const client = new PwnedPasswordsClient({ transport: fake.transport, requestIntervalMs: 0 });

    const summary = await client.checkMany(inputs(...SAMPLES));
    const serialised = JSON.stringify(summary);

    for (const secretPassword of SAMPLES) {
      const { prefix, suffix } = passwordRange(secretPassword);
      expect(serialised, secretPassword).not.toContain(secretPassword);
      expect(serialised, secretPassword).not.toContain(suffix);
      expect(serialised, secretPassword).not.toContain(prefix + suffix);
      // The prefix is safe to *send* — that is the whole design — but it must not come back
      // attached to a credential id, which is what would re-link the anonymised half of this
      // feature to the identifying half.
      expect(serialised, secretPassword).not.toContain(prefix);
    }
  });

  it('holds when every lookup failed', async () => {
    const fake = fakeTransport(() => new Error('the prefix 5BAA6 could not be reached'));
    const client = new PwnedPasswordsClient({ transport: fake.transport, requestIntervalMs: 0 });

    const summary = await client.checkMany(inputs(...SAMPLES));
    const serialised = JSON.stringify(summary);

    // The transport's own error message named a prefix. Only a reason from the closed union
    // escapes the client, so it cannot have come with it.
    expect(serialised).not.toContain('5BAA6');
    for (const secretPassword of SAMPLES) {
      expect(serialised, secretPassword).not.toContain(secretPassword);
    }
  });

  it('returns only the four documented fields per record', async () => {
    const fake = honestTransport();
    const client = new PwnedPasswordsClient({ transport: fake.transport, requestIntervalMs: 0 });

    const summary = await client.checkMany(inputs('password'));

    for (const result of summary.results) {
      expect(Object.keys(result).sort()).toEqual(['count', 'credentialId', 'reason', 'status']);
    }
  });
});
