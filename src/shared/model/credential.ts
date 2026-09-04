// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The credential record model, and — the important part — the declaration of which parts
 * of it are **secret material**.
 *
 * This file lives in `@shared` because both processes need the shapes: the main process
 * to store them, the renderer to render them. It contains types and pure predicates only.
 *
 * ## The secret boundary is declared exactly once, here
 *
 * Decision D13 says the renderer never holds secret material. That rule is only as good as
 * the definition of "secret", and a definition that exists in two places will disagree
 * within a month. So there is one definition, in this file, and everything else derives
 * from it:
 *
 *   - the projection builder (`src/main/vault/projection.ts`) reads it to decide what to strip
 *   - the property test reads it to decide what to hunt for
 *   - the secret broker reads it to decide what may be fetched on demand
 *
 * Adding a field to the record model without classifying it here is a type error, by
 * construction — see `SECRET_CORE_FIELDS` and the exhaustiveness check below.
 */

// ── Field types ──────────────────────────────────────────────────────────────

export const CUSTOM_FIELD_TYPES = [
  'text',
  'password',
  'email',
  'url',
  'number',
  'date',
  'datetime',
  'boolean',
  'multiline',
  'phone',
  'pin',
  'otp-secret',
  'address',
] as const;

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/**
 * Custom-field types whose values are secret by nature.
 *
 * Everything else is secret only if the user marked the field hidden — see
 * `isCustomFieldValueSecret`. Defaulting the rest to visible is what lets the renderer
 * show "Account number: 4471" in a list without a round trip, while the user keeps the
 * ability to hide anything they consider sensitive (decision D10).
 */
export const SECRET_CUSTOM_FIELD_TYPES: readonly CustomFieldType[] = [
  'password',
  'pin',
  'otp-secret',
];

export interface CustomField {
  readonly id: string;
  readonly label: string;
  readonly type: CustomFieldType;
  readonly value: string;
  /** The user's own "treat this as sensitive" switch. Independent of type. */
  readonly hidden: boolean;
  readonly order: number;
}

/** A field's value crosses to the renderer only when this returns false. */
export function isCustomFieldValueSecret(field: Pick<CustomField, 'type' | 'hidden'>): boolean {
  return field.hidden || SECRET_CUSTOM_FIELD_TYPES.includes(field.type);
}

// ── Security questions ───────────────────────────────────────────────────────

/**
 * The *question* is a prompt, not a secret — "your first pet's name" reveals nothing. The
 * *answer* is a credential in every sense and is treated exactly like a password.
 *
 * Most password managers bury these in a free-text note, which means they cannot be
 * individually revealed, copied, versioned, or hidden. Here they are a first-class
 * repeatable field.
 */
export interface SecurityQuestion {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
}

// ── Attachments ──────────────────────────────────────────────────────────────

export interface AttachmentMeta {
  /** 32 lowercase hex characters — the chunk id in the KEEP container. */
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly addedAt: number;
}

// ── History and the audit trail ──────────────────────────────────────────────

/**
 * What a timeline entry *is*.
 *
 * A runtime array as well as a type, like `AUDIT_PRIVACY_LEVELS` and `CUSTOM_FIELD_TYPES`,
 * because anything validating a value that came out of a file — an import parser, an export
 * reader, an IPC payload — needs something to check against, and a hand-written list at
 * each of those sites is three lists that disagree.
 */
export const HISTORY_ACTIONS = ['create', 'update', 'restore', 'import', 'merge'] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

/**
 * Where and by what a change was made.
 *
 * This is Keyhold's headline differentiator: no other free, local password manager
 * records which device and network a change came from. It lives *inside* the encrypted
 * payload, so it travels with the record and is never exposed by the file itself.
 *
 * How much of it is captured is the user's choice — see `AuditPrivacyLevel`.
 */
export interface ChangeOrigin {
  readonly action: HistoryAction;
  readonly deviceName?: string;
  readonly osUser?: string;
  readonly platform?: string;
  readonly osRelease?: string;
  readonly appVersion?: string;
  readonly networkName?: string;
  readonly localIp?: string;
}

