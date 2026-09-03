// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aliasesFrom,
  factsOf,
  importedNamesFrom,
  isTestFile,
  moduleGraphFrom,
  posixRelative,
  sourceFilesUnder,
  type SourceFacts,
  type SourceTree,
} from '../../../tools/source-facts.js';

/**
 * The structural guarantees the shell makes about itself.
 *
 * Menus, trays and OS file handlers are the surfaces most likely to grow a shortcut through
 * the architecture, because each one is a place where "just reach the vault from here" is
 * genuinely the shortest path. Every claim below is a claim about what the code *does not
 * contain*, so none of them can be checked by calling a function. They are checked by reading
 * the code — which makes *how* it is read the entire security property.
 *
 *   1. **No window and no `WebContents` is created here.** Every `BrowserWindow` in Keyhold
 *      is built in `src/main/window.ts` with `HARDENED_WEB_PREFERENCES`, and every
 *      `WebContents` that will ever exist is hardened by the `web-contents-created` hook in
 *      `src/main/index.ts`. A window created in the shell would be a second construction site
 *      with its own opinion about `contextIsolation`, and it would be one nobody thinks to
 *      look at when auditing the security file.
 *   2. **The shell never touches the vault.** It reports — "the user chose Lock", "the OS
 *      handed us this file" — and `src/main/index.ts` decides what that means. A shell that
 *      could reach the vault would be a second path into it, sitting next to the IPC layer
 *      that validates everything, and validating nothing.
 *   3. **The pure half is genuinely pure.** `index.ts` documents a split — decisions on one
 *      side, translation on the other — and the split is what makes the menu's locked-vault
 *      guard and the tray's credential guard testable at all. A single `import { app }` in
 *      `menu-model.ts` would take the whole of that with it.
 *   4. **What is logged is a reason, never a value.** The shell logs deliberately; a missing
 *      tray icon and a rejected `open-file` are both things a user needs told about. What it
 *      must never log is the *input*, because a rejected path is whatever the sender chose and
 *      this line goes to a log that gets pasted into an issue.
 *
 * ## Why this file parses instead of pattern-matching — read before "simplifying" it
 *
 * This guard used to read the source as text: a hand-rolled comment stripper, then a table of
 * regexes per claim. The stripper was a **copy** of the one `src/main/breach/no-network.test.ts`
 * was rebuilt to remove — line for line the same three-branch algorithm, and its own comment
 * said so, noting that sharing it "would mean a third location outside both modules" and that
 * "the duplication is noted in this phase's report". Noting it is what let one file's bug become
 * two files' bug. Every hole that audit found in the original was live here too, and the shell
 * had grown two more of its own. All four were measured by planting a real violation and
 * watching this guard pass:
 *
 *   - **N18 — the string-literal hole.** The stripper had no notion of string literals, so a
 *     line containing `'/*'` opened a block comment that never closed, and every following
 *     line of that file was deleted before any regex saw it. The opener does not have to be
 *     contrived: `const KEEP_GLOB = '**' + '/*.keep'` is the most natural line imaginable for a
 *     directory that handles OS file hand-offs. Measured: with a `session.revealSecret()` call
 *     planted under such a line in `menu-model.ts`, the guard passed every assertion. The same
 *     plant hid a `console.warn` naming the rejected path, and a `new BrowserWindow({
 *     webPreferences: { contextIsolation: false } })`. Three of the four claims above were
 *     blinded by one line.
 *   - **N17 — the one-directory hole.** `readdirSync` over this directory, non-recursively.
 *     A subdirectory does not end in `.ts`, so it was filtered out of the listing and the
 *     completeness check did not notice it either. Measured: `shell/bridge/reveal.ts`
 *     containing `revealSecret` was invisible to every assertion in the file.
 *   - **S1 — the shape hole.** The Electron check was a single non-global regex for one import
 *     shape, `import { … } from 'electron'`. Measured: `import * as electron from 'electron'`
 *     in `menu-model.ts` — a full Electron namespace in the pure half — passed. So would a
 *     default import, a `require`, and a dynamic `import()`.
 *   - **S2 — the graph hole.** There was no module graph at all: every claim was per-file text.
 *     "Nothing here reaches the vault" was really "no file here spells one of six names".
 *     Measured: `menu-model.ts` importing `@shared/model/vault-summary.js`, which imports
 *     `@main/session/controller.js` and reveals a secret, passed — the specifier names neither
 *     `session/` nor `vault/`, and nothing followed it.
 *
 * So the imports, the identifiers, the calls and the strings now come from the **TypeScript
 * parser**, the same one that compiles the project. Comments are trivia and never become
 * nodes, which closes N18 by construction rather than by a better regex; the walk is recursive
 * and the classification is written over it, which closes N17; the Electron check reads the
 * import *clause* rather than matching one spelling of it, which closes S1; and the vault
 * claim is now reachability over the module graph rather than a list of names, which closes S2.
 * Aliases are read out of `tsconfig.node.json` itself rather than restated here.
 *
 * The last `describe` plants each of those violations into a throwaway source tree and asserts
 * the scan **fails** on it. A guard nobody has watched fail is not known to work, and this one
 * was watched to pass while carrying four bypasses.
 *
 * ## The duplication that caused this, now folded in
 *
 * `factsOf`, `sourceFilesUnder`, `aliasesFrom`, `resolveSpecifier` and `moduleGraphFrom` used to
 * sit in this file **and** in `src/main/breach/no-network.test.ts`, twice over. That was the
 * second list hard rule 8 exists for, and it is not an abstract one: the routine those two files
 * shared before the rebuild was the comment stripper, N18 was found and fixed in the breach copy,
 * and this copy kept the bug under a comment saying that sharing the routine "would mean a third
 * location outside both modules" and that the duplication was "noted in this phase's report".
 * Noting it is what let seven planted violations through this guard for weeks.
 *
 * They now live in `tools/source-facts.ts`, which both guards import, and whose header carries
 * the full history. **Nothing below re-derives a fact about source.** What stays here is the
 * *policy* — which names mean a window, which mean the vault, where the shell may reach, what
 * counts as logging a value. Those are judgements about this directory and they belong beside
 * it. If a claim here needs a fact the shared module does not expose, add it there: a local
 * `factsOf` in this file would be the third copy.
 */

