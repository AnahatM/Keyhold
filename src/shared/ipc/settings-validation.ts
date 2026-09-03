// SPDX-License-Identifier: GPL-3.0-or-later
import { HEALTH_RULE_IDS, type HealthRuleId } from '../model/health.js';
import { AUDIT_PRIVACY_LEVELS, type AuditPrivacyLevel } from '../model/credential.js';
import type { KdfCost, MachineSettings } from '../model/settings-plan.js';
import { KDF_UI_CEILING, KDF_UI_FLOOR } from '../model/settings-plan.js';
import type { VaultHealthSettings, VaultSettings } from '../model/vault-document.js';
import { IpcValidationError, requireBoolean } from './validation.js';

/**
 * Runtime validation for settings payloads.
 *
 * Two properties this file exists to guarantee, and both are about the same failure.
 *
 * **A patch is a patch.** Every field is optional and absent means "leave it alone", so a
 * screen sending one toggle cannot reset the rest of a user's configuration to whatever its
 * own defaults happened to be. That is the bug that looks like the app forgetting your
 * choices, and it is silent.
 *
 * **A setting may not be weakened by a malformed payload.** Every number is bounded here as
 * well as in the UI, because the UI is the semi-trusted half: a renderer replaying
 * `kh:settings:update-machine` with `autoLock: { idleMs: 2 ** 53 }` must be refused, not
 * clamped quietly to something that looks disabled but is not.
 */

/** Bounds live here because this is where an untrusted payload meets them. */
const BOUNDS = {
  /** One minute to twelve hours. Below a minute is unusable; above half a day is not a lock. */
  autoLockIdleMinutes: { min: 1, max: 720 },
  /** Five seconds to ten minutes. A clipboard that clears instantly cannot be pasted. */
  clipboardClearMs: { min: 5_000, max: 600_000 },
  /** Three to fifty. Below three is a typo away from destroying a vault. */
  wipeAfterFailedAttempts: { min: 3, max: 50 },
  historyMaxVersions: { min: 1, max: 1_000 },
  passwordAgeWarningDays: { min: 1, max: 3_650 },
  trashRetentionDays: { min: 1, max: 3_650 },
  weakEntropyBits: { min: 20, max: 128 },
  expiringWithinDays: { min: 1, max: 365 },
} as const;

interface Bound {
  readonly min: number;
  readonly max: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireBounded(channel: string, value: unknown, name: string, bound: Bound): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new IpcValidationError(channel, `${name} must be a whole number`);
  }
  if (value < bound.min || value > bound.max) {
    // Refused rather than clamped. A clamp turns "the renderer sent nonsense" into "the
    // setting quietly became something the user did not choose", and the second is worse
    // precisely because nothing reports it.
    throw new IpcValidationError(
      channel,
      `${name} must be between ${String(bound.min)} and ${String(bound.max)}`
    );
  }
  return value;
}

function requireNullableBounded(
  channel: string,
  value: unknown,
  name: string,
  bound: Bound
): number | null {
  // `null` is a real setting — never auto-lock, never purge trash, unlimited history — and is
  // meaningfully different from a number. `undefined` means the patch did not mention it.
  return value === null ? null : requireBounded(channel, value, name, bound);
}

export function requireMachineSettingsPatch(
  channel: string,
  value: unknown
): Partial<MachineSettings> {
  if (!isObject(value)) throw new IpcValidationError(channel, 'the patch must be an object');

  const patch: {
    autoLock?: MachineSettings['autoLock'];
    clipboardClearMs?: number | null;
    wipeAfterFailedAttempts?: number | null;
    networkAllowed?: boolean;
  } = {};

  if (value.networkAllowed !== undefined) {
    // `requireBoolean`, so a truthy string cannot turn the network on. This is the one
    // setting where a renderer bug and an attack look identical from here, and the boundary
    // should not have to tell them apart to refuse both.
    patch.networkAllowed = requireBoolean(channel, value.networkAllowed, 'networkAllowed');
  }

  if (value.autoLock !== undefined) {
    if (!isObject(value.autoLock)) {
      throw new IpcValidationError(channel, 'autoLock must be an object');
    }
    const source = value.autoLock;
    patch.autoLock = {
      idleMinutes: requireNullableBounded(
        channel,
        source.idleMinutes,
        'autoLock.idleMinutes',
        BOUNDS.autoLockIdleMinutes
      ),
      lockOnSleep: requireBoolean(channel, source.lockOnSleep, 'autoLock.lockOnSleep'),
      lockOnScreenLock: requireBoolean(
        channel,
        source.lockOnScreenLock,
        'autoLock.lockOnScreenLock'
      ),
      lockOnMinimise: requireBoolean(channel, source.lockOnMinimise, 'autoLock.lockOnMinimise'),
      lockOnBlur: requireBoolean(channel, source.lockOnBlur, 'autoLock.lockOnBlur'),
    };
  }

  if (value.clipboardClearMs !== undefined) {
    patch.clipboardClearMs = requireNullableBounded(
      channel,
      value.clipboardClearMs,
      'clipboardClearMs',
      BOUNDS.clipboardClearMs
    );
  }

  if (value.wipeAfterFailedAttempts !== undefined) {
    patch.wipeAfterFailedAttempts = requireNullableBounded(
      channel,
      value.wipeAfterFailedAttempts,
      'wipeAfterFailedAttempts',
      BOUNDS.wipeAfterFailedAttempts
    );
  }

  return patch;
}

