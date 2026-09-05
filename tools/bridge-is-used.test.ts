// SPDX-License-Identifier: GPL-3.0-or-later
import { globSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Guard: **every capability handed to the renderer is used by the renderer.**
 *
 * This is the generalisation of the rule this repository keeps breaking. `CLAUDE.md` names the
 * failure outright — "built and unreachable is the failure mode this project actually has" —
 * and lists six subsystems it happened to: the breach check, the TOTP engine, the recovery
 * engine, the session activity log, the settings screen and the inline generator. Every test of
 * every one of them passed the entire time, because **no test of a subsystem can see that
 * nothing calls it.**
 *
 * The smoke run catches the ones somebody thought to write a check for. This catches the shape
 * without anybody having to think of it, and it does so statically:
 *
 *   `KeyholdApi` in `src/shared/ipc/api.ts` is the complete list of things the renderer is
 *   able to do. If a member of it is never called anywhere under `src/renderer/`, then a
 *   capability was designed, implemented in main, validated at the boundary, exposed through
 *   the preload bridge — and wired to nothing.
 *
 * That is not a style problem. It is the exact signature of the defect, and it is visible from
 * the two ends without running anything.
 *
 * ## What it deliberately does not claim
 *
 * A method that is called is not thereby *reachable* — the call could sit in a component
 * nothing renders, which is how `BreachSection` was stranded even though `useBreachCheck`
 * called the bridge. This file is blind past the call site, and deliberately.
 *
 * That second half is now covered too, and it did **not** need a running app after all, which
 * is worth recording because this comment claimed for a while that it did.
 * `tools/renderer-is-reachable.test.ts` walks the import graph from the application entry and
 * from every test file: a module nothing imports cannot run, whatever its own tests say. It
 * found four dead modules on its first run. What still needs a running app is the third
 * question — whether a reachable component actually renders anything — and that is
 * `src/main/smoke.ts`, which asserts the breach panel is present and idle.
 *
 * ## Why the parser rather than a regex
 *
 * `no-network.test.ts` records what happened when a guard in this repository read source as
 * text: a comment stripper with no notion of string literals blinded whole files, and the
 * scan failed open for months. Property names come from `ts.createSourceFile` here, the same
 * parser that compiles the project, so a mention inside a comment or a string is not a call.
 *
 * ## Fault injection performed, two defects
 *
 *  1. Added `neverCalled: () => Promise<void>;` to `BreachApi`. Failed with
 *     `breach.neverCalled`.
 *  2. Removed the one `window.keyhold.recovery.saveReport()` binding from the renderer.
 *     **Failed nothing** — the parameter it was assigned to is also called `saveReport`, so
 *     the name survived the deletion. An injection that fails nothing is a finding, and this
 *     one is recorded rather than buried: a stricter form was built to close it, measured, and
 *     rejected for producing 28 false positives. The reasoning and the measurement are in
 *     `accessedNames` below, so nobody repeats the experiment blind.
 *
 * On its first run against a clean tree it found three real defects: `app.getVersion` (a second
 * route to a build-time constant, since deleted along with its dead IPC channel), and
 * `session.clearClipboard` and `attachments.audit` — both built, both correct, both surfaced
 * nowhere, now backlog E21 and E22.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/**
 * Members that are exposed and not called, with the reason.
 *
 * Two kinds of entry can live here, labelled differently on purpose — the same convention as
 * `file-length.test.ts`. One kind is a capability with a caller the static scan cannot see;
 * those say so. The other is **debt**: built, correct, and surfaced nowhere, with a backlog
 * item naming the control it is waiting for. An allow-list that only ever contained
 * justifications would be a place for bad news to go and die, and this guard exists precisely
 * to stop that.
 *
 * Both entries below are debt, and both were found by this guard on its first run.
 */
const ALLOWED: readonly { readonly member: string; readonly why: string }[] = [
  {
    member: 'session.clearClipboard',
    why: '**debt.** Implemented, validated and exposed; no control invokes it. Keyhold clears the clipboard on a timer, so what is missing is the "I am done, clear it now" button beside the countdown. Backlog E21',
  },
  {
    member: 'attachments.audit',
    why: '**debt.** Reports attachment orphans in both directions and nothing renders the report. Its natural home is the "Diagnose a vault" view, which already lists findings and what to do about each. Backlog E22',
  },
];

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

/**
 * `domain.method` for every member of `KeyholdApi`.
 *
 * Three domains — `importer`, `theme` and `sync` — declare their interface in the module that
 * owns them and re-export it here, which is hard rule 8 working correctly and would defeat a
 * scan that only read one file. So the local imports are followed one level: enough to reach
 * them, and short of building a `ts.Program` for a question this simple.
 */
function apiSurface(): readonly string[] {
  const file = join(ROOT, 'src/shared/ipc/api.ts');
  const source = parse(file);

  /** Every `export interface X { ... }` reachable from `api.ts`, by name. */
  const interfaces = new Map<string, ts.InterfaceDeclaration>();
  const collect = (from: ts.SourceFile): void => {
    from.forEachChild((node) => {
      if (ts.isInterfaceDeclaration(node) && !interfaces.has(node.name.text)) {
        interfaces.set(node.name.text, node);
      }
    });
  };
  collect(source);

  source.forEachChild((node) => {
    if (!ts.isImportDeclaration(node)) return;
    const specifier = node.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) return;
    // `./x.js` on disk is `./x.ts` — the project's ESM-style specifiers.
    const target = join(dirname(file), specifier.text.replace(/\.js$/, '.ts'));
    // A specifier that does not resolve is a failure of the walk, not an absence: the same
    // reasoning as `no-network.test.ts`. It is reported by the interface lookup below rather
    // than swallowed here, because that message names the domain a reader has to go and find.
    try {
      collect(parse(target));
    } catch {
      // Left to the per-domain assertion, which says which domain could not be resolved.
    }
  });

  const root = interfaces.get('KeyholdApi');
  expect(root, 'KeyholdApi is no longer an interface in src/shared/ipc/api.ts').toBeDefined();

  const surface: string[] = [];
  for (const domainMember of root?.members ?? []) {
    if (!ts.isPropertySignature(domainMember) || !ts.isIdentifier(domainMember.name)) continue;
    const domain = domainMember.name.text;

    const typeName = domainMember.type;
    if (typeName === undefined || !ts.isTypeReferenceNode(typeName)) continue;
    if (!ts.isIdentifier(typeName.typeName)) continue;

    const domainInterface = interfaces.get(typeName.typeName.text);
    expect(
      domainInterface,
      `KeyholdApi.${domain} points at ${typeName.typeName.text}, which is not an interface here`
    ).toBeDefined();

    for (const method of domainInterface?.members ?? []) {
      if (!ts.isPropertySignature(method) && !ts.isMethodSignature(method)) continue;
      if (!ts.isIdentifier(method.name)) continue;
      surface.push(`${domain}.${method.name.text}`);
    }
  }
  return surface;
}

