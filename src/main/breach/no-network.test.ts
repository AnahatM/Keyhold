// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aliasesFrom,
  factsOf,
  importedNamesFrom,
  isLocalSpecifier,
  moduleGraphFrom,
  posixRelative,
  sourceFilesUnder,
  type SourceFacts,
  type SourceTree,
} from '../../../tools/source-facts.js';
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
 * It is checked four ways, because a setting is one forgotten `if` away from being on and a
 * behavioural test alone would pass for a module that merely happened not to be called:
 *
 * 1. **Repo-wide, over the source.** Hard rule 5 is repo-wide, so the scan is too: every
 *    `.ts`/`.tsx` file under `src/`, recursively, and exactly one of them —
 *    `https-transport.ts` — may name a way to originate a request.
 * 2. **Directory-strict.** Inside `src/main/breach/` the bar is higher still: no file but the
 *    transport may so much as *mention* a network API or a URL, and `client.ts` must not be
 *    able to reach the transport through any chain of imports, anywhere in the repo. A client
 *    with no transport does not merely hold no reference to code that could reach the
 *    network; it does not have such code in its module graph at all.
 * 3. **Behaviourally, with `fetch` booby-trapped.** The global is replaced for the whole file
 *    with something that throws. A request attempted anywhere below fails loudly here rather
 *    than quietly succeeding on somebody's machine.
 * 4. **By what is *not* computed.** With no transport the password is never hashed — not
 *    hashed-and-then-withheld. `passwordRange` is spied on and must never be called. That is
 *    the difference between a feature that is off and one that is merely quiet.
 *
 * There is deliberately no test here that makes a real request. The range API is free and
 * public, and hitting it from a test suite would still be wrong: it would leak the fact that
 * this machine ran these tests, it would flake on a plane, and it would make the suite's
 * result depend on somebody else's uptime.
 *
 * ## Why this file parses instead of pattern-matching — read before "simplifying" it
 *
 * The scan used to read the source as text: a hand-rolled comment stripper, a regex per API,
 * and a module-graph walk over specifiers matching `/'(\.[^']*)'/`. A subsystem audit found
 * it **failed open in three ways at once**, which is worse than having no guard, because a
 * guard that cannot fail is the reason nobody looks:
 *
 *   - **N10 — the alias hole.** The walk captured only `'./…'` specifiers. This project uses
 *     `@main/*` and `@shared/*` aliases everywhere (`tsconfig.node.json`, kept in step with
 *     the Vite config by `tools/alias-parity.test.ts`), so `import { createHttpsTransport }
 *     from '@main/breach/https-transport.js'` in `client.ts` resolved perfectly at build time
 *     and was **invisible** to the strongest check in the file. Measured: with that line
 *     planted, the guard passed 14/14.
 *   - **N18 — the string-literal hole.** The comment stripper had no notion of string
 *     literals, so a line containing `'/*'` opened a block comment that never closed and
 *     every following line of that file was stripped before the scan. Measured: with a
 *     literal `fetch()` to the real HIBP endpoint appended to `client.ts` under such a line,
 *     the guard passed 14/14.
 *   - **N17 — the one-directory hole.** `readdirSync` over this directory, non-recursively,
 *     while hard rule 5 covers the repository. Measured: a `fetch()` in
 *     `src/main/breach/nested/leak.ts` was invisible.
 *
 * So the specifiers, the identifiers and the calls now come from the **TypeScript parser**,
 * the same one that compiles the project. Comments are trivia and never become nodes, which
 * closes N18 by construction rather than by a better regex; aliases are read out of
 * `tsconfig.node.json` itself rather than restated here, which closes N10 without a second
 * list (hard rule 8); and the walk covers all of `src/`, which closes N17.
 *
 * The last `describe` in the structural half plants each of those violations into a
 * throwaway source tree and asserts the scan **fails** on it. A guard nobody has watched fail
 * is not known to work, and these three in particular were watched to pass for months.
 *
 * ## Where the scanner lives — `tools/source-facts.ts`
 *
 * It is not in this file. The reader — `factsOf`, `sourceFilesUnder`, `aliasesFrom`,
 * `resolveSpecifier`, `moduleGraphFrom` — is shared with `src/main/shell/shell-hardening.test.ts`,
 * which makes the same kind of claim about the same kind of absence.
 *
 * That module's own header records why, and it is the reason this one is worth reading twice:
 * the hand-rolled stripper N18 lived in was a **copy**, and when the bug was fixed here the copy
 * kept it and let seven planted violations through the other guard. Rebuilding both on the
 * parser fixed the bug and re-created the duplication in a new spelling. There is now one
 * scanner. **If this file needs a fact the shared module does not expose, add it there.** A
 * local `factsOf` here would be the third time.
 *
 * What stays here is the *policy*: which names count as the ability to originate a request, and
 * which files may have it. That is a judgement about this feature, and it belongs next to it.
 */