/**
 * How much provenance to record. This metadata is encrypted, but it still travels inside
 * a file the user may hand to someone, so they get to decide.
 */
export const AUDIT_PRIVACY_LEVELS = ['none', 'device', 'network', 'full'] as const;
export type AuditPrivacyLevel = (typeof AUDIT_PRIVACY_LEVELS)[number];

export const DEFAULT_AUDIT_PRIVACY_LEVEL: AuditPrivacyLevel = 'device';

/** Which origin fields each level is permitted to capture. Consumed by the capture code and its test. */
export const AUDIT_LEVEL_FIELDS: Record<AuditPrivacyLevel, readonly (keyof ChangeOrigin)[]> = {
  none: ['action'],
  device: ['action', 'deviceName', 'platform', 'appVersion'],
  network: ['action', 'deviceName', 'platform', 'appVersion', 'osUser', 'networkName'],
  full: [
    'action',
    'deviceName',
    'platform',
    'appVersion',
    'osUser',
    'networkName',
    'osRelease',
    'localIp',
  ],
};

/**
 * The previous values a version can carry.
 *
 * Keyed by exactly the strings `applyPatch` reports in `changedFields`, which is what lets
 * the invariant `Object.keys(snapshot) ⊆ changedFields` be asserted rather than hoped for.
 * A nested shape (`meta.expiresAt`) would have made that comparison a string-parsing
 * exercise, and the two would have drifted apart the first time a field moved.
 */
export interface VersionedValues {
  readonly username?: string;
  readonly email?: string;
  readonly password?: string;
  readonly urls?: readonly string[];
  readonly securityQuestions?: readonly SecurityQuestion[];
  readonly notes?: string;
  readonly custom?: readonly CustomField[];
  readonly title?: string;
  readonly favorite?: boolean;
  readonly folderId?: string | null;
  readonly tags?: readonly string[];
  readonly icon?: CredentialIcon;
  readonly expiresAt?: number | null;
  readonly rotationIntervalDays?: number | null;
}

export type VersionedField = keyof VersionedValues;

/**
 * The fields history records, in the order a diff should present them.
 *
 * `historyEnabled` is deliberately absent. Turning history on or off is a change to the
 * record, so it must dirty the vault and bump `updatedAt` — but recording a *version* for
 * it would put an entry in the timeline that has nothing to show, and turning history on
 * would immediately create a version documenting that history was turned on.
 */
export const VERSIONED_FIELDS = [
  'title',
  'username',
  'email',
  'password',
  'urls',
  'securityQuestions',
  'notes',
  'custom',
  'tags',
  'folderId',
  'favorite',
  'icon',
  'expiresAt',
  'rotationIntervalDays',
] as const satisfies readonly VersionedField[];

/**
 * Compile-time check that every versioned value is listed in `VERSIONED_FIELDS`.
 *
 * Without it, adding a field to `VersionedValues` and forgetting the array would silently
 * mean that field is changed, saved, and never recorded in history — a data-loss bug with
 * no failing test and no error message.
 */
type _AllVersionedFieldsListed = VersionedField extends (typeof VERSIONED_FIELDS)[number]
  ? true
  : ['Unlisted field in VersionedValues — add it to VERSIONED_FIELDS'];
export const _allVersionedFieldsListed: _AllVersionedFieldsListed = true;

/** The versioned fields whose old values are secret, and so are fetched one at a time. */
export const SECRET_VERSIONED_FIELDS = [
  'password',
  'notes',
  'securityQuestions',
  'custom',
] as const satisfies readonly VersionedField[];

/**
 * One historical state — **the values that were replaced**, not the values that replaced
 * them.
 *
 * ## Why the delta points backwards
 *
 * Each version stores what the record held *before* the change it describes, so the state
 * as of any version is reconstructed by starting from the current record and walking
 * backwards. That direction is not arbitrary:
 *
 *  - **Pruning stays lossless for what remains.** Retention drops the *oldest* versions.
 *    With backward deltas the retained versions are exactly the ones still reachable from
 *    the present, so every version you can see, you can restore. Forward deltas would need
 *    the pruned base to reconstruct anything at all, so pruning would silently break the
 *    entries it left behind.
 *  - **The current record is always intact.** There is no replay to get to "now", which is
 *    the state that actually matters, and no way for a corrupt version to make the live
 *    record unreadable.
 *
 * Only the changed fields are stored. A full copy per edit would grow without bound on a
 * frequently-edited record, and would duplicate every unchanged secret once per save.
 */
