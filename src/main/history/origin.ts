// SPDX-License-Identifier: GPL-3.0-or-later
import { hostname, release, userInfo, networkInterfaces } from 'node:os';
import {
  AUDIT_LEVEL_FIELDS,
  type AuditPrivacyLevel,
  type ChangeOrigin,
  type HistoryAction,
} from '@shared/model/credential.js';
import type { NetworkProbe } from './network-name.js';

/**
 * Captures **where a change came from**: the device, the account, the platform, the
 * network.
 *
 * This is Keyhold's headline differentiator, and it is also the part of the app most
 * capable of embarrassing its user. The provenance lives inside the encrypted body, so the
 * file reveals none of it — but the file is the thing people copy to a USB stick and hand
 * to someone. `WORK-LAPTOP-7`, `anahat`, and the SSID of a home network are all real
 * information about a real person's life, and they end up in a document the user may share
 * without thinking about the history it carries.
 *
 * So capture is governed by an explicit privacy level, and the level is enforced **here**,
 * at the point of capture, not at the point of display. A field that was never captured
 * cannot leak, cannot be recovered by an attacker with the master password, and cannot be
 * un-hidden by a future version of the app that forgets why the setting existed. Filtering
 * at display time would have left all of it in the file.
 *
 * ## The levels
 *
 * | Level     | Captures                                                    |
 * | --------- | ----------------------------------------------------------- |
 * | `none`    | The action only. History still works; it just says nothing about where. |
 * | `device`  | Device name, platform, app version. **The default.**         |
 * | `network` | Adds the OS user and the network name.                       |
 * | `full`    | Adds the OS release and the local IP.                        |
 *
 * The default stops at `device` because that is the level that answers the question people
 * actually have — *"was this me, on my own machine?"* — while a network name says where
 * you were and an IP says something about the network you were on.
 *
 * ## Capture is synchronous. Detection is not.
 *
 * `capture()` never awaits anything, because it runs on the save path and a save must not
 * be able to hang (see `network-name.ts`). The network name comes from a cache that a
 * background refresh keeps warm. A cold or stale cache means the origin carries no network
 * name — which is a strictly better outcome than a save that waits on a subprocess.
 */

/** How long a detected network name is trusted before a refresh is triggered. */
export const NETWORK_CACHE_TTL_MS = 60_000;

export interface OriginCaptureOptions {
  readonly appVersion: string;
  readonly probe: NetworkProbe;
  /** Injectable so tests do not read the real machine. */
  readonly now?: () => number;
  readonly deviceName?: () => string;
  readonly osUser?: () => string;
  readonly osRelease?: () => string;
  readonly localIp?: () => string | null;
  readonly platform?: NodeJS.Platform;
  readonly networkTtlMs?: number;
}

/** Friendly platform names. `win32` and `darwin` are implementation trivia to a user. */
const PLATFORM_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

/**
 * The machine's first non-internal IPv4 address.
 *
 * `full` only. It is in the model because it distinguishes two machines that report the
 * same hostname — which happens more than people expect on default-named laptops — and out
 * of the default because it is a location signal.
 */