// ── Where things are ─────────────────────────────────────────────────────────

const DIRECTORY = import.meta.dirname;
const ROOT = resolve(DIRECTORY, '..', '..', '..');

/** Repo-relative, `/`-separated, so failure messages read the same on both platforms. */
const repoPath = (file: string): string => posixRelative(ROOT, file);

/**
 * The pure column of the table in `index.ts`: no Electron, testable under Vitest.
 *
 * Listed rather than inferred, so that adding a file is a decision. The completeness check
 * below fails on any file that is in neither column — and it walks recursively now, so a new
 * subdirectory is a file in neither column rather than a blind spot.
 */
const PURE_FILES: readonly string[] = [
  'file-open-request.ts',
  'menu-commands.ts',
  'menu-model.ts',
  'shell-settings.ts',
  'shortcut-parity.ts',
  'tray-model.ts',
  'window-placement.ts',
];

/** The Electron-bound column: translation and wiring, with no decisions left in it. */
const ELECTRON_FILES: readonly string[] = ['menu-template.ts', 'power-events.ts', 'tray.ts'];

/** Electron-bound, and the only file here that receives a window it did not create. */
const CONTROLLER_FILE = 'shell-controller.ts';

/** The barrel. Re-exports both columns and imports nothing on its own account. */
const BARREL_FILE = 'index.ts';

// ── The tree being scanned ───────────────────────────────────────────────────

/**
 * The project, and the aliases its imports may be written in.
 *
 * The alias table is parsed out of `tsconfig.node.json` rather than restated: hard rule 8, and
 * because a guard carrying its own copy of it stops seeing an alias the moment one is added —
 * which is how a module walk goes quietly blind, and how S2 stayed invisible.
 */
const PROJECT: SourceTree = {
  root: join(ROOT, 'src'),
  aliases: aliasesFrom(join(ROOT, 'tsconfig.node.json'), ROOT),
};

/** Directory-relative, `/`-separated: `menu-model.ts`, or `bridge/reveal.ts`. */
const localName = (file: string): string => posixRelative(DIRECTORY, file);

