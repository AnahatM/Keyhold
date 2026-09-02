// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  IpcValidationError,
  MAX_STRING_BYTES,
  requireBoolean,
  requireId,
  requireListOptions,
  requireNonEmptyString,
  requireSecretRef,
  requireString,
  requireVaultPath,
} from './validation.js';

/**
 * IPC validation.
 *
 * The renderer is semi-trusted (decision D13) and TypeScript is erased at runtime, so a
 * handler typed `(path: string)` will cheerfully receive `undefined`, an object, or a
 * 500 MB string. These validators are the actual type check.
 *
 * The `requireSecretRef` block is the most important: it is what stands between "reveal my
 * GitHub password" and "reveal an arbitrary property of an arbitrary object".
 */

const CHANNEL = 'kh:test:channel';

describe('strings', () => {
  it('accepts a string', () => {
    expect(requireString(CHANNEL, 'hello', 'x')).toBe('hello');
  });

  it('rejects every non-string, including the ones that coerce', () => {
    for (const value of [undefined, null, 42, true, {}, [], Symbol('s')]) {
      expect(() => requireString(CHANNEL, value, 'x')).toThrow(IpcValidationError);
    }
  });

  it('caps length — one huge string is a trivial OOM from a compromised renderer', () => {
    const huge = 'a'.repeat(MAX_STRING_BYTES + 1);
    expect(() => requireString(CHANNEL, huge, 'x')).toThrow(/exceeds/);
  });

  it('allows a string right at the cap', () => {
    expect(() => requireString(CHANNEL, 'a'.repeat(MAX_STRING_BYTES), 'x')).not.toThrow();
  });

  it('rejects an empty or whitespace-only value where one is required', () => {
    expect(() => requireNonEmptyString(CHANNEL, '', 'x')).toThrow(/must not be empty/);
    expect(() => requireNonEmptyString(CHANNEL, '   ', 'x')).toThrow(/must not be empty/);
  });

  it('never echoes the offending value — it could be a password, and this reaches a log', () => {
    const error = (() => {
      try {
        requireNonEmptyString(CHANNEL, 42, 'password');
        return null;
      } catch (e) {
        return e as Error;
      }
    })();

    expect(error?.message).toContain('password must be a string');
    expect(error?.message).not.toContain('42');
  });
});

describe('identifiers', () => {
  it('accepts a UUID and a hex chunk id', () => {
    expect(() => requireId(CHANNEL, '0b8e4c2a-1234-4abc-9def-000000000000', 'id')).not.toThrow();
    expect(() => requireId(CHANNEL, 'a'.repeat(32), 'id')).not.toThrow();
  });

  it('rejects anything that could change meaning when interpolated', () => {
    // Path traversal, separators, NUL, and shell-ish characters all fail the same way,
    // because the character set is an allow-list rather than a blocklist.
    for (const value of [
      '../../etc/passwd',
      'a/b',
      'a\\b',
      'a\0b',
      'a b',
      'a;rm -rf /',
      "a'or'1'='1",
      '',
      'a'.repeat(129),
    ]) {
      expect(
        () => requireId(CHANNEL, value, 'id'),
        `should reject ${JSON.stringify(value)}`
      ).toThrow(IpcValidationError);
    }
  });
});

describe('booleans and options', () => {
  it('rejects truthy values that are not booleans', () => {
    for (const value of ['true', 1, 0, null]) {
      expect(() => requireBoolean(CHANNEL, value, 'flag')).toThrow(IpcValidationError);
    }
  });

  it('defaults list options when absent', () => {
    expect(requireListOptions(CHANNEL, undefined)).toEqual({ includeTrashed: false });
    expect(requireListOptions(CHANNEL, null)).toEqual({ includeTrashed: false });
    expect(requireListOptions(CHANNEL, {})).toEqual({ includeTrashed: false });
  });

  it('accepts a valid option object and rejects a malformed one', () => {
    expect(requireListOptions(CHANNEL, { includeTrashed: true })).toEqual({ includeTrashed: true });
    expect(() => requireListOptions(CHANNEL, { includeTrashed: 'yes' })).toThrow(
      IpcValidationError
    );
    expect(() => requireListOptions(CHANNEL, [])).toThrow(/must be an object/);
  });
});

