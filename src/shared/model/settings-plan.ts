// SPDX-License-Identifier: GPL-3.0-or-later
import { DEFAULT_KDF_PARAMS, MAX_KDF_PARAMS, MIN_KDF_PARAMS } from '../format/types.js';
import {
  DEFAULT_VAULT_HEALTH_SETTINGS,
  DEFAULT_VAULT_SETTINGS,
  type VaultHealthSettings,
  type VaultSettings,
} from './vault-document.js';

/**
 * The settings contract — what is configurable, where each setting lives, what its bounds
 * are, and what the screen may ask the main process to do about it.
 *
 * **This file is types, defaults, bounds and pure clamps. No copy, no logic that touches a
 * key, no Node and no DOM** — it compiles into both bundles. The prose lives in
 * `src/renderer/src/settings/settings-copy.ts`, beside the components that render it, for
 * the same reason `health-presentation.ts` holds the health strings.
 *
 * ## The one distinction this whole file exists to make
 *
 * A setting is either **machine-scoped** or **vault-scoped**, and the difference is not
 * cosmetic:
 *
 * - **Machine** — `userData/preferences.json`. Stays on this computer. Carrying a vault to
 *   a friend's laptop must not import your idle timeout.
 * - **Vault** — inside the encrypted body. Travels with the file. Copy the vault to another
 *   machine, or hand it to someone, and the audit privacy level goes with it.
 *
 * A user who cannot tell which is which will be surprised by a security setting, and being
 * surprised by a security setting is the entire problem. `SETTING_SCOPE` below is the
 * single source the UI reads to label every control, so a new setting cannot be added
 * without answering the question.
 *
 * ## Where this contract is ahead of the implementation
 *
 * Phase 14 has no IPC surface yet. Three shapes here are deliberately declared as the
 * canonical version of something that currently also exists in the main process, so that
 * folding them together is a one-line import change rather than a rewrite:
 *
 * - `AutoLockSettings` / `DEFAULT_AUTO_LOCK` — today in `src/main/session/auto-lock.ts`.
 * - `SecretRevealLimits` — today the `DEFAULT_*` constants in
 *   `src/main/vault/secret-broker.ts`.
 * - `HealthSettings` — today only per-call options on `health.analyse`, persisted nowhere.
 *
 * `ConfigurableVaultSettings` extends `VaultSettings` rather than restating its five
 * fields, so the existing list stays the only list.
 */

// ── Scope ────────────────────────────────────────────────────────────────────

export const SETTINGS_SCOPES = ['machine', 'vault'] as const;
export type SettingsScope = (typeof SETTINGS_SCOPES)[number];

// ── Machine-scoped ───────────────────────────────────────────────────────────

/**
 * When the vault locks itself.
 *
 * Structurally identical to `AutoLockSettings` in `src/main/session/auto-lock.ts`, which
 * should import this once Phase 14's IPC lands — see the file header.
 */
export interface AutoLockSettings {
  /** Minutes of system-wide idleness before locking. `null` disables the idle trigger. */
  readonly idleMinutes: number | null;
  readonly lockOnSleep: boolean;
  readonly lockOnScreenLock: boolean;
  /** Off by default: minimising to check something else is not walking away. */
  readonly lockOnMinimise: boolean;
  readonly lockOnBlur: boolean;
}

export const DEFAULT_AUTO_LOCK: AutoLockSettings = {
  idleMinutes: 10,
  lockOnSleep: true,
  lockOnScreenLock: true,
  lockOnMinimise: false,
  lockOnBlur: false,
};

/**
 * The ceiling on on-demand secret reveals.
 *
 * Not a defence against a fully compromised renderer — it can wait out any window. It is a
 * tripwire for a bug or a hostile dependency looping over every record to harvest the
 * vault. Raising it is therefore a real trade, and the UI says so.
 */
export interface SecretRevealLimits {
  /** How long a revealed secret stays granted, whether or not the renderer used it. */
  readonly grantTtlMs: number;
  readonly maxRevealsPerWindow: number;
  /** Read-only in the UI: the window the count is measured over. */
  readonly windowMs: number;
}

export const DEFAULT_SECRET_REVEAL_LIMITS: SecretRevealLimits = {
  grantTtlMs: 30_000,
  maxRevealsPerWindow: 60,
  windowMs: 60_000,
};