// ── Where things are ─────────────────────────────────────────────────────────

const BREACH_DIRECTORY = import.meta.dirname;
const ROOT = resolve(BREACH_DIRECTORY, '..', '..', '..');
const SRC = join(ROOT, 'src');

/** The one file allowed to touch the network. Everything else is checked against it. */
const TRANSPORT_FILE = 'https-transport.ts';

const ENTRY_FILE = 'client.ts';

/**
 * The single path in the repository entitled to originate a request, as a repo-relative
 * path. One entry, and it is the assertion rather than a configuration knob: if this list
 * ever needs a second line, that is a decision-log entry, not an edit.
 */
const NETWORK_CAPABLE_PATH = 'src/main/breach/https-transport.ts';

// ── What counts as the ability to make a request ─────────────────────────────

/**
 * Request-originating globals, by the name they are written under.
 *
 * Named rather than pattern-matched on "http", so a failure says which capability appeared.
 */
const NETWORK_GLOBALS: readonly string[] = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'sendBeacon',
];

/**
 * First path segment of a module specifier that can reach the network.
 *
 * `node:` is stripped before the lookup so `http` and `node:http` are one rule. The
 * third-party names are here for the future rather than the present — none is a dependency
 * today, and an update checker or an HTTP client arriving as a transitive convenience is
 * exactly the way an offline application stops being one.
 */
const NETWORK_MODULE_HEADS: ReadonlySet<string> = new Set([
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dns',
  'dgram',
  'undici',
  'axios',
  'got',
  'node-fetch',
  'superagent',
  'ws',
  'socket.io-client',
  'electron-updater',
]);

/** Electron's own request APIs, which do not look like requests at a glance. */
const ELECTRON_NETWORK_BINDINGS: readonly string[] = ['net', 'netLog'];

/** A URL in the source. Only meaningful inside `breach/`; see `directoryStrictFaults`. */
const URL_PATTERN = /\bhttps?:\/\//;

// ── The tree being scanned ───────────────────────────────────────────────────

/**
 * The project, and the aliases its imports may be written in.
 *
 * The alias table is parsed out of `tsconfig.node.json` rather than restated: hard rule 8 (no
 * second list), and because a guard that carries its own copy of it stops seeing an alias the
 * moment one is added — which is the shape of N10 all over again.
 */
const PROJECT: SourceTree = {
  root: SRC,
  aliases: aliasesFrom(join(ROOT, 'tsconfig.node.json'), ROOT),
};

const isTest = (file: string): boolean => /\.test\.tsx?$/.test(file);

const repoPath = (file: string): string => posixRelative(ROOT, file);

/** Parsed once. Roughly three hundred files, and every check below reads the same facts. */
const projectFacts: readonly SourceFacts[] = sourceFilesUnder(PROJECT.root).map(factsOf);

// ── The rules ────────────────────────────────────────────────────────────────

/**
 * Electron bindings this file could reach `net` or `netLog` through.
 *
 * Derived here rather than in the scanner: which of Electron's bindings can originate a request
 * is a fact about *this feature's* policy, and `tools/source-facts.ts` deliberately holds no
 * opinion about the app it reads. What the scanner supplies is the shape-blind part — the
 * imported names, however the import was spelled.
 *
 * A namespace, a default or a `require()` hands the module object over whole, so every binding
 * on it is in reach at once. That is stricter than the version this replaces, which only read
 * `import` declarations and only recognised a namespace import: `const { net } = require(
 * 'electron')` and `await import('electron')` were both invisible to it. Erased imports count
 * too — `import type { net } from 'electron'` in a file with no business knowing Electron
 * exists is worth a failure whether or not it survives the build.
 */
function electronNetworkBindings(facts: SourceFacts): ReadonlySet<string> {
  const names = importedNamesFrom(facts, 'electron');
  if (names.includes('*') || names.includes('default')) return new Set(ELECTRON_NETWORK_BINDINGS);
  return new Set(names);
}

function networkModule(specifier: string, tree: SourceTree): string | null {
  if (isLocalSpecifier(specifier, tree)) return null;
  const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  const head = bare.split('/')[0] ?? bare;
  return NETWORK_MODULE_HEADS.has(head) ? specifier : null;
}

