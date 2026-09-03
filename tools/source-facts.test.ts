// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aliasesFrom,
  factsOf,
  importedNamesFrom,
  isLocalSpecifier,
  isTestFile,
  moduleGraphFrom,
  posixRelative,
  resolveSpecifier,
  sourceFilesUnder,
  type ImportRef,
  type SourceFacts,
  type SourceTree,
} from './source-facts.js';

/**
 * The scanner, tested directly rather than only through the guards that use it.
 *
 * `src/main/breach/no-network.test.ts` and `src/main/shell/shell-hardening.test.ts` are both
 * written over what the source *does not contain*, so the reader underneath them is the entire
 * security property: every one of their assertions is only as true as `factsOf` is complete.
 * Each of those files keeps a planted-violation block of its own, but those blocks are about
 * that guard's rules. This one is about the reader — the shapes a specifier can be written in,
 * the ways a file can hide a line from a text scan, and the two directions of dependency this
 * module is not allowed to have.
 *
 * The history is in `source-facts.ts`'s header and it is short enough to repeat: this reader was
 * a hand-rolled comment stripper, in two copies, and a line containing `'/*'` deleted the rest of
 * whatever file it appeared in. The bug was fixed in one copy. Seven planted violations went
 * through the other, silently, for weeks. So the first test below is a string containing a
 * block-comment opener, and it will stay there.
 *
 * Every assertion here is written so that it can fail: the fixture tree contains a file for each
 * shape, and the shapes that must *not* be flagged (an erased type import, a bare package
 * specifier) are asserted just as explicitly as the ones that must be.
 */

// ── This repository ──────────────────────────────────────────────────────────

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SOURCE_FACTS = join(import.meta.dirname, 'source-facts.ts');

const REPO: SourceTree = {
  root: join(REPO_ROOT, 'src'),
  aliases: aliasesFrom(join(REPO_ROOT, 'tsconfig.node.json'), REPO_ROOT),
};

/**
 * Every file under `src/` that imports this module, repo-relative.
 *
 * Computed at module scope, the same way `no-network.test.ts` parses the tree once: it is five
 * hundred files, it takes a couple of seconds, and a whole-tree scan inside an `it` trips the
 * default five-second timeout the moment the suite runs in parallel with everything else. A
 * security check that fails intermittently on a busy machine gets its assertion relaxed, and
 * then it gets deleted.
 */
const SRC_IMPORTERS: readonly string[] = sourceFilesUnder(REPO.root)
  .map(factsOf)
  .filter((facts) =>
    facts.imports.some(
      (reference) => resolveSpecifier(reference.specifier, facts.file, REPO) === SOURCE_FACTS
    )
  )
  .map((facts) => posixRelative(REPO_ROOT, facts.file))
  .sort();

// ── A throwaway tree with one file per shape ─────────────────────────────────

let fixtureRoot: string;
let fixture: SourceTree;

const write = (path: string, contents: string): void => {
  const file = join(fixtureRoot, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents, 'utf8');
};