export function firstLocalIpv4(
  interfaces: NodeJS.Dict<
    { internal: boolean; family: string; address: string }[]
  > = networkInterfaces()
): string | null {
  for (const addresses of Object.values(interfaces)) {
    if (addresses === undefined) continue;
    for (const address of addresses) {
      if (!address.internal && address.family === 'IPv4') return address.address;
    }
  }
  return null;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export class OriginCapture {
  readonly #options: Required<Omit<OriginCaptureOptions, 'probe' | 'appVersion'>> & {
    readonly probe: NetworkProbe;
    readonly appVersion: string;
  };

  #networkName: string | null = null;
  #networkCheckedAt = 0;
  #refreshing: Promise<void> | null = null;

  constructor(options: OriginCaptureOptions) {
    this.#options = {
      appVersion: options.appVersion,
      probe: options.probe,
      now: options.now ?? Date.now,
      deviceName: options.deviceName ?? hostname,
      osUser: options.osUser ?? ((): string => userInfo().username),
      osRelease: options.osRelease ?? release,
      localIp: options.localIp ?? ((): string | null => firstLocalIpv4()),
      platform: options.platform ?? process.platform,
      networkTtlMs: options.networkTtlMs ?? NETWORK_CACHE_TTL_MS,
    };
  }

  /**
   * Builds the origin for one change.
   *
   * Fields are read one at a time, gated on `AUDIT_LEVEL_FIELDS`, rather than gathered
   * fully and then filtered — see the note on `record` below.
   *
   * `action` is captured at every level including `none`, because it is not provenance: it
   * is what the timeline entry *is*. A history with no verbs is not a history.
   */
  capture(action: HistoryAction, level: AuditPrivacyLevel): ChangeOrigin {
    const permitted = new Set<string>(AUDIT_LEVEL_FIELDS[level]);
    const origin: { action: HistoryAction } & Record<string, string> = { action };

    /**
     * Records one field, and only if it is both permitted and non-empty.
     *
     * Assigning through a single gate rather than building the full origin and filtering
     * it afterwards is the same reasoning as the safe projection: a field that was never
     * captured cannot leak, while one forgotten `delete` on a fully-built object puts the
     * user's hostname in a file they may hand to someone. It also keeps every value
     * *present* rather than explicitly `undefined`, which is what `exactOptionalPropertyTypes`
     * distinguishes and what JSON does to the difference on the way to disk.
     */
    const record = (
      field: Exclude<keyof ChangeOrigin, 'action'>,
      read: () => string | null | undefined
    ): void => {
      if (!permitted.has(field)) return;
      const value = nonEmpty(this.#safe(read));
      if (value !== undefined) origin[field] = value;
    };

    // A capture is also the moment we know the cache is being read, so it is the natural
    // place to notice it has gone stale. The refresh is fire-and-forget: this call returns
    // with whatever the cache holds now, and the *next* save gets the fresh value.
    if (permitted.has('networkName')) this.#refreshNetworkIfStale();

    record('deviceName', this.#options.deviceName);
    record('osUser', this.#options.osUser);
    record('platform', () => PLATFORM_NAMES[this.#options.platform] ?? this.#options.platform);
    record('osRelease', this.#options.osRelease);
    record('appVersion', () => this.#options.appVersion);
    record('networkName', () => this.#networkName);
    record('localIp', this.#options.localIp);

    return origin;
  }

  /** Forces a refresh and waits for it. For the settings screen's "test" button, not the save path. */
  async refreshNetwork(): Promise<string | null> {
    await this.#refresh();
    return this.#networkName;
  }

  /** The cached name, for display. Never triggers a probe. */
  get cachedNetworkName(): string | null {
    return this.#networkName;
  }

  #refreshNetworkIfStale(): void {
    const age = this.#options.now() - this.#networkCheckedAt;
    if (this.#networkCheckedAt !== 0 && age < this.#options.networkTtlMs) return;
    void this.#refresh();
  }

  #refresh(): Promise<void> {
    // One probe at a time. Without this, a burst of saves would spawn a `netsh` per save.
    if (this.#refreshing !== null) return this.#refreshing;

    this.#refreshing = this.#options.probe
      .detect()
      .then((name) => {
        this.#networkName = name;
      })
      .catch(() => {
        // A probe that throws means we do not know the network, not that the network is
        // gone. Keeping the last known value would be a lie about *when* it was true.
        this.#networkName = null;
      })
      .finally(() => {
        this.#networkCheckedAt = this.#options.now();
        this.#refreshing = null;
      });

    return this.#refreshing;
  }

  /**
   * `os.userInfo()` throws on a machine with no passwd entry for the running uid — rare,
   * but real in containers and on some locked-down corporate images. A credential save
   * must not fail because the audit trail could not name the user.
   */
  #safe<T>(read: () => T): T | undefined {
    try {
      return read();
    } catch {
      return undefined;
    }
  }
}
