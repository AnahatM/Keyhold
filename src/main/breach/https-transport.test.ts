// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { passwordRange } from './hash.js';
import { MAX_RANGE_BODY_BYTES, parseRangeBody } from './range.js';
import {
  ADD_PADDING_HEADER,
  PWNED_RANGE_ENDPOINT,
  USER_AGENT,
  createHttpsTransport,
} from './https-transport.js';

/**
 * Tests for the one module in Keyhold that can make a request — checked against a stubbed
 * `fetch`, never against the real service.
 *
 * **Nothing here reaches the network.** The global is replaced for every test in this file
 * and restored afterwards, and the stub is a plain function that returns a `Response` built
 * in memory. Hitting the real range API would be free and would still be wrong: it would
 * leak the fact that this machine ran these tests, it would fail on an aeroplane, and it
 * would make the suite's result depend on somebody else's uptime.
 *
 * The assertions that matter are about the *shape of the request*, because that is where the
 * privacy properties live and because every one of them fails silently. A dropped
 * `Add-Padding` header still returns correct answers. A followed redirect still returns
 * correct answers. A `User-Agent` carrying a version string still returns correct answers.
 * Each one quietly narrows who the requester is while the feature keeps working perfectly.
 */

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

const captured: CapturedRequest[] = [];

/** The stub. Records the request and answers with whatever the test scripted. */
function stubFetch(respond: (url: string) => Response): void {
  captured.length = 0;
  vi.stubGlobal('fetch', (url: string, init: RequestInit): Promise<Response> => {
    captured.push({ url, init });
    return Promise.resolve(respond(url));
  });
}

const headersOf = (init: RequestInit): Headers => new Headers(init.headers);

const PREFIX = passwordRange('password').prefix;

const rangeBody = (): string => [`${'A'.repeat(35)}:12`, `${'0'.repeat(35)}:0`].join('\r\n');

beforeEach(() => {
  captured.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the request', () => {
  beforeEach(() => {
    stubFetch(() => new Response(rangeBody(), { status: 200 }));
  });

  it('asks the free k-anonymity endpoint for exactly the prefix', async () => {
    await createHttpsTransport().fetchRange(PREFIX, AbortSignal.timeout(1_000));

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(`${PWNED_RANGE_ENDPOINT}${PREFIX}`);
  });

  /**
   * `Add-Padding` is a privacy control, not a formality.
   *
   * Without it the response to a range request is as long as that range's entry list, and
   * every range has a different, publicly known length. TLS does not hide response size, so
   * an observer can narrow — often uniquely determine — which prefix was requested, undoing
   * much of the k-anonymity the whole feature rests on.
   *
   * Asserted against the exported constant rather than against a second copy of the string:
   * a header checked against a literal typed twice proves only that someone typed it twice.
   */
  it('asks for padding, so the response size says nothing about the prefix', async () => {
    await createHttpsTransport().fetchRange(PREFIX, AbortSignal.timeout(1_000));

    const init = captured[0]?.init;
    expect(init).toBeDefined();
    expect(headersOf(init ?? {}).get(ADD_PADDING_HEADER)).toBe('true');
  });

  it('refuses to follow a redirect to a host we did not choose', async () => {
    await createHttpsTransport().fetchRange(PREFIX, AbortSignal.timeout(1_000));
    expect(captured[0]?.init.redirect).toBe('error');
  });

  it('sends no cookie and offers no referrer, so there is no session to build on', async () => {
    await createHttpsTransport().fetchRange(PREFIX, AbortSignal.timeout(1_000));

    expect(captured[0]?.init.credentials).toBe('omit');
    expect(captured[0]?.init.referrer).toBe('');
  });

  it('reads rather than writes', async () => {
    await createHttpsTransport().fetchRange(PREFIX, AbortSignal.timeout(1_000));

    expect(captured[0]?.init.method).toBe('GET');
    expect(captured[0]?.init.body).toBeUndefined();
  });

  /**
   * The API asks callers to identify themselves and it is fair to do so — but with the app's
   * name and nothing else. A version string narrows an observer's view of *which* Keyhold
   * user this is, and the entire point of the exercise is to be one of a crowd.
   */
  it('identifies the client without narrowing which client', async () => {
    await createHttpsTransport().fetchRange(PREFIX, AbortSignal.timeout(1_000));

    const agent = headersOf(captured[0]?.init ?? {}).get('User-Agent');
    expect(agent).toBe(USER_AGENT);
    expect(agent).not.toMatch(/\d/);
    expect(agent).not.toMatch(/electron|node|chrome/i);
  });

  it('passes the caller’s deadline through, so a hung request cannot hold a sweep open', async () => {
    const signal = AbortSignal.timeout(1_000);
    await createHttpsTransport().fetchRange(PREFIX, signal);

    expect(captured[0]?.init.signal).toBe(signal);
  });

  /**
   * The whole request, checked against the password it came from.
   *
   * This is the k-anonymity claim stated as an assertion rather than as a paragraph: the
   * password, its full digest and the thirty-five characters that stay here appear nowhere in
   * the URL, the headers or anything else that leaves the process.
   */
  it('carries the prefix and nothing else that came from the password', async () => {
    const secretPassword = 'correct horse battery staple';
    const { prefix, suffix } = passwordRange(secretPassword);

    await createHttpsTransport().fetchRange(prefix, AbortSignal.timeout(1_000));

    const request = captured[0];
    expect(request).toBeDefined();
    const serialised = `${request?.url ?? ''} ${JSON.stringify(request?.init ?? {})}`;

    expect(serialised).toContain(prefix);
    expect(serialised).not.toContain(secretPassword);
    expect(serialised).not.toContain(suffix);
    expect(serialised).not.toContain(prefix + suffix);
  });
});

