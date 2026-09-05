// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Guard: **every renderer module is reachable from something that runs.**
 *
 * This is the second half of the rule `tools/bridge-is-used.test.ts` opens, and that file
 * says plainly what it cannot do:
 *
 * > A method that is called is not thereby *reachable* — the call could sit in a component
 * > nothing renders, which is how `BreachSection` was stranded even though `useBreachCheck`
 * > called the bridge.
 *
 * It concluded that the second half "needs a running app". That turns out not to be true, and
 * the cheaper answer is better: a module nothing imports is unreachable no matter what runs.
 * Walk the import graph from the two things that actually execute — the application entry and
 * the test files — and anything not in the resulting set is code that cannot run at all.
 *
 * ## The two halves together
 *
 * | Guard                       | Answers                                                      |
 * | --------------------------- | ------------------------------------------------------------ |
 * | `bridge-is-used.test.ts`    | Is every capability *called* from somewhere in the renderer?  |
 * | this file                   | Is the module containing that call *reachable* at all?        |
 *
 * Between them: a capability wired to nothing fails the first, and a caller that nothing can
 * reach fails the second. Neither replaces the smoke run, which is the only one that can say
 * a reachable component actually renders something — but the smoke run only checks what
 * somebody thought to write a check for, and these two check the shape without being asked.
 *
 * ## Why the test files are roots, rather than fixtures being allow-listed
 *
 * An in-memory fake imported only by `ImportWizard.test.tsx` is not dead code; it is code the
 * test suite runs. Rooting the walk at `main.tsx` alone reported eleven such files, and
 * excluding them by filename — `fake-*`, `*-fixture`, `test-*` — would have been an
 * allow-list that grows with every new naming habit and hides a genuinely dead fixture inside
 * the pattern. Rooting at the tests states the actual rule instead: **reachable from
 * something that executes.** Measured: it removed all eleven and left the four below, every
 * one of which is real.
 *
 * ## Measurements, so nobody repeats them blind
 *
 * - Roots = entry only, `.tsx` only: **0 stranded.** Sound, but blind to dead `.ts`.
 * - Roots = entry only, `.ts` and `.tsx`: **13 stranded**, 11 of them test fixtures.
 * - Roots = entry + tests, `.ts` and `.tsx`: **4 stranded, all four genuine.** This is the
 *   form in force. It found 573 lines of code that nothing in the repository imports.
 *
 * ## What this does not catch, stated so it is not assumed
 *
 * A module that is *imported* but whose component is never placed in JSX stays reachable
 * here. That variant is already covered from the other side: an import bound to a name that
 * is never used is an unused variable, and `@typescript-eslint/no-unused-vars` fails the lint
 * step on it. The gap that would matter is an import used only in dead code inside a
 * reachable file, which needs a running app and is what the smoke run is for.
 *
 * Fault injection performed:
 *  1. Removed the `TraySection` import and its JSX from `SettingsScreen.tsx` — failed,
 *     naming `settings/TraySection.tsx`.
 *  2. Added a new `src/renderer/src/components/Orphan.tsx` importing nothing — failed,
 *     naming it.
 *  3. Deleted the `ALLOWED` entry for `import/index.ts` — failed, naming it again, so an
 *     exemption cannot be removed without the module it covered coming back into view.
 *  4. Added an `ALLOWED` entry for `App.tsx`, which is reachable — failed on "exempts nothing
 *     that is actually reachable". That is the anti-rot half, and it is the one that stops
 *     this list becoming a place bad news goes to die.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const RENDERER = join(ROOT, 'src/renderer/src');

/**
 * Modules that are unreachable and are staying that way for now, with the reason.
 *
 * Same convention as `bridge-is-used.test.ts` and `file-length.test.ts`: an entry is either a
 * reachability the scan genuinely cannot see, or it is **debt** — and debt names the backlog
 * item it is waiting for. An allow-list that only ever held justifications would be a place
 * for bad news to go and die, which is the failure this guard exists to prevent.
 *
 * All four below are debt, and all four were found by this guard on its first run.
 */
const ALLOWED: readonly { readonly path: string; readonly why: string }[] = [
  {
    path: 'src/renderer/src/settings/fake-gateway.ts',
    why: '**debt.** A complete in-memory `SettingsGateway` double, 174 lines, imported by nothing — not even a test. The settings screen has no component test to drive it. Backlog E23',
  },
  {
    path: 'src/renderer/src/organisation/fake-gateway.ts',
    why: '**debt.** The same shape for folders and tags, 253 lines, and the same absence. Backlog E23',
  },
  {
    path: 'src/renderer/src/import/index.ts',
    why: '**debt.** A barrel whose own doc says "one import site for whoever mounts this" and gives the three lines to do it — and the wizard is mounted by direct path instead, so the barrel is an unused second route whose instructions can drift from the real one. Hard rule 8. Backlog E24',
  },
  {
    path: 'src/renderer/src/export/index.ts',
    why: '**debt.** Same barrel, same absence, same rule. Backlog E24',
  },
];

