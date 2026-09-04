// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

/**
 * Finds a human-meaningful name for the network the machine is currently on.
 *
 * This is the "and from which network" half of Keyhold's audit trail. It is the only part
 * of the app that shells out, so it is worth being explicit about what that costs and how
 * it is contained.
 *
 * ## Nothing here may ever block a save
 *
 * `netsh` and `system_profiler` are slow — tens of milliseconds on a good day, seconds on
 * a machine with a confused adapter, and occasionally never on a machine with a hung
 * network stack. A credential save that waits on any of that is a credential save that can
 * hang, and a password manager that hangs while saving is worse than one that records no
 * network name at all.
 *
 * So this module is asynchronous, cached, and entirely optional. `OriginCapture` reads the
 * cache synchronously and refreshes it in the background; if the cache is cold the origin
 * simply carries no network name. That is the correct trade every time.
 *
 * ## Why `execFile`, never `exec`
 *
 * `exec` runs the command through a shell, which means anything interpolated into it is a
 * shell injection surface. Nothing here interpolates user input today — but a future
 * "probe this interface" argument would, and the safe form costs nothing now.
 *
 * ## Why both binaries are named by absolute path
 *
 * `execFile` with a bare program name resolves through the OS search order, and on Windows
 * `CreateProcess` begins that search with the application directory and — depending on
 * `SafeProcessSearchMode` — the current working directory, both ahead of `%PATH%`. A
 * `netsh.exe` dropped in either would then be executed by Keyhold, in Keyhold's process
 * context, on the ordinary save path. That is not hypothetical for the planned portable
 * Windows build, which by design lives in a user-writable folder. The macOS branch already
 * used an absolute path; `netshPath()` makes the Windows branch match. A wrong or missing
 * path collapses to `null` like every other failure here, so being strict costs nothing.
 *
 * ## Why the output parsing is so defensive
 *
 * These are localised, undocumented, human-readable CLI outputs that change between OS
 * versions. `netsh` prints `SSID` in the user's display language; `system_profiler` has
 * reorganised its keys more than once. Every parser here is allowed to fail, and failing
 * means "no network name", never an exception and never a wrong answer.
 */

const PROBE_TIMEOUT_MS = 2_000;
/** Output past this is certainly not an SSID line we understand; stop reading it. */
const PROBE_MAX_OUTPUT_BYTES = 512 * 1024;

/**
 * The absolute path to `netsh.exe`, so the OS search order never gets a say.
 *
 * `%SystemRoot%` rather than a hardcoded `C:\Windows` because Windows genuinely does get
 * installed elsewhere; the literal is only the fallback for an environment that has lost it.
 * Exported for the guard test that asserts this is never a bare name again.
 */
export function netshPath(): string {
  const systemRoot = process.env.SystemRoot;
  const root = systemRoot !== undefined && systemRoot !== '' ? systemRoot : 'C:\\Windows';
  return join(root, 'System32', 'netsh.exe');
}

/** The absolute path to `system_profiler`, for the same reason as `netshPath`. */
export const SYSTEM_PROFILER_PATH = '/usr/sbin/system_profiler';

/**
 * `nmcli`, for Linux. Absolute for the same reason as the two above: a bare name resolves
 * through `PATH`, and `PATH` is inherited from whatever launched the app.
 *
 * NetworkManager is what desktop Linux overwhelmingly runs, and `nmcli` is the only query
 * tool that is both stable across distributions and does not need root. When it is absent —
 * a machine running `systemd-networkd`, `iwd` alone, or nothing at all — `runCommand`
 * answers `null` and the interface-name fallback applies, which is the same graceful
 * degradation the other two platforms already have.
 */
export const NMCLI_PATH = '/usr/bin/nmcli';

/** nmcli escapes a colon inside a network name as a backslash-colon pair. */
const ESCAPED_COLON = /\\:/g;

/** A network name we will never record, because it identifies nothing. */
const USELESS_NAMES = new Set(['', 'none', 'n/a', 'not associated', 'unknown', '<none>']);

export interface NetworkProbe {
  /** Resolves to a network name, or `null` when there isn't one to be had. */
  detect(): Promise<string | null>;
}

function runCommand(command: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout) => {
        // Every failure mode — missing binary, non-zero exit, timeout, oversized output —
        // resolves to null. A network name is a nice-to-have; nothing above may throw.
        resolve(error ? null : stdout);
      }
    );
  });
}