const at = (path: string): string => join(fixtureRoot, path);
const planted = (path: string): SourceFacts => factsOf(at(path));

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'keyhold-source-facts-'));
  fixture = {
    root: join(fixtureRoot, 'src'),
    aliases: new Map([
      ['@app', join(fixtureRoot, 'src', 'app')],
      ['@lib', join(fixtureRoot, 'src', 'lib')],
    ]),
  };

  // Read through `ts.readConfigFile`, so the comment and the trailing comma are part of the
  // test: a tsconfig is JSONC, and a guard that parsed it as JSON would throw on the real one.
  write(
    'tsconfig.json',
    [
      '{',
      '  // Aliases, in the shape this project writes them.',
      '  "compilerOptions": {',
      '    "paths": {',
      '      "@app/*": ["src/app/*"],',
      '      "@lib/*": ["src/lib/*"],',
      '      "@nostar": ["src/lib/thing.ts"]',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n')
  );

  // The N18 shape, in one file: a string literal containing a block-comment opener, with three
  // different kinds of evidence underneath it. A stripper deletes all of it; a parser sees a
  // string and moves on.
  write(
    'src/app/blinded.ts',
    [
      "const KEEP_GLOB = '**/*.keep';",
      'export const go = (requestedPath: string): Promise<Response> => {',
      '  console.warn(`[app] rejected ${requestedPath} against ${KEEP_GLOB}`);',
      '  const socket = new WebSocket(requestedPath);',
      '  return fetch(requestedPath, socket);',
      '};',
      '',
    ].join('\n')
  );

  // Every import shape at once, so each can be asserted by specifier rather than by position.
  write(
    'src/app/shapes.ts',
    [
      "import { app, type BrowserWindow } from 'electron';",
      "import type { Menu } from 'electron';",
      "import * as everything from 'node:fs';",
      "import theDefault from 'node:util';",
      "const https = require('node:https');",
      "export { thing } from '@lib/thing.js';",
      "export type { Shape } from './types.js';",
      "export * from './star.js';",
      "export const load = async (): Promise<unknown> => import('node:dns');",
      'export const used = [app, everything, theDefault, https] as const;',
      'export type W = BrowserWindow | Menu;',
      '',
    ].join('\n')
  );

  write('src/lib/thing.ts', "export const thing = 'thing';\n");
  write('src/app/types.ts', 'export type Shape = { readonly kind: string };\n');
  write('src/app/star.ts', "export const star = '*';\n");

  // Resolution targets: a `.js` specifier resolving to the `.ts` beside it, a directory
  // resolving through its index, and a `.tsx` — the extension the shell guard's copy of the
  // resolver did not know about.
  write('src/app/dir/index.ts', "export const fromIndex = 'index';\n");
  // Real JSX, not a bare arrow: a `.tsx` parsed with `ScriptKind.TS` still parses — it just
  // produces a different tree, and the difference is exactly a missing call. See the test.
  write(
    'src/app/widget.tsx',
    [
      'export const Widget = (secretPath: string): unknown => (',
      '  <section title={secretPath} onClick={() => fetch(secretPath)}>',
      '    {reveal(secretPath)}',
      '  </section>',
      ');',
      '',
    ].join('\n')
  );
  write('src/app/notes.d.ts', 'export declare const notes: string;\n');
  write('src/app/nested/deep/buried.ts', "export const buried = 'buried';\n");

  // The walk: an alias out of the directory, a dynamic import, a `require`, a cycle, and an
  // `export … from` — five ways to reach a file that a specifier-regex walk missed.
  write(
    'src/app/entry.ts',
    [
      "import { thing } from '@lib/thing.js';",
      "import { fromIndex } from './dir/index.js';",
      "export { buried } from './nested/deep/buried.js';",
      "export const later = async (): Promise<unknown> => import('@lib/lazy.js');",
      "const req = require('./nested/deep/buried.js');",
      'export const all = [thing, fromIndex, req] as const;',
      '',
    ].join('\n')
  );
  write('src/lib/lazy.ts', "import '../app/cycle-a.js';\nexport const lazy = 1;\n");
  write('src/app/cycle-a.ts', "import './cycle-b.js';\nexport const a = 1;\n");
  write('src/app/cycle-b.ts', "import './cycle-a.js';\nexport const b = 1;\n");

  // Unresolvable: one relative, one aliased, and one bare package specifier that is *correctly*
  // not reported — "the walk did not understand this line" and "that is not a file in this
  // tree" must not look the same, in either direction.
  write(
    'src/app/broken.ts',
    ["import './nowhere.js';", "import '@lib/nowhere.js';", "import 'typescript';", ''].join('\n')
  );
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. What a text scan could not see
// ─────────────────────────────────────────────────────────────────────────────

describe('a string literal cannot blind the file', () => {
  it('sees every call below a string containing a block-comment opener — N18', () => {
    const facts = planted('src/app/blinded.ts');

    // All three live below the `'**' + '/*.keep'` line, which is where the stripper stopped.
    expect(facts.called.has('fetch')).toBe(true);
    expect(facts.called.has('WebSocket')).toBe(true);
    expect(facts.logCalls.map((call) => call.method)).toEqual(['warn']);
    expect(facts.logCalls[0]?.names).toContain('requestedPath');
  });

  it('keeps the opener as a string, not as the start of a comment', () => {
    expect(planted('src/app/blinded.ts').strings).toContain('**/*.keep');
  });

  it('does not mistake prose for code', () => {
    // The other half of it: these files describe at length what they refuse to do. Trivia is
    // never a node, so no stripper is needed to ignore the prose — and none may be added.
    write(
      'src/app/prose.ts',
      [
        '/** Discusses fetch, WebSocket, revealSecret and https://example.com at length. */',
        '// Also names contextIsolation, console.warn and require("node:http").',
        "export const answer = 'nothing to see here';",
        '',
      ].join('\n')
    );
    const facts = planted('src/app/prose.ts');

    expect([...facts.identifiers].sort()).toEqual(['answer']);
    expect(facts.called.size).toBe(0);
    expect(facts.imports).toEqual([]);
    expect(facts.logCalls).toEqual([]);
    expect(facts.strings).toEqual(['nothing to see here']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Every shape a specifier can be written in
// ─────────────────────────────────────────────────────────────────────────────

describe('imports, whatever shape they are written in', () => {
  const shapes = (): SourceFacts => planted('src/app/shapes.ts');
  const ref = (specifier: string, kind: ImportRef['kind'] = 'static'): ImportRef => {
    const found = shapes().imports.find(
      (candidate) => candidate.specifier === specifier && candidate.kind === kind
    );
    if (found === undefined) throw new Error(`no ${kind} import of ${specifier} was found`);
    return found;
  };

  it('separates an erased binding from a live one on the same clause', () => {
    // `import { app, type BrowserWindow }` — one capability and one type, in one statement.
    // The shell guard needs the second gone; the breach guard needs it named. Both answers
    // come off the same `ImportRef`, which is why it carries two lists.
    expect(importedNamesFrom(shapes(), 'electron')).toEqual(['app', 'BrowserWindow', 'Menu']);
    expect(importedNamesFrom(shapes(), 'electron', 'values')).toEqual(['app']);
  });

  it('marks a whole-clause type import as erased', () => {
    const named = shapes().imports.filter((candidate) => candidate.specifier === 'electron');

    expect(named.map((candidate) => candidate.typeOnly)).toEqual([false, true]);
    expect(named[1]?.names).toEqual(['Menu']);
    expect(named[1]?.valueNames).toEqual([]);
  });

  it('reads a namespace import as the whole namespace', () => {
    expect(ref('node:fs').names).toEqual(['*']);
    expect(ref('node:fs').valueNames).toEqual(['*']);
  });

  it('reads a default import as a default binding', () => {
    expect(ref('node:util').names).toEqual(['default']);
  });

  it('reads a require() as the whole namespace', () => {
    expect(ref('node:https', 'require').valueNames).toEqual(['*']);
  });

  it('reads a dynamic import() as the whole namespace', () => {
    expect(ref('node:dns', 'dynamic').valueNames).toEqual(['*']);
  });

  it('reads `export … from` as the import it is', () => {
    // A re-export is a live binding. The shell guard's copy of this returned an empty name list
    // for every `export … from`, so `export { net } from 'electron'` in the pure half would
    // have been an Electron value import that the Electron rule could not see.
    expect(ref('@lib/thing.js').names).toEqual(['thing']);
    expect(ref('@lib/thing.js').valueNames).toEqual(['thing']);
  });

  it('reads `export * from` as the whole namespace, and `export type` as erased', () => {
    expect(ref('./star.js').valueNames).toEqual(['*']);
    expect(ref('./types.js').typeOnly).toBe(true);
    expect(ref('./types.js').valueNames).toEqual([]);
  });

  it('asks about one module without answering for another', () => {
    expect(importedNamesFrom(shapes(), 'node:child_process')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Finding the files, and resolving what they name
// ─────────────────────────────────────────────────────────────────────────────

describe('finding files', () => {
  it('descends into subdirectories', () => {
    const found = sourceFilesUnder(join(fixtureRoot, 'src')).map((file) =>
      posixRelative(fixtureRoot, file)
    );

    expect(found).toContain('src/app/nested/deep/buried.ts');
    expect(found).toContain('src/app/dir/index.ts');
  });

  it('includes .tsx and excludes declaration files', () => {
    const found = sourceFilesUnder(join(fixtureRoot, 'src')).map((file) =>
      posixRelative(fixtureRoot, file)
    );

    expect(found).toContain('src/app/widget.tsx');
    expect(found).not.toContain('src/app/notes.d.ts');
  });

  it('parses .tsx as TSX rather than as TS, so a call inside JSX is still a call', () => {
    // A `.tsx` parsed with `ScriptKind.TS` does not throw. It silently produces a different
    // tree — the worst outcome available to a scanner — and the difference is load-bearing:
    // measured on this fixture, `ScriptKind.TS` sees `fetch` (it is inside an attribute, which
    // survives being reparsed as a type assertion) but **not** `reveal`, which sits in a JSX
    // expression container. It also invents an empty-string identifier out of the wreckage.
    //
    // This is live today: `no-network.test.ts` scans all of `src/`, and `src/renderer/` is
    // `.tsx`. "Makes no request from a test, either" is an assertion about the `called` set of
    // renderer test files, so a TS-parsed `.tsx` would answer it from a mangled tree.
    const facts = planted('src/app/widget.tsx');

    expect(facts.called.has('reveal')).toBe(true);
    expect(facts.called.has('fetch')).toBe(true);
    expect(facts.identifiers.has('')).toBe(false);
    expect(facts.identifiers).toContain('Widget');
  });

  it('names a test file a test file, .tsx included', () => {
    expect(isTestFile('a/b/thing.test.ts')).toBe(true);
    expect(isTestFile('a/b/thing.test.tsx')).toBe(true);
    expect(isTestFile('a/b/thing.ts')).toBe(false);
    expect(isTestFile('a/b/attestation.ts')).toBe(false);
  });
});

describe('resolving a specifier', () => {
  it('resolves an alias read out of a tsconfig', () => {
    // The alias table is parsed from the fixture's own tsconfig, comments and all — never
    // restated in the test. A guard carrying its own copy goes blind the day one is added.
    const aliases = aliasesFrom(at('tsconfig.json'), fixtureRoot);
    const tree: SourceTree = { root: join(fixtureRoot, 'src'), aliases };

    expect([...aliases.keys()].sort()).toEqual(['@app', '@lib']);
    expect(resolveSpecifier('@lib/thing.js', at('src/app/entry.ts'), tree)).toBe(
      at('src/lib/thing.ts')
    );
  });

  it('ignores a paths entry that is not a prefix mapping', () => {
    // `"@nostar": ["src/lib/thing.ts"]` maps one specifier to one file. It is not a prefix, so
    // treating it as one would resolve `@nostarry/anything` to a path inside it.
    expect([...aliasesFrom(at('tsconfig.json'), fixtureRoot).keys()]).not.toContain('@nostar');
  });

  it('resolves a .js specifier to the .ts beside it, and a directory through its index', () => {
    expect(resolveSpecifier('./thing.js', at('src/lib/entry.ts'), fixture)).toBe(
      at('src/lib/thing.ts')
    );
    expect(resolveSpecifier('./dir', at('src/app/entry.ts'), fixture)).toBe(
      at('src/app/dir/index.ts')
    );
  });

  it('resolves a .jsx specifier to the .tsx beside it', () => {
    expect(resolveSpecifier('./widget.jsx', at('src/app/entry.ts'), fixture)).toBe(
      at('src/app/widget.tsx')
    );
  });

  it('tells a local specifier apart from a package', () => {
    expect(isLocalSpecifier('./thing.js', fixture)).toBe(true);
    expect(isLocalSpecifier('@lib/thing.js', fixture)).toBe(true);
    expect(isLocalSpecifier('typescript', fixture)).toBe(false);
    expect(isLocalSpecifier('@types/node', fixture)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The module graph
// ─────────────────────────────────────────────────────────────────────────────

describe('the module graph', () => {
  const reached = (): readonly string[] =>
    [...moduleGraphFrom([at('src/app/entry.ts')], fixture).files].map((file) =>
      posixRelative(fixtureRoot, file)
    );

  it('follows an aliased specifier out of the directory', () => {
    expect(reached()).toContain('src/lib/thing.ts');
  });

  it('follows a dynamic import(), transitively', () => {
    expect(reached()).toContain('src/lib/lazy.ts');
    // `lazy.ts` is only reached through the `import()`, and `cycle-a.ts` only through `lazy.ts`.
    expect(reached()).toContain('src/app/cycle-a.ts');
  });

  it('follows a require() and an `export … from`', () => {
    expect(reached()).toContain('src/app/nested/deep/buried.ts');
  });

  it('terminates on a cycle', () => {
    const graph = moduleGraphFrom([at('src/app/cycle-a.ts')], fixture);

    expect([...graph.files].map((file) => posixRelative(fixtureRoot, file)).sort()).toEqual([
      'src/app/cycle-a.ts',
      'src/app/cycle-b.ts',
    ]);
  });

  it('walks from several entries at once', () => {
    const graph = moduleGraphFrom([at('src/app/cycle-a.ts'), at('src/lib/thing.ts')], fixture);

    expect(graph.files.size).toBe(3);
  });

  it('reports a local specifier it cannot resolve instead of walking past it', () => {
    // The whole point: a walk that cannot follow a line must say so. Silence would make a
    // typo'd specifier and a genuinely absent dependency indistinguishable, and the guards
    // read this list as a hard failure.
    const graph = moduleGraphFrom([at('src/app/broken.ts')], fixture);

    expect([...graph.unresolved].sort()).toEqual([
      'src/app/broken.ts → ./nowhere.js',
      'src/app/broken.ts → @lib/nowhere.js',
    ]);
  });

  it('does not report a package specifier as unresolved', () => {
    // `import 'typescript'` is in the same file. It is not a file in this tree and never will
    // be, so reporting it would make the list noise, and a noisy list gets its assertion
    // relaxed to `toBeLessThan(n)` — which is how a guard dies.
    expect(moduleGraphFrom([at('src/app/broken.ts')], fixture).unresolved).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. What this module may depend on, and what may depend on it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The scanner reads every other module, so its own dependencies are a security question.
 *
 * An import from `src/` would make it part of what it scans. An import *of* it from `src/` would
 * put a recursive-directory-walking, file-reading module into the shipped app for no reason at
 * all — it adds no capability the app needs, and hard rule 5 is easier to keep true when the
 * only file that reads the whole tree cannot be reached from the tree.
 *
 * The two guards import it and are excluded: they are `.test.ts`, they are not in any of the
 * three build entries, and the non-vacuity assertion below names both of them so this rule
 * cannot quietly become a rule about nothing.
 */
describe('the scanner is not part of what it scans', () => {
  it('imports nothing but node and the compiler', () => {
    const specifiers = factsOf(SOURCE_FACTS).imports.map((reference) => reference.specifier);

    expect([...new Set(specifiers)].sort()).toEqual(['node:fs', 'node:path', 'typescript']);
  });

  it('cannot originate a request itself', () => {
    // `no-network.test.ts` scans `src/`, so this file sits outside its reach. Moving shared
    // code out of `src/` must not move it out of hard rule 5.
    const facts = factsOf(SOURCE_FACTS);

    for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon']) {
      expect(facts.identifiers.has(name), `source-facts.ts names ${name}`).toBe(false);
    }
  });

  it('is imported by no shipped file under src/', () => {
    expect(SRC_IMPORTERS.filter((path) => !isTestFile(path))).toEqual([]);
  });

  it('is imported by both guards, so the rule above is about something', () => {
    // Non-vacuity, and it is not theoretical: a resolver that silently stopped matching, or a
    // walk that stopped descending, would satisfy the assertion above perfectly and for ever.
    expect(SRC_IMPORTERS).toEqual([
      'src/main/breach/no-network.test.ts',
      'src/main/shell/shell-hardening.test.ts',
    ]);
  });
});
