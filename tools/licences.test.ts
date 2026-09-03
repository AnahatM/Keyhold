// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { factsOf } from './source-facts.js';
import {
  collectLicences,
  developmentDependencyNames,
  hasInstalledModules,
  licenceFrom,
  licenceId,
  productionDependencyNames,
  renderLicenceNotice,
  resolvePackageDirectory,
  unresolvedLicences,
  UNKNOWN_LICENCE,
  UNKNOWN_VERSION,
  type LicenceEntry,
} from './licences.js';

/**
 * Guard: the third-party licence list is *derived* from `package.json`, and cannot be hand-written.
 *
 * Roadmap Phase 16 puts a licence list on the About page. The failure mode this exists to make
 * impossible is the ordinary one — somebody writes the list down, it is correct on the day, and
 * then a dependency is added, removed, or bumped past a relicence and nothing in the repository
 * disagrees with the stale paragraph. Every other guard here catches a claim that contradicts
 * the code; a stale licence notice contradicts nothing. It just quietly stops being true, in a
 * document whose entire job is to be a true statement about what is inside the binary.
 *
 * So this file makes two separate claims, and both halves are needed:
 *
 *  1. **The list is correct right now.** Re-derived here, independently of the module under
 *     test — the assertions below read `package.json` and the installed manifests with plain
 *     `readFileSync` and `JSON.parse` rather than through `tools/licences.ts`'s own helpers, so
 *     a bug in the extraction cannot hide behind itself.
 *  2. **The list cannot become hand-written.** `tools/licences.ts` is parsed and every string
 *     literal in it is checked against the real dependency names, versions and licence ids. The
 *     moment somebody pastes `'react@19.2.8 — MIT'` into the generator to "fix" an entry, this
 *     fails. That is the check that keeps claim 1 from being satisfiable by cheating.
 *
 * Skipping rather than failing when `node_modules` is absent follows
 * `tools/fixtures-are-committed.test.ts`: a guard that fails for want of a tool is a guard people
 * learn to ignore, and on a fresh clone there is nothing to be right or wrong about yet. The
 * fixture-tree half below never skips, because it builds its own installation — so the
 * extraction rules stay under test even where the repository's own tree is not there to read.
 *
 * Fault injections performed against `tools/licences.ts`, each restored afterwards:
 *   · merging `devDependencies` into the roots → three failures, the first naming all 148
 *     build-only packages the walk then reached
 *   · filtering unknown-licence entries out of the result → eight failures, including the
 *     fresh-clone case that must report a loud unknown rather than an empty list
 *   · returning `''` instead of UNKNOWN_LICENCE for a missing field → six failures
 *   · never following a package's own `dependencies` → "includes what the direct dependencies
 *     themselves depend on" fails, naming scheduler, fastest-levenshtein and
 *     @zxcvbn-ts/dictionary-compression
 *   · `name.replace('/', '-')` in the resolver → five failures, the independent re-derivation
 *     among them
 *   · resolving from the root instead of from the dependent → the nested-copy assertion fails,
 *     reporting the hoisted 9.9.9 for a package whose dependent loads 0.1.0
 *   · taking the first entry of a `licenses` array instead of an OR expression → that test fails
 *   · dropping the not-installed branch → three failures
 *   · pasting a hand-written `react@19.2.8 — MIT` constant in → "contains no licence data of its
 *     own" fails, quoting the literal
 *   · `import { version } from 'react'` → "depends on nothing it describes" fails, and the
 *     literal check catches the specifier too
 *   · flattening a second reach to `direct: true` → "does not promote a package to direct"
 *     fails; that injection is the bug this file found, and the diamond fixture is the one
 *     shape in the tree that can see it
 *   · forcing `INSTALLED` false → 8 skipped, 22 passed, nothing failed
 *
 * One injection initially caught nothing, and the fixture was changed rather than the finding
 * being written off: sorting by `localeCompare` passed, because for a list of ordinary
 * lowercase names ICU and code-unit collation agree, so the assertion could not tell a
 * machine-independent order from a machine-dependent one. The fixture now installs `Base64`
 * alongside `abbrev` — the pair the two orders disagree on — and the injection fails.
 */