function cleanName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  if (USELESS_NAMES.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

/**
 * Parses `netsh wlan show interfaces`.
 *
 * The output pairs `Key : Value` with the key localised. Matching the literal string
 * "SSID" would fail on a non-English Windows install, so this matches the *shape*: the
 * first key whose name ends in `SSID` and is not `BSSID`. `BSSID` is the access point's
 * MAC address — recording that instead of the network name would be both wrong and a
 * meaningfully worse privacy leak, so it is excluded by name rather than by luck.
 */
export function parseNetshSsid(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    if (!/ssid$/i.test(key) || /bssid$/i.test(key)) continue;

    const name = cleanName(line.slice(separator + 1));
    if (name !== null) return name;
  }
  return null;
}

/**
 * Parses `nmcli -t -f ACTIVE,SSID device wifi`.
 *
 * Each line is `yes:Network name` or `no:Other network`. A colon inside the name is escaped
 * by nmcli as `\:`, so the split is on the **first unescaped** colon — a network called
 * `Cafe: Free WiFi` would otherwise be truncated to `Cafe`.
 *
 * A machine on Ethernet has wifi devices with no active connection, and one with wifi off
 * has no lines at all. Both answer `null`, and the interface-name fallback takes over.
 */
export function parseNmcliSsid(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith('yes:')) continue;
    const name = cleanName(line.slice(4).replace(ESCAPED_COLON, ':'));
    if (name !== null) return name;
  }
  return null;
}

/**
 * Parses `system_profiler SPAirPortDataType`.
 *
 * macOS 14 removed the SSID from `airport -I` and then removed the binary itself, so this
 * reads the profiler's nested "Current Network Information" block instead: the network
 * name is the sole key on the line *after* that heading, given as `Name:` with no value.
 */
export function parseAirportNetwork(output: string): string | null {
  const lines = output.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!/current network information/i.test(lines[index] ?? '')) continue;

    const candidate = lines[index + 1];
    if (candidate === undefined) return null;

    // The heading's successor is `        <name>:` — a key with no value.
    const name = cleanName(candidate.replace(/:\s*$/, ''));
    if (name !== null) return name;
  }
  return null;
}

/**
 * The last resort: the name of the interface carrying the machine's outbound address.
 *
 * Far less useful than an SSID — "Ethernet" tells you little — but it does distinguish a
 * change made at a desk from one made on a laptop's Wi-Fi, and it works on every platform
 * with no subprocess at all. Internal (loopback) interfaces are skipped because every
 * machine has one and it identifies nothing.
 */
export function activeInterfaceName(
  interfaces: NodeJS.Dict<{ internal: boolean; family: string }[]> = networkInterfaces()
): string | null {
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (addresses === undefined) continue;
    if (addresses.some((address) => !address.internal && address.family === 'IPv4')) {
      return cleanName(name);
    }
  }
  return null;
}

/** The real probe. Injectable everywhere it is used, so no test ever spawns a process. */
export class SystemNetworkProbe implements NetworkProbe {
  readonly #platform: NodeJS.Platform;

  constructor(platform: NodeJS.Platform = process.platform) {
    this.#platform = platform;
  }

  async detect(): Promise<string | null> {
    const ssid = await this.#detectSsid();
    return ssid ?? activeInterfaceName();
  }

  async #detectSsid(): Promise<string | null> {
    if (this.#platform === 'win32') {
      const output = await runCommand(netshPath(), ['wlan', 'show', 'interfaces']);
      return output === null ? null : parseNetshSsid(output);
    }
    if (this.#platform === 'darwin') {
      const output = await runCommand(SYSTEM_PROFILER_PATH, [
        'SPAirPortDataType',
        '-detailLevel',
        'basic',
      ]);
      return output === null ? null : parseAirportNetwork(output);
    }
    if (this.#platform === 'linux') {
      // `-t` for terse, `-f` for the two fields we want. The output is one line per
      // connection, `yes:Name` or `no:Name`, so the active one is found by prefix rather
      // than by parsing a table whose column widths depend on the terminal.
      const output = await runCommand(NMCLI_PATH, ['-t', '-f', 'ACTIVE,SSID', 'device', 'wifi']);
      return output === null ? null : parseNmcliSsid(output);
    }
    return null;
  }
}
