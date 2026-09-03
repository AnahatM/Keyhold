// SPDX-License-Identifier: GPL-3.0-or-later
import {
  SECRET_VERSIONED_FIELDS,
  type CredentialIcon,
  type CustomFieldProjection,
  type SecurityQuestionProjection,
  type VersionedField,
} from '@shared/model/credential.js';
import type { DiffValue } from '@shared/model/history.js';
import type { VaultSettings } from '@shared/model/vault-document.js';
import type { ConflictSide, MergeConflict, MergeConflictKind } from '@shared/model/sync.js';
import { TARGET_KIND_NOUNS, type MergeTargetKind, type TargetName } from './merge-targets.js';

/**
 * Turning a merge conflict into a question a person can answer.
 *
 * Pure, and outside the components for the same reason `../export/export-presentation.ts` is:
 * these sentences *are* the feature. The engine's job is to refuse to guess; this file's job is
 * to make the refusal answerable. A row reading `record:abc-123:field:password` with two buttons
 * marked "ours" and "theirs" is a debug view, and a user who picks the wrong side of four
 * hundred of those was failed here, not in the merge.
 *
 * ## Two standing constraints
 *
 * **Nothing here may render a secret.** It cannot, structurally: a `ConflictSide` carries a kind
 * and, for a secret, a length. This module receives sides and labels, never a record and never a
 * value, so there is nothing for it to leak. `MergeResolver.test.tsx` proves that end to end by
 * planting a value on every side at runtime and sweeping the rendered DOM for it.
 *
 * **No conflict may render blank, and none may render its raw id.** Every map below is an
 * exhaustive `Record` over a closed union, so adding a conflict kind, a versioned field or a
 * vault setting is a compile error until it has words. Where the closed union runs out — `field`
 * is `string | null` on purpose, so the engine can name a property the model does not export —
 * {@link fieldLabel} humanises the identifier rather than printing it verbatim.
 */

// ── Which sort of thing conflicted ───────────────────────────────────────────

/**
 * The subject a conflict kind is about.
 *
 * A `Record` over the closed union rather than a `switch` with a default, so a seventh conflict
 * kind cannot quietly become a record.
 */
const TARGET_KIND_BY_CONFLICT: Readonly<Record<MergeConflictKind, MergeTargetKind>> = {
  'record-field': 'record',
  'record-delete-vs-edit': 'record',
  'record-history': 'record',
  folder: 'folder',
  tag: 'tag',
  setting: 'setting',
};

export function targetKindOf(conflict: MergeConflict): MergeTargetKind {
  return TARGET_KIND_BY_CONFLICT[conflict.kind];
}

// ── Naming the property ──────────────────────────────────────────────────────

/**
 * Every versioned field, in English.
 *
 * `Record<VersionedField, string>` rather than a lookup with a fallback: adding a field to the
 * credential model and forgetting the word for it is then a type error here, instead of a merge
 * row that asks the user about `rotationIntervalDays`.
 */
const VERSIONED_FIELD_LABELS: Readonly<Record<VersionedField, string>> = {
  title: 'Title',
  username: 'Username',
  email: 'Email',
  password: 'Password',
  urls: 'Web addresses',
  securityQuestions: 'Security questions',
  notes: 'Notes',
  custom: 'Custom fields',
  tags: 'Tags',
  folderId: 'Folder',
  favorite: 'Favourite',
  icon: 'Icon',
  expiresAt: 'Expiry date',
  rotationIntervalDays: 'Rotation reminder',
};

/**
 * Every vault setting, in English, keyed by `keyof VaultSettings`.
 *
 * The compound settings (`health`, `attachments`, `breachCheck`) never produce a conflict — the
 * engine reconciles them field by field because every field has an answer that cannot cost the
 * user anything. They are listed anyway so the `Record` stays exhaustive: a new setting is then
 * a compile error here whether or not it turns out to be conflictable.
 */
const SETTING_LABELS: Readonly<Record<keyof VaultSettings, string>> = {
  historyEnabledByDefault: 'Keep history for new records',
  historyMaxVersions: 'Versions kept per record',
  auditPrivacyLevel: 'Detail recorded in the activity log',
  passwordAgeWarningDays: 'Age at which a password counts as old',
  trashRetentionDays: 'Days a trashed record is kept',
  health: 'Health checks',
  attachments: 'Attachment limits',
  breachCheck: 'Breach checking',
};

/**
 * Properties the engine names that are not versioned credential fields.
 *
 * `attachments` is a record field to the engine but not a versioned one; the rest belong to the
 * folder, tag and history-settings merges.
 */
const OTHER_PROPERTY_LABELS: Readonly<Record<string, string>> = {
  attachments: 'Attachments',
  trashedAt: 'Trash',
  enabled: 'History',
  maxVersions: 'Versions kept',
  name: 'Name',
  parentId: 'Parent folder',
  colour: 'Colour',
  order: 'Order',
};

