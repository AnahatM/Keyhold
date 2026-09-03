// SPDX-License-Identifier: GPL-3.0-or-later
import { posix, win32 } from 'node:path';
import type { Platform } from '@shared/ipc/api.js';
import { isLocalPathOn } from '@shared/model/local-path.js';

/**
 * Validating a path the operating system hands us.
 *
 * Double-clicking a `.keep` file, dragging one onto the dock icon, or launching
 * `Keyhold.exe C:\...\vault.keep` all end here. **This is untrusted input arriving from
 * outside the app** — from a file manager, a browser download, an email attachment, a
 * malicious `.lnk`, or a second process that got the single-instance lock's `argv` handed
 * to it. It is not a path the user picked in one of our own dialogs, and it must not be
 * treated like one.
 *
 * `src/main/ipc/register.ts` already makes the corresponding point from the other side: the
 * renderer never supplies a path, because a compromised renderer would then choose what the
 * main process opens. The OS is a different source with the same property — we did not
 * choose the string, so we check it before it reaches the vault layer.
 *
 * ## What is checked, and why each one
 *
 * - **Type and emptiness.** `process.argv` is `string[]` at compile time and whatever the
 *   launcher passed at runtime.
 * - **NUL and control characters.** A `vault.keep\0.exe` style truncation attack is old, and
 *   Node throws on NUL in a path — but it throws *deep inside an fs call*, after the value
 *   has already been threaded through the session. Rejecting at the boundary means the error
 *   is about the input rather than about a filesystem operation.
 * - **URLs, not paths.** `file:///…`, `http://…` and Windows UNC-with-scheme forms are
 *   rejected outright. The `open-file` event and `argv` deliver paths; anything with a
 *   scheme arrived from a protocol handler we have not registered and do not want.
 * - **Traversal segments.** A `..` in input we did not construct has no legitimate meaning
 *   here and is the signature of an attempt to escape a directory the sender expected us to
 *   stay inside. Resolving it away would silently accept the attempt.
 * - **Local storage only.** The check that matters most, and the one that was missing: on
 *   Windows an absolute path can name another machine, and merely *stat*ing it dials out
 *   over SMB and hands over an NTLMv2 handshake. See `@shared/model/local-path.ts`.
 * - **Absolute only.** A relative path resolves against the process working directory, which
 *   for a double-clicked file is whatever the shell felt like and for a packaged app is
 *   frequently `C:\Windows\System32`. "Open the vault next to wherever we happen to be" is
 *   not a behaviour anyone wants.
 * - **Extension allow-list.** `.keep`, `.keepx`, `.keeptheme` and nothing else — matching the
 *   `fileAssociations` block in `electron-builder.yml`, and deliberately *not* `.keepbak`:
 *   a rolling backup that opens on double-click invites the user to work inside a file the
 *   app is about to overwrite.
 * - **It is a file.** A directory named `Vault.keep` is a perfectly legal thing to create,
 *   and handing one to the container reader produces an `EISDIR` several layers down.
 *
 * ## Purity
 *
 * The platform and the "is this a file?" probe are injected. That is not test ceremony: it
 * is what lets Windows path rules be tested on a Mac and vice versa, and what lets the
 * not-a-file case be tested without creating one. `resolveFileOpenRequest` in
 * `shell-controller.ts` supplies the real `statSync`.
 */

/** What a validated path turned out to be. `.keep` and `.keepx` are NOT interchangeable. */
export type FileOpenKind =
  /** `.keep` — *the vault*, opened with the master password. */
  | 'vault'
  /** `.keepx` — *a parcel*: a chosen subset under its own separate passphrase. */
  | 'parcel'
  /** `.keeptheme` — a colour theme, imported and read, never written back to. */
  | 'theme';

/** The single source for what the shell will accept. Mirrors `electron-builder.yml`. */
export const FILE_OPEN_EXTENSIONS: Readonly<Record<string, FileOpenKind>> = {
  '.keep': 'vault',
  '.keepx': 'parcel',
  '.keeptheme': 'theme',
};

export type FileOpenRejection =
  | 'not-a-string'
  | 'empty'
  | 'control-characters'
  | 'looks-like-a-url'
  | 'traversal'
  | 'not-absolute'
  /** A UNC share, a device path, or a drive-less root. See `isLocalPathOn`. */
  | 'not-local-storage'
  | 'unsupported-extension'
  | 'not-a-file';