/**
 * Every name the renderer reads off something — property accesses, destructured bindings,
 * shorthand properties, and the elements of a declared `…METHODS` list — anywhere under
 * `src/renderer/`.
 *
 * ## Why the method name and not the literal `keyhold.x.y` chain
 *
 * Measured, not assumed. The strict form — accept only a literal
 * `window.keyhold.<domain>.<method>` chain — was implemented and run against this repository,
 * and reported **31 of the API's members as unused, of which 28 were false**. Two legitimate
 * patterns defeat it, and both are deliberate designs rather than sloppiness:
 *
 *  - **Gateways take the bridge as an argument.** `createIpcImportGateway(window.keyhold
 *    .importer)` names the domain once and the methods never, on purpose, so the calling
 *    component can be handed a fake in a test.
 *  - **`organisation/ipc-gateway.ts` reads the bridge by string**, checking every method is
 *    present before using any of it, because a half-registered bridge should fail loudly
 *    rather than at the first click. Its method names are string literals in an array — there
 *    is no property access anywhere to find.
 *
 * A guard with 28 false positives is a guard somebody switches off within a week, so this
 * matches names, plus the elements of a declared `…METHODS` array for the second pattern.
 *
 * ## What that costs, stated rather than hidden
 *
 * The loose match can be **masked by an unrelated local of the same name**. Fault injection
 * proved it: deleting the real `window.keyhold.recovery.saveReport()` binding failed nothing,
 * because the parameter it was assigned to is also called `saveReport`.
 *
 * So this guard detects **a capability that was never wired up** — the shape every one of the
 * six stranded subsystems had — and not a capability whose only call site was later deleted.
 * That is the majority of the risk and not all of it. The remainder belongs to the smoke run,
 * which drives the real app. Between them the API is covered exhaustively but statically, and
 * the reachable paths dynamically but only where somebody wrote a check.
 */