const shellFiles = sourceFilesUnder(DIRECTORY).filter((file) => !isTestFile(file));
const shellFacts: readonly SourceFacts[] = shellFiles.map(factsOf);
const shellFileNames = shellFiles.map(localName);

const factsFor = (name: string): SourceFacts => {
  const facts = shellFacts.find((candidate) => localName(candidate.file) === name);
  if (facts === undefined) throw new Error(`no such shell file: ${name}`);
  return facts;
};

// ── The rules ────────────────────────────────────────────────────────────────

/**
 * Electron value bindings this file pulls in, by any import shape. Closes S1.
 *
 * The shape-blindness is the shared scanner's job: a default import, a namespace import, a
 * named import, a `require()`, a dynamic `import()` and an `export … from` are six node shapes
 * and one identical capability, and the regex this replaces recognised exactly one of them.
 * What is decided *here* is that only the runtime bindings count — `import type { BrowserWindow }
 * from 'electron'` is erased and carries nothing, which is why the pure half may name the type.
 */
function electronValueImports(facts: SourceFacts): readonly string[] {
  return importedNamesFrom(facts, 'electron', 'values');
}

/**
 * Names that only appear where a window, a `WebContents` or a session is being built or driven.
 *
 * `BrowserWindow` itself is deliberately **not** here: `shell-controller.ts` and
 * `menu-template.ts` both accept one as a `type`, which is the correct way to be handed a
 * window you did not create. Constructing one is checked separately, as a call.
 */
const WINDOW_NAMES: readonly string[] = [
  'webPreferences',
  'contextIsolation',
  'nodeIntegration',
  'webSecurity',
  'allowRunningInsecureContent',
  'sandbox',
  'webviewTag',
  'setWindowOpenHandler',
  'loadURL',
  'loadFile',
  'executeJavaScript',
  'defaultSession',
  'webRequest',
  'openExternal',
  'webContents',
];

function windowFaults(facts: SourceFacts): readonly string[] {
  const faults: string[] = [];
  if (facts.called.has('BrowserWindow')) faults.push('constructs a BrowserWindow');
  for (const name of WINDOW_NAMES) {
    if (facts.identifiers.has(name)) faults.push(`names ${name}`);
  }
  return faults;
}

/**
 * Names that mean the vault, the session, or a secret.
 *
 * Kept for the failure *message* — "menu-model.ts names revealSecret" is a better first line
 * than a path through four modules. It is not the load-bearing check: a name list can only
 * catch a spelling somebody chose, and the reachability rule below is what actually holds.
 */
const VAULT_NAMES: readonly string[] = [
  'SessionController',
  'VaultService',
  'SecretBroker',
  'revealSecret',
  'secretPassword',
  'SecretString',
  'getCredential',
  'clipboard',
];

function vaultFaults(facts: SourceFacts): readonly string[] {
  return VAULT_NAMES.filter((name) => facts.identifiers.has(name)).map((name) => `names ${name}`);
}

/**
 * Where the shell is allowed to reach.
 *
 * Its own directory, and `src/shared/` — the model types and the IPC contract, which both
 * halves of the app already share. Nothing else under `src/main/`: not the session, not the
 * vault, not crypto, not the IPC handlers. That is claim 2 stated as reachability rather than
 * as a list of forbidden names, and it is the check that closes S2.
 *
 * If a legitimate shell feature ever needs something from `src/main/`, this test failing is
 * the correct outcome: it is a decision-log entry, not an edit to a pattern.
 */
function outsideShellReach(file: string, tree: SourceTree): boolean {
  const path = posixRelative(tree.root, file);
  return !path.startsWith('main/shell/') && !path.startsWith('shared/');
}

/** A URL in the source. See the note on the network claim below. */
const URL_PATTERN = /\bhttps?:\/\//;

