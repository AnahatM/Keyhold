// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The structural guarantees the shell makes about itself.
 *
 * Menus, trays and OS file handlers are the surfaces most likely to grow a shortcut through
 * the architecture, because each one is a place where "just reach the vault from here" is
 * genuinely the shortest path. Three of the four claims below cannot be checked by calling a
 * function — they are claims about what the code *does not contain* — so they are checked by
 * reading it.
 *
 *   1. **No window and no `WebContents` is created here.** Every `BrowserWindow` in Keyhold
 *      is built in `src/main/window.ts` with `HARDENED_WEB_PREFERENCES`, and every
 *      `WebContents` that will ever exist is hardened by the `web-contents-created` hook in
 *      `src/main/index.ts`. A window created in the shell would be a second construction site
 *      with its own opinion about `contextIsolation`, and it would be one nobody thinks to
 *      look at when auditing the security file.
 *   2. **The shell never touches the session.** It reports — "the user chose Lock", "the OS
 *      handed us this file" — and `src/main/index.ts` decides what that means. A shell that
 *      could reach the vault would be a second path into it, sitting next to the IPC layer
 *      that validates everything, and validating nothing.
 *   3. **The shell makes no network request.** Hard rule 5. The one opt-in exception lives in
 *      `src/main/breach/` and is guarded there by its own `no-network.test.ts`; a menu that
 *      checked for updates would be a second exception nobody voted for.
 *   4. **The pure half is genuinely pure.** `index.ts` documents a split — decisions on one
 *      side, translation on the other — and the split is what makes the menu's locked-vault
 *      guard and the tray's credential guard testable at all. A single `import { app }` in
 *      `menu-model.ts` would take the whole of that with it.
 */

const DIRECTORY = dirname(fileURLToPath(import.meta.url));

/**
 * The pure column of the table in `index.ts`: no Electron, testable under Vitest.
 *
 * Listed rather than inferred, so that adding a file is a decision. The completeness check
 * below fails on any file that is in neither column — which is the only way a list like this
 * stays true.
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
const ELECTRON_FILES: readonly string[] = [
  'menu-template.ts',
  'power-events.ts',
  'shell-controller.ts',
  'tray.ts',
];

/** The barrel. Re-exports both columns and imports nothing on its own account. */
const BARREL_FILE = 'index.ts';

function sourceFileNames(): readonly string[] {
  return readdirSync(DIRECTORY)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort();
}

/**
 * Source with its comments removed.
 *
 * Necessary rather than fussy: these files *discuss* `BrowserWindow`, `webPreferences` and
 * the session at length, and a guard that matched prose would fire on the paragraph
 * explaining why the prose is true. Block comments are tracked across lines; a line comment
 * is cut at the first `//` that is not part of a `://`, so a URL inside a string literal
 * stays visible to the scan.
 *
 * The same helper exists in `src/main/breach/no-network.test.ts`. Sharing it would mean a
 * third location outside both modules; the duplication is noted in this phase's report.
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

/** `import { … } from 'electron'` — the value import. A `type` import costs nothing. */
const VALUE_IMPORTS_ELECTRON = /import\s+(?!type\s)\{([^}]*)\}\s*from\s+'electron'/;

/** Names inside an `import { … }` that are not themselves prefixed with `type`. */
function valueImportsFromElectron(code: string): readonly string[] {
  const match = VALUE_IMPORTS_ELECTRON.exec(code);
  if (match === null) return [];

  return (match[1] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !part.startsWith('type '));
}

describe('the file list this guard is written over', () => {
  it('classifies every file, so a new one cannot slip past unclassified', () => {
    const classified = [...PURE_FILES, ...ELECTRON_FILES, BARREL_FILE].sort();
    expect(sourceFileNames()).toEqual(classified);
  });
});

describe('the pure half is genuinely pure', () => {
  it('imports no Electron value anywhere in the decision-making layer', () => {
    for (const name of PURE_FILES) {
      expect(valueImportsFromElectron(codeOf(name)), name).toEqual([]);
    }
  });

  it('is proved non-vacuous by the other half, which does import Electron', () => {
    // Without this, deleting the `electron` import from every file in the directory would
    // make the assertion above pass perfectly while the shell stopped working.
    for (const name of ELECTRON_FILES) {
      expect(valueImportsFromElectron(codeOf(name)).length, name).toBeGreaterThan(0);
    }
  });

  it('keeps the barrel free of Electron of its own', () => {
    expect(valueImportsFromElectron(codeOf(BARREL_FILE))).toEqual([]);
  });
});

