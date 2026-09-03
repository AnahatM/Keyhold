// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The third-party licence list, derived from `package.json` and `node_modules`.
 *
 * ## Why this is code rather than a document
 *
 * Phase 16 wants an About page carrying the licences of everything Keyhold ships. The obvious
 * way to produce one is to write it down once, and that list is wrong the first time a
 * dependency is added, removed, or bumped past a relicence — silently, because nothing in the
 * repository disagrees with a stale paragraph. A licence notice is a legal claim about what is
 * inside the binary, so "silently wrong" is the worst available outcome and a hand-maintained
 * copy is the second list hard rule 8 exists to forbid.
 *
 * So the list is computed, every time, from the two things that actually decide what ships:
 * the `dependencies` map in `package.json`, and the manifests npm installed under
 * `node_modules`. `tools/licences.test.ts` is the guard that keeps it that way — it re-derives
 * the same answer independently and fails if this module ever grows a baked-in package name,
 * version, or licence id.
 *
 * ## What counts as shipping
 *
 * `dependencies` only. `devDependencies` are build machinery — TypeScript, Vitest, the linter —
 * and none of their code reaches a user, so listing them would overstate what is bundled.
 *
 * The walk then follows each production package's own `dependencies` transitively, because
 * `react-dom` bundling `scheduler` means `scheduler` ships whether or not this repository ever
 * names it. Stopping at the direct level is the same defect as the hand-written list: an entry
 * that is genuinely inside the binary and genuinely absent from the notice.
 *
 * `peerDependencies` and `optionalDependencies` are deliberately not followed. A peer is
 * satisfied by something already in the graph (so it is reached anyway, under its real
 * version), and an optional dependency that npm chose not to install is not in the binary.
 * Following either would list code that is not there, which is its own kind of false notice.
 *
 * ## Missing information is reported, never dropped
 *
 * A package with no `license` field, an unreadable manifest, a `SEE LICENSE IN …` pointer, or
 * an `UNLICENSED` declaration all produce an entry whose licence is {@link UNKNOWN_LICENCE},
 * carrying a `problem` string saying what a human has to go and check. None of them produce
 * silence. A notice that quietly omits the one package whose terms nobody could read is worse
 * than no notice at all: it reads as a complete answer.
 *
 * ## What this module may depend on
 *
 * Node built-ins and nothing else. It describes the dependency tree, so it must not be part of
 * it — a licence generator that needed a package installed to tell you what is installed could
 * not run on a fresh clone, which is exactly when the answer matters.
 */

// ── The shape of an answer ───────────────────────────────────────────────────

/**
 * What a licence reads as when it could not be determined from the manifest.
 *
 * Deliberately not an empty string, `null`, or a dropped row. It is written to be conspicuous
 * in a rendered notice and to be greppable in a diff, because the only correct response to it
 * is a person opening the package and reading its terms.
 */
export const UNKNOWN_LICENCE = 'UNKNOWN — check manually';

/** What a version reads as when the package is not installed and cannot be inspected. */
export const UNKNOWN_VERSION = 'unknown';

/** One package, as it will appear in the notice. */
export interface LicenceEntry {
  /** The npm name, scope included: `@zxcvbn-ts/core`. */
  readonly name: string;
  readonly version: string;
  /** An SPDX expression as declared, or {@link UNKNOWN_LICENCE}. */
  readonly licence: string;
  /** Named in this repository's own `dependencies`, rather than pulled in by another package. */
  readonly direct: boolean;
  /** Why the licence is unknown, phrased as the check a human has to perform. `null` if fine. */
  readonly problem: string | null;
}

export interface LicenceOptions {
  /**
   * Follow each production package's own `dependencies`. On by default: the transitive set is
   * what is inside the binary, and the direct set is only what this repository asked for.
   */
  readonly includeTransitive?: boolean;
}

/** `name@version` — the identity a notice is sorted and de-duplicated by. */
export function licenceId(entry: LicenceEntry): string {
  return `${entry.name}@${entry.version}`;
}

// ── Reading manifests ────────────────────────────────────────────────────────

