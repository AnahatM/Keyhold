// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DEFAULT_BREACH_CHECK_SETTINGS } from '../model/breach.js';
import { HEALTH_RULE_IDS } from '../model/health.js';
import { KDF_UI_CEILING, KDF_UI_FLOOR } from '../model/settings-plan.js';
import {
  requireKdfCost,
  requireMachineSettingsPatch,
  requireVaultSettingsPatch,
} from './settings-validation.js';
import { IpcValidationError } from './validation.js';

/**
 * Settings payloads, at the boundary where an untrusted object meets a stored preference.
 *
 * The renderer is semi-trusted (decision D13) and TypeScript is erased at runtime, so a
 * handler typed `(patch: Partial<VaultSettings>)` will happily receive anything at all. Three
 * properties are worth defending here, and one of them is the reason this file was written.
 *
 * ## The breach check is the only setting that hands the app a capability
 *
 * `requireBreachCheckPatch` refuses `requestIntervalMs` outright rather than bounding it. The
 * interval is how long the client waits between requests to a free, unauthenticated service
 * run at somebody else's expense; a renderer that could set it to zero would turn a privacy
 * feature into a small denial-of-service run **from the user's own address**, attributed to
 * them. That refusal had no test, which is the gap this closes.
 *
 * ## A patch is a patch
 *
 * Absent means "leave it alone". A screen sending one toggle must not reset the rest of
 * somebody's configuration to whatever its own defaults happened to be — the bug that looks
 * like the app forgetting your choices, and which reports itself nowhere.
 *
 * ## Refused, never clamped
 *
 * An out-of-range number throws. Clamping turns "the renderer sent nonsense" into "the
 * setting quietly became something you did not choose", and the second is worse precisely
 * because nothing tells you.
 *
 * ## Fault injection performed
 *
 * `requireBreachCheckPatch`'s two-line refusal replaced with a spread that took
 * `requestIntervalMs` from the payload whenever it was a number — the exact shape a
 * well-meaning "let the settings screen tune this" change would take. Four tests failed,
 * including the two that send a *plausible* value rather than a hostile one.
 */

const CHANNEL = 'kh:test:channel';

/** A health block, since `requireVaultSettingsPatch` demands a whole one or none at all. */
const HEALTH = {
  enabledRules: Object.fromEntries(HEALTH_RULE_IDS.map((rule) => [rule, true])),
  weakEntropyBits: 50,
  expiringWithinDays: 30,
};