/** Everything this screen edits that stays on this computer. */
export interface MachineSettings {
  readonly autoLock: AutoLockSettings;
  /** Milliseconds before a copied secret is cleared. `null` disables the timer. */
  readonly clipboardClearMs: number | null;
  /** Erase the vault after N consecutive failed unlocks. `null` — the default — is never. */
  readonly wipeAfterFailedAttempts: number | null;
  readonly secretReveal: SecretRevealLimits;
  /**
   * The global network kill-switch. **Off by default, and machine-scoped.**
   *
   * Hard rule 5's second switch. The per-vault breach toggle answers *should this vault use
   * the service*; this answers *may this installation talk to the network at all*, which is
   * a question someone on an air-gapped or corporate machine needs answered once rather than
   * per vault and per feature.
   *
   * Machine-scoped is the load-bearing half: vault settings travel inside the `.keep` file,
   * so a vault carried to a friend's laptop must not be able to turn that machine's network
   * on. The two are ANDed with this one dominant — see `src/main/network-policy.ts`, which
   * is the only thing that reads the stored value.
   *
   * The renderer receives it to *display*, never to decide on. Turning it on is the
   * dangerous direction and is the one that gets a confirmation; turning it off is
   * immediate.
   */
  readonly networkAllowed: boolean;
}

export const DEFAULT_MACHINE_SETTINGS: MachineSettings = {
  autoLock: DEFAULT_AUTO_LOCK,
  clipboardClearMs: 30_000,
  wipeAfterFailedAttempts: null,
  secretReveal: DEFAULT_SECRET_REVEAL_LIMITS,
  networkAllowed: false,
};

// ── Vault-scoped ─────────────────────────────────────────────────────────────

/**
 * Which health rules run, and at what thresholds.
 *
 * Vault-scoped, deliberately. One of the three thresholds — `passwordAgeWarningDays` —
 * already lives in `VaultSettings`, and splitting three thresholds across two scopes would
 * produce exactly the confusion this screen exists to remove. "How this vault is judged"
 * is a property of the data, not of the machine looking at it.
 */
export type HealthSettings = VaultHealthSettings;

export const DEFAULT_HEALTH_SETTINGS: HealthSettings = DEFAULT_VAULT_HEALTH_SETTINGS;

/**
 * `VaultSettings` plus the health configuration Phase 14 adds to it.
 *
 * An extension rather than a copy: the five existing fields keep exactly one declaration,
 * in `vault-document.ts`, and folding `health` into that interface later removes this type
 * without touching a single consumer.
 */
/**
 * The vault-scoped settings this screen edits.
 *
 * Now exactly `VaultSettings`: `health` used to be declared here as an addition, which made
 * two shapes for one thing and meant a rule added to the engine could be configurable in the
 * screen's type and absent from the file it is stored in. It lives in the model.
 */
export type ConfigurableVaultSettings = VaultSettings;

export const DEFAULT_CONFIGURABLE_VAULT_SETTINGS: ConfigurableVaultSettings =
  DEFAULT_VAULT_SETTINGS;

// ── The registry ─────────────────────────────────────────────────────────────

/**
 * Every individually addressable setting on this screen.
 *
 * The point of the list is `SETTING_SCOPE` and the copy `Record`s keyed off it: a new
 * setting with no scope, no label or no help text is a **compile error**, not a control
 * that quietly ships without saying where it lives.
 *
 * Per-rule health toggles are not listed here — they are generated from `HEALTH_RULE_IDS`,
 * so a new rule cannot be silently unconfigurable either.
 */
export const SETTING_IDS = [
  'autoLock.idleMinutes',
  'autoLock.lockOnSleep',
  'autoLock.lockOnScreenLock',
  'autoLock.lockOnMinimise',
  'autoLock.lockOnBlur',
  'clipboardClearMs',
  'wipeAfterFailedAttempts',
  'secretReveal.maxRevealsPerWindow',
  'secretReveal.grantTtlMs',
  'quickUnlock',
  'networkAllowed',
  'breachCheck.enabled',
  'historyEnabledByDefault',
  'historyMaxVersions',
  'auditPrivacyLevel',
  'health.rules',
  'health.weakEntropyBits',
  'health.expiringWithinDays',
  'passwordAgeWarningDays',
  'trashRetentionDays',
  'kdfCost',
] as const;

export type SettingId = (typeof SETTING_IDS)[number];

