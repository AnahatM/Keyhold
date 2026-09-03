// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

/**
 * The one source scanner. Every structural guard in this repository reads code through here.
 *
 * ## Why this module exists — read before copying anything out of it
 *
 * Two security guards are written over what the source *does not contain*:
 * `src/main/breach/no-network.test.ts` (hard rule 5 — nothing can originate a request) and
 * `src/main/shell/shell-hardening.test.ts` (no window is built in the shell, the shell cannot
 * reach the vault, the pure half imports no Electron, nothing logs a value). Neither claim can
 * be checked by calling a function, so *how the code is read* is the entire security property.
 *
 * That reader has now been the same defect twice:
 *
 *  1. **The stripper.** Both guards began as text matching over a hand-rolled comment stripper.
 *     The stripper had no notion of string literals, so a line containing `'/*'` — the shell's
 *     `const KEEP_GLOB = '**' + '/*.keep'` is the most natural line imaginable for a directory
 *     that handles OS file hand-offs — opened a block comment that never closed, and every line
 *     below it was deleted before any check saw it. The bug was found and fixed in the breach
 *     copy. The shell copy kept it, under a comment saying that sharing the routine "would mean
 *     a third location outside both modules" and that the duplication was "noted in the report".
 *     Noting it is what let one file's bug be two files' bug: seven planted violations went
 *     through the shell guard, silently, for weeks.
 *  2. **The rebuild.** Both guards were then rebuilt onto the TypeScript parser, which closes
 *     that hole by construction — a comment is trivia and never becomes a node. Both got their
 *     own copy of `factsOf`, `sourceFilesUnder`, `aliasesFrom`, `resolveSpecifier` and
 *     `moduleGraphFrom`. Same defect, new spelling.
 *
 * So: **this is the third location, and it is the only one.** Hard rule 8 is not a tidiness
 * preference here — a second scanner is a second answer to "what does this file contain", and
 * the guards are only worth their assertions if that question has one answer. If a guard needs
 * a fact this module does not expose, add it here and let both guards see it. Do not re-derive
 * it locally, and do not copy a function out of this file.
 *
 * ## What it deliberately is not
 *
 * Not "the source with comments removed" — that framing is what produced the stripper. The
 * facts below come from `ts.createSourceFile`, the same parser that compiles the project, so
 * prose about `fetch` cannot reach them and no string literal can hide a line from them.
 *
 * Not a type checker. It parses one file at a time and never builds a `ts.Program`: the guards
 * ask what a file *names*, *calls* and *imports*, and a program would cost seconds per run to
 * answer questions nobody is asking.
 *
 * ## What it may depend on
 *
 * Nothing under `src/`. This module reads every other module, so an import from the app would
 * make the scanner part of what it scans; and nothing under `src/` may import it either — it
 * adds no capability to the shipped app, and it must not be able to. Both directions are
 * asserted in `tools/source-facts.test.ts`.
 */

// ── What one file contains ───────────────────────────────────────────────────

/**
 * One `import`, `export … from`, `import()` or `require()`, however it was written.
 *
 * `names` and `valueNames` are both kept because the two guards want genuinely different
 * questions answered. The shell asks what survives to runtime: `import type { BrowserWindow }
 * from 'electron'` is erased and carries no capability, so it may sit in the pure half. The
 * breach guard asks what was *named at all*: an `electron` type import in a file that has no
 * business knowing Electron exists is worth a failure whether or not it is erased. Collapsing
 * the two would silently pick one guard's answer for both.
 *
 * `'*'` stands for the whole module namespace (`import * as x`, `import()`, `require()`,
 * `export * from`) and `'default'` for a default binding. Both hand over every binding at once,
 * which is exactly what the old single-shape regexes in both guards could not see.
 */