export interface CredentialVersion {
  readonly versionNumber: number;
  /** When the change this version describes was made. */
  readonly savedAt: number;
  readonly changedFields: readonly VersionedField[];
  /** The previous values of `changedFields`. Keys are a subset of `changedFields`. */
  readonly snapshot: VersionedValues;
  readonly origin: ChangeOrigin;
}

export interface HistorySettings {
  /** The per-credential checkbox. Defaults from settings, overridable per record. */
  readonly enabled: boolean;
  /** Oldest versions are pruned beyond this. `null` means unlimited. */
  readonly maxVersions: number | null;
  /**
   * Newest last, `versionNumber` strictly ascending and contiguous within the array.
   * Numbers are never reused after pruning, so an exported timeline keeps its identifiers.
   */
  readonly versions: readonly CredentialVersion[];
}

// ── The record ───────────────────────────────────────────────────────────────

export interface CredentialFields {
  readonly username: string;
  readonly email: string;
  readonly password: string;
  /** Multiple, first is primary. */
  readonly urls: readonly string[];
  readonly securityQuestions: readonly SecurityQuestion[];
  readonly notes: string;
  readonly custom: readonly CustomField[];
}

/**
 * Core field names whose values must never reach the renderer in bulk.
 *
 * `notes` is here because it is free text: users put recovery codes, PINs and backup
 * phrases in notes constantly, so treating it as non-secret would quietly defeat the whole
 * boundary.
 */
export const SECRET_CORE_FIELDS = ['password', 'notes'] as const;
export type SecretCoreField = (typeof SECRET_CORE_FIELDS)[number];

/**
 * Compile-time check that every core field is deliberately classified.
 *
 * Adding a field to `CredentialFields` without listing it in one of these two arrays makes
 * this line a type error — which is the point. A new field that nobody classified would
 * otherwise default to crossing the boundary, and the failure would be silent.
 */
export const NON_SECRET_CORE_FIELDS = [
  'username',
  'email',
  'urls',
  'securityQuestions',
  'custom',
] as const;

type _AllCoreFieldsClassified = keyof CredentialFields extends
  SecretCoreField | (typeof NON_SECRET_CORE_FIELDS)[number]
  ? true
  : [
      'Unclassified field in CredentialFields — add it to SECRET_CORE_FIELDS or NON_SECRET_CORE_FIELDS',
    ];
export const _allCoreFieldsClassified: _AllCoreFieldsClassified = true;

export interface CredentialMeta {
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Drives the "old password" health rule. Distinct from `updatedAt`. */
  readonly passwordUpdatedAt: number;
  readonly lastUsedAt: number | null;
  readonly useCount: number;
  readonly expiresAt: number | null;
  readonly rotationIntervalDays: number | null;
  /**
   * Where the record was created.
   *
   * On the record rather than in the version array, because creation has no *previous*
   * state to snapshot — a version describing it would be an entry the timeline could not
   * diff and the restore button could not act on. It is captured once and never changes,
   * which is also what makes it the one origin that survives history being turned off.
   */
  readonly createdOrigin: ChangeOrigin;
}

/**
 * How many entries each repeatable field may hold.
 *
 * Two layers enforce these and both are deliberate: `credential-validation.ts` rejects an
 * over-long array at the IPC boundary, before anything tries to validate ten thousand entries
 * one at a time, and `credential-ops.ts` rejects one so a single record cannot bloat a vault.
 * Two reasons, two places, one number — which is why the number lives here rather than being
 * written down twice.
 *
 * It was written down twice. Raising the ops cap alone made the IPC boundary the real limit
 * and the ops cap unreachable, silently; a guard that parsed both files out of the source
 * existed only because there were two files to parse. Findings S13 and S14.
 */
