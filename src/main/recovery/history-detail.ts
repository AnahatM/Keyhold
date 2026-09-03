// SPDX-License-Identifier: GPL-3.0-or-later
import {
  VERSIONED_FIELDS,
  type Credential,
  type VersionedField,
} from '@shared/model/credential.js';
import { formatCount } from './text.js';

/**
 * The `invalid-history` finding's detail, **composed** rather than borrowed.
 *
 * ## Why this file exists at all
 *
 * `assertValidHistory` reports a broken invariant by interpolating the offending value into
 * its message — a snapshot key, a changed-field name, a version number. All three come out of
 * the document, and in the corrupt document this directory exists to describe they can hold
 * anything: `versioning.ts` says so, and so did the comment that used to sit at this call
 * site. A fragment of a decrypted note is the case everyone means.
 *
 * That message used to reach the report through a scrubber that replaced any double-quoted
 * run not on an allow-list. Two shapes walked past it, and both are now regression tests in
 * `document-diagnosis.test.ts`:
 *
 *  - **A length cap ran first and took the closing quote with it.** Past roughly 175
 *    characters of key the message was truncated mid-token, the scanner found no `"…"` pair
 *    at all, and the whole message — key included — went through untouched.
 *  - **The key supplied its own quotes.** `x" <secret> "password` presents the scanner with
 *    two pairs it is happy about and leaks everything *between* them. Reordering the cap and
 *    the scrub fixes the first and does nothing for the second.
 *
 * There is a third shape no quoted-run scrubber could ever have covered: the ascending-order
 * message interpolates the version number **unquoted**, and a version number out of a corrupt
 * file is only a number because the type says so.
 *
 * **So do not reintroduce a scrubber, however much simpler it looks.** Scrubbing is the losing
 * side of the exchange — it has to win against every shape, forever, while a shape only has to
 * be new once. Every string below is assembled from literals in this file plus values that are
 * safe by construction: a count, a 1-based position, a length, or a field name taken *from
 * `VERSIONED_FIELDS` itself* rather than from the document. Nothing that came out of the file
 * is interpolated, so there is nothing to scrub.
 *
 * ## Why a length and a position, and deliberately not a hash prefix
 *
 * A reader needs enough to find the offending key in their own vault. A 1-based position and a
 * character count do that without reproducing it. A truncated digest would identify it more
 * precisely, and was considered and rejected: this report is written to be pasted somewhere
 * public, and a short digest of a short secret is recovered offline by guessing. A length
 * leaks one number about a value; a digest leaks the value to anyone patient.
 *
 * ## Why this describes rather than decides
 *
 * `assertValidHistory` remains the only judge of whether a history is valid — this module is
 * never asked unless it has already thrown, and it can neither suppress nor invent a finding.
 * What it does duplicate is the *order* the invariants are checked in, so the sentence
 * describes the violation that actually fired rather than a different one further down the
 * same record. If `versioning.ts` grows an invariant this file has not been taught, the walk
 * below finds nothing and the caller gets `UNATTRIBUTED_HISTORY_DETAIL` — less useful, still
 * true, and never a leak. Failing to a vaguer sentence is the correct direction to fail in,
 * and `history-detail.test.ts` pins it down.
 */

/** Said when the walk below cannot attribute the failure. Vaguer, never wrong, never a leak. */
export const UNATTRIBUTED_HISTORY_DETAIL =
  'the version history breaks an invariant this build cannot name without quoting the document';

/**
 * The field name to print, taken from our own list.
 *
 * Returns the entry from `VERSIONED_FIELDS` rather than the caller's string. The two are equal
 * whenever this returns non-null, so it changes no output — it makes the allow-list structural
 * instead of remembered, and lets a reviewer see that the only field names able to reach a
 * report are ones this build compiled in.
 */
function knownFieldName(value: unknown): VersionedField | null {
  return VERSIONED_FIELDS.find((field) => field === value) ?? null;
}

/**
 * Code points, not UTF-16 units — the number is for a human counting characters.
 *
 * `Array.from` rather than `.length`, so a key of three emoji reports 3 and not 6. Nobody
 * counting characters in their own vault means UTF-16 units.
 */
function characterCount(value: string): number {
  return Array.from(value).length;
}

/** `key 2 of 5, 31 character(s)` — a locator that reproduces nothing. */
function locator(label: string, index: number, total: number, value: string): string {
  const size = formatCount(characterCount(value));
  return `${label} ${formatCount(index + 1)} of ${formatCount(total)}, ${size} character(s)`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Describes the first broken invariant in a record's history, in words that carry no document.
 *
 * Total by construction: every read below is guarded, because the input reached this module
 * precisely *because* it is not the shape the types promise. It never throws, and it never
 * returns an empty string.
 */
export function describeHistoryViolation(record: Credential): string {
  const history: unknown = record.history;
  if (!isPlainObject(history)) return UNATTRIBUTED_HISTORY_DETAIL;

  const rawVersions: unknown = history.versions;
  const maxVersions: unknown = history.maxVersions;
  if (!Array.isArray(rawVersions)) return UNATTRIBUTED_HISTORY_DETAIL;
  const versions = rawVersions as readonly unknown[];

  // The order mirrors `assertValidHistory` exactly. A different order would name a different
  // violation from the one that fired, which is a wrong answer rather than a vague one.
  if (maxVersions !== null) {
    if (typeof maxVersions !== 'number' || !Number.isInteger(maxVersions) || maxVersions < 0) {
      return 'history.maxVersions is not a non-negative integer or null';
    }
    if (versions.length > maxVersions) {
      return `${formatCount(versions.length)} version(s) exceed the history cap of ${formatCount(maxVersions)}`;
    }
  }

  let previousNumber = 0;
  for (const [position, entry] of versions.entries()) {
    const at = `the version at position ${formatCount(position + 1)}`;
    if (!isPlainObject(entry)) return `${at} is not a version object`;

    const number: unknown = entry.versionNumber;
    const isInteger = typeof number === 'number' && Number.isInteger(number);
    if (!isInteger || number <= previousNumber) {
      // The number is printed only once it is known to be an integer: a corrupt document's
      // version number can be a string, and that string can be anything at all.
      return isInteger
        ? `version numbers must strictly ascend — ${at} carries version ${formatCount(number)} after ${formatCount(previousNumber)}`
        : `version numbers must strictly ascend — the number on ${at} is not an integer`;
    }
    previousNumber = number;

    const rawChanged: unknown = entry.changedFields;
    if (!Array.isArray(rawChanged)) return `${at} does not list its changed fields`;
    const changedFields = rawChanged as readonly unknown[];

    for (const [index, field] of changedFields.entries()) {
      if (knownFieldName(field) !== null) continue;
      return typeof field === 'string'
        ? `${at} lists a changed field this build does not version (${locator('entry', index, changedFields.length, field)})`
        : `${at} lists a changed field that is not a string (entry ${formatCount(index + 1)} of ${formatCount(changedFields.length)})`;
    }

    const snapshot: unknown = entry.snapshot;
    if (!isPlainObject(snapshot)) return `${at} has no snapshot object`;

    const keys = Object.keys(snapshot);
    for (const [index, key] of keys.entries()) {
      if (changedFields.includes(key)) continue;
      const named = knownFieldName(key);
      return named === null
        ? // The key came out of the file and is not one of ours, so it is never repeated.
          `${at} snapshots a key it does not list as changed, and that this build does not version (${locator('key', index, keys.length, key)})`
        : `${at} snapshots "${named}", which it does not list as changed`;
    }
  }

  return UNATTRIBUTED_HISTORY_DETAIL;
}
