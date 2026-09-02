// SPDX-License-Identifier: GPL-3.0-or-later
import { malformed } from '../crypto/errors.js';

/**
 * Value-level readers for a Keyhold JSON export that arrived from outside.
 *
 * **This file treats the export as hostile input**, exactly as `format/header.ts` treats a
 * `.keep` header. That is not paranoia about our own writer: a `.json` export is a file
 * anybody can hand a user, and unlike the vault body it has never been authenticated by an
 * AEAD before it is parsed. `JSON.parse` guarantees nothing about shape, so every field is
 * checked explicitly rather than trusted to be what the type declaration claims.
 *
 * Errors are `VaultError`s with the `MALFORMED` code, and they name the *path* of the bad
 * field — never its value, which in this file would often be a password.
 */

/** Makes every property of `T` writable, so a parser can fill one in field by field. */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw malformed(`"${path}" is not an object`);
  return value;
}

export function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw malformed(`"${path}" is not an array`);
  return value;
}

export function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw malformed(`"${path}" is not a string`);
  return value;
}

export function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw malformed(`"${path}" is not a boolean`);
  return value;
}

export function requireNumber(value: unknown, path: string): number {
  // `Number.isFinite` rather than `typeof === 'number'`: `NaN` and `Infinity` are numbers to
  // TypeScript, survive `JSON.parse` as `null`, and would poison every date comparison they
  // reached without ever failing a check.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw malformed(`"${path}" is not a finite number`);
  }
  return value;
}

export function requireStringArray(value: unknown, path: string): string[] {
  return requireArray(value, path).map((item, index) => requireString(item, `${path}[${index}]`));
}

/** A number, or `null`. The shape every optional timestamp in the record model uses. */
export function requireNullableNumber(value: unknown, path: string): number | null {
  return value === null ? null : requireNumber(value, path);
}

export function requireNullableString(value: unknown, path: string): string | null {
  return value === null ? null : requireString(value, path);
}

/**
 * Reads a value that must be one of a fixed set of strings.
 *
 * The set is passed in rather than inferred, so the caller names the authority it is
 * checking against — `CUSTOM_FIELD_TYPES`, `AUDIT_PRIVACY_LEVELS` — instead of restating the
 * members here and letting the two drift.
 */
export function requireMember<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[]
): T {
  const text = requireString(value, path);
  const match = allowed.find((candidate) => candidate === text);
  if (match === undefined) {
    throw malformed(`"${path}" is not one of: ${allowed.join(', ')}`);
  }
  return match;
}