describe('the breach check patch', () => {
  it('accepts the one field it is allowed to carry', () => {
    expect(requireVaultSettingsPatch(CHANNEL, { breachCheck: { enabled: true } })).toEqual({
      breachCheck: { ...DEFAULT_BREACH_CHECK_SETTINGS, enabled: true },
    });
  });

  it('takes the pacing from the defaults rather than from the payload', () => {
    const patch = requireVaultSettingsPatch(CHANNEL, { breachCheck: { enabled: true } });

    // Not merely "equal to the defaults" — this is the assertion that the numbers deciding
    // how hard Keyhold hits somebody else's server are decided in this process.
    expect(patch.breachCheck?.requestIntervalMs).toBe(
      DEFAULT_BREACH_CHECK_SETTINGS.requestIntervalMs
    );
    expect(patch.breachCheck?.requestTimeoutMs).toBe(
      DEFAULT_BREACH_CHECK_SETTINGS.requestTimeoutMs
    );
  });

  it('refuses a renderer-supplied request interval outright, rather than bounding it', () => {
    for (const requestIntervalMs of [0, -1, 1, 100, null, 'fast']) {
      expect(() =>
        requireVaultSettingsPatch(CHANNEL, { breachCheck: { enabled: true, requestIntervalMs } })
      ).toThrow(/request pacing is not settable/);
    }
  });

  it('refuses a renderer-supplied timeout the same way', () => {
    expect(() =>
      requireVaultSettingsPatch(CHANNEL, { breachCheck: { enabled: true, requestTimeoutMs: 1 } })
    ).toThrow(/request pacing is not settable/);
  });

  it('refuses the pacing even when it matches the default, so the rule has no exceptions', () => {
    // A validator that let a "harmless" value through would be one `===` away from letting
    // the harmful one through too, and the harmless case is what a probe sends first.
    expect(() =>
      requireVaultSettingsPatch(CHANNEL, {
        breachCheck: {
          enabled: false,
          requestIntervalMs: DEFAULT_BREACH_CHECK_SETTINGS.requestIntervalMs,
        },
      })
    ).toThrow(IpcValidationError);
  });

  it('refuses the pacing before it looks at anything else in the object', () => {
    // Order matters: a payload that is invalid twice over must not be able to choose which
    // complaint it gets, because the reachable one is the one an attacker tunes against.
    expect(() =>
      requireVaultSettingsPatch(CHANNEL, {
        breachCheck: { enabled: 'yes', requestIntervalMs: 0 },
      })
    ).toThrow(/request pacing is not settable/);
  });

  it('will not turn the check on with a truthy non-boolean', () => {
    for (const enabled of ['true', 1, {}, [], 'on']) {
      expect(() => requireVaultSettingsPatch(CHANNEL, { breachCheck: { enabled } })).toThrow(
        IpcValidationError
      );
    }
  });

  it('requires the field: an empty object cannot opt a vault in by omission', () => {
    expect(() => requireVaultSettingsPatch(CHANNEL, { breachCheck: {} })).toThrow(
      IpcValidationError
    );
  });

  it('rejects a non-object where the block belongs', () => {
    for (const breachCheck of [true, 1, 'enabled', [], null]) {
      expect(() => requireVaultSettingsPatch(CHANNEL, { breachCheck })).toThrow(IpcValidationError);
    }
  });

  it('leaves the block alone when the patch does not mention it', () => {
    const patch = requireVaultSettingsPatch(CHANNEL, { passwordAgeWarningDays: 90 });
    expect('breachCheck' in patch).toBe(false);
  });
});

describe('the vault settings patch', () => {
  it('carries only what was sent', () => {
    expect(requireVaultSettingsPatch(CHANNEL, { historyEnabledByDefault: false })).toEqual({
      historyEnabledByDefault: false,
    });
  });

  it('keeps null as a real value, distinct from a field being absent', () => {
    // `null` means "never purge" / "unlimited". Collapsing it onto `undefined` would silently
    // turn an explicit choice into no choice at all.
    const patch = requireVaultSettingsPatch(CHANNEL, {
      historyMaxVersions: null,
      trashRetentionDays: null,
    });
    expect(patch).toEqual({ historyMaxVersions: null, trashRetentionDays: null });
  });

  it('refuses an out-of-range number rather than clamping it', () => {
    expect(() => requireVaultSettingsPatch(CHANNEL, { passwordAgeWarningDays: 0 })).toThrow(
      /between/
    );
    expect(() => requireVaultSettingsPatch(CHANNEL, { trashRetentionDays: 2 ** 53 })).toThrow(
      /between/
    );
    expect(() => requireVaultSettingsPatch(CHANNEL, { historyMaxVersions: 1.5 })).toThrow(
      /whole number/
    );
  });

  it('refuses an audit privacy level it does not know, rather than defaulting one', () => {
    // This field decides what is recorded about the user's machine and network. A guess
    // records more than they asked for, and a field never captured is the only kind that
    // cannot leak.
    expect(() => requireVaultSettingsPatch(CHANNEL, { auditPrivacyLevel: 'everything' })).toThrow(
      /not a known level/
    );
  });

  it('builds the health rules from the registry, not from the payload keys', () => {
    const patch = requireVaultSettingsPatch(CHANNEL, {
      health: { ...HEALTH, enabledRules: { ...HEALTH.enabledRules, invented: true } },
    });

    // A rule the renderer invented does not arrive…
    expect(patch.health?.enabledRules).not.toHaveProperty('invented');
    expect(Object.keys(patch.health?.enabledRules ?? {}).sort()).toEqual(
      [...HEALTH_RULE_IDS].sort()
    );
  });

  it('refuses a health block that has dropped a rule, rather than assuming a default for it', () => {
    // …and one the renderer forgot cannot silently vanish either. A rule missing from the
    // payload would otherwise become `false`, quietly switching off a check the user had on.
    const { [HEALTH_RULE_IDS[0]]: _dropped, ...rest } = HEALTH.enabledRules;
    expect(() =>
      requireVaultSettingsPatch(CHANNEL, { health: { ...HEALTH, enabledRules: rest } })
    ).toThrow(IpcValidationError);
  });

  it('rejects a patch that is not an object at all', () => {
    for (const value of [undefined, null, 42, 'settings', []]) {
      expect(() => requireVaultSettingsPatch(CHANNEL, value)).toThrow(IpcValidationError);
    }
  });
});