export interface FileOpenAccepted {
  readonly ok: true;
  readonly path: string;
  readonly kind: FileOpenKind;
}

export interface FileOpenRejected {
  readonly ok: false;
  readonly reason: FileOpenRejection;
}

export type FileOpenResult = FileOpenAccepted | FileOpenRejected;

export interface FileOpenOptions {
  readonly platform: Platform;
  /** True when the path names an existing regular file. Injected; see the file header. */
  readonly isFile: (path: string) => boolean;
}

/** `..` as a whole segment, on either separator. `..foo` and `foo..bar` are ordinary names. */
const TRAVERSAL_SEGMENT = /(^|[\\/])\.\.([\\/]|$)/;

/** Anything of the form `scheme:` at the start. Excludes `C:\…`, which is one letter. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]+:/i;

// eslint-disable-next-line no-control-regex -- Matching control characters is the point.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function reject(reason: FileOpenRejection): FileOpenRejected {
  return { ok: false, reason };
}

/**
 * Validates one path from the OS.
 *
 * Returns a result rather than throwing. A bad `argv` entry is a normal occurrence — every
 * Electron switch, every `--inspect`, every stray argument from a launcher goes through
 * here — and an exception per switch would be noise around the one case that matters.
 */
export function parseFileOpenRequest(raw: unknown, options: FileOpenOptions): FileOpenResult {
  if (typeof raw !== 'string') return reject('not-a-string');

  const value = raw.trim();
  if (value === '') return reject('empty');
  if (CONTROL_CHARACTERS.test(value)) return reject('control-characters');
  if (URL_SCHEME.test(value)) return reject('looks-like-a-url');
  if (TRAVERSAL_SEGMENT.test(value)) return reject('traversal');

  // The platform decides what "absolute" and "extension" mean. `C:\x` is absolute on
  // Windows and a relative filename containing a colon on POSIX; getting this from the
  // ambient process instead would make the check untestable and, on the day someone runs
  // the tests on the other OS, wrong.
  const path = options.platform === 'win32' ? win32 : posix;
  if (!path.isAbsolute(value)) return reject('not-absolute');

  // Absolute is not the same as local, and on Windows the gap between them is a network
  // connection. `\host\sharev.keep` satisfies every check above and every check below,
  // and `statSync` on it opens an SMB session to `host` with an NTLMv2 handshake carrying
  // the logged-in user's credentials -- from an app whose hard rule 5 is zero network by
  // default, before a window has even been created. `isLocalPathOn` is an allow-list of the
  // shapes that name local storage, for the reason given in full in that module: a
  // deny-list of the UNC forms is one Windows path syntax away from being wrong again.
  if (!isLocalPathOn(value, options.platform === 'win32' ? 'win32' : 'posix')) {
    return reject('not-local-storage');
  }

  const kind = FILE_OPEN_EXTENSIONS[path.extname(value).toLowerCase()];
  if (kind === undefined) return reject('unsupported-extension');

  // Last, because it is the only check that touches the disk. Everything cheap and
  // certain runs first.
  if (!options.isFile(value)) return reject('not-a-file');

  return { ok: true, path: path.normalize(value), kind };
}

/**
 * Every openable file in a command line.
 *
 * Electron's `argv` is a mixed bag: the executable, possibly the script path in
 * development, Chromium's own switches, and — somewhere in there — the file the user
 * double-clicked. Switches are skipped by their leading dash rather than by matching a list
 * of known Electron flags, because that list is Chromium's and it changes every release.
 *
 * `skipCount` is the caller's, because only the caller knows whether this is a packaged
 * build (argv[0] is the app) or a development run (argv[0] is Electron, argv[1] is the
 * script). Guessing it here would mean guessing wrong in one of the two modes.
 */
export function fileOpenRequestsFromArgv(
  argv: readonly string[],
  options: FileOpenOptions & { readonly skipCount: number }
): readonly FileOpenAccepted[] {
  const accepted: FileOpenAccepted[] = [];

  for (const argument of argv.slice(Math.max(0, options.skipCount))) {
    if (argument.startsWith('-')) continue;
    const result = parseFileOpenRequest(argument, options);
    if (result.ok) accepted.push(result);
  }

  return accepted;
}