/**
 * Splits a camelCase identifier into words and sentence-cases it.
 *
 * The last resort, reached only when the engine names a property none of the maps above knows.
 * It cannot invent a good name, but "Some new property" is answerable and `someNewProperty` is
 * not, and the alternative — rendering nothing — hides a row the user still has to settle.
 */
function humanise(identifier: string): string {
  const spaced = identifier.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  const trimmed = spaced.trim();
  if (trimmed === '') return 'Property';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function isVersionedField(field: string): field is VersionedField {
  return Object.hasOwn(VERSIONED_FIELD_LABELS, field);
}

function isSettingKey(key: string): key is keyof VaultSettings {
  return Object.hasOwn(SETTING_LABELS, key);
}

/**
 * The property a conflict is about, in English.
 *
 * For a `'setting'` conflict the *target* is the property — `field` is `null` and `targetId` is
 * the settings key — which is why this takes the whole conflict rather than just the field.
 */
export function fieldLabel(conflict: MergeConflict): string {
  if (conflict.kind === 'setting') {
    return isSettingKey(conflict.targetId)
      ? SETTING_LABELS[conflict.targetId]
      : humanise(conflict.targetId);
  }
  const field = conflict.field;
  if (field === null) return TARGET_KIND_NOUNS[targetKindOf(conflict)];
  if (isVersionedField(field)) return VERSIONED_FIELD_LABELS[field];
  return OTHER_PROPERTY_LABELS[field] ?? humanise(field);
}

// ── What kind of disagreement this is ────────────────────────────────────────

/**
 * One line saying what happened, per conflict kind.
 *
 * Phrased as the *situation*, not the mechanism: the reader is deciding, not debugging.
 */
export const CONFLICT_KIND_MEANINGS: Readonly<Record<MergeConflictKind, string>> = {
  'record-field': 'This field holds a different value in each file.',
  'record-delete-vs-edit':
    'One file has this record in the trash; the other has it live and edited. Keeping the edit keeps the record.',
  'record-history': 'The two files disagree about how much history to keep for this record.',
  folder: 'This folder is described differently in each file.',
  tag: 'This tag is described differently in each file.',
  setting: 'This vault setting has a different value in each file.',
};

/**
 * A distinguishable glyph per kind — never colour alone (WCAG 1.4.1).
 *
 * Six different shapes, not six coloured dots: they stay six different things in greyscale and
 * in the high-contrast theme. On a screen whose entire job is telling someone which of two
 * things they are about to keep, a signal only a full-colour eye can read would be exactly the
 * wrong economy.
 */
export const CONFLICT_KIND_SYMBOLS: Readonly<Record<MergeConflictKind, string>> = {
  'record-field': '≠',
  'record-delete-vs-edit': '⌫',
  'record-history': '⏱',
  folder: '🗀',
  tag: '⌗',
  setting: '⚙',
};

/**
 * True when part of the value behind this conflict is not on screen and cannot be put there.
 *
 * Two independent tests, ANDed into an OR on purpose:
 *
 *  - the field is in `SECRET_VERSIONED_FIELDS`, the model's own classification, reused rather
 *    than restated (hard rule 8) — so a field promoted to secret in `credential.ts` is treated
 *    as hidden here for free; and
 *  - either side actually crossed as `'secret'`, which catches the reverse case: a projector
 *    that masks something this list has not heard of.
 *
 * This is what `bulk-resolution.ts` keys the across-records sweep off, so getting it wrong in
 * the permissive direction is what a fault injection has to be able to catch.
 */
export function hidesValue(conflict: MergeConflict): boolean {
  const field = conflict.field;
  const classified =
    field !== null && (SECRET_VERSIONED_FIELDS as readonly string[]).includes(field);
  return classified || conflict.ours.kind === 'secret' || conflict.theirs.kind === 'secret';
}

// ── Rendering one side ───────────────────────────────────────────────────────

/** One line of a `questions` or `custom` side. Labels and prompts only, never an answer. */
export interface SideEntry {
  readonly key: string;
  readonly label: string;
  /** `'Answered'`, `'Hidden'`, `'Empty'` — a fact *about* the value, never the value. */
  readonly detail: string;
}

export interface SideSummary {
  readonly kind: ConflictSide['kind'];
  /** The line to show. Empty when {@link entries} carries the content instead. */
  readonly text: string;
  /** Characters in the hidden value, for an honest mask. `null` when nothing is hidden. */
  readonly maskLength: number | null;
  readonly entries: readonly SideEntry[];
  /** True when the value itself is not on screen, so the UI can say so out loud. */
  readonly hidden: boolean;
  /** True when this side has no record/folder/tag at all — different from "empty". */
  readonly absent: boolean;
}

const EMPTY_ENTRIES: readonly SideEntry[] = [];

function formatDate(epochMs: number): string {
  // The user's locale, via the platform. A fixed format would be wrong for most of the world,
  // and the value here is a date the merge is asking about, so it must be readable at a glance.
  return new Date(epochMs).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function isIcon(value: DiffValue): value is CredentialIcon {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A plain `DiffValue`, in English.
 *
 * Field-aware for exactly two things — timestamps and the trash flag — because an epoch
 * millisecond rendered raw is a number nobody can act on, and `trashedAt: null` reads as
 * "Not set" when what it means is "not in the trash".
 */
function formatValue(value: DiffValue, field: string | null): string {
  if (field === 'trashedAt') {
    return value === null || typeof value !== 'number'
      ? 'Not in the trash'
      : `In the trash since ${formatDate(value)}`;
  }
  if (value === null) return 'Not set';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    return field === 'expiresAt' ? formatDate(value) : String(value);
  }
  if (typeof value === 'string') return value.trim() === '' ? 'Empty' : value;
  if (Array.isArray(value)) {
    return value.length === 0 ? 'None' : value.join(', ');
  }
  if (isIcon(value)) {
    return value.value === undefined || value.value === ''
      ? `${value.kind} icon`
      : `${value.kind} icon — ${value.value}`;
  }
  /* c8 ignore next -- unreachable: DiffValue is closed and every arm is handled above. */
  return 'Not set';
}

function questionEntries(questions: readonly SecurityQuestionProjection[]): readonly SideEntry[] {
  return questions.map((question) => ({
    key: question.id,
    label: question.question.trim() === '' ? 'Untitled question' : question.question,
    detail: question.hasAnswer ? 'Answered — answer hidden' : 'No answer',
  }));
}

/**
 * Custom fields, as labels and facts.
 *
 * **The non-secret `value` is deliberately not rendered**, even though the projection carries it
 * and rendering it would break no rule. This is the one screen that shows many records at once,
 * and a custom field's contents are the user's data whether or not the model classifies them as
 * secret. Showing the label, the type and whether there is a value is enough to tell the two
 * sides apart, which is all a resolver needs. The value is a click away in the record itself.
 */
function customEntries(fields: readonly CustomFieldProjection[]): readonly SideEntry[] {
  return fields.map((custom) => ({
    key: custom.id,
    label: custom.label.trim() === '' ? 'Untitled field' : custom.label,
    detail: custom.isSecret
      ? 'Hidden value'
      : custom.hasValue
        ? `${custom.type} — has a value`
        : `${custom.type} — empty`,
  }));
}

/**
 * One side of one conflict, ready to render.
 *
 * `field` is passed separately rather than read off a conflict so the two ends of a row and the
 * ancestor column all go through the same function with the same context.
 */
export function describeSide(side: ConflictSide, field: string | null): SideSummary {
  switch (side.kind) {
    case 'absent':
      return {
        kind: 'absent',
        text: 'Not in this file',
        maskLength: null,
        entries: EMPTY_ENTRIES,
        hidden: false,
        absent: true,
      };
    case 'secret':
      return {
        kind: 'secret',
        // The length, and nothing else. Enough for an honest mask, useless to an attacker —
        // and stated in words as well as drawn, because a row of dots is not an accessible name.
        text: `Hidden — ${side.length} character${side.length === 1 ? '' : 's'}`,
        maskLength: side.length,
        entries: EMPTY_ENTRIES,
        hidden: true,
        absent: false,
      };
    case 'questions':
      return {
        kind: 'questions',
        text:
          side.questions.length === 0
            ? 'No security questions'
            : `${side.questions.length} question${side.questions.length === 1 ? '' : 's'}`,
        maskLength: null,
        entries: questionEntries(side.questions),
        hidden: true,
        absent: false,
      };
    case 'custom':
      return {
        kind: 'custom',
        text:
          side.fields.length === 0
            ? 'No custom fields'
            : `${side.fields.length} field${side.fields.length === 1 ? '' : 's'}`,
        maskLength: null,
        entries: customEntries(side.fields),
        hidden: true,
        absent: false,
      };
    case 'value':
      return {
        kind: 'value',
        text: formatValue(side.value, field),
        maskLength: null,
        entries: EMPTY_ENTRIES,
        hidden: false,
        absent: false,
      };
  }
}

// ── The question itself ──────────────────────────────────────────────────────

/**
 * The row's accessible question, spelled out for a screen reader.
 *
 * The visual row shows the target as a heading and the property beside two side cards, which
 * reads fine with eyes and as fragments without them. This is the sentence the radio group is
 * labelled with, so the question arrives whole.
 */
export function conflictQuestion(conflict: MergeConflict, target: TargetName): string {
  const property = fieldLabel(conflict);
  if (conflict.kind === 'setting') return `Which value should ${property} keep?`;
  if (conflict.kind === 'record-delete-vs-edit') {
    return `${target.name} was trashed in one file and edited in the other. Which should win?`;
  }
  return `Which ${property.toLowerCase()} should ${target.name} keep?`;
}