/** Where each setting is stored, and therefore whether it follows the file to another device. */
export const SETTING_SCOPE: Readonly<Record<SettingId, SettingsScope>> = {
  'autoLock.idleMinutes': 'machine',
  'autoLock.lockOnSleep': 'machine',
  'autoLock.lockOnScreenLock': 'machine',
  'autoLock.lockOnMinimise': 'machine',
  'autoLock.lockOnBlur': 'machine',
  clipboardClearMs: 'machine',
  wipeAfterFailedAttempts: 'machine',
  'secretReveal.maxRevealsPerWindow': 'machine',
  'secretReveal.grantTtlMs': 'machine',
  quickUnlock: 'machine',
  // Machine-scoped, and the scope is the security property rather than an implementation
  // detail. A vault carried to a friend's laptop must not be able to turn that machine's
  // network on — see `src/main/network-policy.ts`.
  networkAllowed: 'machine',
  // Vault-scoped, unlike the kill-switch above it, and the split is the point: the machine
  // decides whether *anything* may reach the network, and each vault decides for itself
  // whether its own passwords are checked. A vault copied to a machine with the switch down
  // stays unchecked there, and a vault that never opted in stays unchecked everywhere.
  'breachCheck.enabled': 'vault',
  historyEnabledByDefault: 'vault',
  historyMaxVersions: 'vault',
  auditPrivacyLevel: 'vault',
  'health.rules': 'vault',
  'health.weakEntropyBits': 'vault',
  'health.expiringWithinDays': 'vault',
  passwordAgeWarningDays: 'vault',
  trashRetentionDays: 'vault',
  // The KDF parameters live in the vault's plaintext header, so they travel with the file
  // exactly as the encrypted settings do. Presented as vault-scoped for that reason.
  kdfCost: 'vault',
};

// ── Bounds ───────────────────────────────────────────────────────────────────

export interface NumericBound {
  readonly min: number;
  readonly max: number;
}

/**
 * The accepted range for every numeric setting.
 *
 * These match the coercion already performed in the main process — `coercePreferences`
 * caps the clipboard timer at ten minutes and refuses a wipe threshold below three — so
 * that a value the UI offers is never one the store will silently rewrite. A control whose
 * chosen value comes back different is worse than a control that would not offer it.
 */
export const SETTING_BOUNDS = {
  idleMinutes: { min: 1, max: 1_440 },
  clipboardClearMs: { min: 5_000, max: 600_000 },
  // Below three fires on ordinary typos, which is a data-loss trap rather than a setting.
  wipeAfterFailedAttempts: { min: 3, max: 100 },
  grantTtlMs: { min: 5_000, max: 300_000 },
  maxRevealsPerWindow: { min: 5, max: 500 },
  historyMaxVersions: { min: 1, max: 1_000 },
  passwordAgeWarningDays: { min: 30, max: 3_650 },
  trashRetentionDays: { min: 1, max: 3_650 },
  weakEntropyBits: { min: 30, max: 120 },
  expiringWithinDays: { min: 1, max: 365 },
} as const satisfies Readonly<Record<string, NumericBound>>;

/** Clamps to a bound, rounding to an integer. `null` (meaning "never") passes through. */
export function clampOptional(value: number | null, bound: NumericBound): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) return null;
  return Math.min(bound.max, Math.max(bound.min, Math.round(value)));
}

/** Clamps to a bound where the setting cannot be switched off. */
export function clampRequired(value: number, bound: NumericBound, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(bound.max, Math.max(bound.min, Math.round(value)));
}

// ── KDF cost ─────────────────────────────────────────────────────────────────

export interface KdfCost {
  readonly memoryKib: number;
  readonly iterations: number;
  readonly parallelism: number;
}

export const DEFAULT_KDF_COST: KdfCost = {
  memoryKib: DEFAULT_KDF_PARAMS.memoryKib,
  iterations: DEFAULT_KDF_PARAMS.iterations,
  parallelism: DEFAULT_KDF_PARAMS.parallelism,
};

/**
 * The floor this screen may not go below — **the shipped default, not the format floor**.
 *
 * They are different numbers on purpose, and conflating them would be the bug:
 *
 * - `MIN_KDF_PARAMS` (19 MiB, t=2) is what the reader will *accept from a file*. It has to
 *   be permissive enough to open a vault written by an older or third-party tool, and its
 *   job is only to refuse a downgraded header that would make an existing vault trivially
 *   crackable.
 * - This floor is what the app may *create*. Re-keying a vault below the shipped default
 *   would let the settings screen manufacture a weaker vault than `calibrateKdf` will ever
 *   produce — and that function already refuses to calibrate below the default, for
 *   exactly this reason. A settings screen that can undo a guard is not a setting, it is a
 *   hole.
 *
 * `parallelism` is the one exception: it is floored at the format minimum, because lanes
 * trade against available cores rather than against memory hardness, and a single-core
 * machine legitimately wants 1.
 */