export const MAX_URLS = 32;
export const MAX_TAGS = 64;
export const MAX_CUSTOM_FIELDS = 128;
export const MAX_SECURITY_QUESTIONS = 32;

/** Same reasoning as `HISTORY_ACTIONS`: a parser reading an icon out of a file needs this. */
export const ICON_KINDS = ['auto', 'letter', 'emoji', 'custom'] as const;

export interface CredentialIcon {
  readonly kind: (typeof ICON_KINDS)[number];
  readonly value?: string;
}

/** The full record. **Main process only** — this type never crosses IPC. */
export interface Credential {
  readonly id: string;
  readonly type: 'login';
  readonly title: string;
  readonly favorite: boolean;
  readonly folderId: string | null;
  readonly tags: readonly string[];
  readonly icon: CredentialIcon;
  readonly fields: CredentialFields;
  readonly attachments: readonly AttachmentMeta[];
  readonly meta: CredentialMeta;
  readonly history: HistorySettings;
  /** Soft delete. Doubles as the sync tombstone, so a deletion cannot resurrect. */
  readonly trashedAt: number | null;
}

// ── The safe projection ──────────────────────────────────────────────────────

/** A custom field as the renderer sees it: value present only when non-secret. */
export interface CustomFieldProjection {
  readonly id: string;
  readonly label: string;
  readonly type: CustomFieldType;
  readonly hidden: boolean;
  readonly order: number;
  /** Absent when the value is secret. Never `null` for "empty" — use `hasValue`. */
  readonly value?: string;
  readonly hasValue: boolean;
  readonly isSecret: boolean;
}

/** A security question as the renderer sees it: the prompt, never the answer. */
export interface SecurityQuestionProjection {
  readonly id: string;
  readonly question: string;
  readonly hasAnswer: boolean;
}

/**
 * The previous values of one version, as the renderer is allowed to see them.
 *
 * Mirrors `CredentialProjection`'s rule exactly: the non-secret old values are present so
 * a timeline can show `"Gmail" → "Google"` without a round trip, and the secret ones are
 * present only as facts *about* themselves (`passwordLength`) so a mask renders at the
 * right width. The old password itself is fetched one at a time through the broker, under
 * the same rate limit and clipboard rules as the current one.
 */
export interface VersionedValuesProjection {
  readonly title?: string;
  readonly username?: string;
  readonly email?: string;
  readonly urls?: readonly string[];
  readonly tags?: readonly string[];
  readonly folderId?: string | null;
  readonly favorite?: boolean;
  readonly icon?: CredentialIcon;
  readonly expiresAt?: number | null;
  readonly rotationIntervalDays?: number | null;
  /** Prompts only. The old answers are secret and are fetched by ref. */
  readonly securityQuestions?: readonly SecurityQuestionProjection[];
  /** Labels, types and non-secret values only. */
  readonly custom?: readonly CustomFieldProjection[];
  /** Present when the password changed. The length of the *old* password, never its value. */
  readonly passwordLength?: number;
  /** Present when the notes changed. The length of the *old* notes, never their text. */
  readonly notesLength?: number;
}

/** One history entry as the renderer sees it: what changed, from where, and the safe half of it. */
export interface VersionProjection {
  readonly versionNumber: number;
  readonly savedAt: number;
  readonly changedFields: readonly VersionedField[];
  readonly snapshot: VersionedValuesProjection;
  /**
   * The changed fields whose previous value is secret, so the UI knows which rows get a
   * reveal button rather than a value. Derived here rather than in the renderer, so the
   * classification lives in one place (`SECRET_VERSIONED_FIELDS`).
   */
  readonly secretFields: readonly VersionedField[];
  readonly origin: ChangeOrigin;
}

/**
 * **What the renderer is allowed to hold.**
 *
 * Enough to search, sort, filter, group and render a list and a detail pane. Not enough
 * for a compromised renderer to be worth compromising.
 *
 * Note what is present as a *fact about* a secret rather than the secret: `hasPassword`,
 * `passwordLength`, `hasAnswer`, `hasValue`. Those drive the UI (show a masked field of
 * the right width, show "not set") without carrying anything an attacker could use.
 */
