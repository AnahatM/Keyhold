// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { menuShortcutBindings, type MenuShortcutBinding } from './menu-model.js';
import {
  acceleratorFromCombo,
  findShortcutDrift,
  type RendererShortcut,
} from './shortcut-parity.js';

/**
 * Tests for the drift detector and the accelerator translation it compares with.
 *
 * ## Why the real cross-table guard is not in this file
 *
 * It cannot be. `src/main/**` and `src/renderer/src/**` are two TypeScript projects, and
 * `tsconfig.node.json` lists only the first — so a test *here* that imports the renderer's
 * `SHORTCUTS` fails the build with TS6307 before it can assert anything, and drags
 * `key-combo.ts` into the same error behind it. That is the project boundary doing its job:
 * the main process must not be able to reach into the renderer, and a test file living in
 * `src/main` is still `src/main`.
 *
 * The comparison itself is still worth having, so it belongs in the one place permitted to
 * see both halves — `tests/renderer/`, which `vitest.config.ts` already includes and which
 * neither tsconfig compiles. The exact file is in this phase's report; it was outside this
 * agent's write scope.
 *
 * What *is* here is everything that can be checked from the main side alone: the translation
 * both halves are compared through, the detector that does the comparing, and the shape of
 * the menu's own accelerator strings — because a drift report is only trustworthy if the
 * menu's side of it is already in the normal form the detector produces.
 */

describe('translating a DOM combo into an Electron accelerator', () => {
  it('renders the accelerator modifier as CmdOrCtrl', () => {
    expect(acceleratorFromCombo({ key: 's', mod: true, shift: false, alt: false })).toBe(
      'CmdOrCtrl+S'
    );
  });

  it('orders modifiers the way Electron parses them', () => {
    expect(acceleratorFromCombo({ key: 't', mod: true, shift: true, alt: true })).toBe(
      'CmdOrCtrl+Alt+Shift+T'
    );
  });

  it('uses Electron spellings for the named keys that differ', () => {
    expect(acceleratorFromCombo({ key: 'Escape', mod: false, shift: false, alt: false })).toBe(
      'Esc'
    );
    expect(acceleratorFromCombo({ key: 'Enter', mod: true, shift: false, alt: false })).toBe(
      'CmdOrCtrl+Return'
    );
    expect(acceleratorFromCombo({ key: 'ArrowDown', mod: false, shift: false, alt: false })).toBe(
      'Down'
    );
  });

  it('passes an unmapped named key through unchanged', () => {
    // Rather than dropping it, which would produce an accelerator Electron silently ignores.
    expect(acceleratorFromCombo({ key: 'Backspace', mod: true, shift: false, alt: false })).toBe(
      'CmdOrCtrl+Backspace'
    );
    expect(acceleratorFromCombo({ key: 'F5', mod: false, shift: false, alt: false })).toBe('F5');
  });

  it('leaves a punctuation key alone', () => {
    expect(acceleratorFromCombo({ key: '/', mod: true, shift: false, alt: false })).toBe(
      'CmdOrCtrl+/'
    );
  });
});

