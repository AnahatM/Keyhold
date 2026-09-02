// SPDX-License-Identifier: GPL-3.0-or-later
import type { AuditPrivacyLevel, Credential } from './credential.js';
import {
  DEFAULT_HEALTH_RULE_TOGGLES,
  DEFAULT_HEALTH_THRESHOLDS,
  type HealthRuleId,
} from './health.js';

/**
 * The decrypted contents of a vault — what the KEEP container's body holds once
 * decompressed and parsed.
 *
 * The container treats the body as opaque bytes, deliberately: the format layer knows
 * about encryption and framing, and this layer knows about records. Keeping those apart
 * means the container can be tested exhaustively without a record model, and the record
 * model can change without touching a byte of the format.
 */

export const VAULT_DOCUMENT_VERSION = 1;

export interface Folder {
  readonly id: string;
  readonly name: string;
  /** `null` for a root folder. A record belongs to at most one folder. */
  readonly parentId: string | null;
  readonly order: number;
}

export interface Tag {
  readonly id: string;
  readonly name: string;
  /** A token name, never a raw colour — the theme decides what it looks like. */
  readonly colour: string;
}

/**
 * Vault-scoped settings, stored **inside** the encrypted body.
 *
 * These travel with the vault rather than living in app preferences, because they are
 * properties of the data: if you copy your vault to another machine, the history
 * retention policy and the audit privacy level should come with it. Machine-specific
 * preferences (window size, theme) live in app config instead.
 */
export interface VaultSettings {
  /** Default for new records. Each record can override it — the per-credential checkbox. */
  readonly historyEnabledByDefault: boolean;
  readonly historyMaxVersions: number | null;
  readonly auditPrivacyLevel: AuditPrivacyLevel;
  /** Days after which a password counts as "old" in the health dashboard. */
  readonly passwordAgeWarningDays: number;
  /** Days a trashed record is kept before permanent deletion. `null` disables purging. */
  readonly trashRetentionDays: number | null;
  /**
   * Which health rules run, and at what thresholds.
   *
   * Vault-scoped rather than machine-scoped, and deliberately: `passwordAgeWarningDays`
   * above is already one of these thresholds, and splitting the set across two scopes would
   * produce exactly the confusion the settings screen exists to remove. *How this vault is
   * judged* is a property of the data, not of the machine looking at it.
   */
  readonly health: VaultHealthSettings;
}

/**
 * Health configuration, stored with the vault.
 *
 * The rule ids come from `HEALTH_RULE_IDS`, so a rule added to the engine and not to this
 * record is a type error rather than a rule that silently cannot be switched off.
 */
export interface VaultHealthSettings {
  readonly enabledRules: Readonly<Record<HealthRuleId, boolean>>;
  readonly weakEntropyBits: number;
  readonly expiringWithinDays: number;
}

export const DEFAULT_VAULT_HEALTH_SETTINGS: VaultHealthSettings = {
  enabledRules: DEFAULT_HEALTH_RULE_TOGGLES,
  weakEntropyBits: DEFAULT_HEALTH_THRESHOLDS.weakEntropyBits,
  expiringWithinDays: DEFAULT_HEALTH_THRESHOLDS.expiringWithinDays,
};

export const DEFAULT_VAULT_SETTINGS: VaultSettings = {
  historyEnabledByDefault: true,
  historyMaxVersions: 50,
  auditPrivacyLevel: 'device',
  passwordAgeWarningDays: 365,
  trashRetentionDays: 30,
  health: DEFAULT_VAULT_HEALTH_SETTINGS,
};

export interface VaultDocument {
  readonly documentVersion: number;
  readonly records: readonly Credential[];
  readonly folders: readonly Folder[];
  readonly tags: readonly Tag[];
  readonly settings: VaultSettings;
}

export function emptyVaultDocument(
  settings: VaultSettings = DEFAULT_VAULT_SETTINGS
): VaultDocument {
  return {
    documentVersion: VAULT_DOCUMENT_VERSION,
    records: [],
    folders: [],
    tags: [],
    settings,
  };
}

/**
 * Vault-level facts the renderer may hold. No secrets, and no record contents.
 *
 * Deliberately includes `generation` and `modifiedAt`: the sync engine and the
 * external-change banner both need them, and neither reveals anything.
 */
export interface VaultSummary {
  readonly vaultId: string;
  readonly path: string;
  readonly displayName: string;
  readonly createdAt: number;
  readonly modifiedAt: number;
  readonly generation: number;
  readonly recordCount: number;
  readonly attachmentCount: number;
  readonly trashedCount: number;
  readonly folderCount: number;
  readonly tagCount: number;
  readonly settings: VaultSettings;
}

/** What is known about a vault file *before* it is unlocked. */
export interface VaultLockedInfo {
  readonly path: string;
  readonly vaultId: string;
  readonly createdAt: number;
  readonly modifiedAt: number;
  readonly generation: number;
  /** So the unlock screen can warn that this vault will take a while to open. */
  readonly kdfMemoryKib: number;
  readonly kdfIterations: number;
  /** An interrupted write was found next to it. Surfaced, never acted on automatically. */
  readonly hasOrphanedTemp: boolean;
}