export interface CredentialProjection {
  readonly id: string;
  readonly type: 'login';
  readonly title: string;
  readonly favorite: boolean;
  readonly folderId: string | null;
  readonly tags: readonly string[];
  readonly icon: CredentialIcon;

  readonly username: string;
  readonly email: string;
  readonly urls: readonly string[];

  readonly hasPassword: boolean;
  /** So a masked field can be rendered at the right width. Not the password. */
  readonly passwordLength: number;
  readonly hasNotes: boolean;
  readonly notesLength: number;

  readonly securityQuestions: readonly SecurityQuestionProjection[];
  readonly custom: readonly CustomFieldProjection[];
  readonly attachments: readonly AttachmentMeta[];

  readonly meta: CredentialMeta;
  readonly historyEnabled: boolean;
  readonly historyCount: number;
  readonly history: readonly VersionProjection[];
  readonly trashedAt: number | null;
}

/**
 * Addresses one secret value for on-demand fetching.
 *
 * Deliberately a closed discriminated union rather than a free-form path string: a string
 * path would let the renderer ask for anything at all, and the main process would have to
 * decide safety by parsing. This way the set of askable things is finite and reviewable.
 */
export type SecretRef =
  | { readonly kind: 'password'; readonly credentialId: string }
  | { readonly kind: 'notes'; readonly credentialId: string }
  | { readonly kind: 'security-answer'; readonly credentialId: string; readonly questionId: string }
  | { readonly kind: 'custom-value'; readonly credentialId: string; readonly fieldId: string }
  /**
   * The **current one-time code** for an `otp-secret` field — not its seed.
   *
   * A separate kind rather than reusing `custom-value`, because they are different secrets
   * with different lifetimes: the seed is permanent and must never leave main, the code dies
   * in under a minute. Copying "the OTP field" has to put six digits on the clipboard, not an
   * `otpauth://` URI, and a caller that could not say which it meant would eventually put the
   * seed there.
   *
   * Display goes through `kh:totp:code`, which carries the expiry and the issuer as well.
   * This exists so a **copy** reaches the brokered clipboard with its auto-clear timer, the
   * same as every other secret. Both resolve through `VaultService.totpCode`.
   */
  | { readonly kind: 'totp-code'; readonly credentialId: string; readonly fieldId: string }
  | {
      readonly kind: 'historic-password';
      readonly credentialId: string;
      readonly versionNumber: number;
    }
  | {
      readonly kind: 'historic-notes';
      readonly credentialId: string;
      readonly versionNumber: number;
    }
  | {
      readonly kind: 'historic-answer';
      readonly credentialId: string;
      readonly versionNumber: number;
      readonly questionId: string;
    }
  | {
      readonly kind: 'historic-custom';
      readonly credentialId: string;
      readonly versionNumber: number;
      readonly fieldId: string;
    }
  /**
   * An attachment's bytes.
   *
   * A ref kind of its own rather than a variant of `custom-value`, because the thing it
   * addresses is not a field: it is a file, it can be tens of megabytes, and it can be a
   * photograph of a passport. It goes through the same broker, the same rate limit and the
   * same drop-on-lock as a password, which is the point of giving it a kind at all.
   */
  | {
      readonly kind: 'attachment';
      readonly credentialId: string;
      readonly attachmentId: string;
    };

/**
 * The four `historic-*` kinds mirror the four live ones exactly, one for one.
 *
 * They are separate kinds rather than an optional `versionNumber` on the live refs because
 * an optional field would make "reveal the current password" and "reveal a password from
 * two years ago" the same request with a property missing — and a dropped property is the
 * kind of mistake that produces the *wrong* secret rather than an error.
 *
 * A historic reveal goes through the same broker, the same rate limit and the same
 * clipboard rules as a live one. An old password is still a password.
 */
export const SECRET_REF_KINDS = [
  'password',
  'notes',
  'security-answer',
  'custom-value',
  'totp-code',
  'historic-password',
  'historic-notes',
  'historic-answer',
  'historic-custom',
  'attachment',
] as const;
