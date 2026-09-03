// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  IpcValidationError,
  MAX_STRING_UNITS,
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

/** One astral-plane character: two UTF-16 code units, four bytes of UTF-8. */
const ASTRAL = '\u{1F600}';

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
    const huge = 'a'.repeat(MAX_STRING_UNITS + 1);
    expect(() => requireString(CHANNEL, huge, 'x')).toThrow(/longer than/);
  });

  it('counts UTF-16 code units, which is what the name now says', () => {
    // An astral-plane character is two code units, so half as many of them reach the cap.
    // Asserted because the constant was called MAX_STRING_BYTES while measuring this, and a
    // reader budgeting memory from the old name was out by up to 4x — finding S11.
    const astral = ASTRAL.repeat(MAX_STRING_UNITS / 2);
    expect(astral.length).toBe(MAX_STRING_UNITS);
    expect(() => requireString(CHANNEL, astral, 'x')).not.toThrow();
    expect(() => requireString(CHANNEL, `${astral}a`, 'x')).toThrow(/longer than/);
  });

  it('allows a string right at the cap', () => {
    expect(() => requireString(CHANNEL, 'a'.repeat(MAX_STRING_UNITS), 'x')).not.toThrow();
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

  it('rejects a path that names another machine', () => {
    // The same finding as `src/main/shell/file-open-request.test.ts`, reached from the other
    // direction. A UNC path is absolute, and absolute is not local: on Windows, opening one
    // makes the main process dial an SMB host the sender chose and hand over an NTLMv2
    // handshake with the logged-in user's credentials. This validator's whole stated purpose
    // is the case where a compromised renderer replays a channel directly, and until this
    // was written, replaying `kh:vault:unlock` with `\\attacker\s\v.keep` was a one-line
    // Windows credential exfiltration.
    for (const path of [
      String.raw`\\attacker.example\share\vault.keep`,
      '//attacker.example/share/vault.keep',
      String.raw`\\?\UNC\attacker.example\s\vault.keep`,
      String.raw`\\.\pipe\vault.keep`,
      String.raw`\Users\me\vault.keep`,
    ]) {
      expect(() => requireVaultPath(CHANNEL, path), path).toThrow(/on this machine/);
    }
  });

  it('rejects a NUL byte, which truncates a path inside some native calls', () => {
    // The classic way to make a validated string mean something different by the time it
    // reaches the filesystem.
    expect(() => requireVaultPath(CHANNEL, '/home/user/vault.keep\0.txt')).toThrow(/null byte/);
  });

  it('rejects an empty path', () => {
    expect(() => requireVaultPath(CHANNEL, '')).toThrow(IpcValidationError);
  });

  /**
   * This validator's own doc calls itself defence in depth "where a compromised renderer
   * replays a channel directly" — and an audit found it did not defend that case. It took
   * any non-empty string, so `kh:vault:create` reached `writeVaultFileAtomically`, whose
   * first act is `mkdir(directory, { recursive: true })`. A replayed channel could create
   * arbitrary directory trees and drop a file anywhere the user can write.
   */
  it('rejects a relative path', () => {
    expect(() => requireVaultPath(CHANNEL, 'vault.keep')).toThrow(/absolute/);
    expect(() => requireVaultPath(CHANNEL, '../../../vault.keep')).toThrow(/absolute/);
    expect(() => requireVaultPath(CHANNEL, './sub/vault.keep')).toThrow(/absolute/);
  });

  it('rejects a path that does not name a vault', () => {
    // The realistic targets: a Startup shortcut, a shell profile, a config file.
    expect(() => requireVaultPath(CHANNEL, 'C:/Users/a/Start Menu/Programs/Startup/x.lnk')).toThrow(
      /\.keep/
    );
    expect(() => requireVaultPath(CHANNEL, '/home/a/.bashrc')).toThrow(/\.keep/);
  });

  it('is case-insensitive about the extension', () => {
    // This test used to read "accepts a UNC share and is case-insensitive about the
    // extension", and asserted both halves. The UNC half was the vulnerability written down
    // as an expectation, which is why it survived a security pass: a reviewer reading the
    // suite would have seen UNC support as intended behaviour rather than as a hole. The
    // extension half was always right and is kept.
    expect(() => requireVaultPath(CHANNEL, 'C:/Users/me/vault.KEEP')).not.toThrow();
    expect(() => requireVaultPath(CHANNEL, '/home/me/vault.Keep')).not.toThrow();
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