/** Where the walk starts: the application entry, plus everything the test runner executes. */
function roots(): readonly string[] {
  const entry = join(RENDERER, 'main.tsx');
  const tests = globSync('**/*.test.{ts,tsx}', { cwd: RENDERER }).map((file) =>
    join(RENDERER, file)
  );
  return [entry, ...tests];
}

/**
 * Resolves an import specifier to a file, or `null` for anything outside the renderer.
 *
 * Handles the `.js`-suffixed specifiers this project writes (TypeScript's `nodenext` style,
 * where the source says `.js` and the file on disk is `.ts`), directory imports resolving to
 * `index`, and the `@renderer/*` alias from `tsconfig.web.json`. The alias is honoured even
 * though nothing currently uses it — a guard that starts producing false positives the day
 * somebody adopts a configured path mapping is a guard that gets deleted.
 */
function resolveImport(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@renderer/')) {
    base = join(RENDERER, specifier.slice('@renderer/'.length));
  } else if (specifier.startsWith('.')) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    // A package, or `@shared/*` — shared is compiled into both bundles and its reachability
    // is not this guard's question.
    return null;
  }

  const withoutJs = base.replace(/\.js$/, '');
  for (const candidate of [
    `${withoutJs}.tsx`,
    `${withoutJs}.ts`,
    join(withoutJs, 'index.tsx'),
    join(withoutJs, 'index.ts'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Every module this file pulls in, via the parser rather than a regex.
 *
 * `export … from` counts as well as `import`: a barrel re-exporting a module keeps it alive
 * exactly as an import does, and missing that would report every module behind a barrel as
 * dead. Type-only imports count too — deliberately conservative, since the question here is
 * "can this file be reached", and a false positive on live code is far more expensive than
 * missing a module that is only reachable for its types.
 */
function importsOf(file: string): readonly string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const found: string[] = [];
  source.forEachChild((node) => {
    const specifier =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : null;
    if (specifier === null) return;
    const resolved = resolveImport(file, specifier);
    if (resolved !== null) found.push(resolved);
  });
  return found;
}

function reachableModules(): ReadonlySet<string> {
  const seen = new Set<string>();
  const stack = [...roots()];
  while (stack.length > 0) {
    const file = stack.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    stack.push(...importsOf(file));
  }
  return seen;
}

const asRepoPath = (file: string): string => relative(ROOT, file).split('\\').join('/');

/** Every renderer module that is not itself a test file. */
function rendererModules(): readonly string[] {
  return globSync('**/*.{ts,tsx}', { cwd: RENDERER })
    .filter((file) => !/\.test\.tsx?$/.test(file))
    .map((file) => join(RENDERER, file));
}

describe('every renderer module can be reached from something that runs', () => {
  const reachable = reachableModules();
  const allowed = new Set(ALLOWED.map((entry) => entry.path));

  it('has no module that nothing imports', () => {
    const stranded = rendererModules()
      .filter((file) => !reachable.has(file))
      .map(asRepoPath)
      .filter((path) => !allowed.has(path))
      .sort();

    expect(
      stranded,
      'A renderer module nothing imports cannot run, whatever its own tests say. This is the ' +
        'shape CLAUDE.md calls "built and unreachable". Wire it up, delete it, or add it to ' +
        'ALLOWED with the backlog item it is waiting for.'
    ).toEqual([]);
  });

  it('exempts nothing that is actually reachable', () => {
    // The anti-rot half, copied from file-length.test.ts's convention: an entry whose module
    // has since been wired up has stopped being an exemption and is now a way to miss the
    // next time that module is stranded.
    const nowReachable = ALLOWED.filter((entry) => reachable.has(join(ROOT, entry.path))).map(
      (entry) => entry.path
    );

    expect(
      nowReachable,
      'These are reachable now and no longer need an exemption — delete the entry.'
    ).toEqual([]);
  });

  it('exempts nothing that has been deleted', () => {
    const missing = ALLOWED.filter((entry) => !existsSync(join(ROOT, entry.path))).map(
      (entry) => entry.path
    );

    expect(missing, 'These no longer exist — delete the entry.').toEqual([]);
  });

  it('every exemption says what it is waiting for', () => {
    // A reason that does not name a backlog item is how debt becomes a permanent resident.
    const vague = ALLOWED.filter((entry) => !/Backlog [A-Z]\d+/.test(entry.why)).map(
      (entry) => entry.path
    );

    expect(vague, 'A debt entry must name the backlog item that will close it.').toEqual([]);
  });

  it('starts from roots that exist', () => {
    // Cheap, and it defends the whole file: if the entry path is ever renamed, every walk
    // starts from nothing, everything is stranded, and the failure would look like a
    // catastrophe rather than a typo.
    expect(existsSync(join(RENDERER, 'main.tsx'))).toBe(true);
    expect(roots().length).toBeGreaterThan(1);
  });
});