export const KDF_UI_FLOOR: KdfCost = {
  memoryKib: DEFAULT_KDF_PARAMS.memoryKib,
  iterations: DEFAULT_KDF_PARAMS.iterations,
  parallelism: MIN_KDF_PARAMS.parallelism,
};

export const KDF_UI_CEILING: KdfCost = {
  memoryKib: MAX_KDF_PARAMS.memoryKib,
  iterations: MAX_KDF_PARAMS.iterations,
  parallelism: MAX_KDF_PARAMS.parallelism,
};

/** True when a cost would produce a vault weaker than the one the app ships by default. */
export function isKdfCostBelowFloor(cost: KdfCost): boolean {
  return (
    cost.memoryKib < KDF_UI_FLOOR.memoryKib ||
    cost.iterations < KDF_UI_FLOOR.iterations ||
    cost.parallelism < KDF_UI_FLOOR.parallelism
  );
}

/**
 * Forces a cost into the permitted range.
 *
 * Every path that sends a KDF cost anywhere goes through this, so "the UI cannot create a
 * weak vault" is one function with one test rather than a rule each control has to honour.
 */
export function clampKdfCost(cost: KdfCost): KdfCost {
  const clamp = (value: number, min: number, max: number, fallback: number): number =>
    Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

  return {
    memoryKib: clamp(
      cost.memoryKib,
      KDF_UI_FLOOR.memoryKib,
      KDF_UI_CEILING.memoryKib,
      DEFAULT_KDF_COST.memoryKib
    ),
    iterations: clamp(
      cost.iterations,
      KDF_UI_FLOOR.iterations,
      KDF_UI_CEILING.iterations,
      DEFAULT_KDF_COST.iterations
    ),
    parallelism: clamp(
      cost.parallelism,
      KDF_UI_FLOOR.parallelism,
      KDF_UI_CEILING.parallelism,
      DEFAULT_KDF_COST.parallelism
    ),
  };
}

/** Offered costs, ordered weakest-permitted first. Names and notes are renderer copy. */
export const KDF_PRESET_IDS = ['default', 'stronger', 'strongest'] as const;
export type KdfPresetId = (typeof KDF_PRESET_IDS)[number];

export const KDF_PRESETS: Readonly<Record<KdfPresetId, KdfCost>> = {
  default: DEFAULT_KDF_COST,
  stronger: { memoryKib: 262_144, iterations: 3, parallelism: 4 },
  strongest: { memoryKib: 1_048_576, iterations: 4, parallelism: 4 },
};

export function kdfPresetFor(cost: KdfCost): KdfPresetId | null {
  for (const id of KDF_PRESET_IDS) {
    const preset = KDF_PRESETS[id];
    if (
      preset.memoryKib === cost.memoryKib &&
      preset.iterations === cost.iterations &&
      preset.parallelism === cost.parallelism
    ) {
      return id;
    }
  }
  return null;
}

// ── Clamping whole objects ───────────────────────────────────────────────────

export function clampMachineSettings(settings: MachineSettings): MachineSettings {
  return {
    autoLock: {
      ...settings.autoLock,
      idleMinutes: clampOptional(settings.autoLock.idleMinutes, SETTING_BOUNDS.idleMinutes),
    },
    clipboardClearMs: clampOptional(settings.clipboardClearMs, SETTING_BOUNDS.clipboardClearMs),
    wipeAfterFailedAttempts: clampOptional(
      settings.wipeAfterFailedAttempts,
      SETTING_BOUNDS.wipeAfterFailedAttempts
    ),
    secretReveal: {
      windowMs: settings.secretReveal.windowMs,
      grantTtlMs: clampRequired(
        settings.secretReveal.grantTtlMs,
        SETTING_BOUNDS.grantTtlMs,
        DEFAULT_SECRET_REVEAL_LIMITS.grantTtlMs
      ),
      maxRevealsPerWindow: clampRequired(
        settings.secretReveal.maxRevealsPerWindow,
        SETTING_BOUNDS.maxRevealsPerWindow,
        DEFAULT_SECRET_REVEAL_LIMITS.maxRevealsPerWindow
      ),
    },
    // Not clamped, because it is a boolean and there is nothing to clamp — carried through
    // explicitly rather than spread, so adding a machine setting is a compile error here
    // rather than a value that silently stops surviving a clamp.
    networkAllowed: settings.networkAllowed,
  };
}