function accessedNames(): ReadonlySet<string> {
  const names = new Set<string>();

  for (const match of globSync('src/renderer/**/*.{ts,tsx}', { cwd: ROOT })) {
    const file = join(ROOT, match);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      match.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    const walk = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
        names.add(node.name.text);
      }
      // `const { run, availability } = window.keyhold.breach` — destructuring is a use.
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) names.add(node.name.text);
      if (ts.isShorthandPropertyAssignment(node)) names.add(node.name.text);

      // A declared list of bridge method names, as strings — the organisation gateway's
      // `BRIDGE_METHODS`, which looks its methods up at runtime so there is no property access
      // anywhere to find. Without this its nine methods all report as unused.
      //
      // Narrowed to a `const …METHODS = [...]` rather than counting every string literal in
      // the renderer, which was the first attempt and was far too broad: `'audit'` is also a
      // search alias in `command-registry.ts`, so counting bare strings silently masked the
      // genuinely-unsurfaced `attachments.audit`. The allow-list's anti-rot test caught that,
      // which is the second time in this file that a supposedly-safer rule was measured and
      // found to be worse.
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text.endsWith('METHODS') &&
        node.initializer !== undefined
      ) {
        const literals = ts.isAsExpression(node.initializer)
          ? node.initializer.expression
          : node.initializer;
        if (ts.isArrayLiteralExpression(literals)) {
          for (const element of literals.elements) {
            if (ts.isStringLiteralLike(element)) names.add(element.text);
          }
        }
      }
      node.forEachChild(walk);
    };
    source.forEachChild(walk);
  }

  return names;
}

describe('every capability exposed to the renderer is used by it', () => {
  const surface = apiSurface();
  const used = accessedNames();
  const allowed = new Set(ALLOWED.map((entry) => entry.member));

  it('finds the API surface at all, so an empty scan cannot pass silently', () => {
    // The failure this prevents: `KeyholdApi` is renamed, `apiSurface()` returns nothing, and
    // a guard over an empty list passes for every possible codebase.
    expect(surface.length).toBeGreaterThan(60);
    expect(surface).toContain('breach.run');
    expect(surface).toContain('vault.save');
  });

  it('finds renderer names at all, so an empty scan cannot pass silently', () => {
    // The failure this prevents: the walk stops finding anything, every capability reports as
    // unused, and somebody allow-lists the lot rather than reading the guard.
    expect(used.size).toBeGreaterThan(200);
  });

  it('has no member that is exposed and never called', () => {
    const unused = surface
      .filter((member) => !allowed.has(member))
      .filter((member) => !used.has(member.slice(member.indexOf('.') + 1)));

    expect(
      unused,
      unused.length === 0
        ? ''
        : `${String(unused.length)} capability/capabilities are exposed to the renderer and never used by it. ` +
            'Either wire it up, or delete it from KeyholdApi and the preload bridge. This is the ' +
            '"built and unreachable" failure CLAUDE.md warns about, caught at the API boundary.'
    ).toEqual([]);
  });

  it('has no stale entry in the allow-list', () => {
    // An exemption that is no longer needed is how an allow-list stops meaning anything.
    for (const entry of ALLOWED) {
      expect(
        surface.includes(entry.member),
        `${entry.member} is allow-listed but is no longer part of KeyholdApi — delete the entry`
      ).toBe(true);
      expect(
        used.has(entry.member.slice(entry.member.indexOf('.') + 1)),
        `${entry.member} is allow-listed but IS now called — delete the entry`
      ).toBe(false);
    }
  });
});