/**
 * Words that name a value rather than a reason.
 *
 * Matched as a **substring, case-insensitively**, on the identifiers and property names inside
 * a `console.*` argument — not on the raw text of the call. Two deliberate differences from the
 * word-boundary regex this replaces:
 *
 *  - A value word inside a longer name used to pass. `\bpath\b` does not match inside
 *    `requestedPath`, so `console.error(requestedPath)` — no comment trickery, in plain sight —
 *    satisfied the old rule completely. (`secretPassword` was the same gap in the logging rule,
 *    but the vault name list happened to catch that one spelling, so it was never live.)
 *    Substring matching is the fix, and it costs nothing: a name containing `path` that is not
 *    a path is a name worth renaming.
 *  - A banned word inside a fixed string literal no longer fails. `console.warn('no path was
 *    given')` reproduces nothing — the leak is an interpolated *value*, and flagging our own
 *    prose trains people to reword the message instead of removing the value.
 *
 * The honest limit: a value laundered through a local (`const p = request.path; console.warn(p)`)
 * is invisible to this, and to any check that does not do dataflow. The mitigation is that the
 * shell's logging is four lines long and the non-vacuity check below keeps it reviewed.
 */
const VALUE_WORDS: readonly string[] = [
  'path',
  'argv',
  'password',
  'secret',
  'credential',
  'token',
  'seed',
  'plaintext',
  'clipboard',
  'value',
];

function logFaults(facts: SourceFacts): readonly string[] {
  const faults: string[] = [];
  for (const call of facts.logCalls) {
    for (const name of call.names) {
      // One fault per name, not per word it matches: `secretPassword` contains two of them and
      // reporting it twice makes the failure look like two problems.
      if (VALUE_WORDS.some((word) => name.toLowerCase().includes(word))) {
        faults.push(`console.${call.method} names ${name}`);
      }
    }
  }
  return faults;
}

// ─────────────────────────────────────────────────────────────────────────────
// The file list this guard is written over
// ─────────────────────────────────────────────────────────────────────────────

