// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  FILE_OPEN_EXTENSIONS,
  fileOpenRequestsFromArgv,
  parseFileOpenRequest,
  type FileOpenOptions,
} from './file-open-request.js';

/**
 * A path arriving from outside the app.
 *
 * Double-clicking a file, dragging one onto the dock, a `.lnk` someone was sent, or the
 * `argv` of a *second process* that the single-instance lock handed to us. None of it is a
 * path we chose, and the IPC layer already refuses renderer-supplied paths for the same
 * reason.
 *
 * The platform and the "is it a file?" probe are injected, so Windows rules can be tested
 * on any machine and the not-a-file case needs no filesystem.
 */

const anything = (): boolean => true;
const nothing = (): boolean => false;

const win = (isFile: (path: string) => boolean = anything): FileOpenOptions => ({
  platform: 'win32',
  isFile,
});

const mac = (isFile: (path: string) => boolean = anything): FileOpenOptions => ({
  platform: 'darwin',
  isFile,
});

describe('accepting a real vault path', () => {
  it('accepts an absolute Windows path to a .keep', () => {
    const result = parseFileOpenRequest('C:\\Users\\Ana\\Vaults\\Personal.keep', win());

    expect(result).toEqual({
      ok: true,
      path: 'C:\\Users\\Ana\\Vaults\\Personal.keep',
      kind: 'vault',
    });
  });

  it('accepts an absolute POSIX path to a .keep', () => {
    const result = parseFileOpenRequest('/Users/ana/Vaults/Personal.keep', mac());

    expect(result).toEqual({ ok: true, path: '/Users/ana/Vaults/Personal.keep', kind: 'vault' });
  });

  it('is case-insensitive about the extension', () => {
    // A file created on a case-insensitive volume, or renamed in Explorer, is still a vault.
    expect(parseFileOpenRequest('C:\\v\\Work.KEEP', win())).toMatchObject({ ok: true });
  });

  /**
   * `.keep` and `.keepx` are not interchangeable and the caller has to be able to tell them
   * apart: a `.keep` is *the vault*, opened with the master password; a `.keepx` is *a
   * parcel* — a chosen subset under its own separate passphrase. Handing one to the other's
   * open path is a confusing failure at best.
   */
  it('distinguishes a vault, a parcel and a theme', () => {
    expect(parseFileOpenRequest('/v/a.keep', mac())).toMatchObject({ kind: 'vault' });
    expect(parseFileOpenRequest('/v/a.keepx', mac())).toMatchObject({ kind: 'parcel' });
    expect(parseFileOpenRequest('/v/a.keeptheme', mac())).toMatchObject({ kind: 'theme' });
  });
});

