// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  CredentialIcon,
  CustomFieldProjection,
  SecurityQuestionProjection,
  VersionedField,
} from './credential.js';

/**
 * The renderer-facing shapes for history.
 *
 * The record-side shapes — `CredentialVersion`, `ChangeOrigin`, `VersionedValues` — live in
 * `credential.js` beside the model they belong to. These are the *projections*: what may
 * cross the IPC boundary once the secrets are taken out.
 */

/**
 * The values a non-secret diff side can hold.
 *
 * Enumerated rather than left as `unknown`, so a renderer rendering a diff row knows what
 * it is looking at without a cast, and so adding a versioned field of some new shape is a
 * type error here rather than a runtime surprise in a component.
 */
export type DiffValue = string | number | boolean | null | readonly string[] | CredentialIcon;

/**
 * One side of one field's change.
 *
 * A discriminated union rather than an optional-value object, because "the old password was
 * 14 characters" and "the old title was empty" are genuinely different things and a UI that
 * had to distinguish them by checking which optional field was present would eventually get
 * it wrong.
 */
export type DiffSide =
  | { readonly kind: 'value'; readonly value: DiffValue }
  /** A secret. Its length, and nothing else — enough for an honest mask, useless to an attacker. */
  | { readonly kind: 'secret'; readonly length: number }
  | { readonly kind: 'questions'; readonly questions: readonly SecurityQuestionProjection[] }
  | { readonly kind: 'custom'; readonly fields: readonly CustomFieldProjection[] };

export interface FieldDiffProjection {
  readonly field: VersionedField;
  /** True when the caller must go through the broker to see the actual values. */
  readonly isSecret: boolean;
  readonly before: DiffSide;
  readonly after: DiffSide;
}

/** Where in a record's timeline to look. `'current'` is the live record. */
export type HistoryPointRef = number | 'current';