describe('nothing here creates a window or a WebContents', () => {
  const FORBIDDEN: readonly (readonly [what: string, pattern: RegExp])[] = [
    ['constructs a BrowserWindow', /\bnew\s+BrowserWindow\b/],
    ['sets webPreferences', /\bwebPreferences\b/],
    ['names contextIsolation', /\bcontextIsolation\b/],
    ['names nodeIntegration', /\bnodeIntegration\b/],
    ['names webSecurity', /\ballowRunningInsecureContent\b|\bwebSecurity\b/],
    ['names sandbox', /\bsandbox\s*:/],
    ['installs its own window-open handler', /\bsetWindowOpenHandler\b/],
    ['navigates a WebContents', /\.loadURL\b|\.loadFile\b|\.executeJavaScript\b/],
    ['reaches the session', /\bsession\.defaultSession\b|\bwebRequest\b/],
    ['opens an external URL', /\bshell\.openExternal\b|\bopenExternally\b/],
    ['attaches a webview', /\bwebviewTag\b|\bwebContents\.\w/],
  ];

  it('holds for every file in the directory', () => {
    for (const name of sourceFileNames()) {
      const code = codeOf(name);
      for (const [what, pattern] of FORBIDDEN) {
        expect(pattern.test(code), `${name} ${what}`).toBe(false);
      }
    }
  });
});

describe('nothing here reaches the vault', () => {
  const FORBIDDEN: readonly (readonly [what: string, pattern: RegExp])[] = [
    ['imports the session layer', /from\s+'[^']*(session|vault)\//],
    ['names the session controller', /\bSessionController\b/],
    ['names the vault service', /\bVaultService\b/],
    ['reveals a secret', /\brevealSecret\b|\bsecretPassword\b|\bSecretString\b/],
    ['reads a credential', /\bcredentials\.\w|\bgetCredential\b/],
    ['reaches the clipboard', /\bclipboard\b/],
  ];

  it('holds for every file in the directory', () => {
    for (const name of sourceFileNames()) {
      const code = codeOf(name);
      for (const [what, pattern] of FORBIDDEN) {
        expect(pattern.test(code), `${name} ${what}`).toBe(false);
      }
    }
  });
});

describe('the shell makes no network request', () => {
  const NETWORK_APIS: readonly (readonly [name: string, pattern: RegExp])[] = [
    ['fetch', /\bfetch\b/],
    ['XMLHttpRequest', /\bXMLHttpRequest\b/],
    ['WebSocket', /\bWebSocket\b/],
    ['EventSource', /\bEventSource\b/],
    ['node:http', /\bnode:https?\b/],
    ['node:net', /\bnode:net\b/],
    ['node:dns', /\bnode:dns\b/],
    ['Electron net', /\bnet\.request\b/],
    ['a URL', /\bhttps?:\/\//],
  ];

  it('holds for every file in the directory', () => {
    for (const name of sourceFileNames()) {
      const code = codeOf(name);
      for (const [api, pattern] of NETWORK_APIS) {
        expect(pattern.test(code), `${name} names ${api}`).toBe(false);
      }
    }
  });
});

describe('what the shell is allowed to log', () => {
  /**
   * The shell does log, deliberately — a missing tray icon and a rejected `open-file` are
   * both things a user needs told about. What it must never log is the *input*: a rejected
   * path is whatever the sender chose, it can be anything, and this line goes to a log that
   * gets pasted into an issue.
   */
  const CALL = /console\s*\.\s*\w+\s*\(([^;]*)\)/g;

  it('names the reason, never the path or anything from the vault', () => {
    for (const name of sourceFileNames()) {
      for (const call of codeOf(name).matchAll(CALL)) {
        const argument = call[1] ?? '';
        expect(argument, `${name}: ${argument}`).not.toMatch(
          /\bpath\b|\bargv\b|\bpassword\b|\bsecret\b|\bcredential\b|\bvalue\b/i
        );
      }
    }
  });

  it('finds the logging it is checking', () => {
    // A scan that matched nothing would pass forever, including after someone added a
    // `console.warn(path)` in a shape this regex does not recognise.
    const calls = sourceFileNames().flatMap((name) => [...codeOf(name).matchAll(CALL)]);
    expect(calls.length).toBeGreaterThan(0);
  });
});