/**
 * Ways this file could originate a request, named.
 *
 * `mentions` is the difference between the two strictness levels. Repo-wide, only a *call*
 * counts in a test file — a test that stubs `fetch` by name is doing the opposite of making
 * a request, and banning the name would push people to spell it `globalThis['fe' + 'tch']`.
 * In production code the *name* counts, because there is no legitimate reason to write it.
 */
function networkFaults(
  facts: SourceFacts,
  tree: SourceTree,
  mentions: 'named' | 'called'
): readonly string[] {
  const faults: string[] = [];
  const names = mentions === 'named' ? facts.identifiers : facts.called;

  for (const global of NETWORK_GLOBALS) {
    if (names.has(global)) faults.push(global);
  }
  for (const reference of facts.imports) {
    const module = networkModule(reference.specifier, tree);
    if (module !== null) faults.push(`${reference.kind} import of ${module}`);
  }
  const electron = electronNetworkBindings(facts);
  for (const binding of ELECTRON_NETWORK_BINDINGS) {
    if (electron.has(binding)) faults.push(`electron's \`${binding}\``);
  }

  return faults;
}

/**
 * The stricter bar inside `src/main/breach/`: mentioning the capability is enough, an
 * `electron` import of any kind counts, and a URL in a string counts too.
 *
 * Worth more than the repo-wide rule here because this directory is where somebody looking
 * for "the network code" will look, and because the transport's isolation is the argument
 * the whole feature rests on.
 */