function requireHealthPatch(channel: string, value: unknown): VaultHealthSettings {
  if (!isObject(value)) throw new IpcValidationError(channel, 'health must be an object');
  if (!isObject(value.enabledRules)) {
    throw new IpcValidationError(channel, 'health.enabledRules must be an object');
  }

  const rules = value.enabledRules;
  // Built from `HEALTH_RULE_IDS` rather than from the payload's own keys, so a rule the
  // renderer forgot cannot silently vanish and one it invented cannot silently arrive.
  const enabledRules = Object.fromEntries(
    HEALTH_RULE_IDS.map((rule) => [
      rule,
      requireBoolean(channel, rules[rule], `health.enabledRules.${rule}`),
    ])
  ) as Record<HealthRuleId, boolean>;

  return {
    enabledRules,
    weakEntropyBits: requireBounded(
      channel,
      value.weakEntropyBits,
      'health.weakEntropyBits',
      BOUNDS.weakEntropyBits
    ),
    expiringWithinDays: requireBounded(
      channel,
      value.expiringWithinDays,
      'health.expiringWithinDays',
      BOUNDS.expiringWithinDays
    ),
  };
}

export function requireVaultSettingsPatch(channel: string, value: unknown): Partial<VaultSettings> {
  if (!isObject(value)) throw new IpcValidationError(channel, 'the patch must be an object');

  const patch: {
    historyEnabledByDefault?: boolean;
    historyMaxVersions?: number | null;
    auditPrivacyLevel?: AuditPrivacyLevel;
    passwordAgeWarningDays?: number;
    trashRetentionDays?: number | null;
    health?: VaultHealthSettings;
  } = {};

  if (value.historyEnabledByDefault !== undefined) {
    patch.historyEnabledByDefault = requireBoolean(
      channel,
      value.historyEnabledByDefault,
      'historyEnabledByDefault'
    );
  }
  if (value.historyMaxVersions !== undefined) {
    patch.historyMaxVersions = requireNullableBounded(
      channel,
      value.historyMaxVersions,
      'historyMaxVersions',
      BOUNDS.historyMaxVersions
    );
  }
  if (value.auditPrivacyLevel !== undefined) {
    const level = value.auditPrivacyLevel;
    if (typeof level !== 'string' || !(AUDIT_PRIVACY_LEVELS as readonly string[]).includes(level)) {
      // Rejected, not defaulted. This field decides what is written into the file about the
      // user's machine and network; guessing it wrong records more than they asked for, and
      // a field that was never captured is the only kind that cannot leak.
      throw new IpcValidationError(channel, 'auditPrivacyLevel is not a known level');
    }
    patch.auditPrivacyLevel = level as AuditPrivacyLevel;
  }
  if (value.passwordAgeWarningDays !== undefined) {
    patch.passwordAgeWarningDays = requireBounded(
      channel,
      value.passwordAgeWarningDays,
      'passwordAgeWarningDays',
      BOUNDS.passwordAgeWarningDays
    );
  }
  if (value.trashRetentionDays !== undefined) {
    patch.trashRetentionDays = requireNullableBounded(
      channel,
      value.trashRetentionDays,
      'trashRetentionDays',
      BOUNDS.trashRetentionDays
    );
  }
  if (value.health !== undefined) {
    patch.health = requireHealthPatch(channel, value.health);
  }

  return patch;
}

/**
 * The Argon2 cost a re-key may set.
 *
 * Bounded against `KDF_UI_FLOOR` and `KDF_UI_CEILING` rather than against the format's
 * `MIN_KDF_PARAMS`, and the difference is the whole reason this function exists. The format
 * floor is what the reader will *accept from a file* and is deliberately permissive, so a
 * vault written by an older build still opens. This is what the app may *create*, and it
 * may not create something weaker than what it ships by default — otherwise the settings
 * screen becomes a supported way to downgrade a vault below what `calibrateKdf` will ever
 * produce, which is a hole wearing a slider.
 *
 * The bound is enforced here, in the payload validator, and not only in the screen. The
 * renderer is the semi-trusted half: a slider that stops at the floor is a courtesy, and
 * an `invoke` that ignores it must still be refused.
 */
export function requireKdfCost(channel: string, value: unknown): KdfCost {
  if (!isObject(value)) {
    throw new IpcValidationError(channel, 'cost must be an object');
  }

  return {
    memoryKib: requireBounded(channel, value.memoryKib, 'memoryKib', {
      min: KDF_UI_FLOOR.memoryKib,
      max: KDF_UI_CEILING.memoryKib,
    }),
    iterations: requireBounded(channel, value.iterations, 'iterations', {
      min: KDF_UI_FLOOR.iterations,
      max: KDF_UI_CEILING.iterations,
    }),
    parallelism: requireBounded(channel, value.parallelism, 'parallelism', {
      min: KDF_UI_FLOOR.parallelism,
      max: KDF_UI_CEILING.parallelism,
    }),
  };
}