const ROOT = resolve(import.meta.dirname, '..');
const GENERATOR = join(import.meta.dirname, 'licences.ts');

/**
 * Whether this checkout has dependencies installed.
 *
 * Computed once, at module scope, so the two halves of the suite agree about it and so the
 * `runIf` conditions are decided before any assertion runs.
 */
const INSTALLED = hasInstalledModules(ROOT);

const ENTRIES: readonly LicenceEntry[] = INSTALLED ? collectLicences(ROOT) : [];

// ── The repository's own list ────────────────────────────────────────────────

/**
 * The production dependencies, read straight out of `package.json` by this test.
 *
 * Deliberately not `productionDependencyNames`. This is the value the module's answer is
 * compared against, so it has to be obtained some other way — otherwise the comparison is the
 * module agreeing with itself, which is precisely the shape of a hand-written list passing its
 * own guard.
 */
function declaredDependencies(field: 'dependencies' | 'devDependencies'): readonly string[] {
  const raw = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<
    string,
    Record<string, string> | undefined
  >;
  return Object.keys(raw[field] ?? {}).sort();
}

/** A manifest field, read the naive way — top-level `node_modules` only, no hoisting rules. */
function installedField(name: string, field: 'version' | 'license'): unknown {
  try {
    const text = readFileSync(
      join(ROOT, 'node_modules', ...name.split('/'), 'package.json'),
      'utf8'
    );
    return (JSON.parse(text) as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

const named = (entries: readonly LicenceEntry[], name: string): LicenceEntry | undefined =>
  entries.find((entry) => entry.name === name);

describe("the repository's licence list", () => {
  it('has dependencies to describe, so the sweep cannot pass vacuously', () => {
    // Not gated on INSTALLED: package.json is committed, so an empty answer here is a broken
    // reader rather than a fresh clone, and that is worth failing on either way.
    expect(declaredDependencies('dependencies').length).toBeGreaterThan(3);
  });

  it.runIf(INSTALLED)('lists exactly the production dependencies as direct entries', () => {
    const direct = ENTRIES.filter((entry) => entry.direct)
      .map((entry) => entry.name)
      .sort();

    expect(
      direct,
      'The direct entries must be package.json’s "dependencies", no more and no less. ' +
        'devDependencies are build machinery and ship in nothing.'
    ).toEqual(declaredDependencies('dependencies'));
  });

  it.runIf(INSTALLED)('names no package that exists only to build the app', () => {
    // The other direction of the same rule, stated over the whole closure rather than the
    // roots. A dev-only package can only appear here if the walk started reading the wrong
    // field — a production dependency never lists the linter among its own `dependencies`.
    const buildOnly = new Set(
      developmentDependencyNames(ROOT).filter(
        (name) => !declaredDependencies('dependencies').includes(name)
      )
    );
    const leaked = ENTRIES.filter((entry) => buildOnly.has(entry.name)).map(licenceId);

    expect(leaked, 'these are devDependencies and are not inside the binary').toEqual([]);
  });

  it.runIf(INSTALLED)('agrees with the installed manifests, re-read independently', () => {
    const mismatches: string[] = [];

    for (const name of declaredDependencies('dependencies')) {
      const entry = named(ENTRIES, name);
      if (entry === undefined) {
        mismatches.push(`${name}: absent from the list entirely`);
        continue;
      }

      const version = installedField(name, 'version');
      if (version !== entry.version) {
        mismatches.push(`${name}: manifest says ${String(version)}, list says ${entry.version}`);
      }

      // Only the plain-string form is re-derivable this crudely; the legacy shapes are covered
      // exhaustively against the fixture tree below, where they can be planted deliberately.
      const licence = installedField(name, 'license');
      if (typeof licence === 'string' && licence.trim() !== entry.licence) {
        mismatches.push(`${name}: manifest says ${licence.trim()}, list says ${entry.licence}`);
      }
    }

    expect(mismatches, 'the generated list disagrees with what npm actually installed').toEqual([]);
  });

  it.runIf(INSTALLED)('includes what the direct dependencies themselves depend on', () => {
    // One level of the closure, re-derived here. Stopping at the direct level is the same
    // defect as a hand-written list: `react-dom` bundles `scheduler`, so `scheduler` is inside
    // the binary whether or not this repository has ever typed its name.
    const listed = new Set(ENTRIES.map((entry) => entry.name));
    const expected = new Set<string>();

    for (const name of declaredDependencies('dependencies')) {
      const text = (() => {
        try {
          return readFileSync(
            join(ROOT, 'node_modules', ...name.split('/'), 'package.json'),
            'utf8'
          );
        } catch {
          return '{}';
        }
      })();
      const manifest = JSON.parse(text) as { dependencies?: Record<string, string> };
      for (const child of Object.keys(manifest.dependencies ?? {})) expected.add(child);
    }

    const missing = [...expected].filter((name) => !listed.has(name)).sort();
    expect(missing, 'these ship inside a production dependency and are not in the notice').toEqual(
      []
    );
  });

  it.runIf(INSTALLED)('reports every unknown licence with a check somebody can act on', () => {
    const useless = unresolvedLicences(ENTRIES)
      .filter((entry) => entry.problem === null || entry.problem.length < 20)
      .map(licenceId);

    expect(
      useless,
      'An UNKNOWN entry whose reason is empty is a dead end. Say what to open and read.'
    ).toEqual([]);
  });

  it.runIf(INSTALLED)('renders every entry, unknowns included', () => {
    const notice = renderLicenceNotice(ENTRIES);
    const absent = ENTRIES.filter((entry) => !notice.includes(licenceId(entry))).map(licenceId);

    expect(
      absent,
      'a package that is in the list and not in the notice is an undisclosed ' + 'licence'
    ).toEqual([]);
  });

  it.runIf(INSTALLED)('is sorted by name@version in code-unit order, and is deterministic', () => {
    const ids = ENTRIES.map(licenceId);
    expect(ids, 'the notice must be byte-identical on every machine that regenerates it').toEqual(
      [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    );
    expect(collectLicences(ROOT)).toEqual(ENTRIES);
  });

  it('skips rather than fails where nothing is installed', () => {
    // The skip predicate itself, asserted directly: when `INSTALLED` is true — which is the
    // only state a developer ever watches this suite in — every `runIf` above is invisible, so
    // the behaviour on a fresh clone would otherwise never be observed at all.
    const bare = mkdtempSync(join(tmpdir(), 'keyhold-licences-bare-'));
    try {
      writeFileSync(join(bare, 'package.json'), JSON.stringify({ dependencies: { react: '19' } }));
      expect(hasInstalledModules(bare)).toBe(false);

      // And if it is run anyway, the answer is a loud unknown rather than an empty list.
      const entries = collectLicences(bare);
      expect(entries.map(licenceId)).toEqual([`react@${UNKNOWN_VERSION}`]);
      expect(entries[0]?.licence).toBe(UNKNOWN_LICENCE);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

// ── The generator holds no data of its own ───────────────────────────────────

describe('the generator', () => {
  it.runIf(INSTALLED)('contains no licence data of its own', () => {
    // The half that makes the rest of this file mean something. Every assertion above is
    // satisfiable by a module that simply returns a list somebody typed; this is the one that
    // says the answer was computed. It reads string literals out of the parse tree rather than
    // the file text, so a package name sitting in a comment is prose and a package name in an
    // array is a finding — see tools/source-facts.ts for why that distinction is not optional.
    const banned = new Set<string>();
    for (const entry of ENTRIES) {
      banned.add(entry.name.toLowerCase());
      if (entry.licence !== UNKNOWN_LICENCE) banned.add(entry.licence.toLowerCase());
    }
    const versions = [
      ...new Set(ENTRIES.map((entry) => entry.version).filter((v) => v !== UNKNOWN_VERSION)),
    ];

    const offences = factsOf(GENERATOR)
      .strings.filter((literal) => {
        const trimmed = literal.trim().toLowerCase();
        return banned.has(trimmed) || versions.some((version) => literal.includes(version));
      })
      .map((literal) => JSON.stringify(literal));

    expect(
      [...new Set(offences)].sort(),
      'tools/licences.ts names a package, version or licence it is supposed to be deriving. ' +
        'The list must come from package.json and node_modules, never from a literal.'
    ).toEqual([]);
  });

  it('depends on nothing it describes', () => {
    // A licence generator that needed an installed package in order to report what is installed
    // could not run on a fresh clone — which is the one moment the answer is worth having.
    const foreign = factsOf(GENERATOR)
      .imports.map((reference) => reference.specifier)
      .filter((specifier) => !specifier.startsWith('node:'))
      .sort();

    expect(foreign, 'node built-ins only').toEqual([]);
  });
});

// ── The extraction rules, against a planted installation ─────────────────────

/**
 * A throwaway `node_modules` holding one package per rule.
 *
 * The repository's own tree is six MIT packages and will stay that way for a while, so it can
 * only ever demonstrate the happy path. Every branch that matters — the legacy manifest shapes,
 * an absent licence, a corrupt manifest, a package npm never installed, a scope, a nested copy,
 * a dependency cycle — has to be planted, or it is untested code shipping in a guard.
 */
const FIXTURE = { root: '' };

function writePackage(relativeDirectory: string, manifest: unknown): void {
  const directory = join(FIXTURE.root, ...relativeDirectory.split('/'));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest, null, 2));
}

beforeAll(() => {
  FIXTURE.root = mkdtempSync(join(tmpdir(), 'keyhold-licences-'));

  writePackage('.', {
    name: 'fixture-root',
    dependencies: {
      'plain-mit': '1.0.0',
      '@scope/scoped': '1.0.0',
      'legacy-object': '1.0.0',
      'legacy-array': '1.0.0',
      'no-licence': '1.0.0',
      'empty-licence': '1.0.0',
      'pointer-licence': '1.0.0',
      proprietary: '1.0.0',
      'cycle-a': '1.0.0',
      'broken-manifest': '1.0.0',
      'never-installed': '1.0.0',
      // The pair that separates a code-unit sort from a locale-aware one: 'B' precedes 'a' by
      // code unit and follows it under every ICU collation. Legacy npm names really do carry
      // capitals (`JSONStream`, `Base64`), and without a pair like this in the tree the
      // sortedness assertion below is satisfied by `localeCompare` too, which would make the
      // notice differ byte-for-byte between machines while every test stayed green.
      Base64: '1.0.0',
      abbrev: '1.0.0',
      'diamond-left': '1.0.0',
      'diamond-right': '1.0.0',
    },
    devDependencies: { 'dev-only-tool': '1.0.0' },
  });

  writePackage('node_modules/plain-mit', { name: 'plain-mit', version: '1.2.3', license: 'MIT' });
  writePackage('node_modules/Base64', { name: 'Base64', version: '1.0.0', license: 'MIT' });
  writePackage('node_modules/abbrev', { name: 'abbrev', version: '1.0.0', license: 'MIT' });

  // Scoped, and with a copy of its child nested beneath it rather than hoisted — the layout npm
  // produces on a version conflict, and the one a top-level-only reader gets wrong.
  writePackage('node_modules/@scope/scoped', {
    name: '@scope/scoped',
    version: '2.0.0',
    license: 'Apache-2.0',
    dependencies: { 'nested-child': '0.1.0' },
  });
  writePackage('node_modules/@scope/scoped/node_modules/nested-child', {
    name: 'nested-child',
    version: '0.1.0',
    license: 'ISC',
  });
  writePackage('node_modules/nested-child', {
    name: 'nested-child',
    version: '9.9.9',
    license: 'ISC',
  });

  writePackage('node_modules/legacy-object', {
    name: 'legacy-object',
    version: '3.0.0',
    license: { type: 'BSD-3-Clause', url: 'https://example.invalid/licence' },
  });
  writePackage('node_modules/legacy-array', {
    name: 'legacy-array',
    version: '4.0.0',
    licenses: [{ type: 'MIT' }, { type: 'GPL-2.0' }],
  });

  writePackage('node_modules/no-licence', { name: 'no-licence', version: '5.0.0' });
  writePackage('node_modules/empty-licence', {
    name: 'empty-licence',
    version: '6.0.0',
    license: '   ',
  });
  writePackage('node_modules/pointer-licence', {
    name: 'pointer-licence',
    version: '7.0.0',
    license: 'SEE LICENSE IN COPYING.txt',
  });
  writePackage('node_modules/proprietary', {
    name: 'proprietary',
    version: '8.0.0',
    license: 'UNLICENSED',
  });

  // Two direct packages depending on one shared child: the child is reached twice, and both
  // times transitively. It is the shape that caught a real bug here — a de-duplicating record
  // that flattened any second reach to `direct: true` and would have printed a package nobody
  // in this repository asked for among the ones we did.
  writePackage('node_modules/diamond-left', {
    name: 'diamond-left',
    version: '1.0.0',
    license: 'MIT',
    dependencies: { 'shared-child': '1.0.0' },
  });
  writePackage('node_modules/diamond-right', {
    name: 'diamond-right',
    version: '1.0.0',
    license: 'MIT',
    dependencies: { 'shared-child': '1.0.0' },
  });
  writePackage('node_modules/shared-child', {
    name: 'shared-child',
    version: '1.0.0',
    license: 'MIT',
  });

  writePackage('node_modules/cycle-a', {
    name: 'cycle-a',
    version: '1.0.0',
    license: 'MIT',
    dependencies: { 'cycle-b': '1.0.0' },
  });
  writePackage('node_modules/cycle-b', {
    name: 'cycle-b',
    version: '1.0.0',
    license: 'MIT',
    dependencies: { 'cycle-a': '1.0.0' },
  });

  // Installed, and its manifest is not JSON. Distinct from never having been installed.
  mkdirSync(join(FIXTURE.root, 'node_modules', 'broken-manifest'), { recursive: true });
  writeFileSync(
    join(FIXTURE.root, 'node_modules', 'broken-manifest', 'package.json'),
    '{ this is not json'
  );

  // Present on disk, named only as a devDependency: it must not reach the notice.
  writePackage('node_modules/dev-only-tool', {
    name: 'dev-only-tool',
    version: '10.0.0',
    license: 'MIT',
  });
});

afterAll(() => {
  rmSync(FIXTURE.root, { recursive: true, force: true });
});

describe('the extraction rules', () => {
  const list = (): readonly LicenceEntry[] => collectLicences(FIXTURE.root);

  it('reads a plain SPDX string', () => {
    expect(named(list(), 'plain-mit')).toEqual({
      name: 'plain-mit',
      version: '1.2.3',
      licence: 'MIT',
      direct: true,
      problem: null,
    });
  });

  it('resolves a scoped name as two path segments', () => {
    const entry = named(list(), '@scope/scoped');
    expect(entry?.version).toBe('2.0.0');
    expect(entry?.licence).toBe('Apache-2.0');
  });

  it('attributes a nested copy to the version its dependent actually resolves', () => {
    // Both copies of `nested-child` are installed. The one inside `@scope/scoped` is the one
    // that package loads, so 0.1.0 is what ships for it — a reader that only looked at the
    // top-level directory would report 9.9.9 and describe a file nobody executes.
    const versions = list()
      .filter((entry) => entry.name === 'nested-child')
      .map((entry) => entry.version);
    expect(versions).toEqual(['0.1.0']);
  });

  it('reads the deprecated license object', () => {
    expect(named(list(), 'legacy-object')?.licence).toBe('BSD-3-Clause');
  });

  it('reads the legacy licenses array as an OR expression', () => {
    expect(named(list(), 'legacy-array')?.licence).toBe('(MIT OR GPL-2.0)');
  });

  it('reports a missing licence rather than guessing or dropping the package', () => {
    const entry = named(list(), 'no-licence');
    expect(entry?.licence).toBe(UNKNOWN_LICENCE);
    expect(entry?.problem).toContain('no "license" or "licenses" field');
  });

  it('treats a whitespace-only licence as no licence', () => {
    expect(named(list(), 'empty-licence')?.licence).toBe(UNKNOWN_LICENCE);
  });

  it('refuses to render a SEE LICENSE IN pointer as an answer', () => {
    const entry = named(list(), 'pointer-licence');
    expect(entry?.licence).toBe(UNKNOWN_LICENCE);
    expect(entry?.problem).toContain('COPYING.txt');
  });

  it('flags an UNLICENSED package as proprietary', () => {
    const entry = named(list(), 'proprietary');
    expect(entry?.licence).toBe(UNKNOWN_LICENCE);
    expect(entry?.problem).toContain('proprietary');
  });

  it('still lists a package that is not installed', () => {
    const entry = named(list(), 'never-installed');
    expect(entry?.version).toBe(UNKNOWN_VERSION);
    expect(entry?.licence).toBe(UNKNOWN_LICENCE);
    expect(entry?.problem).toContain('not installed');
  });

  it('never drops a package it cannot read', () => {
    const entry = named(list(), 'broken-manifest');
    expect(entry?.licence).toBe(UNKNOWN_LICENCE);
    expect(entry?.problem).toContain('could not be read');
  });

  it('excludes devDependencies even when they are installed', () => {
    expect(named(list(), 'dev-only-tool')).toBeUndefined();
  });

  it('follows a dependency cycle without hanging', () => {
    const names = list().map((entry) => entry.name);
    expect(names).toContain('cycle-a');
    expect(names).toContain('cycle-b');
    expect(named(list(), 'cycle-b')?.direct).toBe(false);
  });

  it('does not promote a package to direct just because two packages depend on it', () => {
    const shared = list().filter((entry) => entry.name === 'shared-child');
    expect(shared.map(licenceId)).toEqual(['shared-child@1.0.0']);
    expect(shared[0]?.direct).toBe(false);
  });

  it('can be asked for the direct dependencies alone', () => {
    const direct = collectLicences(FIXTURE.root, { includeTransitive: false });
    expect(direct.map((entry) => entry.name)).not.toContain('cycle-b');
    expect(direct.every((entry) => entry.direct)).toBe(true);
  });

  it('is sorted in code-unit order rather than locale order', () => {
    const ids = list().map(licenceId);
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(new Set(ids).size).toBe(ids.length);

    // The assertion above is necessary and not sufficient: for a list of ordinary lowercase
    // names, `localeCompare` produces the identical order, so it would pass a generator whose
    // output changes with the ICU build underneath it. This pair is the one that tells them
    // apart — a notice regenerated on another machine must be byte-identical or the diff is
    // noise, and a noisy diff is how a real licence change goes unreviewed.
    expect(ids.indexOf('Base64@1.0.0')).toBeLessThan(ids.indexOf('abbrev@1.0.0'));
    expect('Base64@1.0.0'.localeCompare('abbrev@1.0.0')).toBeGreaterThan(0);
  });

  it('gives every unknown a check somebody can act on', () => {
    // The same property the repository-level test asserts, restated where it cannot pass
    // vacuously: today every installed dependency declares a licence, so up there the set of
    // unknowns is empty and the assertion is only waiting for its first real subject. Here
    // there are six, one per way of failing to state a licence.
    const useless = unresolvedLicences(list())
      .filter((entry) => entry.problem === null || entry.problem.length < 20)
      .map(licenceId);
    expect(unresolvedLicences(list()).length).toBe(6);
    expect(useless, 'an UNKNOWN with no stated check is a dead end').toEqual([]);
  });

  it('renders the unknowns a second time, where they cannot be scrolled past', () => {
    const notice = renderLicenceNotice(list());
    expect(notice).toContain('Needs a manual check (6)');
    expect(notice).toContain('never-installed');
  });

  it('resolves nothing outside the tree it was given', () => {
    // The walk stops at the root it was handed, so it can never climb into a parent project's
    // node_modules and describe a package this repository does not ship.
    expect(resolvePackageDirectory('vitest', FIXTURE.root, FIXTURE.root)).toBeNull();
  });

  it('names the file when package.json cannot be read at all', () => {
    const empty = mkdtempSync(join(tmpdir(), 'keyhold-licences-empty-'));
    try {
      expect(() => productionDependencyNames(empty)).toThrow(/No readable package.json/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('reads a manifest with no licence fields at all without crashing', () => {
    expect(licenceFrom({ name: 'x' })).toEqual({
      licence: UNKNOWN_LICENCE,
      problem: expect.stringContaining('no "license" or "licenses" field'),
    });
  });
});
