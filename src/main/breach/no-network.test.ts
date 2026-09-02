// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HashModule from './hash.js';

/**
 * The guard the whole feature rests on: **Keyhold does not make a network request unless
 * somebody hands it the ability to, and nothing in this directory can hand it to itself.**
 *
 * Every other test here asks whether the breach check produces the right answer. This one
 * asks whether it is capable of asking the question at all, which is the property a
 * security-minded user actually cares about when they read "off by default" in a password
 * manager that promises to be offline.
 *
 * It is checked three ways, because a setting is one forgotten `if` away from being on and
 * a behavioural test alone would pass for a module that merely happened not to be called:
 *
 * 1. **Structurally, over the source.** No file in `src/main/breach/` other than
 *    `https-transport.ts` may so much as name a network API, and `client.ts` must not be
 *    able to reach `https-transport.ts` through any chain of imports. A client with no
 *    transport does not hold a reference to code that could reach the network; it does not
 *    have such code in its module graph at all.
 * 2. **Behaviourally, with `fetch` booby-trapped.** The global is replaced for the whole
 *    file with something that throws. A request attempted anywhere below fails loudly here
 *    rather than quietly succeeding on somebody's machine.
 * 3. **By what is *not* computed.** With no transport the password is never hashed — not
 *    hashed-and-then-withheld. `passwordRange` is spied on and must never be called. That is
 *    the difference between a feature that is off and one that is merely quiet.
 *
 * There is deliberately no test here that makes a real request. The range API is free and
 * public, and hitting it from a test suite would still be wrong: it would leak the fact that
 * this machine ran these tests, it would flake on a plane, and it would make the suite's
 * result depend on somebody else's uptime.
 */

const DIRECTORY = dirname(fileURLToPath(import.meta.url));

/** The one file allowed to touch the network. Everything else is checked against it. */
const TRANSPORT_FILE = 'https-transport.ts';

const ENTRY_FILE = 'client.ts';

/**
 * Ways to originate a request, as they would appear in source.
 *
 * Named rather than pattern-matched on "http", so the failure message says which capability
 * appeared. `net` and `dns` are in here because Electron's `net` module and a bare DNS
 * lookup are both requests that do not look like one at a glance.
 */
const NETWORK_APIS: readonly (readonly [name: string, pattern: RegExp])[] = [
  ['fetch', /\bfetch\b/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bWebSocket\b/],
  ['EventSource', /\bEventSource\b/],
  ['sendBeacon', /\bsendBeacon\b/],
  ['node:http', /\bnode:https?\b/],
  ['node:net', /\bnode:net\b/],
  ['node:tls', /\bnode:tls\b/],
  ['node:dns', /\bnode:dns\b/],
  ['node:dgram', /\bnode:dgram\b/],
  ['electron net', /\bfrom\s+'electron'/],
  ['a URL', /\bhttps?:\/\//],
];

function sourceFileNames(): readonly string[] {
  return readdirSync(DIRECTORY)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort();
}

/**
 * Source with its comments removed.
 *
 * Necessary rather than fussy: these files *discuss* `fetch` at length, and a guard that
 * matched prose would fire on the paragraph explaining why the prose is true. Block comments
 * are tracked across lines; a line comment is cut at the first `//` that is not part of a
 * `://`, which keeps a URL inside a string literal visible to the scan — the one case where
 * matching a "comment" is exactly what is wanted.
 */
function stripComments(source: string): string {
  const out: string[] = [];
  let inBlock = false;

  for (const rawLine of source.split(/\r?\n/)) {
    let line = rawLine;

    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlock = false;
    }

    const blockStart = line.indexOf('/*');
    if (blockStart !== -1) {
      const end = line.indexOf('*/', blockStart + 2);
      if (end === -1) {
        line = line.slice(0, blockStart);
        inBlock = true;
      } else {
        line = line.slice(0, blockStart) + line.slice(end + 2);
      }
    }

    const lineComment = line.search(/(^|[^:])\/\//);
    if (lineComment !== -1) {
      line = line.slice(0, lineComment === 0 ? 0 : lineComment + 1);
    }

    out.push(line);
  }

  return out.join('\n');
}

function codeOf(fileName: string): string {
  return stripComments(readFileSync(join(DIRECTORY, fileName), 'utf8'));
}

/** Relative imports, as file names in this directory. Non-relative specifiers are ignored. */
function relativeImports(code: string): readonly string[] {
  const names: string[] = [];
  const pattern = /(?:from|import)\s*\(?\s*'(\.[^']*)'/g;

  for (const match of code.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    // Source imports are written with a `.js` extension (NodeNext-style) and resolve to the
    // `.ts` beside them.
    names.push(specifier.replace(/^\.\//, '').replace(/\.js$/, '.ts'));
  }

  return names;
}

/** Every file reachable from `entry` by following relative imports, `entry` included. */
function moduleGraphFrom(entry: string): ReadonlySet<string> {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const next of relativeImports(codeOf(current))) queue.push(next);
  }

  return seen;
}

