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

export type HistoryAction = 'create' | 'update' | 'restore' | 'import' | 'merge';

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
 * One historical state. Stores only the fields that changed, not a full copy — history on
 * a frequently-edited record would otherwise grow without bound.
 */
export interface CredentialVersion {
  readonly versionNumber: number;
  readonly savedAt: number;
  readonly changedFields: readonly string[];
  readonly snapshot: Partial<CredentialFields>;
  readonly origin: ChangeOrigin;
}

export interface HistorySettings {
  /** The per-credential checkbox. Defaults from settings, overridable per record. */
  readonly enabled: boolean;
  /** Oldest versions are pruned beyond this. `null` means unlimited. */
  readonly maxVersions: number | null;
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
}

export interface CredentialIcon {
  readonly kind: 'auto' | 'letter' | 'emoji' | 'custom';
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

/** One history entry as the renderer sees it: what and where, never the old values. */
export interface VersionProjection {
  readonly versionNumber: number;
  readonly savedAt: number;
  readonly changedFields: readonly string[];
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
  | { readonly kind: 'custom-value'; readonly credentialId: string; readonly fieldId: string };

export const SECRET_REF_KINDS = ['password', 'notes', 'security-answer', 'custom-value'] as const;