describe('what comes back', () => {
  it('returns the body for a 200', async () => {
    stubFetch(() => new Response(rangeBody(), { status: 200 }));

    const response = await createHttpsTransport().fetchRange(PREFIX, AbortSignal.timeout(1_000));

    expect(response.status).toBe(200);
    expect(parseRangeBody(response.body, 'A'.repeat(35))).toMatchObject({ kind: 'ok', count: 12 });
  });

  /**
   * A 500's HTML error page is not read.
   *
   * Reading it would allocate for nothing and put an attacker-influenced blob in memory next
   * to the prefix it concerns. The status is the whole answer for anything that is not a 200.
   */
  it('does not read the body of a status that has no answer in it', async () => {
    stubFetch(() => new Response('<html>a very long error page</html>', { status: 503 }));

    const response = await createHttpsTransport().fetchRange(PREFIX, AbortSignal.timeout(1_000));

    expect(response.status).toBe(503);
    expect(response.body).toBe('');
  });

  it('normalises Retry-After to whole seconds', async () => {
    stubFetch(() => new Response('', { status: 429, headers: { 'Retry-After': '7' } }));

    const response = await createHttpsTransport().fetchRange(PREFIX, AbortSignal.timeout(1_000));

    expect(response.status).toBe(429);
    expect(response.retryAfterSeconds).toBe(7);
  });

  it('reports a missing Retry-After as absent rather than as zero', async () => {
    stubFetch(() => new Response('', { status: 429 }));

    const response = await createHttpsTransport().fetchRange(PREFIX, AbortSignal.timeout(1_000));
    expect(response.retryAfterSeconds).toBeNull();
  });

  it('handles a response with no body at all', async () => {
    stubFetch(() => new Response(null, { status: 200 }));

    const response = await createHttpsTransport().fetchRange(PREFIX, AbortSignal.timeout(1_000));
    // Empty is not "no matches" — the parser rejects it, which is the point.
    expect(parseRangeBody(response.body, 'A'.repeat(35)).kind).toBe('malformed');
  });
});

describe('a hostile or broken endpoint', () => {
  /**
   * The body read stops one byte past the cap.
   *
   * A response with no end to it must not be able to make the process allocate without
   * bound, and — just as importantly — the over-long body must be *rejected* rather than
   * silently truncated into something that still parses. A truncated body that parses is the
   * dangerous outcome: the missing tail could be the very entry being looked for.
   */
  it('stops reading an endless body and rejects what it read', async () => {
    const CHUNK = 64 * 1024;
    const LIMIT = 64;
    let pulls = 0;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > LIMIT) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode('A'.repeat(CHUNK)));
      },
    });

    stubFetch(() => new Response(stream, { status: 200 }));

    const response = await createHttpsTransport().fetchRange(PREFIX, AbortSignal.timeout(5_000));

    expect(response.body.length).toBeGreaterThan(MAX_RANGE_BODY_BYTES);
    // It gave up long before the stream did.
    expect(pulls).toBeLessThan(LIMIT);
    expect(parseRangeBody(response.body, 'A'.repeat(35))).toEqual({
      kind: 'malformed',
      fault: 'oversized',
    });
  });

  it('lets a transport failure propagate rather than inventing a status', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));

    await expect(
      createHttpsTransport().fetchRange(PREFIX, AbortSignal.timeout(1_000))
    ).rejects.toThrow(TypeError);
  });
});

describe('the prefix is validated even though we generated it', () => {
  beforeEach(() => {
    stubFetch(() => new Response(rangeBody(), { status: 200 }));
  });

  const bad = [
    ['a full digest', passwordRange('password').prefix + passwordRange('password').suffix],
    ['lower case', PREFIX.toLowerCase()],
    ['too short', '5BAA'],
    ['a path traversal', '../../etc'],
    ['a query string', '5BAA6?x=1'],
    ['an empty string', ''],
    ['a password', 'hunter2'],
  ] as const;

  for (const [name, value] of bad) {
    it(`refuses ${name} without sending anything`, async () => {
      await expect(
        createHttpsTransport().fetchRange(value, AbortSignal.timeout(1_000))
      ).rejects.toThrow(TypeError);

      expect(captured).toHaveLength(0);
    });
  }

  it('names the expected shape in the error, never the value it was given', async () => {
    const secretPassword = 'hunter2';

    await expect(
      createHttpsTransport().fetchRange(secretPassword, AbortSignal.timeout(1_000))
    ).rejects.toThrow(/five upper-case hex characters/);

    await createHttpsTransport()
      .fetchRange(secretPassword, AbortSignal.timeout(1_000))
      .catch((error: unknown) => {
        expect(String(error)).not.toContain(secretPassword);
      });
  });
});