describe('the source cannot reach the network', () => {
  it('finds the files it is supposed to be checking', () => {
    // A scan over an empty directory listing passes vacuously and would keep passing after a
    // rename. Both anchors are asserted by name.
    const names = sourceFileNames();
    expect(names).toContain(ENTRY_FILE);
    expect(names).toContain(TRANSPORT_FILE);
    expect(names.length).toBeGreaterThan(4);
  });

  it('names a network API in exactly one file', () => {
    const offenders = sourceFileNames().filter((name) => {
      const code = codeOf(name);
      return NETWORK_APIS.some(([, pattern]) => pattern.test(code));
    });

    expect(offenders).toEqual([TRANSPORT_FILE]);
  });

  it('says which capability appeared, when one does', () => {
    // Reported per API rather than per file, so a failure message names the thing that was
    // added instead of leaving someone to diff a file against its own history.
    for (const name of sourceFileNames()) {
      if (name === TRANSPORT_FILE) continue;
      const code = codeOf(name);
      for (const [api, pattern] of NETWORK_APIS) {
        expect(pattern.test(code), `${name} names ${api}`).toBe(false);
      }
    }
  });

  /**
   * The strongest of the three source checks.
   *
   * "The client does not call `fetch`" would still be true of a client that imported
   * something that did. This asserts the transport is not in the client's module graph at
   * all: no chain of imports from `client.ts` arrives at the one file that can make a
   * request, so the capability is absent rather than unused.
   */
  it('keeps the transport out of the client’s module graph entirely', () => {
    const reachable = moduleGraphFrom(ENTRY_FILE);

    expect(reachable).toContain(ENTRY_FILE);
    expect([...reachable].sort()).not.toContain(TRANSPORT_FILE);
  });

  it('walks the graph rather than only looking at direct imports', () => {
    // The walk is only worth anything if it actually recurses. `client.ts` reaches `range.ts`
    // through `transport.ts`... and directly; `hash.ts` and `transport.ts` are its own
    // imports. Asserting the graph is bigger than the entry proves the traversal ran.
    const reachable = moduleGraphFrom(ENTRY_FILE);
    expect(reachable.size).toBeGreaterThan(1);
    expect(reachable).toContain('hash.ts');
    expect(reachable).toContain('transport.ts');
  });

  /**
   * No logging, anywhere in this directory.
   *
   * A prefix in a log file, sitting next to a record title, re-attaches the anonymised half
   * of this feature to the identifying half — which is the one thing the k-anonymity argument
   * depends on not happening. The safest way to be sure nothing is logged is for there to be
   * no logging statement to review.
   */
  it('contains no logging at all', () => {
    for (const name of sourceFileNames()) {
      expect(codeOf(name), `${name} logs`).not.toMatch(/\bconsole\s*\./);
    }
  });

  /** Nothing is persisted: no file is written, no store is reached, nothing is remembered. */
  it('writes nothing to disk', () => {
    for (const name of sourceFileNames()) {
      const code = codeOf(name);
      expect(code, `${name} touches the filesystem`).not.toMatch(/\bnode:fs\b|\bwriteFile|\bapp\./);
      expect(code, `${name} reaches a store`).not.toMatch(/localStorage|PreferencesStore/);
    }
  });
});

