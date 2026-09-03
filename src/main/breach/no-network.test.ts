// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

// ── Reading source the way the compiler reads it ─────────────────────────────

interface ImportRef {
  readonly specifier: string;
  readonly kind: 'static' | 'dynamic' | 'require';
}

/**
 * Everything the checks below need to know about one file, taken from its parse tree.
 *
 * Deliberately not "the source with comments removed": that framing is what produced N18.
 * A comment never becomes a node, so prose about `fetch` cannot reach these sets, and no
 * string literal can hide a line from them either.
 */
interface SourceFacts {
  readonly file: string;
  readonly imports: readonly ImportRef[];
  /** Every identifier written in code, including property names (`navigator.sendBeacon`). */
  readonly identifiers: ReadonlySet<string>;
  /** Names actually invoked: `fetch(…)`, `new WebSocket(…)`, `globalThis['fetch'](…)`. */
  readonly called: ReadonlySet<string>;
  /** String and template contents, in code only. */
  readonly strings: readonly string[];
  /** Named bindings imported from `electron`. */
  readonly electronBindings: ReadonlySet<string>;
}

function stringValue(node: ts.Node | undefined): string | null {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;
}

function importedNames(declaration: ts.ImportDeclaration): readonly string[] {
  const clause = declaration.importClause;
  if (clause === undefined) return [];

  const names: string[] = [];
  if (clause.name !== undefined) names.push(clause.name.text);

  const bindings = clause.namedBindings;
  if (bindings !== undefined && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      // `import { net as electronNet }` — the imported name is what matters, not the local.
      names.push((element.propertyName ?? element.name).text);
    }
  } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
    // `import * as electron from 'electron'` puts every binding in reach at once.
    names.push(...ELECTRON_NETWORK_BINDINGS);
  }

  return names;
}

function factsOf(file: string): SourceFacts {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    false,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const imports: ImportRef[] = [];
  const identifiers = new Set<string>();
  const called = new Set<string>();
  const strings: string[] = [];
  const electronBindings = new Set<string>();

  const calleeName = (expression: ts.Expression): string | null => {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (ts.isElementAccessExpression(expression)) return stringValue(expression.argumentExpression);
    return null;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = stringValue(node.moduleSpecifier);
      if (specifier !== null) {
        imports.push({ specifier, kind: 'static' });
        if (specifier === 'electron') {
          for (const name of importedNames(node)) electronBindings.add(name);
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      // `export … from '…'` is an import as far as the module graph is concerned.
      const specifier = stringValue(node.moduleSpecifier);
      if (specifier !== null) imports.push({ specifier, kind: 'static' });
    } else if (ts.isCallExpression(node)) {
      const first = node.arguments[0];
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = stringValue(first);
        if (specifier !== null) imports.push({ specifier, kind: 'dynamic' });
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const specifier = stringValue(first);
        if (specifier !== null) imports.push({ specifier, kind: 'require' });
      }
      const name = calleeName(node.expression);
      if (name !== null) called.add(name);
    } else if (ts.isNewExpression(node)) {
      const name = calleeName(node.expression);
      if (name !== null) called.add(name);
    } else if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      identifiers.add(node.text);
    } else if (ts.isStringLiteralLike(node)) {
      strings.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      strings.push(node.head.text, ...node.templateSpans.map((span) => span.literal.text));
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);

  return { file, imports, identifiers, called, strings, electronBindings };
}

// ── The tree being scanned ───────────────────────────────────────────────────

/**
 * A source tree and the aliases its imports may be written in.
 *
 * A parameter rather than a constant so the fault-injection block can point the very same
 * scan at a throwaway tree of planted violations. A guard that can only be run against the
 * repository can only be observed passing.
 */
interface SourceTree {
  readonly root: string;
  /** Alias prefix (`@main`) → absolute directory. Read from tsconfig, never restated. */
  readonly aliases: ReadonlyMap<string, string>;
}

/**
 * The project's path aliases, read out of `tsconfig.node.json`.
 *
 * Parsed rather than duplicated: hard rule 8 (no second list), and because a guard that
 * carries its own copy of the alias table stops seeing an alias the moment one is added —
 * which is the shape of N10 all over again.
 */
function aliasesFrom(tsconfigPath: string, root: string): ReadonlyMap<string, string> {
  const parsed = ts.readConfigFile(tsconfigPath, (path) => ts.sys.readFile(path));
  expect(parsed.error, `${tsconfigPath} could not be read`).toBeUndefined();

  const config = parsed.config as {
    compilerOptions?: { paths?: Readonly<Record<string, readonly string[]>> };
  };
  const paths = config.compilerOptions?.paths ?? {};

  const aliases = new Map<string, string>();
  for (const [pattern, targets] of Object.entries(paths)) {
    const target = targets[0];
    if (!pattern.endsWith('/*') || target?.endsWith('/*') !== true) continue;
    aliases.set(pattern.slice(0, -2), resolve(root, target.slice(0, -2)));
  }
  return aliases;
}

const PROJECT: SourceTree = {
  root: SRC,
  aliases: aliasesFrom(join(ROOT, 'tsconfig.node.json'), ROOT),
};

function sourceFilesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFilesUnder(path));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(path);
  }
  return found.sort();
}

const isTest = (file: string): boolean => /\.test\.tsx?$/.test(file);

const repoPath = (file: string): string => relative(ROOT, file).split(sep).join('/');

/** Parsed once. Roughly three hundred files, and every check below reads the same facts. */
const projectFacts: readonly SourceFacts[] = sourceFilesUnder(PROJECT.root).map(factsOf);

// ── Resolution and the module graph ──────────────────────────────────────────

function isLocalSpecifier(specifier: string, tree: SourceTree): boolean {
  if (specifier.startsWith('.')) return true;
  for (const alias of tree.aliases.keys()) {
    if (specifier === alias || specifier.startsWith(`${alias}/`)) return true;
  }
  return false;
}

/** The file a specifier names, or `null` if it is not a file in this tree. */
function resolveSpecifier(specifier: string, fromFile: string, tree: SourceTree): string | null {
  let base: string | null = null;

  if (specifier.startsWith('.')) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    for (const [alias, directory] of tree.aliases) {
      if (specifier === alias) base = directory;
      else if (specifier.startsWith(`${alias}/`))
        base = join(directory, specifier.slice(alias.length + 1));
    }
  }
  if (base === null) return null;

  // Source imports are written with a `.js`/`.jsx` extension (NodeNext-style) and resolve to
  // the `.ts`/`.tsx` beside them; a directory resolves through its `index`.
  const withoutExtension = base.replace(/\.[cm]?jsx?$/, '');
  const candidates = [
    base,
    `${withoutExtension}.ts`,
    `${withoutExtension}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];

  for (const candidate of candidates) {
    if (!/\.tsx?$/.test(candidate)) continue;
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // Not this candidate. An unresolvable local specifier is reported by the caller.
    }
  }
  return null;
}

interface ModuleGraph {
  /** Every file reachable from the entry, the entry included. */
  readonly files: ReadonlySet<string>;
  /** Local specifiers that resolved to nothing — a hole in the walk, never a pass. */
  readonly unresolved: readonly string[];
}

/**
 * Every file reachable from `entry` by following imports of any kind.
 *
 * Relative, aliased, dynamic and `require`d specifiers all count, and the walk leaves the
 * directory: reachability is a property of the repository, not of a folder. An unresolvable
 * local specifier is collected rather than skipped, because "the walk did not understand
 * this line" and "there is nothing there" must not look the same to a security guard.
 */
function moduleGraphFrom(entry: string, tree: SourceTree): ModuleGraph {
  const files = new Set<string>();
  const unresolved: string[] = [];
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || files.has(current)) continue;
    files.add(current);

    for (const reference of factsOf(current).imports) {
      const resolved = resolveSpecifier(reference.specifier, current, tree);
      if (resolved !== null) queue.push(resolved);
      else if (isLocalSpecifier(reference.specifier, tree)) {
        unresolved.push(`${repoPath(current)} → ${reference.specifier}`);
      }
    }
  }

  return { files, unresolved };
}

// ── The rules ────────────────────────────────────────────────────────────────

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
  for (const binding of ELECTRON_NETWORK_BINDINGS) {
    if (facts.electronBindings.has(binding)) faults.push(`electron's \`${binding}\``);
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
    const graph = moduleGraphFrom(join(BREACH_DIRECTORY, ENTRY_FILE), PROJECT);

    expect([...graph.files].map(repoPath).sort()).not.toContain(NETWORK_CAPABLE_PATH);
  });

  it('walks the whole graph rather than only direct or relative imports', () => {
    const graph = moduleGraphFrom(join(BREACH_DIRECTORY, ENTRY_FILE), PROJECT);
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
    const graph = moduleGraphFrom(join(BREACH_DIRECTORY, ENTRY_FILE), PROJECT);
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
    const graph = moduleGraphFrom(join(fixtureRoot, 'src/main/breach/aliased-client.ts'), fixture);
    expect([...graph.files]).toContain(join(fixtureRoot, 'src/main/breach/https-transport.ts'));
  });

  it('finds a relative import', () => {
    const graph = moduleGraphFrom(join(fixtureRoot, 'src/main/breach/relative-client.ts'), fixture);
    expect([...graph.files]).toContain(join(fixtureRoot, 'src/main/breach/https-transport.ts'));
  });

  it('finds a dynamic import()', () => {
    const graph = moduleGraphFrom(join(fixtureRoot, 'src/main/breach/dynamic-client.ts'), fixture);
    expect([...graph.files]).toContain(join(fixtureRoot, 'src/main/breach/https-transport.ts'));
  });

  it('follows a chain rather than only direct imports', () => {
    const graph = moduleGraphFrom(join(fixtureRoot, 'src/main/breach/indirect-client.ts'), fixture);
    expect([...graph.files]).toContain(join(fixtureRoot, 'src/main/breach/https-transport.ts'));
  });

  it('reports a local import it cannot resolve instead of walking past it', () => {
    const graph = moduleGraphFrom(join(fixtureRoot, 'src/main/breach/broken-client.ts'), fixture);
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
