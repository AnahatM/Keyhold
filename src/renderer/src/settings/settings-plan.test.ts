// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DEFAULT_KDF_PARAMS, MIN_KDF_PARAMS } from '@shared/format/types.js';
import { HEALTH_RULE_IDS } from '@shared/model/health.js';
import { DEFAULT_VAULT_SETTINGS } from '@shared/model/vault-document.js';
import {
  DEFAULT_CONFIGURABLE_VAULT_SETTINGS,
  DEFAULT_KDF_COST,
  DEFAULT_MACHINE_SETTINGS,
  KDF_PRESETS,
  KDF_PRESET_IDS,
  KDF_UI_FLOOR,
  SETTING_BOUNDS,
  SETTING_IDS,
  SETTING_SCOPE,
  clampKdfCost,
  clampMachineSettings,
  clampVaultSettings,
  isKdfCostBelowFloor,
  kdfPresetFor,
} from '@shared/model/settings-plan.js';

/**
 * The settings contract's guards.
 *
 * Lives beside the screen rather than beside `settings-plan.ts` because it is the screen
 * that depends on these properties holding, and because the shared model has no test file
 * of its own to extend. The tests here are the ones where a silent regression would be
 * expensive, per the testing policy — not coverage of the constants themselves.
 *
 * The load-bearing one is the KDF floor. Everything else on this screen can be got wrong
 * and produces an annoyance; getting that wrong produces a vault that is genuinely easier
 * to attack, written by the app itself, with no error anywhere.
 */

describe('the KDF floor', () => {
  it('cannot be gone below, however the value arrives', () => {
    // The three ways a weak cost could reach the gateway: a hand-edited stored value, a
    // preset someone lowered, and arithmetic that produced a nonsense number.
    const attempts = [
      { memoryKib: 1, iterations: 1, parallelism: 1 },
      {
        memoryKib: MIN_KDF_PARAMS.memoryKib,
        iterations: MIN_KDF_PARAMS.iterations,
        parallelism: 1,
      },
      { memoryKib: 0, iterations: 0, parallelism: 0 },
      { memoryKib: -65_536, iterations: -3, parallelism: -4 },
      { memoryKib: Number.NaN, iterations: Number.NaN, parallelism: Number.NaN },
    ];

    for (const attempt of attempts) {
      const clamped = clampKdfCost(attempt);
      expect(isKdfCostBelowFloor(clamped), JSON.stringify(attempt)).toBe(false);
      expect(clamped.memoryKib).toBeGreaterThanOrEqual(KDF_UI_FLOOR.memoryKib);
      expect(clamped.iterations).toBeGreaterThanOrEqual(KDF_UI_FLOOR.iterations);
      expect(clamped.parallelism).toBeGreaterThanOrEqual(KDF_UI_FLOOR.parallelism);
    }
  });

  it('is the shipped default, not the format minimum', () => {
    // These are deliberately different numbers: the format floor is what the reader will
    // ACCEPT from a file written elsewhere; this floor is what the app may CREATE. If they
    // were ever collapsed into one, the settings screen would be able to re-key a vault
    // weaker than `calibrateKdf` will produce, undoing a guard that already exists.
    expect(KDF_UI_FLOOR.memoryKib).toBe(DEFAULT_KDF_PARAMS.memoryKib);
    expect(KDF_UI_FLOOR.memoryKib).toBeGreaterThan(MIN_KDF_PARAMS.memoryKib);
    expect(KDF_UI_FLOOR.iterations).toBe(DEFAULT_KDF_PARAMS.iterations);
  });

  it('leaves a legitimate cost untouched', () => {
    expect(clampKdfCost(DEFAULT_KDF_COST)).toEqual(DEFAULT_KDF_COST);
    for (const id of KDF_PRESET_IDS) {
      expect(clampKdfCost(KDF_PRESETS[id]), id).toEqual(KDF_PRESETS[id]);
    }
  });

  it('offers no preset that is below it', () => {
    for (const id of KDF_PRESET_IDS) {
      expect(isKdfCostBelowFloor(KDF_PRESETS[id]), id).toBe(false);
    }
  });

  it('recognises a preset by its values, and refuses to guess otherwise', () => {
    expect(kdfPresetFor(KDF_PRESETS.stronger)).toBe('stronger');
    expect(kdfPresetFor({ memoryKib: 123_456, iterations: 3, parallelism: 4 })).toBeNull();
  });
});