// ── Behaviour, with the network booby-trapped ────────────────────────────────

/**
 * `passwordRange` and `rangePrefix`, wrapped so the disabled path can be checked for having
 * left the password alone. The real implementations are kept — nothing here is faked, only
 * observed.
 */
const hashSpies = vi.hoisted(() => ({
  passwordRange: vi.fn<(secretPassword: string) => HashModule.PasswordRange>(),
  rangePrefix: vi.fn<(secretPassword: string) => string>(),
}));

vi.mock('./hash.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HashModule>();
  hashSpies.passwordRange.mockImplementation(actual.passwordRange);
  hashSpies.rangePrefix.mockImplementation(actual.rangePrefix);
  return { ...actual, passwordRange: hashSpies.passwordRange, rangePrefix: hashSpies.rangePrefix };
});

const { PwnedPasswordsClient } = await import('./client.js');

describe('a client constructed with no transport', () => {
  const attemptedRequest = vi.fn(() => {
    throw new Error('a test attempted a real network request');
  });

  beforeEach(() => {
    hashSpies.passwordRange.mockClear();
    hashSpies.rangePrefix.mockClear();
    attemptedRequest.mockClear();
    vi.stubGlobal('fetch', attemptedRequest);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports itself as not enabled', () => {
    expect(new PwnedPasswordsClient().enabled).toBe(false);
    // And the same when the option is present but absent-valued, which is what a settings
    // object that has not opted in looks like on the way through.
    expect(new PwnedPasswordsClient({ transport: undefined }).enabled).toBe(false);
  });

  it('answers "unknown / disabled" for a single check, and never "safe"', async () => {
    const result = await new PwnedPasswordsClient().check('password');

    expect(result).toEqual({ status: 'unknown', count: 0, reason: 'disabled' });
    expect(result.status).not.toBe('safe');
  });

  it('answers "unknown / disabled" for every record in a sweep', async () => {
    const summary = await new PwnedPasswordsClient().checkMany([
      { credentialId: 'a', secretPassword: 'password' },
      { credentialId: 'b', secretPassword: 'hunter2' },
      { credentialId: 'c', secretPassword: '' },
    ]);

    expect(summary.requestCount).toBe(0);
    expect(summary.incompleteReason).toBe('disabled');
    // The record with no password is skipped rather than reported: there was nothing to
    // check, and counting it would inflate "could not check" with something uncheckable.
    expect(summary.results.map((result) => result.credentialId)).toEqual(['a', 'b']);
    for (const result of summary.results) {
      expect(result).toMatchObject({ status: 'unknown', reason: 'disabled', count: 0 });
    }
  });

  /**
   * The assertion that separates "off" from "quiet".
   *
   * A client that computed the range prefix and then declined to send it would pass every
   * other test in this file. It would also mean the password had been hashed for a purpose
   * the user did not consent to, and that the code was one line away from sending it.
   */
  it('does not hash the password at all', async () => {
    const client = new PwnedPasswordsClient();

    await client.check('password');
    await client.checkMany([{ credentialId: 'a', secretPassword: 'password' }]);

    expect(hashSpies.passwordRange).not.toHaveBeenCalled();
    expect(hashSpies.rangePrefix).not.toHaveBeenCalled();
  });

  it('makes no request, on any path', async () => {
    const client = new PwnedPasswordsClient();

    await client.check('password');
    await client.checkMany([{ credentialId: 'a', secretPassword: 'password' }]);
    client.clearCache();

    expect(attemptedRequest).not.toHaveBeenCalled();
  });

  it('caches nothing, so there is no state to leak or to persist', async () => {
    const client = new PwnedPasswordsClient();
    await client.checkMany([{ credentialId: 'a', secretPassword: 'password' }]);

    expect(client.cachedRangeCount).toBe(0);
  });

  it('never mentions the password, whatever it is asked', async () => {
    const secretPassword = 'correct horse battery staple';
    const summary = await new PwnedPasswordsClient().checkMany([
      { credentialId: 'a', secretPassword },
    ]);

    expect(JSON.stringify(summary)).not.toContain(secretPassword);
  });
});