describe('rejecting what the OS should not have handed us', () => {
  it('rejects a non-string', () => {
    expect(parseFileOpenRequest(undefined, mac())).toEqual({ ok: false, reason: 'not-a-string' });
    expect(parseFileOpenRequest(42, mac())).toEqual({ ok: false, reason: 'not-a-string' });
    expect(parseFileOpenRequest(null, mac())).toEqual({ ok: false, reason: 'not-a-string' });
  });

  it('rejects an empty or blank path', () => {
    expect(parseFileOpenRequest('', mac())).toEqual({ ok: false, reason: 'empty' });
    expect(parseFileOpenRequest('   ', mac())).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects the wrong extension', () => {
    // Including the one that looks right and is not: a rolling backup that opens on
    // double-click invites the user to work inside a file the app is about to overwrite.
    expect(parseFileOpenRequest('/v/a.keepbak', mac())).toEqual({
      ok: false,
      reason: 'unsupported-extension',
    });
    expect(parseFileOpenRequest('/v/a.exe', mac())).toEqual({
      ok: false,
      reason: 'unsupported-extension',
    });
    expect(parseFileOpenRequest('/v/keep', mac())).toEqual({
      ok: false,
      reason: 'unsupported-extension',
    });
  });

  it('rejects a traversal segment rather than resolving it away', () => {
    // Resolving would silently *accept* the attempt and open whatever it pointed at. A `..`
    // in input we did not construct has no legitimate meaning here.
    expect(parseFileOpenRequest('/v/../../etc/shadow.keep', mac())).toEqual({
      ok: false,
      reason: 'traversal',
    });
    expect(parseFileOpenRequest('C:\\v\\..\\..\\Windows\\a.keep', win())).toEqual({
      ok: false,
      reason: 'traversal',
    });
  });

  it('does not mistake an ordinary name containing dots for a traversal', () => {
    expect(parseFileOpenRequest('/v/my..vault.keep', mac())).toMatchObject({ ok: true });
    expect(parseFileOpenRequest('/v/..hidden.keep', mac())).toMatchObject({ ok: true });
  });

  it('rejects a relative path', () => {
    // It would resolve against the process working directory, which for a double-clicked
    // file is whatever the shell felt like — frequently C:\Windows\System32.
    expect(parseFileOpenRequest('vault.keep', win())).toEqual({
      ok: false,
      reason: 'not-absolute',
    });
    expect(parseFileOpenRequest('./vault.keep', mac())).toEqual({
      ok: false,
      reason: 'not-absolute',
    });
  });

  it('rejects a URL', () => {
    expect(parseFileOpenRequest('file:///Users/ana/a.keep', mac())).toEqual({
      ok: false,
      reason: 'looks-like-a-url',
    });
    expect(parseFileOpenRequest('https://evil.example/a.keep', mac())).toEqual({
      ok: false,
      reason: 'looks-like-a-url',
    });
    expect(parseFileOpenRequest('keyhold://open/a.keep', mac())).toEqual({
      ok: false,
      reason: 'looks-like-a-url',
    });
  });

  it('does not mistake a Windows drive letter for a URL scheme', () => {
    expect(parseFileOpenRequest('C:\\v\\a.keep', win())).toMatchObject({ ok: true });
  });

  it('rejects control characters, including a NUL truncation', () => {
    expect(parseFileOpenRequest('/v/a.keep\u0000.exe', mac())).toEqual({
      ok: false,
      reason: 'control-characters',
    });
    expect(parseFileOpenRequest('/v/a\nb.keep', mac())).toEqual({
      ok: false,
      reason: 'control-characters',
    });
  });

  it('rejects something that is not a regular file', () => {
    // A directory named `Vault.keep` is perfectly legal to create, and handing one to the
    // container reader produces an EISDIR several layers down instead of a clear refusal.
    expect(parseFileOpenRequest('/v/Vault.keep', mac(nothing))).toEqual({
      ok: false,
      reason: 'not-a-file',
    });
  });

  it('checks the cheap things before touching the disk', () => {
    let probed = false;
    const probe = (): boolean => {
      probed = true;
      return true;
    };

    parseFileOpenRequest('/v/a.txt', mac(probe));

    expect(probed).toBe(false);
  });
});

describe('reading a command line', () => {
  it('finds the document among the switches', () => {
    const argv = [
      'C:\\Program Files\\Keyhold\\Keyhold.exe',
      '--no-sandbox',
      'C:\\v\\Personal.keep',
      '--enable-features=Something',
    ];

    const found = fileOpenRequestsFromArgv(argv, { ...win(), skipCount: 1 });

    expect(found.map((entry) => entry.path)).toEqual(['C:\\v\\Personal.keep']);
  });

  it('skips the script path in a development run', () => {
    // argv[0] is Electron, argv[1] is the script it was pointed at. Neither is a document,
    // and `out/main/index.js` is not one either — but only the caller knows which mode
    // this is, which is why skipCount is a parameter.
    const argv = ['/usr/bin/electron', '/repo/out/main/index.js', '/v/Personal.keep'];

    const found = fileOpenRequestsFromArgv(argv, { ...mac(), skipCount: 2 });

    expect(found.map((entry) => entry.path)).toEqual(['/v/Personal.keep']);
  });

  it('returns nothing for a plain launch', () => {
    expect(fileOpenRequestsFromArgv(['/app/Keyhold'], { ...mac(), skipCount: 1 })).toEqual([]);
  });

  it('drops the invalid entries and keeps the valid one', () => {
    const argv = [
      'app',
      '/v/../escape.keep',
      'relative.keep',
      'https://evil.example/a.keep',
      '/v/Good.keep',
    ];

    const found = fileOpenRequestsFromArgv(argv, { ...mac(), skipCount: 1 });

    expect(found.map((entry) => entry.path)).toEqual(['/v/Good.keep']);
  });
});

describe('the extension table', () => {
  it('matches the file associations Keyhold registers', () => {
    // electron-builder.yml registers exactly these three, and deliberately not `.keepbak`.
    expect(Object.keys(FILE_OPEN_EXTENSIONS).sort()).toEqual(['.keep', '.keeptheme', '.keepx']);
  });
});