describe('vault paths', () => {
  it('accepts an ordinary path on either platform', () => {
    expect(() => requireVaultPath(CHANNEL, 'C:\\Users\\anahat\\vault.keep')).not.toThrow();
    expect(() => requireVaultPath(CHANNEL, '/home/anahat/vault.keep')).not.toThrow();
  });

  it('rejects a NUL byte, which truncates a path inside some native calls', () => {
    // The classic way to make a validated string mean something different by the time it
    // reaches the filesystem.
    expect(() => requireVaultPath(CHANNEL, '/home/user/vault.keep\0.txt')).toThrow(/null byte/);
  });

  it('rejects an empty path', () => {
    expect(() => requireVaultPath(CHANNEL, '')).toThrow(IpcValidationError);
  });
});

describe('secret references — the most security-sensitive payload in the contract', () => {
  it('accepts each of the four legitimate shapes', () => {
    expect(requireSecretRef(CHANNEL, { kind: 'password', credentialId: 'cred-1' })).toEqual({
      kind: 'password',
      credentialId: 'cred-1',
    });
    expect(requireSecretRef(CHANNEL, { kind: 'notes', credentialId: 'cred-1' })).toEqual({
      kind: 'notes',
      credentialId: 'cred-1',
    });
    expect(
      requireSecretRef(CHANNEL, {
        kind: 'security-answer',
        credentialId: 'cred-1',
        questionId: 'q-1',
      })
    ).toEqual({ kind: 'security-answer', credentialId: 'cred-1', questionId: 'q-1' });
    expect(
      requireSecretRef(CHANNEL, { kind: 'custom-value', credentialId: 'cred-1', fieldId: 'f-1' })
    ).toEqual({ kind: 'custom-value', credentialId: 'cred-1', fieldId: 'f-1' });
  });

  it('rejects an unknown kind rather than falling through to a default', () => {
    expect(() => requireSecretRef(CHANNEL, { kind: 'everything', credentialId: 'a' })).toThrow(
      /not a known secret kind/
    );
    expect(() => requireSecretRef(CHANNEL, { kind: '__proto__', credentialId: 'a' })).toThrow(
      IpcValidationError
    );
  });

  it('rejects a missing or malformed credential id', () => {
    expect(() => requireSecretRef(CHANNEL, { kind: 'password' })).toThrow(/credentialId/);
    expect(() => requireSecretRef(CHANNEL, { kind: 'password', credentialId: '../other' })).toThrow(
      IpcValidationError
    );
  });

  it('requires the discriminant-specific field for each variant', () => {
    expect(() => requireSecretRef(CHANNEL, { kind: 'security-answer', credentialId: 'a' })).toThrow(
      /questionId/
    );
    expect(() => requireSecretRef(CHANNEL, { kind: 'custom-value', credentialId: 'a' })).toThrow(
      /fieldId/
    );
  });

  it('strips anything extra rather than passing it through', () => {
    // The returned object is rebuilt field by field, so a smuggled property cannot ride
    // along into code that later spreads the ref.
    const result = requireSecretRef(CHANNEL, {
      kind: 'password',
      credentialId: 'cred-1',
      __proto__: { polluted: true },
      extra: 'ignored',
      questionId: 'not-applicable',
    });
    expect(result).toEqual({ kind: 'password', credentialId: 'cred-1' });
    expect(Object.keys(result)).toEqual(['kind', 'credentialId']);
  });

  it('rejects a non-object, including an array and a string', () => {
    for (const value of [null, undefined, 'password', 42, ['password', 'a']]) {
      expect(() => requireSecretRef(CHANNEL, value)).toThrow(/must be an object/);
    }
  });
});