function directoryStrictFaults(facts: SourceFacts, tree: SourceTree): readonly string[] {
  const faults = [...networkFaults(facts, tree, 'named')];

  if (facts.imports.some((reference) => reference.specifier === 'electron')) {
    faults.push('an import from electron');
  }
  if (facts.strings.some((value) => URL_PATTERN.test(value))) faults.push('a URL');

  return faults;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Repo-wide: hard rule 5 is about the repository, so the scan is too
// ─────────────────────────────────────────────────────────────────────────────

describe('nothing in src/ can originate a request', () => {
  it('scans the whole tree rather than one directory', () => {
    // The hole this replaces (N17) was a single non-recursive `readdirSync`, and a scan over
    // the wrong set of files passes vacuously. Both the size and the spread are asserted so
    // a walk that silently stopped descending fails here rather than everywhere else.
    const scanned = projectFacts.map((facts) => repoPath(facts.file));
    expect(scanned.length).toBeGreaterThan(150);
    expect(scanned).toContain(NETWORK_CAPABLE_PATH);

    const directories = new Set(scanned.map((path) => dirname(path)));
    expect(directories.size).toBeGreaterThan(20);
    for (const area of ['src/main', 'src/preload', 'src/renderer', 'src/shared']) {
      expect(
        scanned.some((path) => path.startsWith(`${area}/`)),
        `nothing under ${area} was scanned`
      ).toBe(true);
    }
  });

  it('names a request-originating API in exactly one file', () => {
    const offenders = projectFacts
      .filter((facts) => !isTest(facts.file))
      .filter((facts) => networkFaults(facts, PROJECT, 'named').length > 0)
      .map(
        (facts) => `${repoPath(facts.file)} — ${networkFaults(facts, PROJECT, 'named').join(', ')}`
      );

    expect(offenders).toEqual([`${NETWORK_CAPABLE_PATH} — fetch`]);
  });

  it('makes no request from a test, either', () => {
    // A test may name `fetch` — booby-trapping it is how the behavioural half below works —
    // but calling one, or importing a module that can, would mean the suite itself reaches
    // the network on somebody's machine.
    const offenders = projectFacts
      .filter((facts) => isTest(facts.file))
      .filter((facts) => networkFaults(facts, PROJECT, 'called').length > 0)
      .map(
        (facts) => `${repoPath(facts.file)} — ${networkFaults(facts, PROJECT, 'called').join(', ')}`
      );

    expect(offenders).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The breach directory, held to a higher bar
// ─────────────────────────────────────────────────────────────────────────────

const breachFacts = projectFacts.filter(
  (facts) => dirname(facts.file) === BREACH_DIRECTORY && !isTest(facts.file)
);

const breachFileNames = breachFacts.map((facts) => relative(BREACH_DIRECTORY, facts.file));

describe('the breach directory', () => {
  it('finds the files it is supposed to be checking', () => {
    // A scan over an empty directory listing passes vacuously and would keep passing after a
    // rename. Both anchors are asserted by name.
    expect(breachFileNames).toContain(ENTRY_FILE);
    expect(breachFileNames).toContain(TRANSPORT_FILE);
    expect(breachFileNames.length).toBeGreaterThan(4);
  });

  it('mentions a network API or a URL in exactly one file', () => {
    const offenders = breachFacts
      .filter((facts) => directoryStrictFaults(facts, PROJECT).length > 0)
      .map((facts) => relative(BREACH_DIRECTORY, facts.file));

    expect(offenders).toEqual([TRANSPORT_FILE]);
  });

  it('says which capability appeared, when one does', () => {
    // Reported per API rather than per file, so a failure message names the thing that was
    // added instead of leaving someone to diff a file against its own history.
    for (const facts of breachFacts) {
      if (facts.file === join(BREACH_DIRECTORY, TRANSPORT_FILE)) continue;
      for (const fault of directoryStrictFaults(facts, PROJECT)) {
        expect.fail(`${relative(BREACH_DIRECTORY, facts.file)} names ${fault}`);
      }
    }
  });

  /**
   * The strongest of the source checks.
   *
   * "The client does not call `fetch`" would still be true of a client that imported
   * something that did. This asserts the transport is not in the client's module graph at
   * all: no chain of imports from `client.ts` arrives at the one file that can make a
   * request, so the capability is absent rather than unused.
   *
   * The walk follows aliased specifiers now (N10), and follows them out of this directory,
   * because `client.ts` legitimately imports `@shared/model/breach.js` and
   * `../crypto/random.js` — and an import written `@main/breach/https-transport.js` used to
   * be invisible to exactly this assertion.
   */
  it('keeps the transport out of the client’s module graph entirely', () => {
    const graph = moduleGraphFrom([join(BREACH_DIRECTORY, ENTRY_FILE)], PROJECT);

    expect([...graph.files].map(repoPath).sort()).not.toContain(NETWORK_CAPABLE_PATH);
  });

  it('walks the whole graph rather than only direct or relative imports', () => {
    const graph = moduleGraphFrom([join(BREACH_DIRECTORY, ENTRY_FILE)], PROJECT);
    const reached = [...graph.files].map(repoPath);

    // `hash.ts` and `transport.ts` are direct relative imports; `range.ts` is reached through
    // `transport.ts` as well as directly, so its presence proves recursion; `random.ts` is
    // reached out of this directory and `breach.ts` through an alias, so their presence
    // proves the walk does the two things it used to be unable to do.
    expect(reached).toContain('src/main/breach/hash.ts');
    expect(reached).toContain('src/main/breach/transport.ts');
    expect(reached).toContain('src/main/breach/range.ts');
    expect(reached).toContain('src/main/crypto/random.ts');
    expect(reached).toContain('src/shared/model/breach.ts');
  });

  it('resolves every local import it meets, so nothing is skipped in silence', () => {
    const graph = moduleGraphFrom([join(BREACH_DIRECTORY, ENTRY_FILE)], PROJECT);
    expect(graph.unresolved, 'imports the walk could not follow').toEqual([]);
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
    for (const facts of breachFacts) {
      expect(facts.identifiers.has('console'), `${repoPath(facts.file)} logs`).toBe(false);
    }
  });

  /** Nothing is persisted: no file is written, no store is reached, nothing is remembered. */
  it('writes nothing to disk', () => {
    const banned = ['writeFile', 'writeFileSync', 'app', 'localStorage', 'PreferencesStore'];

    for (const facts of breachFacts) {
      for (const reference of facts.imports) {
        expect(
          /^(node:)?fs(\/|$)/.test(reference.specifier),
          `${repoPath(facts.file)} imports ${reference.specifier}`
        ).toBe(false);
      }
      for (const name of banned) {
        expect(facts.identifiers.has(name), `${repoPath(facts.file)} names ${name}`).toBe(false);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The guard, watched failing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every bypass the audit found, planted into a throwaway tree, with the scan asserted to
 * **fail** on it.
 *
 * This block is the reason to trust the ones above. All three of N10, N17 and N18 were
 * silent for months precisely because the guard was only ever observed passing, and a
 * one-off manual plant-and-revert proves the guard worked on the day somebody tried it.
 * These are the same checks, run against files that are supposed to trip them, every time
 * the suite runs.
 */
describe('the scan can actually fail', () => {
  let fixtureRoot: string;
  let fixture: SourceTree;

  const write = (path: string, contents: string): void => {
    const file = join(fixtureRoot, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, 'utf8');
  };

  const factsFor = (path: string): SourceFacts => factsOf(join(fixtureRoot, path));

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'keyhold-no-network-'));
    fixture = {
      root: join(fixtureRoot, 'src'),
      aliases: new Map([
        ['@main', join(fixtureRoot, 'src', 'main')],
        ['@shared', join(fixtureRoot, 'src', 'shared')],
      ]),
    };

    write(
      'src/main/breach/https-transport.ts',
      'export const go = (): Promise<Response> => fetch("x");\n'
    );
    write(
      'src/main/breach/aliased-client.ts',
      "import { go } from '@main/breach/https-transport.js';\nexport const run = go;\n"
    );
    write(
      'src/main/breach/relative-client.ts',
      "import { go } from './https-transport.js';\nexport const run = go;\n"
    );
    write(
      'src/main/breach/dynamic-client.ts',
      "export const run = async (): Promise<unknown> => import('@main/breach/https-transport.js');\n"
    );
    write(
      'src/main/breach/indirect-client.ts',
      "import { run } from './aliased-client.js';\nexport const go = run;\n"
    );
    write('src/main/breach/broken-client.ts', "import './nowhere.js';\nexport const x = 1;\n");
    // The N18 shape: a `/*` inside a string literal, then a real request underneath it.
    write(
      'src/main/blinded.ts',
      'const marker = "/*";\nexport const go = (): Promise<Response> => fetch(marker);\n'
    );
    write(
      'src/main/deep/nested/leak.ts',
      'export const go = (): Promise<Response> => fetch("x");\n'
    );
    write(
      'src/main/requires.ts',
      "const https = require('node:https');\nexport const x = https;\n"
    );
    write('src/main/electron-net.ts', "import { net } from 'electron';\nexport const x = net;\n");
    write('src/main/clean.ts', "export const answer = 'nothing to see here';\n");
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('finds an import written in the project’s alias style — N10', () => {
    const graph = moduleGraphFrom(
      [join(fixtureRoot, 'src/main/breach/aliased-client.ts')],
      fixture
    );
    expect([...graph.files]).toContain(join(fixtureRoot, 'src/main/breach/https-transport.ts'));
  });

  it('finds a relative import', () => {
    const graph = moduleGraphFrom(
      [join(fixtureRoot, 'src/main/breach/relative-client.ts')],
      fixture
    );
    expect([...graph.files]).toContain(join(fixtureRoot, 'src/main/breach/https-transport.ts'));
  });

  it('finds a dynamic import()', () => {
    const graph = moduleGraphFrom(
      [join(fixtureRoot, 'src/main/breach/dynamic-client.ts')],
      fixture
    );
    expect([...graph.files]).toContain(join(fixtureRoot, 'src/main/breach/https-transport.ts'));
  });

  it('follows a chain rather than only direct imports', () => {
    const graph = moduleGraphFrom(
      [join(fixtureRoot, 'src/main/breach/indirect-client.ts')],
      fixture
    );
    expect([...graph.files]).toContain(join(fixtureRoot, 'src/main/breach/https-transport.ts'));
  });

  it('reports a local import it cannot resolve instead of walking past it', () => {
    const graph = moduleGraphFrom([join(fixtureRoot, 'src/main/breach/broken-client.ts')], fixture);
    expect(graph.unresolved).toHaveLength(1);
  });

  it('is not blinded by a string containing a block-comment opener — N18', () => {
    expect(networkFaults(factsFor('src/main/blinded.ts'), fixture, 'named')).toContain('fetch');
  });

  it('reads files in subdirectories, not just one directory — N17', () => {
    const scanned = sourceFilesUnder(fixture.root);
    expect(scanned).toContain(join(fixtureRoot, 'src/main/deep/nested/leak.ts'));
    expect(networkFaults(factsFor('src/main/deep/nested/leak.ts'), fixture, 'named')).toContain(
      'fetch'
    );
  });

  it('finds a network module pulled in by require()', () => {
    expect(networkFaults(factsFor('src/main/requires.ts'), fixture, 'named')).toContain(
      'require import of node:https'
    );
  });

  it('finds electron’s own net module', () => {
    expect(networkFaults(factsFor('src/main/electron-net.ts'), fixture, 'named')).toContain(
      "electron's `net`"
    );
  });

  it('counts a call as a call, not merely a mention', () => {
    // The distinction the test-file rule rests on: stubbing `fetch` by name is not making a
    // request, but calling it is. If this ever stopped holding, `makes no request from a
    // test` would silently become a rule about nothing.
    expect(networkFaults(factsFor('src/main/blinded.ts'), fixture, 'called')).toContain('fetch');
    expect(networkFaults(factsFor('src/main/clean.ts'), fixture, 'called')).toEqual([]);
  });

  it('does not flag a file that does none of this', () => {
    expect(networkFaults(factsFor('src/main/clean.ts'), fixture, 'named')).toEqual([]);
    expect(directoryStrictFaults(factsFor('src/main/clean.ts'), fixture)).toEqual([]);
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