describe('the drift detector itself', () => {
  const registry: readonly RendererShortcut[] = [
    {
      id: 'vault.save',
      combo: { key: 's', mod: true, shift: false, alt: false },
      whenLocked: false,
    },
    {
      id: 'shortcuts.help',
      combo: { key: '/', mod: true, shift: false, alt: false },
      whenLocked: true,
    },
  ];

  it('reports an accelerator that has drifted', () => {
    const bindings: readonly MenuShortcutBinding[] = [
      { shortcutId: 'vault.save', command: 'vault.save', accelerator: 'CmdOrCtrl+Shift+S' },
    ];

    expect(findShortcutDrift(bindings, registry)).toEqual([
      {
        kind: 'accelerator-mismatch',
        shortcutId: 'vault.save',
        detail: 'menu declares "CmdOrCtrl+Shift+S", renderer binds "CmdOrCtrl+S"',
      },
    ]);
  });

  it('reports a shortcut id the renderer does not have', () => {
    const bindings: readonly MenuShortcutBinding[] = [
      { shortcutId: 'vault.teleport', command: 'vault.save', accelerator: 'CmdOrCtrl+S' },
    ];

    expect(findShortcutDrift(bindings, registry).map((drift) => drift.kind)).toEqual([
      'unknown-shortcut',
    ]);
  });

  /**
   * The security-relevant disagreement.
   *
   * The catalogue's `needsUnlockedVault` and the registry's `whenLocked` are two spellings
   * of one fact. When they disagree the menu either offers something over a locked vault
   * that the renderer refuses to run, or — worse — the reverse.
   */
  it('reports a locked-state disagreement', () => {
    const bindings: readonly MenuShortcutBinding[] = [
      // `help.shortcuts` is lock-independent in the catalogue; this registry entry says
      // otherwise.
      { shortcutId: 'shortcuts.help', command: 'help.shortcuts', accelerator: 'CmdOrCtrl+/' },
    ];

    const locked: readonly RendererShortcut[] = [
      {
        id: 'shortcuts.help',
        combo: { key: '/', mod: true, shift: false, alt: false },
        whenLocked: false,
      },
    ];

    expect(findShortcutDrift(bindings, locked)).toEqual([
      {
        kind: 'locked-state-mismatch',
        shortcutId: 'shortcuts.help',
        detail: 'menu allows this while locked, renderer blocks it',
      },
    ]);
  });

  it('reports every disagreement rather than stopping at the first', () => {
    const bindings: readonly MenuShortcutBinding[] = [
      { shortcutId: 'vault.save', command: 'vault.save', accelerator: 'CmdOrCtrl+Shift+S' },
      { shortcutId: 'vault.teleport', command: 'vault.lock', accelerator: 'CmdOrCtrl+L' },
    ];

    expect(findShortcutDrift(bindings, registry).map((drift) => drift.kind)).toEqual([
      'accelerator-mismatch',
      'unknown-shortcut',
    ]);
  });

  it('says nothing when they agree', () => {
    const bindings: readonly MenuShortcutBinding[] = [
      { shortcutId: 'vault.save', command: 'vault.save', accelerator: 'CmdOrCtrl+S' },
      { shortcutId: 'shortcuts.help', command: 'help.shortcuts', accelerator: 'CmdOrCtrl+/' },
    ];

    expect(findShortcutDrift(bindings, registry)).toEqual([]);
  });
});

describe("the menu's own half of the comparison", () => {
  /**
   * The detector compares strings, so the menu's strings have to already be in the normal
   * form `acceleratorFromCombo` emits — `CmdOrCtrl+Alt+Shift+Key`, modifiers in that order,
   * a single upper-case character or a named key at the end. `Ctrl+S`, `Shift+CmdOrCtrl+S`
   * and `CmdOrCtrl+s` are all things Electron would happily accept and all things that would
   * report as drift against a renderer entry that is perfectly correct.
   */
  const NORMAL_FORM = /^(CmdOrCtrl\+)?(Alt\+)?(Shift\+)?([A-Z0-9,./;'[\]\\`=-]|[A-Z][A-Za-z0-9]+)$/;

  it('writes every accelerator in the form the comparison expects', () => {
    for (const binding of menuShortcutBindings()) {
      expect(binding.accelerator, `${binding.command} → ${binding.accelerator}`).toMatch(
        NORMAL_FORM
      );
    }
  });

  it('names each renderer shortcut at most once', () => {
    // Two menu items bound to one shortcut id is not automatically wrong, but two items
    // claiming *different* accelerators for it is, and the detector would report only the
    // second. Catching the duplicate here is what keeps that from being silent.
    const ids = menuShortcutBindings().map((binding) => binding.shortcutId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('actually has something to compare', () => {
    // A guard over an empty binding list passes forever. This fails the day the last
    // `shortcutId` is dropped from the command catalogue.
    expect(menuShortcutBindings().length).toBeGreaterThan(0);
  });
});
