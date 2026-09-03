// SPDX-License-Identifier: GPL-3.0-or-later
import type { AuditPrivacyLevel, Credential } from './credential.js';
import { DEFAULT_ATTACHMENT_SETTINGS, type AttachmentSettings } from './attachment.js';
import { DEFAULT_BREACH_CHECK_SETTINGS, type BreachCheckSettings } from './breach.js';
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

import type { SavedSearch } from './saved-search.js';

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
  /**
   * Whether a merge writes a history version on each record it changed.
   *
   * **On**, and this is the default that matters. A merge is the one operation that rewrites
   * records the user did not individually touch, and it must not also be the one operation the
   * audit trail cannot see — the same argument that makes a restore versioned.
   *
   * It is a setting because a large first merge can put a version on hundreds of records at
   * once, and somebody who would rather their timeline not fill up that way should be able to
   * say so (hard rule 7). Turning it off loses the account of what the merge did; it does not
   * lose the merge, and the pre-merge backup is unaffected either way.
   */
  readonly historyRecordsMerges: boolean;
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
  /**
   * The attachment caps, travelling **inside the vault** rather than beside it.
   *
   * Deliberately vault-scoped, and it is the scope that carries the meaning. A cap decides
   * what this vault will accept, and the answer has to be the same on every machine that
   * opens it — a 25 MB file attached on a desktop and then unopenable on a laptop whose
   * local setting was 10 MB would be a file the user watched themselves save.
   *
   * The ceilings in `ATTACHMENT_CEILINGS` are **not** enforced here, on purpose. A setting
   * that travels can arrive from a build we have not written, an import, or a hand-edited
   * export, so it is checked where it is *used* — `resolveAttachmentLimits` — which is the
   * only place that catches all three.
   */
  readonly attachments: AttachmentSettings;
  /**
   * Whether this vault's passwords may be checked against Have I Been Pwned, and how.
   *
   * Vault-scoped, and off. It is a property of *this collection of passwords* rather than of
   * the machine looking at them — someone may want it on for their own vault and off for a
   * shared one, on the same computer, and a machine-scoped answer cannot express that.
   *
   * It is only ever half the decision. `NetworkPolicy` ANDs it with the machine-scoped
   * kill-switch, with the kill-switch dominant, because this setting travels inside the
   * `.keep` file: a vault carried to a friend's laptop must not be able to turn that
   * machine's network on. See `src/main/network-policy.ts`.
   */
  readonly breachCheck: BreachCheckSettings;
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
  historyRecordsMerges: true,
  auditPrivacyLevel: 'device',
  passwordAgeWarningDays: 365,
  trashRetentionDays: 30,
  health: DEFAULT_VAULT_HEALTH_SETTINGS,
  attachments: DEFAULT_ATTACHMENT_SETTINGS,
  breachCheck: DEFAULT_BREACH_CHECK_SETTINGS,
};

export interface VaultDocument {
  readonly documentVersion: number;
  readonly records: readonly Credential[];
  readonly folders: readonly Folder[];
  readonly tags: readonly Tag[];
  /**
   * Named queries, beside the folders and tags rather than inside `settings`.
   *
   * A saved search is something the user made and named, not a knob describing how the vault
   * behaves — see `saved-search.ts` for the whole argument. The practical difference is the
   * merge: entries here survive element-wise through `mergeCollection`, whereas anything in
   * `settings` goes through last-writer-wins, and losing a named query because the other
   * machine saved a second later is not a trade anyone would choose.
   */
  readonly savedSearches: readonly SavedSearch[];
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
    savedSearches: [],
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
  /**
   * How many records the header says it holds.
   *
   * Readable without the password, because the header is authenticated rather than encrypted.
   * It is what lets a conflicted copy be described — "41 items, saved after yours" — before
   * anyone commits to opening it.
   */
  readonly recordCount: number;
  /** So the unlock screen can warn that this vault will take a while to open. */
  readonly kdfMemoryKib: number;
  readonly kdfIterations: number;
  /** An interrupted write was found next to it. Surfaced, never acted on automatically. */
  readonly hasOrphanedTemp: boolean;
}