export interface ImportRef {
  readonly specifier: string;
  readonly kind: 'static' | 'dynamic' | 'require';
  /** `import type …` / `export type … from …`: the whole clause is erased at build time. */
  readonly typeOnly: boolean;
  /** Every imported name, by the name it is exported under — erased ones included. */
  readonly names: readonly string[];
  /** The subset of `names` that survives to runtime. Empty for a type-only clause. */
  readonly valueNames: readonly string[];
}

/** One `console.*` call, reduced to the names its arguments could carry a value through. */
export interface LogCall {
  readonly method: string;
  readonly names: readonly string[];
}

/**
 * Everything the guards need to know about one file, taken from its parse tree.
 *
 * The union of what the two guards asked for separately. Nothing here is read by only one of
 * them by accident: `logCalls` is the shell's leak rule, `names` is the breach guard's Electron
 * rule, and both are on the shape because dropping the field only one caller reads today is how
 * the next guard ends up writing its own extractor.
 */
export interface SourceFacts {
  readonly file: string;
  readonly imports: readonly ImportRef[];
  /** Every identifier written in code, property names included (`navigator.sendBeacon`). */
  readonly identifiers: ReadonlySet<string>;
  /** Names actually invoked: `fetch(…)`, `new BrowserWindow(…)`, `globalThis['fetch'](…)`. */
  readonly called: ReadonlySet<string>;
  /** String and template contents, in code only. */
  readonly strings: readonly string[];
  readonly logCalls: readonly LogCall[];
}

function stringValue(node: ts.Node | undefined): string | null {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;
}

/**
 * `import type { … }` — the whole clause erased.
 *
 * Read off `phaseModifier` rather than the deprecated `isTypeOnly`, and compared against
 * `TypeKeyword` specifically: the other phase modifier is `defer`, and a deferred import is a
 * value import that has merely not run yet. Treating it as erased would be a hole.
 */
function isErasedClause(clause: ts.ImportClause): boolean {
  return clause.phaseModifier === ts.SyntaxKind.TypeKeyword;
}

/** `names` and `valueNames` for one import clause, read off the clause rather than its spelling. */
function clauseNames(clause: ts.ImportClause | undefined): {
  names: readonly string[];
  valueNames: readonly string[];
} {
  if (clause === undefined) return { names: [], valueNames: [] };

  const erased = isErasedClause(clause);
  const names: string[] = [];
  const valueNames: string[] = [];

  const add = (name: string, isType: boolean): void => {
    names.push(name);
    if (!erased && !isType) valueNames.push(name);
  };

  if (clause.name !== undefined) add('default', false);

  const bindings = clause.namedBindings;
  if (bindings === undefined) return { names, valueNames };

  if (ts.isNamespaceImport(bindings)) {
    // `import * as electron from 'electron'` puts every binding in reach at once.
    add('*', false);
  } else {
    for (const element of bindings.elements) {
      // `import { net as electronNet }` — the imported name is what matters, not the local.
      add((element.propertyName ?? element.name).text, element.isTypeOnly);
    }
  }
  return { names, valueNames };
}

/**
 * `names` and `valueNames` for an `export … from '…'`.
 *
 * Read for the same reason the import clause is: `export { net } from 'electron'` re-exports a
 * live binding, and a guard that only looks at `import` declarations cannot see it.
 */
function exportNames(declaration: ts.ExportDeclaration): {
  names: readonly string[];
  valueNames: readonly string[];
} {
  const clause = declaration.exportClause;
  const erased = declaration.isTypeOnly;

  // `export * from '…'` and `export * as ns from '…'` both re-export the namespace whole.
  if (clause === undefined || ts.isNamespaceExport(clause)) {
    return { names: ['*'], valueNames: erased ? [] : ['*'] };
  }

  const names: string[] = [];
  const valueNames: string[] = [];
  for (const element of clause.elements) {
    const name = (element.propertyName ?? element.name).text;
    names.push(name);
    if (!erased && !element.isTypeOnly) valueNames.push(name);
  }
  return { names, valueNames };
}