describe('the machine settings patch', () => {
  it('will not turn the network on with a truthy string', () => {
    // The one setting where a renderer bug and an attack look identical from here. The
    // boundary refuses both without having to tell them apart.
    for (const networkAllowed of ['true', 1, 'yes', {}]) {
      expect(() => requireMachineSettingsPatch(CHANNEL, { networkAllowed })).toThrow(
        IpcValidationError
      );
    }
    expect(requireMachineSettingsPatch(CHANNEL, { networkAllowed: true })).toEqual({
      networkAllowed: true,
    });
  });

  it('refuses an auto-lock block that is missing a flag, rather than assuming one', () => {
    expect(() =>
      requireMachineSettingsPatch(CHANNEL, { autoLock: { idleMinutes: 5, lockOnSleep: true } })
    ).toThrow(IpcValidationError);
  });

  it('refuses an idle time that is long enough not to be a lock', () => {
    expect(() =>
      requireMachineSettingsPatch(CHANNEL, {
        autoLock: {
          idleMinutes: 2 ** 53,
          lockOnSleep: true,
          lockOnScreenLock: true,
          lockOnMinimise: false,
          lockOnBlur: false,
        },
      })
    ).toThrow(/between/);
  });

  it('refuses a clipboard timeout too short to paste from', () => {
    expect(() => requireMachineSettingsPatch(CHANNEL, { clipboardClearMs: 10 })).toThrow(/between/);
    expect(requireMachineSettingsPatch(CHANNEL, { clipboardClearMs: null })).toEqual({
      clipboardClearMs: null,
    });
  });

  it('refuses a wipe threshold a typo away from destroying a vault', () => {
    expect(() => requireMachineSettingsPatch(CHANNEL, { wipeAfterFailedAttempts: 1 })).toThrow(
      /between/
    );
  });
});

describe('the KDF cost a re-key may set', () => {
  const cost = { ...KDF_UI_FLOOR };

  it('accepts the floor and the ceiling', () => {
    expect(requireKdfCost(CHANNEL, { ...KDF_UI_FLOOR })).toEqual({ ...KDF_UI_FLOOR });
    expect(requireKdfCost(CHANNEL, { ...KDF_UI_CEILING })).toEqual({ ...KDF_UI_CEILING });
  });

  it('refuses anything below the floor, so the screen cannot downgrade a vault', () => {
    // The format's read floor is deliberately permissive so old vaults still open. What the
    // app may *create* is this, and a slider that stops at the floor is a courtesy the
    // boundary must not rely on.
    expect(() =>
      requireKdfCost(CHANNEL, { ...cost, memoryKib: KDF_UI_FLOOR.memoryKib - 1 })
    ).toThrow(/between/);
    expect(() =>
      requireKdfCost(CHANNEL, { ...cost, iterations: KDF_UI_FLOOR.iterations - 1 })
    ).toThrow(/between/);
  });

  it('refuses a cost that is not a whole number', () => {
    expect(() => requireKdfCost(CHANNEL, { ...cost, parallelism: 1.5 })).toThrow(/whole number/);
  });
});
