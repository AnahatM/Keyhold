// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Whether a path names a file on **this machine's own storage**.
 *
 * ## Why this is a security check and not a formatting check
 *
 * On Windows, touching a path is not a local operation. `\\attacker.example\share\x.keep`
 * is a perfectly ordinary absolute path — `path.win32.isAbsolute` says so, it has no URL
 * scheme, no `..` segment, and a `.keep` extension — and the moment anything calls `stat`
 * on it the OS opens an **SMB connection to a host the attacker named** and, by default,
 * performs an NTLMv2 handshake with the logged-in user's credentials. Three separate
 * things go wrong at once:
 *
 *  - **an outbound network connection**, from an app whose hard rule 5 is *zero network by
 *    default* and whose only sanctioned request is the opt-in HIBP check;
 *  - **a credential disclosure** — the NTLMv2 response is offline-crackable and is the
 *    standard payload of a UNC-path phishing link;
 *  - **a synchronous hang** in the main process, before any window exists, for as long as
 *    the SMB connection takes to time out.
 *
 * None of that requires the file to exist, and none of it requires the user to do anything
 * beyond double-clicking a `.lnk` or a `.url` that someone sent them.
 *
 * So "absolute" is the wrong question. The question is whether the path names local
 * storage, and on Windows the only shape that does is a **drive letter followed by a
 * separator**. Everything else is rejected by construction:
 *
 * | Shape                    | Example                          | Why it is refused                                          |
 * | ------------------------ | -------------------------------- | ---------------------------------------------------------- |
 * | UNC share                | `\\host\share\v.keep`            | dials `host`; the finding above                            |
 * | Forward-slash UNC        | `//host/share/v.keep`            | the same thing — Windows accepts either separator          |
 * | Device path to a UNC     | `\\?\UNC\host\share\v.keep`      | the same thing, past the normal path parser                |
 * | Device namespace         | `\\.\pipe\name`                  | not a file at all; hands a named pipe to the container      |
 * | Rooted with no drive     | `\Users\me\v.keep`               | resolves against whichever drive is current, silently       |
 *
 * The allow-list is the point. A deny-list of the five rows above would be one Windows
 * path syntax away from being wrong again, and Windows has more path syntaxes than anyone
 * has a complete list of.
 *
 * ## POSIX
 *
 * A single leading `/`, and **not** a doubled one. macOS and Linux do not mount a remote
 * share because something read a path, so there is no equivalent of the attack above — but
 * `//host/share/v.keep` is a syntactically valid POSIX path *and* the forward-slash spelling
 * of a Windows UNC share, and {@link isLocalPath} does not know which platform the string
 * came from. Accepting a doubled root there would have let the attack straight through the
 * one check that most needed to stop it. POSIX calls a leading `//` implementation-defined
 * and `path.posix.normalize` collapses it, so refusing it costs nothing real.
 *
 * ## Why it lives in `shared/`
 *
 * Because two places need the same answer, and rule 8 says they get it from one list. The
 * OS hands paths to `src/main/shell/file-open-request.ts` (a double-clicked file, a
 * dragged file, an `argv` entry); the renderer hands them back to
 * `src/shared/ipc/validation.ts` (`requireVaultPath`, after a dialog the main process
 * opened). Both are untrusted for the same reason and were both, until this was written,
 * letting a UNC path through.
 *
 * Deliberately a regex over `node:path`: this module is compiled into the renderer's
 * project too, and must stay free of Node built-ins.
 */

/** `C:\…` or `C:/…`. The one Windows shape that names local storage. */
const WINDOWS_LOCAL = /^[A-Za-z]:[\\/]/;

/**
 * A POSIX root — and **not** a doubled one.
 *
 * `//attacker.example/share/vault.keep` is the forward-slash spelling of a Windows UNC
 * share and is treated as one by Windows, while also being a syntactically valid POSIX
 * path. A platform-agnostic check that accepted a bare leading `/` therefore accepted the
 * attack in the one place it most needed not to: the IPC boundary, which does not know
 * which OS the string came from.
 *
 * POSIX itself says a leading `//` is implementation-defined, and no local path on macOS
 * or Linux needs to be written that way — `path.posix.normalize` collapses it. So refusing
 * it costs nothing real and closes the one spelling that means two different things on two
 * platforms. Found by a test asserting the union property below, which is exactly what that
 * kind of test is for.
 */
const POSIX_ROOT = /^\/(?!\/)/;

/**
 * Whether `value` is an absolute path to local storage, under either platform's rules.
 *
 * Platform-agnostic on purpose: a validator at an IPC boundary does not know, and should
 * not need to ask, which OS the string was typed on. A Windows drive path is not a valid
 * POSIX path and a POSIX root is not a valid Windows path, so accepting either is not a
 * widening — it is the union of two disjoint sets, each of which is already the narrow
 * answer for its own platform.
 *
 * Callers that *do* know the platform — `parseFileOpenRequest`, which is given one — should
 * use {@link isLocalPathOn} instead and get the tighter answer.
 */
export function isLocalPath(value: string): boolean {
  return WINDOWS_LOCAL.test(value) || POSIX_ROOT.test(value);
}

/** The platform-specific answer, for a caller that knows which one it is on. */
export function isLocalPathOn(value: string, platform: 'win32' | 'posix'): boolean {
  return platform === 'win32' ? WINDOWS_LOCAL.test(value) : POSIX_ROOT.test(value);
}