export function clampVaultSettings(settings: ConfigurableVaultSettings): ConfigurableVaultSettings {
  return {
    ...settings,
    historyMaxVersions: clampOptional(
      settings.historyMaxVersions,
      SETTING_BOUNDS.historyMaxVersions
    ),
    passwordAgeWarningDays: clampRequired(
      settings.passwordAgeWarningDays,
      SETTING_BOUNDS.passwordAgeWarningDays,
      DEFAULT_VAULT_SETTINGS.passwordAgeWarningDays
    ),
    trashRetentionDays: clampOptional(
      settings.trashRetentionDays,
      SETTING_BOUNDS.trashRetentionDays
    ),
    health: {
      enabledRules: settings.health.enabledRules,
      weakEntropyBits: clampRequired(
        settings.health.weakEntropyBits,
        SETTING_BOUNDS.weakEntropyBits,
        DEFAULT_HEALTH_SETTINGS.weakEntropyBits
      ),
      expiringWithinDays: clampRequired(
        settings.health.expiringWithinDays,
        SETTING_BOUNDS.expiringWithinDays,
        DEFAULT_HEALTH_SETTINGS.expiringWithinDays
      ),
    },
  };
}

// ── What the screen may ask the main process to do ───────────────────────────

export interface QuickUnlockSummary {
  readonly available: boolean;
  readonly enrolled: boolean;
  readonly promptsForBiometrics: boolean;
  /**
   * Written by the main process and rendered verbatim. Never restated in the UI: Touch ID
   * is a biometric gate and Windows DPAPI is not, and hardcoding "biometric" is precisely
   * how that distinction gets lost. See `src/main/session/quick-unlock.ts`.
   */
  readonly description: string;
}

/** Everything the screen renders, in one read. Contains no secret material. */
export interface SettingsSnapshot {
  readonly machine: MachineSettings;
  /** `null` when no vault is open — the machine half of the screen still works. */
  readonly vault: ConfigurableVaultSettings | null;
  readonly vaultPath: string | null;
  readonly vaultDisplayName: string | null;
  readonly kdf: KdfCost | null;
  readonly quickUnlock: QuickUnlockSummary;
  /** Total stored versions across every record, so "clear all history" can say the cost. */
  readonly historyVersionCount: number;
}

/**
 * The seam between the settings screen and the main process.
 *
 * An interface rather than direct `window.keyhold` calls so the screen can be driven by an
 * in-memory fake in tests — and, today, so it can be written at all: none of the channels
 * it needs exist yet. `createBridgeGateway` implements what the bridge already offers and
 * fails loudly for the rest, which keeps the missing surface visible instead of stubbed.
 *
 * **Nothing here returns secret material.** The two methods that take a master password
 * take it as an argument for the duration of one call and must never store, echo or log
 * it — hence the `Secret` suffix, the convention that marks where secrets flow.
 */
export interface SettingsGateway {
  read: () => Promise<SettingsSnapshot>;
  updateMachine: (patch: Partial<MachineSettings>) => Promise<SettingsSnapshot>;
  /** Rejected when no vault is open — there is nothing to write the settings into. */
  updateVault: (patch: Partial<ConfigurableVaultSettings>) => Promise<SettingsSnapshot>;
  /** The network name that would be recorded right now. `null` is a normal answer. */
  networkName: () => Promise<string | null>;
  changeMasterPassword: (currentSecret: string, nextSecret: string) => Promise<void>;
  /** Re-derives the KEK at a new cost. Needs the master password; invalidates quick unlock. */
  rekey: (currentSecret: string, cost: KdfCost) => Promise<SettingsSnapshot>;
  /** Returns how many versions were removed, so the confirmation can be specific. */
  clearAllHistory: () => Promise<number>;
  /**
   * Enrols or revokes quick unlock for the open vault.
   *
   * One method rather than two, because the two directions must never drift apart:
   * revoking deletes the only wrapping of the data key under the OS key store, and
   * enrolling creates it. A screen that could get into a state where it thought it had
   * revoked and had not would be claiming a protection that is not there.
   */
  setQuickUnlock: (enabled: boolean) => Promise<SettingsSnapshot>;
}
