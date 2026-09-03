// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { isLocalPath, isLocalPathOn } from './local-path.js';

/**
 * Guard: no path that dials another machine is called local.
 *
 * This exists because `\attacker.example\share\vault.keep` passed every check Keyhold had
 * — no URL scheme, no `..`, `win32.isAbsolute` true, a `.keep` extension — and reached
 * `statSync`, which on Windows opens an SMB session to the named host and performs an
 * NTLMv2 handshake with the logged-in user's credentials. From an app whose hard rule 5 is
 * *zero network by default*, triggered by double-clicking a shortcut someone sent.
 *
 * Every remote case below is written the way an attacker would write it, not the way a
 * user would. That is the only way this table is worth having.
 */

/** Shapes that name storage on this machine and must be accepted. */
const LOCAL_WINDOWS = [
  String.raw`C:\Users\me\vault.keep`,
  String.raw`c:\vault.keep`,
  'D:/vault.keep',
  String.raw`Z:\a\b\c.keep`,
];

/** Shapes that do not, and must not be. */
const REMOTE_OR_STRANGE_WINDOWS = [
  // The finding. Both separators, because Windows accepts either.
  String.raw`\attacker.example\share\vault.keep`,
  '//attacker.example/share/vault.keep',
  String.raw`\192.0.2.1\s\vault.keep`,
  // The device-path form of the same thing, which goes past the normal path parser.
  String.raw`\?\UNC\attacker.example\share\vault.keep`,
  // The device namespace. Not a file at all — this hands a named pipe to the container reader.
  String.raw`\.\pipe\keyhold`,
  // Rooted with no drive: resolves against whichever drive happens to be current.
  String.raw`\Users\me\vault.keep`,
  '/Users/me/vault.keep-as-windows',
  // Not absolute at all, kept here so the table is the whole answer rather than half of it.
  String.raw`..\vault.keep`,
  'vault.keep',
  '',
  'C:vault.keep',
];

describe('isLocalPathOn', () => {
  it('accepts a drive path and nothing else on Windows', () => {
    for (const path of LOCAL_WINDOWS) {
      expect(isLocalPathOn(path, 'win32'), path).toBe(true);
    }
    for (const path of REMOTE_OR_STRANGE_WINDOWS) {
      expect(isLocalPathOn(path, 'win32'), path).toBe(false);
    }
  });

  it('accepts a POSIX root and nothing else on POSIX', () => {
    expect(isLocalPathOn('/home/me/vault.keep', 'posix')).toBe(true);
    // Refused, and deliberately so: `//host/share/x` is the forward-slash spelling of a
    // Windows UNC share, and a POSIX branch that accepted a doubled root would have let it
    // through the platform-agnostic check at the IPC boundary. POSIX calls a leading `//`
    // implementation-defined and `path.posix.normalize` collapses it, so nothing local is
    // lost.
    expect(isLocalPathOn('//home/me/vault.keep', 'posix')).toBe(false);
    for (const path of ['home/me/vault.keep', '../vault.keep', '', String.raw`C:\vault.keep`]) {
      expect(isLocalPathOn(path, 'posix'), path).toBe(false);
    }
  });
});

describe('isLocalPath', () => {
  it('accepts either platform s local shape', () => {
    expect(isLocalPath(String.raw`C:\Users\me\vault.keep`)).toBe(true);
    expect(isLocalPath('/home/me/vault.keep')).toBe(true);
  });

  it('rejects every UNC and device form', () => {
    // The platform-agnostic version is the one at the IPC boundary, where the validator does
    // not know which OS the string was typed on. It must be no weaker than the specific one.
    for (const path of REMOTE_OR_STRANGE_WINDOWS) {
      if (path.startsWith('/') && !path.startsWith('//')) continue; // Legitimately local.
      expect(isLocalPath(path), path).toBe(false);
    }
  });

  it('is the union of the two platform answers, and no wider', () => {
    // Stated as a property rather than trusted from the implementation: if someone adds a
    // shape to `isLocalPath` without adding it to a platform, this fails.
    for (const path of [...LOCAL_WINDOWS, ...REMOTE_OR_STRANGE_WINDOWS, '/x', '//x']) {
      expect(isLocalPath(path), path).toBe(
        isLocalPathOn(path, 'win32') || isLocalPathOn(path, 'posix')
      );
    }
  });
});
