// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

/**
 * Keeping the window out of screenshots and screen recordings.
 *
 * `setContentProtection` is a real OS-enforced exclusion — `WDA_EXCLUDEFROMCAPTURE` on
 * Windows, `NSWindowSharingNone` on macOS — and it is on by default, which makes it one of
 * the few settings in Keyhold that starts in the protective position. Two things could go
 * wrong with it and neither would be visible:
 *
 *  1. **The call is never made.** Nothing on screen changes, no error is raised, and a user
 *     who turned the switch on watches their vault appear in a screen recording.
 *  2. **It is applied at window creation only.** Turning the switch on then does nothing until
 *     the app is restarted — the failure the module's own comment calls out: "a protection
 *     that needed a restart is one people turn on and then assume is working."
 *
 * The first is behaviour and is tested directly. The second is a wiring claim about two call
 * sites in two other files, and is asserted structurally, in the manner of `no-network.test.ts`
 * — the parser, not a regex, so a mention inside a comment does not count as a call.
 */

const { setContentProtection, isDestroyed } = vi.hoisted(() => ({
  setContentProtection: vi.fn(),
  isDestroyed: vi.fn(() => false),
}));

vi.mock('electron', () => ({
  // A function rather than an empty class: `window.ts` only ever names the type, never
  // constructs one here, and an empty class is a lint error for a good reason elsewhere.
  BrowserWindow: function BrowserWindow() {
    /* never constructed in this file */
  },
  app: { getPath: () => tmp, isPackaged: false },
  nativeTheme: { shouldUseDarkColors: false },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
}));

const tmp = '/tmp/keyhold-window-test';

const { applyContentProtection } = await import('./window.js');

/** Just enough of a `BrowserWindow` for the one method under test. */
const fakeWindow = (): Parameters<typeof applyContentProtection>[0] =>
  ({ setContentProtection, isDestroyed }) as unknown as Parameters<
    typeof applyContentProtection
  >[0];

describe('applyContentProtection', () => {
  it('passes the flag straight through in both directions', () => {
    setContentProtection.mockClear();

    applyContentProtection(fakeWindow(), true);
    expect(setContentProtection).toHaveBeenCalledWith(true);

    // The off direction matters as much: a switch that can only ever be turned on is not a
    // setting, and this one has a legitimate reason to be turned off — screen sharing a demo.
    applyContentProtection(fakeWindow(), false);
    expect(setContentProtection).toHaveBeenLastCalledWith(false);
  });

  it('does nothing when there is no window, rather than throwing', () => {
    setContentProtection.mockClear();
    expect(() => {
      applyContentProtection(null, true);
    }).not.toThrow();
    expect(setContentProtection).not.toHaveBeenCalled();
  });

  it('does nothing to a destroyed window', () => {
    // The realistic path: a settings change arrives while the window is closing. Calling into
    // a destroyed BrowserWindow throws, and it would throw inside an IPC handler — surfacing
    // to the user as a settings save that failed for no stated reason.
    setContentProtection.mockClear();
    isDestroyed.mockReturnValueOnce(true);

    applyContentProtection(fakeWindow(), true);
    expect(setContentProtection).not.toHaveBeenCalled();
  });
});

// ── The wiring, asserted structurally ────────────────────────────────────────

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Every function this file calls, from the parser rather than from a text search. */
function callsIn(file: string): ReadonlySet<string> {
  const source = ts.createSourceFile(
    file,
    readFileSync(join(ROOT, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const called = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      called.add(node.expression.text);
    }
    node.forEachChild(walk);
  };
  source.forEachChild(walk);
  return called;
}

describe('both paths that must apply it, still do', () => {
  it('is applied when the window is created', () => {
    // In `index.ts`, before the first paint, so a screenshot taken the instant the window
    // appears is already excluded.
    expect(callsIn('src/main/index.ts')).toContain('applyContentProtection');
  });

  it('is applied again when the setting changes', () => {
    // In the `settingsUpdateMachine` handler. Without this the switch takes effect only on
    // the next launch, which is the failure mode the function's own doc names — and it is a
    // one-line deletion away, with nothing else in the suite noticing.
    expect(callsIn('src/main/ipc/register.ts')).toContain('applyContentProtection');
  });
});