/**
 * Parse one file and reduce it to the facts above.
 *
 * Not memoised. A cache would be keyed on a path, and the guards point this at throwaway
 * fixture trees they rewrite during a run; a stale answer in a security scanner is worse than
 * the few hundred milliseconds a whole-repo walk costs.
 */
export function factsOf(file: string): SourceFacts {
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
  const logCalls: LogCall[] = [];

  const calleeName = (expression: ts.Expression): string | null => {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (ts.isElementAccessExpression(expression)) return stringValue(expression.argumentExpression);
    return null;
  };

  /** Every identifier and property name inside an expression — the things carrying values. */
  const namesIn = (node: ts.Node): readonly string[] => {
    const found: string[] = [];
    const walk = (current: ts.Node): void => {
      if (ts.isIdentifier(current) || ts.isPrivateIdentifier(current)) found.push(current.text);
      ts.forEachChild(current, walk);
    };
    walk(node);
    return found;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = stringValue(node.moduleSpecifier);
      if (specifier !== null) {
        const clause = node.importClause;
        imports.push({
          specifier,
          kind: 'static',
          typeOnly: clause !== undefined && isErasedClause(clause),
          ...clauseNames(clause),
        });
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      // `export … from '…'` is an import as far as the module graph is concerned.
      const specifier = stringValue(node.moduleSpecifier);
      if (specifier !== null) {
        imports.push({
          specifier,
          kind: 'static',
          typeOnly: node.isTypeOnly,
          ...exportNames(node),
        });
      }
    } else if (ts.isCallExpression(node)) {
      const first = node.arguments[0];
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = stringValue(first);
        // A dynamic import is never type-only and hands over the whole module namespace.
        if (specifier !== null) {
          imports.push({
            specifier,
            kind: 'dynamic',
            typeOnly: false,
            names: ['*'],
            valueNames: ['*'],
          });
        }
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const specifier = stringValue(first);
        if (specifier !== null) {
          imports.push({
            specifier,
            kind: 'require',
            typeOnly: false,
            names: ['*'],
            valueNames: ['*'],
          });
        }
      }

      const name = calleeName(node.expression);
      if (name !== null) called.add(name);

      const target = node.expression;
      if (
        ts.isPropertyAccessExpression(target) &&
        ts.isIdentifier(target.expression) &&
        target.expression.text === 'console'
      ) {
        logCalls.push({
          method: target.name.text,
          names: node.arguments.flatMap((argument) => namesIn(argument)),
        });
      }
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

  return { file, imports, identifiers, called, strings, logCalls };
}

/**
 * The names a file pulls in from one module, across every import shape.
 *
 * `'*'` or `'default'` in the result means the module object arrived whole, so every binding on
 * it is in reach — the caller decides what that implies for its own list of dangerous names.
 * `values` narrows to bindings that survive to runtime; the default counts erased ones too,
 * because "this file mentions Electron's `net`" is a finding whether or not it is a type.
 */
export function importedNamesFrom(
  facts: SourceFacts,
  module: string,
  scope: 'all' | 'values' = 'all'
): readonly string[] {
  return facts.imports
    .filter((reference) => reference.specifier === module)
    .flatMap((reference) => (scope === 'values' ? reference.valueNames : reference.names));
}

// ── The tree being scanned ───────────────────────────────────────────────────

/**
 * A source tree and the aliases its imports may be written in.
 *
 * A parameter rather than a constant so a guard's fault-injection block can point the very same
 * scan at a throwaway tree of planted violations. A guard that can only be run against the
 * repository can only ever be observed passing.
 */
export interface SourceTree {
  readonly root: string;
  /** Alias prefix (`@main`) → absolute directory. Read from tsconfig, never restated. */
  readonly aliases: ReadonlyMap<string, string>;
}

/**
 * A project's path aliases, read out of a tsconfig.
 *
 * Parsed rather than duplicated: hard rule 8, and because a guard carrying its own copy of the
 * alias table stops seeing an alias the moment one is added — which is how a module walk goes
 * quietly blind. Reads through `ts.readConfigFile`, so the comments in the tsconfig are fine.
 *
 * Throws rather than asserting: this module is not a test and must not depend on a test runner
 * being present, and an unreadable tsconfig has to be a loud failure either way — an empty
 * alias map would make every aliased import unresolvable, which is the shape of the hole the
 * alias support was added to close.
 */
export function aliasesFrom(tsconfigPath: string, root: string): ReadonlyMap<string, string> {
  const parsed = ts.readConfigFile(tsconfigPath, (path) => ts.sys.readFile(path));
  if (parsed.error !== undefined) {
    throw new Error(
      `${tsconfigPath} could not be read: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, ' ')}`
    );
  }

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

/**
 * Every `.ts`/`.tsx` below `directory`, recursively, sorted.
 *
 * Recursive because both guards were once a single non-recursive `readdirSync`, and a
 * subdirectory is not a `.ts` file, so a whole subtree stopped being scanned without anything
 * failing. Declaration files are excluded: they are types, and a type cannot call anything.
 */
export function sourceFilesUnder(directory: string): readonly string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(path);
    }
  };
  walk(directory);
  return found.sort();
}