describe('defaults', () => {
  it('round-trip through a reset unchanged', () => {
    // "Reset to defaults" restores exactly the defaults — which is only true if clamping a
    // default is a no-op. A bound that excluded its own default would quietly turn every
    // reset into a different value.
    expect(clampMachineSettings(DEFAULT_MACHINE_SETTINGS)).toEqual(DEFAULT_MACHINE_SETTINGS);
    expect(clampVaultSettings(DEFAULT_CONFIGURABLE_VAULT_SETTINGS)).toEqual(
      DEFAULT_CONFIGURABLE_VAULT_SETTINGS
    );
  });

  it('extend the vault defaults rather than restating them', () => {
    // The five original fields must keep exactly one declaration. If someone copies them
    // into `settings-plan.ts` instead of spreading them, this catches the divergence the
    // first time either side changes.
    for (const [key, value] of Object.entries(DEFAULT_VAULT_SETTINGS)) {
      expect(DEFAULT_CONFIGURABLE_VAULT_SETTINGS[key as keyof typeof DEFAULT_VAULT_SETTINGS]).toBe(
        value
      );
    }
  });

  it('enable every health rule', () => {
    // Decision D10: everything on, and the user turns off what they do not want. A rule
    // added in the off position would be a silently missing check.
    for (const rule of HEALTH_RULE_IDS) {
      expect(DEFAULT_CONFIGURABLE_VAULT_SETTINGS.health.enabledRules[rule], rule).toBe(true);
    }
  });

  it('leave the destructive option off', () => {
    expect(DEFAULT_MACHINE_SETTINGS.wipeAfterFailedAttempts).toBeNull();
  });
});

describe('bounds', () => {
  it('accept every default they govern', () => {
    const idle = DEFAULT_MACHINE_SETTINGS.autoLock.idleMinutes;
    expect(idle).not.toBeNull();
    if (idle !== null) {
      expect(idle).toBeGreaterThanOrEqual(SETTING_BOUNDS.idleMinutes.min);
      expect(idle).toBeLessThanOrEqual(SETTING_BOUNDS.idleMinutes.max);
    }

    const clipboard = DEFAULT_MACHINE_SETTINGS.clipboardClearMs;
    expect(clipboard).not.toBeNull();
    if (clipboard !== null) {
      expect(clipboard).toBeGreaterThanOrEqual(SETTING_BOUNDS.clipboardClearMs.min);
      expect(clipboard).toBeLessThanOrEqual(SETTING_BOUNDS.clipboardClearMs.max);
    }
  });

  it('refuse a wipe threshold that would fire on typos', () => {
    // Below three is a data-loss trap rather than a security setting — the main process
    // already refuses it, and the UI must not be able to offer what the store will rewrite.
    expect(SETTING_BOUNDS.wipeAfterFailedAttempts.min).toBe(3);
    const clamped = clampMachineSettings({
      ...DEFAULT_MACHINE_SETTINGS,
      wipeAfterFailedAttempts: 1,
    });
    expect(clamped.wipeAfterFailedAttempts).toBe(3);
  });

  it('keep "never" meaning never rather than clamping it to a number', () => {
    const clamped = clampMachineSettings({
      ...DEFAULT_MACHINE_SETTINGS,
      clipboardClearMs: null,
      autoLock: { ...DEFAULT_MACHINE_SETTINGS.autoLock, idleMinutes: null },
    });
    expect(clamped.clipboardClearMs).toBeNull();
    expect(clamped.autoLock.idleMinutes).toBeNull();
  });

  it('cap a value the store would otherwise rewrite', () => {
    // `coercePreferences` caps the clipboard timer at ten minutes. A control offering an
    // hour would appear to save and come back as ten minutes on the next read.
    const clamped = clampMachineSettings({
      ...DEFAULT_MACHINE_SETTINGS,
      clipboardClearMs: 60 * 60_000,
    });
    expect(clamped.clipboardClearMs).toBe(SETTING_BOUNDS.clipboardClearMs.max);
  });
});

describe('the setting registry', () => {
  it('gives every setting a scope', () => {
    for (const id of SETTING_IDS) {
      expect(SETTING_SCOPE[id], id).toMatch(/^(machine|vault)$/);
    }
  });

  it('puts the settings stored inside the file on the vault side', () => {
    // The distinction the whole screen turns on. Getting one of these wrong would tell a
    // user that something travelling inside their vault stays on their machine.
    expect(SETTING_SCOPE.auditPrivacyLevel).toBe('vault');
    expect(SETTING_SCOPE.historyMaxVersions).toBe('vault');
    expect(SETTING_SCOPE.trashRetentionDays).toBe('vault');
    expect(SETTING_SCOPE.passwordAgeWarningDays).toBe('vault');
    expect(SETTING_SCOPE.kdfCost).toBe('vault');

    expect(SETTING_SCOPE['autoLock.idleMinutes']).toBe('machine');
    expect(SETTING_SCOPE.clipboardClearMs).toBe('machine');
    expect(SETTING_SCOPE.quickUnlock).toBe('machine');
    expect(SETTING_SCOPE['secretReveal.maxRevealsPerWindow']).toBe('machine');
  });

  it('has no duplicate ids', () => {
    expect(new Set(SETTING_IDS).size).toBe(SETTING_IDS.length);
  });
});
