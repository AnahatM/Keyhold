// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Guard: the tray is reachable, configurable, and has an icon to draw.
 *
 * **This file exists because the tray shipped as none of those things.** Every part of it
 * was written and tested — `tray.ts`, `tray-model.ts` and its security guard,
 * `shell-settings.ts` and its coercion, the `#createTrayIfWanted` branch — and every one of
 * those tests passed the whole time, because no test of a component can see that nothing
 * constructs it. What actually happened at runtime was:
 *
 *  - `showTrayIcon` defaults to **`true`**, so every launch asked for a tray;
 *  - nothing anywhere passed `trayIcon`, so `#trayIcon` was always `null`;
 *  - `#createTrayIfWanted` therefore took its warning branch every single time, printing
 *    `[shell] no tray icon available; the tray will not be created` into a log nobody reads;
 *  - and no control existed to turn any of it off, so a user could not even discover the
 *    feature was there to be broken.
 *
 * That is the sixth instance of `CLAUDE.md`'s documented failure mode, and the lesson it
 * keeps teaching is the one encoded here: **assert on the caller, not the component.**
 * `tools/bridge-is-used.test.ts` generalises this for the preload bridge; the shell has no
 * such registry to walk, so the wiring is asserted structurally instead — with the parser,
 * not a regex, so that a mention inside a comment does not count as a call.
 *
 * Fault injection performed: deleting `trayIcon:` from the `new NativeShell({…})` options
 * fails "hands the shell an icon"; deleting `settings:` fails "hands the shell the stored
 * settings"; deleting the `applyShellSettings` line from the settings handler fails "a
 * changed setting reaches the running shell"; removing the `extraResources` entry fails
 * "the icon is shipped".
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');

const sourceOf = (relative: string): ts.SourceFile =>
  ts.createSourceFile(
    relative,
    readFileSync(join(ROOT, relative), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

/**
 * Every function called in the file, by name. Comments cannot reach this.
 *
 * Both call shapes count, and the second is not optional: `applyContentProtection(…)` is a
 * bare identifier, but `context.applyShellSettings?.(…)` is a property access on the IPC
 * context. An earlier draft of this helper matched identifiers only, and its first run
 * reported the wiring missing when the wiring was there — a guard that fails on correct code
 * gets deleted rather than believed, which is worse than not having written it.
 */
function callsIn(relative: string): ReadonlySet<string> {
  const called = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const target = node.expression;
      if (ts.isIdentifier(target)) called.add(target.text);
      // Covers both `a.b()` and the optional `a.b?.()`, which parses to the same node kind.
      else if (ts.isPropertyAccessExpression(target)) called.add(target.name.text);
    }
    node.forEachChild(walk);
  };
  sourceOf(relative).forEachChild(walk);
  return called;
}

/**
 * The property names of the object literal handed to `new NativeShell({…})`.
 *
 * Found by walking to the `new` expression rather than by matching text, so that reformatting
 * the call, renaming the local, or moving it inside another block does not quietly turn this
 * assertion into one that passes because it found nothing.
 */
function nativeShellOptionKeys(relative: string): readonly string[] {
  const keys: string[] = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'NativeShell'
    ) {
      const [argument] = node.arguments ?? [];
      if (argument !== undefined && ts.isObjectLiteralExpression(argument)) {
        for (const property of argument.properties) {
          const name = property.name;
          if (name !== undefined && ts.isIdentifier(name)) keys.push(name.text);
        }
      }
    }
    node.forEachChild(walk);
  };
  sourceOf(relative).forEachChild(walk);
  return keys;
}

describe('the tray is actually constructed', () => {
  it('hands the shell an icon, so the tray is created rather than warned about', () => {
    expect(nativeShellOptionKeys('src/main/index.ts')).toContain('trayIcon');
  });

  it('loads that icon from a real path', () => {
    // `loadTrayIcon` answers a missing file with `null` rather than an empty image, so the
    // failure mode this replaces — an invisible, clickable dot in the notification area —
    // cannot come back through a wrong path. It can only come back through no call at all.
    expect(callsIn('src/main/index.ts')).toContain('loadTrayIcon');
  });

  it('hands the shell the stored settings, not the built-in defaults', () => {
    // Without this the shell runs on `DEFAULT_SHELL_SETTINGS` forever and the settings
    // screen writes to a preferences file nothing reads back.
    expect(nativeShellOptionKeys('src/main/index.ts')).toContain('settings');
  });
});

describe('the tray is configurable', () => {
  it('a changed setting reaches the running shell, not only the next launch', () => {
    // In the `settingsUpdateMachine` handler, beside `applyContentProtection`, and for the
    // same reason: a switch whose effect needs a restart is one people flip and then assume
    // is working.
    expect(callsIn('src/main/ipc/register.ts')).toContain('applyShellSettings');
  });

  it('every tray setting is rendered by a control somebody can reach', () => {
    // The half `bridge-is-used.test.ts` cannot see for the shell: a setting that exists in
    // the model, is validated at the boundary, is stored, and is rendered nowhere.
    const section = readFileSync(join(ROOT, 'src/renderer/src/settings/TraySection.tsx'), 'utf8');
    for (const id of ['showTrayIcon', 'closeToTray', 'minimiseToTray', 'lockOnHideToTray']) {
      expect(section).toContain(`settingId="tray.${id}"`);
    }
  });

  it('and that section is mounted, not merely written', () => {
    // `TraySection` joins `SettingsScreen`'s body and its jump-list. The component test
    // above would pass for a file no screen imports — which is the entire failure this
    // guard exists for.
    const screen = readFileSync(join(ROOT, 'src/renderer/src/settings/SettingsScreen.tsx'), 'utf8');
    expect(screen).toContain('<TraySection');
    expect(screen).toContain("id: 'kh-settings-tray'");
  });
});

describe('the icon survives packaging', () => {
  it('is shipped as an extra resource, in both sizes index.ts asks for', () => {
    // `build/` is buildResources, deliberately absent from the `files` allow-list. Without
    // an `extraResources` entry the packaged app has no icon file at all — and this is
    // exactly the class of defect that is invisible until somebody installs a release,
    // because `npm run dev` reads the icon straight out of the source tree.
    const config = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8');
    expect(config).toContain('from: build/icons');
    expect(config).toContain('to: icons');
    for (const size of ['16x16.png', '32x32.png']) {
      expect(config).toContain(size);
    }
  });
});