export const isTestFile = (file: string): boolean => /\.test\.tsx?$/.test(file);

/** `/`-separated, so failure messages read the same on both platforms. */
export const posixRelative = (from: string, file: string): string =>
  relative(from, file).split(sep).join('/');

// ── Resolution and the module graph ──────────────────────────────────────────

/** A specifier that names a file in this tree rather than a package: relative, or aliased. */
export function isLocalSpecifier(specifier: string, tree: SourceTree): boolean {
  if (specifier.startsWith('.')) return true;
  for (const alias of tree.aliases.keys()) {
    if (specifier === alias || specifier.startsWith(`${alias}/`)) return true;
  }
  return false;
}

/** The file a specifier names, or `null` if it is not a file in this tree. */
export function resolveSpecifier(
  specifier: string,
  fromFile: string,
  tree: SourceTree
): string | null {
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

export interface ModuleGraph {
  /** Every file reachable from the entries, the entries included. */
  readonly files: ReadonlySet<string>;
  /** Local specifiers that resolved to nothing — a hole in the walk, never a pass. */
  readonly unresolved: readonly string[];
}

/**
 * Every file reachable from `entries` by following imports of any kind.
 *
 * Relative, aliased, dynamic and `require`d specifiers all count, and the walk leaves the
 * directory: reachability is a property of the repository, not of a folder. An unresolvable
 * local specifier is collected rather than skipped, because "the walk did not understand this
 * line" and "there is nothing there" must not look the same to a security guard.
 *
 * Type-only imports are followed too. They carry no capability, but a rule with an exception is
 * a rule someone will argue about, and a type import is still a file this code has a reason to
 * know about.
 */
export function moduleGraphFrom(entries: readonly string[], tree: SourceTree): ModuleGraph {
  const files = new Set<string>();
  const unresolved: string[] = [];
  const queue = [...entries];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || files.has(current)) continue;
    files.add(current);

    for (const reference of factsOf(current).imports) {
      const resolved = resolveSpecifier(reference.specifier, current, tree);
      if (resolved !== null) queue.push(resolved);
      else if (isLocalSpecifier(reference.specifier, tree)) {
        // Named from one level above the tree root, which for a root of `…/src` is the
        // repository: `src/main/breach/client.ts → ./nowhere.js` is the whole story, and the
        // same expression keeps a fixture tree's message short instead of printing a temp path.
        unresolved.push(`${posixRelative(dirname(tree.root), current)} → ${reference.specifier}`);
      }
    }
  }

  return { files, unresolved };
}