describe('the file list this guard is written over', () => {
  it('classifies every file, so a new one cannot slip past unclassified', () => {
    // Recursive, so a file added in a subdirectory is an unclassified file rather than an
    // invisible one. That is N17: `readdirSync` filtered directories out along with the
    // non-`.ts` entries, and a whole subtree stopped being scanned without anything failing.
    const classified = [...PURE_FILES, ...ELECTRON_FILES, CONTROLLER_FILE, BARREL_FILE].sort();
    expect(shellFileNames).toEqual(classified);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Nothing here creates a window or a WebContents
// ─────────────────────────────────────────────────────────────────────────────

describe('nothing here creates a window or a WebContents', () => {
  it('holds for every file in the directory', () => {
    const offenders = shellFacts
      .filter((facts) => windowFaults(facts).length > 0)
      .map((facts) => `${localName(facts.file)} — ${windowFaults(facts).join(', ')}`);

    expect(offenders).toEqual([]);
  });

  it('lets a file be handed a window it did not create', () => {
    // The rule is about construction and navigation, not about the type. `shell-controller.ts`
    // is given a `BrowserWindow` by `src/main/index.ts` and shows and hides it; asserting it
    // may not name the type would push that wiring somewhere less visible.
    const controller = factsFor(CONTROLLER_FILE);
    expect(controller.identifiers.has('BrowserWindow')).toBe(true);
    expect(controller.called.has('BrowserWindow')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Nothing here reaches the vault
// ─────────────────────────────────────────────────────────────────────────────

describe('nothing here reaches the vault', () => {
  it('names nothing from the session, the vault or the clipboard', () => {
    const offenders = shellFacts
      .filter((facts) => vaultFaults(facts).length > 0)
      .map((facts) => `${localName(facts.file)} — ${vaultFaults(facts).join(', ')}`);

    expect(offenders).toEqual([]);
  });

  /**
   * The strongest of the checks, and the one S2 was hiding from.
   *
   * "No file here spells `SessionController`" would still be true of a shell that imported
   * something that did. This asserts that no chain of imports out of any shell file arrives
   * anywhere under `src/main/` outside this directory — so the capability is absent rather
   * than merely unspelled.
   */
  it('cannot reach anything in src/main/ outside this directory', () => {
    const graph = moduleGraphFrom(shellFiles, PROJECT);
    const escapes = [...graph.files]
      .filter((file) => outsideShellReach(file, PROJECT))
      .map(repoPath)
      .sort();

    expect(escapes).toEqual([]);
  });

  it('walks a real graph rather than only the directory', () => {
    // Non-vacuity: an empty or directory-bounded walk would satisfy the assertion above
    // perfectly. `local-path.ts` is a value import out of the directory and `appearance.ts` a
    // type import through an alias, so reaching both proves the walk does the two things the
    // planted violations needed it to do.
    const reached = [...moduleGraphFrom(shellFiles, PROJECT).files].map(repoPath);

    expect(reached).toContain('src/shared/model/local-path.ts');
    expect(reached).toContain('src/shared/theme/appearance.ts');
    expect(reached.length).toBeGreaterThan(shellFiles.length);
  });

  it('resolves every local import it meets, so nothing is skipped in silence', () => {
    const graph = moduleGraphFrom(shellFiles, PROJECT);
    expect(graph.unresolved, 'imports the walk could not follow').toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The pure half is genuinely pure
// ─────────────────────────────────────────────────────────────────────────────

describe('the pure half is genuinely pure', () => {
  it('imports no Electron value anywhere in the decision-making layer', () => {
    for (const name of PURE_FILES) {
      expect(electronValueImports(factsFor(name)), name).toEqual([]);
    }
  });

  it('is proved non-vacuous by the other half, which does import Electron', () => {
    // Without this, deleting the `electron` import from every file in the directory would
    // make the assertion above pass perfectly while the shell stopped working.
    for (const name of [...ELECTRON_FILES, CONTROLLER_FILE]) {
      expect(electronValueImports(factsFor(name)).length, name).toBeGreaterThan(0);
    }
  });

  it('keeps the barrel free of Electron of its own', () => {
    expect(electronValueImports(factsFor(BARREL_FILE))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. What the shell is allowed to log
// ─────────────────────────────────────────────────────────────────────────────

describe('what the shell is allowed to log', () => {
  it('names the reason, never the path or anything from the vault', () => {
    const offenders = shellFacts
      .filter((facts) => logFaults(facts).length > 0)
      .map((facts) => `${localName(facts.file)} — ${logFaults(facts).join(', ')}`);

    expect(offenders).toEqual([]);
  });

  it('finds the logging it is checking', () => {
    // A scan that matched nothing would pass forever, including after someone added a
    // `console.warn(path)` in a shape this walk does not recognise.
    const calls = shellFacts.flatMap((facts) => facts.logCalls);

    expect(calls.length).toBeGreaterThan(0);
    // Only `warn` and `error` — `no-console` in `eslint.config.js` allows exactly those two,
    // and a `console.log` here would mean the lint rule had been turned off somewhere.
    expect([...new Set(calls.map((call) => call.method))].sort()).toEqual(['error', 'warn']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The network claim, and what is deliberately not repeated here
// ─────────────────────────────────────────────────────────────────────────────

/**
 * This guard used to carry its own nine-line table of network APIs: `fetch`, `XMLHttpRequest`,
 * `WebSocket`, `EventSource`, `node:http`, `node:net`, `node:dns`, Electron's `net.request`,
 * and a URL. Eight of those nine are now a **second list** (hard rule 8), and a weaker copy of
 * one: `src/main/breach/no-network.test.ts` scans every non-test `.ts` under `src/`,
 * recursively, off the parse tree, and asserts that the set of files naming a
 * request-originating API is exactly `['src/main/breach/https-transport.ts — fetch']`. That
 * covers every file in this directory, it covers module heads this table never listed, and it
 * fails with a better message. Repeating it here would mean two lists that can disagree about
 * what "the network" is — which is how `stripComments` came to exist in two files.
 *
 * The ninth is not covered anywhere: `no-network.test.ts` only checks for a URL *inside
 * `src/main/breach/`*. So the URL rule stays, and it is a directory-local judgement rather
 * than a restatement of hard rule 5 — a shell that cannot open an external URL (checked above,
 * as `openExternal`) has no use for one, so a URL appearing here is dead code or a mistake.
 * When a Help menu eventually wants one, this failing is the conversation, not the obstacle.
 */
describe('the shell has no URL in it', () => {
  it('holds for every file in the directory', () => {
    const offenders = shellFacts
      .filter((facts) => facts.strings.some((value) => URL_PATTERN.test(value)))
      .map((facts) => localName(facts.file));

    expect(offenders).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The guard, watched failing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every bypass the audit found, planted into a throwaway tree, with the same scan asserted to
 * **fail** on it.
 *
 * This block is the reason to trust the ones above. N18, N17, S1 and S2 were all silent
 * precisely because the guard was only ever observed passing, and a one-off manual
 * plant-and-revert only proves the guard worked on the day somebody tried it. These are the
 * same functions, run against files that are supposed to trip them, on every run.
 */
describe('the scan can actually fail', () => {
  let fixtureRoot: string;
  let fixture: SourceTree;
  let shellRoot: string;

  const write = (path: string, contents: string): void => {
    const file = join(fixtureRoot, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, 'utf8');
  };

  const planted = (path: string): SourceFacts => factsOf(join(fixtureRoot, path));

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'keyhold-shell-hardening-'));
    shellRoot = join(fixtureRoot, 'src', 'main', 'shell');
    fixture = {
      root: join(fixtureRoot, 'src'),
      aliases: new Map([
        ['@main', join(fixtureRoot, 'src', 'main')],
        ['@shared', join(fixtureRoot, 'src', 'shared')],
      ]),
    };

    // N18: a `/*` inside a string literal. The stripper this replaces treated it as an
    // unterminated block comment and deleted every line below it, in three separate claims.
    write(
      'src/main/shell/blinded-vault.ts',
      [
        "const KEEP_GLOB = '**/*.keep';",
        'export const leak = (session: SessionController): string =>',
        '  session.revealSecret(KEEP_GLOB);',
        '',
      ].join('\n')
    );
    write(
      'src/main/shell/blinded-log.ts',
      [
        "const ANY_KEEP = '**/*.keep';",
        'export function trace(path: string): void {',
        '  console.warn(`[shell] rejected ${path} against ${ANY_KEEP}`);',
        '}',
        '',
      ].join('\n')
    );
    write(
      'src/main/shell/blinded-window.ts',
      [
        "const ICON_GLOB = 'resources/*/*.png';",
        'export const popOut = (): BrowserWindow =>',
        '  new BrowserWindow({ webPreferences: { contextIsolation: false }, sandbox: false });',
        `export const glob = ICON_GLOB;`,
        '',
      ].join('\n')
    );

    // A value word inside a longer name, which the word-boundary regex walked past. No comment
    // trickery: this shape passed the old guard while sitting in plain sight.
    write(
      'src/main/shell/word-boundary-log.ts',
      'export const trace = (requestedPath: string, secretPassword: string): void => {\n' +
        '  console.error(requestedPath, secretPassword);\n' +
        '};\n'
    );

    // N17: one directory down.
    write(
      'src/main/shell/bridge/reveal.ts',
      'export const reveal = (c: SessionController): string => c.revealSecret();\n'
    );

    // S1: the three import shapes the single regex did not recognise.
    write(
      'src/main/shell/namespace-electron.ts',
      "import * as electron from 'electron';\nexport const quit = electron.app.quit;\n"
    );
    write(
      'src/main/shell/default-electron.ts',
      "import electron from 'electron';\nexport const quit = electron.app.quit;\n"
    );
    write(
      'src/main/shell/required-electron.ts',
      "const { app } = require('electron');\nexport const quit = app.quit;\n"
    );
    write(
      'src/main/shell/type-only-electron.ts',
      "import type { BrowserWindow } from 'electron';\nexport type W = BrowserWindow;\n"
    );

    // S2: the reach is real, transitive, and written in an alias that names neither
    // `session/` nor `vault/`.
    write(
      'src/main/shell/aliased-client.ts',
      "import { summaryTitle } from '@shared/model/vault-summary.js';\nexport const title = summaryTitle;\n"
    );
    write(
      'src/shared/model/vault-summary.ts',
      "import type { SessionController } from '@main/session/controller.js';\n" +
        'export const summaryTitle = (c: SessionController): string => c.reveal();\n'
    );
    write(
      'src/main/session/controller.ts',
      'export class SessionController {\n  reveal(): string {\n    return "x";\n  }\n}\n'
    );

    write('src/main/shell/broken-client.ts', "import './nowhere.js';\nexport const x = 1;\n");
    write(
      'src/main/shell/clean.ts',
      [
        '/** Discusses BrowserWindow, webPreferences, revealSecret and the session at length. */',
        '// A comment naming contextIsolation, clipboard, secretPassword and https://example.com',
        "export const answer = 'nothing to see here';",
        'export const log = (): void => {',
        "  console.warn('[shell] a reason, not a value');",
        '};',
        '',
      ].join('\n')
    );
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('is not blinded by a string containing a block-comment opener — N18, the vault claim', () => {
    expect(vaultFaults(planted('src/main/shell/blinded-vault.ts'))).toContain('names revealSecret');
  });

  it('is not blinded by a string containing a block-comment opener — N18, the log claim', () => {
    expect(logFaults(planted('src/main/shell/blinded-log.ts'))).toContain(
      'console.warn names path'
    );
  });

  it('is not blinded by a string containing a block-comment opener — N18, the window claim', () => {
    const faults = windowFaults(planted('src/main/shell/blinded-window.ts'));

    expect(faults).toContain('constructs a BrowserWindow');
    expect(faults).toContain('names webPreferences');
    expect(faults).toContain('names contextIsolation');
    expect(faults).toContain('names sandbox');
  });

  it('catches a value word inside a longer name, not only as a whole word', () => {
    const faults = logFaults(planted('src/main/shell/word-boundary-log.ts'));

    // `requestedPath` is the shape that was live: `\bpath\b` cannot see it, and no other rule
    // in the old guard covered it either.
    expect(faults).toContain('console.error names requestedPath');
    // Reported once, though it matches two of the words.
    expect(faults.filter((fault) => fault.endsWith('secretPassword'))).toHaveLength(1);
  });

  it('reads files in subdirectories, not just one directory — N17', () => {
    const scanned = sourceFilesUnder(shellRoot).map((file) => relative(shellRoot, file));

    expect(scanned).toContain(join('bridge', 'reveal.ts'));
    expect(vaultFaults(planted('src/main/shell/bridge/reveal.ts'))).toContain('names revealSecret');
  });

  it('finds an Electron namespace import — S1', () => {
    expect(electronValueImports(planted('src/main/shell/namespace-electron.ts'))).toEqual(['*']);
  });

  it('finds an Electron default import — S1', () => {
    expect(electronValueImports(planted('src/main/shell/default-electron.ts'))).toEqual([
      'default',
    ]);
  });

  it('finds an Electron require() — S1', () => {
    expect(electronValueImports(planted('src/main/shell/required-electron.ts'))).toEqual(['*']);
  });

  it('does not count a type-only Electron import, which is erased', () => {
    expect(electronValueImports(planted('src/main/shell/type-only-electron.ts'))).toEqual([]);
  });

  it('follows an aliased specifier out of the directory and back into src/main — S2', () => {
    const entry = join(fixtureRoot, 'src/main/shell/aliased-client.ts');
    const graph = moduleGraphFrom([entry], fixture);
    const escapes = [...graph.files].filter((file) => outsideShellReach(file, fixture));

    // The specifier names neither `session/` nor `vault/`, and the hop that reaches the
    // session is a type-only import two modules away.
    expect(escapes).toContain(join(fixtureRoot, 'src/main/session/controller.ts'));
  });

  it('reports a local import it cannot resolve instead of walking past it', () => {
    const entry = join(fixtureRoot, 'src/main/shell/broken-client.ts');

    expect(moduleGraphFrom([entry], fixture).unresolved).toHaveLength(1);
  });

  it('does not flag a file that only discusses all of this in its comments', () => {
    // The other half of N18: the reason the old guard had a comment stripper at all is that
    // these files describe what they refuse to do, at length. Trivia is never a node, so the
    // prose costs nothing and no stripper is needed to ignore it.
    const clean = planted('src/main/shell/clean.ts');

    expect(vaultFaults(clean)).toEqual([]);
    expect(windowFaults(clean)).toEqual([]);
    expect(logFaults(clean)).toEqual([]);
    expect(electronValueImports(clean)).toEqual([]);
    expect(clean.strings.some((value) => URL_PATTERN.test(value))).toBe(false);
    expect(clean.logCalls).toHaveLength(1);
  });
});