type JsonObject = Readonly<Record<string, unknown>>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A manifest, or `null` if it is missing, unreadable, malformed, or not an object.
 *
 * Every failure collapses to the same `null` on purpose. The caller's next move is identical in
 * all four cases — record an entry that says a human has to look — and distinguishing "no such
 * file" from "trailing comma on line 40" here would only tempt a caller into treating one of
 * them as an acceptable reason to skip the package.
 */
export function readManifest(directory: string): JsonObject | null {
  let text: string;
  try {
    text = readFileSync(join(directory, 'package.json'), 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }

  return isJsonObject(parsed) ? parsed : null;
}

/** Whether a directory holds a `package.json` at all, however malformed its contents. */
function hasManifestFile(directory: string): boolean {
  try {
    return statSync(join(directory, 'package.json')).isFile();
  } catch {
    return false;
  }
}

/** The keys of a dependency map, or nothing if the field is absent or not an object. */
function dependencyNames(manifest: JsonObject, field: string): readonly string[] {
  const raw = manifest[field];
  return isJsonObject(raw) ? Object.keys(raw) : [];
}

/**
 * This repository's production dependencies, sorted.
 *
 * Throws rather than returning empty. An empty list is indistinguishable from "there are no
 * dependencies", and a licence notice that renders nothing because it could not find
 * `package.json` would pass every eyeball test while claiming the app bundles no third-party
 * code at all.
 */
export function productionDependencyNames(root: string): readonly string[] {
  const manifest = readManifest(root);
  if (manifest === null) {
    throw new Error(`No readable package.json at ${root} — cannot derive the licence list.`);
  }
  return [...dependencyNames(manifest, 'dependencies')].sort();
}

/** Names listed only as build tooling. Not shipped, and so not listed — exposed for the guard. */
export function developmentDependencyNames(root: string): readonly string[] {
  const manifest = readManifest(root);
  if (manifest === null) {
    throw new Error(`No readable package.json at ${root} — cannot derive the licence list.`);
  }
  return [...dependencyNames(manifest, 'devDependencies')].sort();
}

/** Whether dependencies are installed at all, so a caller can skip rather than report nonsense. */
export function hasInstalledModules(root: string): boolean {
  try {
    return statSync(join(root, 'node_modules')).isDirectory();
  } catch {
    return false;
  }
}

// ── Extracting the licence ───────────────────────────────────────────────────

export interface LicenceReading {
  readonly licence: string;
  readonly problem: string | null;
}

const unknown = (problem: string): LicenceReading => ({ licence: UNKNOWN_LICENCE, problem });

/**
 * Declared text that is a pointer to a licence rather than a licence.
 *
 * npm's own schema blesses both: `UNLICENSED` means proprietary, and `SEE LICENSE IN <file>`
 * means the terms are in a file nobody has read yet. Neither is an SPDX identifier, so neither
 * can be rendered as an answer — but both are also unmistakably *declared*, so the entry says
 * what to go and read instead of pretending the field was empty.
 */
function pointerReading(declared: string): LicenceReading | null {
  const upper = declared.toUpperCase();
  if (upper === 'UNLICENSED') {
    return unknown(
      'the manifest declares UNLICENSED — the package is proprietary. Confirm we are entitled ' +
        'to redistribute it before shipping, or drop the dependency.'
    );
  }
  if (upper.startsWith('SEE LICENSE IN ') || upper.startsWith('SEE LICENCE IN ')) {
    return unknown(
      `the manifest says "${declared}" rather than an SPDX identifier. Open that file in the ` +
        'package and record the terms by hand.'
    );
  }
  return null;
}

/** The `type` of one entry in the legacy `licenses` array, which may be a string or an object. */
function legacyType(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (isJsonObject(value)) {
    const type = value.type;
    if (typeof type === 'string' && type.trim() !== '') return type.trim();
  }
  return null;
}

/**
 * The licence a manifest declares, across every shape npm has ever accepted.
 *
 * Three shapes are live in the wild and all three appear in real dependency trees: the modern
 * `"license": "MIT"` string, the deprecated `"license": { "type": … }` object, and the older
 * still `"licenses": [ … ]` array used for dual licensing. A generator that understood only the
 * first would report {@link UNKNOWN_LICENCE} for packages whose terms are stated perfectly
 * clearly, and a notice full of spurious unknowns is a notice people stop reading.
 *
 * Multiple entries are joined into an SPDX `OR` expression rather than one being picked, since
 * choosing between them is a decision for a human and recording only one misstates the terms.
 */
export function licenceFrom(manifest: JsonObject): LicenceReading {
  const declared = manifest.license;

  if (typeof declared === 'string') {
    const trimmed = declared.trim();
    if (trimmed === '') return unknown('the "license" field is present but empty.');
    return pointerReading(trimmed) ?? { licence: trimmed, problem: null };
  }

  // Deprecated but still shipping: `"license": { "type": "MIT", "url": … }`.
  if (isJsonObject(declared)) {
    const type = legacyType(declared);
    if (type !== null) return pointerReading(type) ?? { licence: type, problem: null };
    return unknown('the "license" field is an object with no usable "type".');
  }

  // Older still: `"licenses": [ { "type": … }, … ]`, npm's original dual-licence shape.
  const legacy = manifest.licenses;
  if (Array.isArray(legacy)) {
    const types = legacy
      .map((entry) => legacyType(entry))
      .filter((type): type is string => type !== null);

    if (types.length === 1) {
      const only = types[0] ?? '';
      return pointerReading(only) ?? { licence: only, problem: null };
    }
    if (types.length > 1) return { licence: `(${types.join(' OR ')})`, problem: null };
    return unknown('the "licenses" array holds no usable entries.');
  }

  return unknown('the manifest declares no "license" or "licenses" field.');
}

// ── Finding the installed package ────────────────────────────────────────────

/**
 * Where a package resolved from `fromDirectory` actually lives, or `null` if it is not there.
 *
 * npm hoists what it can and nests what it cannot, so the same name can resolve to different
 * versions depending on who is asking. Walking up from the dependent — its own `node_modules`
 * first, then each ancestor's — is Node's resolution order, and it is the only way to attribute
 * the right version to the right dependent. Reading only the top-level directory would report
 * one arbitrary copy and miss the other entirely.
 *
 * The walk stops at `root`, so it can never wander into a parent project's `node_modules` and
 * report a package this repository does not ship.
 */
export function resolvePackageDirectory(
  name: string,
  fromDirectory: string,
  root: string
): string | null {
  // Split rather than interpolate: a scoped `@zxcvbn-ts/core` is two path segments, and on
  // Windows a raw name with a forward slash is not reliably a path.
  const segments = name.split('/');
  const stop = resolve(root);
  let current = resolve(fromDirectory);

  for (;;) {
    const candidate = join(current, 'node_modules', ...segments);
    // Existence, not readability. A package whose manifest is corrupt is still installed and
    // still ships; treating it as absent would report "run npm install" for a file that is
    // sitting right there, and send whoever reads the notice looking in the wrong place.
    if (hasManifestFile(candidate)) return candidate;

    if (current === stop) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ── The list ─────────────────────────────────────────────────────────────────

interface Pending {
  readonly name: string;
  readonly from: string;
  readonly direct: boolean;
}

/**
 * Every third-party package that ships, with its licence, sorted and de-duplicated.
 *
 * `root` is a parameter rather than a constant so the guard can point this at a throwaway tree
 * of planted manifests — a missing licence, a legacy array, a package that was never installed.
 * A generator that can only be run against this repository can only ever be observed agreeing
 * with itself.
 *
 * De-duplication is by `name@version`, not by name: two versions of the same package genuinely
 * both ship and both carry terms, and collapsing them would drop one. Recording is idempotent
 * and only the *expansion* of a directory is guarded, which is what makes a cycle terminate
 * without a second reach being mistaken for a second package.
 */
export function collectLicences(
  root: string,
  options: LicenceOptions = {}
): readonly LicenceEntry[] {
  const includeTransitive = options.includeTransitive ?? true;

  const entries = new Map<string, LicenceEntry>();
  const visited = new Set<string>();
  const queue: Pending[] = productionDependencyNames(root).map((name) => ({
    name,
    from: root,
    direct: true,
  }));

  const record = (entry: LicenceEntry): void => {
    const existing = entries.get(licenceId(entry));
    if (existing === undefined) {
      entries.set(licenceId(entry), entry);
      return;
    }
    // Reached more than once. `direct` is the OR of the ways it was reached, never a flat true:
    // a package two other packages both depend on is reached twice and is still not something
    // this repository asked for, and marking it direct would put it in the wrong half of the
    // "these are our dependencies" list on the About page.
    entries.set(licenceId(entry), { ...existing, direct: existing.direct || entry.direct });
  };

  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) continue;

    const directory = resolvePackageDirectory(item.name, item.from, root);
    if (directory === null) {
      record({
        name: item.name,
        version: UNKNOWN_VERSION,
        licence: UNKNOWN_LICENCE,
        direct: item.direct,
        problem:
          'not installed under node_modules, so its terms could not be read. Run the install ' +
          'and regenerate before publishing this notice.',
      });
      continue;
    }

    const manifest = readManifest(directory);
    if (manifest === null) {
      // The package is installed but its manifest is corrupt or is not an object. Reported
      // with the directory, so the check is "open this file", not "reinstall and hope".
      record({
        name: item.name,
        version: UNKNOWN_VERSION,
        licence: UNKNOWN_LICENCE,
        direct: item.direct,
        problem: `its package.json under ${directory} could not be read. Inspect it by hand.`,
      });
      continue;
    }

    const rawVersion = manifest.version;
    const version =
      typeof rawVersion === 'string' && rawVersion !== '' ? rawVersion : UNKNOWN_VERSION;
    const reading = licenceFrom(manifest);

    record({
      name: item.name,
      version,
      licence: reading.licence,
      direct: item.direct,
      problem: reading.problem,
    });

    // Recording is idempotent, so a package reached twice is described twice and stored once.
    // Only the *expansion* is guarded, and that is what makes a dependency cycle terminate.
    if (includeTransitive && !visited.has(directory)) {
      visited.add(directory);
      for (const child of dependencyNames(manifest, 'dependencies')) {
        queue.push({ name: child, from: directory, direct: false });
      }
    }
  }

  // Code-unit order, not locale order: the notice must be byte-identical on every machine that
  // regenerates it, and `localeCompare` is not the same list under every ICU build.
  return [...entries.values()].sort((left, right) => {
    const a = licenceId(left);
    const b = licenceId(right);
    if (a < b) return -1;
    return a > b ? 1 : 0;
  });
}

/** The entries whose terms nobody has established yet — the only rows that need a human. */
export function unresolvedLicences(entries: readonly LicenceEntry[]): readonly LicenceEntry[] {
  return entries.filter((entry) => entry.licence === UNKNOWN_LICENCE);
}

/**
 * The notice as plain text, deterministic for a given list.
 *
 * Every entry appears in the body, and the unresolved ones appear a second time underneath with
 * the check they need. The repetition is the point: an unknown licence buried in a list of
 * ninety is an unknown licence nobody acts on.
 */
export function renderLicenceNotice(entries: readonly LicenceEntry[]): string {
  const lines: string[] = [
    'Third-party licences',
    '',
    'Generated from package.json and node_modules. Do not edit by hand — the guard in',
    'tools/licences.test.ts fails if this list stops being derivable.',
    '',
    `${entries.length} package${entries.length === 1 ? '' : 's'} ship with Keyhold:`,
    '',
  ];

  for (const entry of entries) {
    lines.push(`- ${licenceId(entry)} — ${entry.licence}${entry.direct ? '' : ' (transitive)'}`);
  }

  const unresolved = unresolvedLicences(entries);
  if (unresolved.length > 0) {
    lines.push('', `Needs a manual check (${unresolved.length}):`, '');
    for (const entry of unresolved) {
      lines.push(`- ${licenceId(entry)}: ${entry.problem ?? 'reason not recorded.'}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
