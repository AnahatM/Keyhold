// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { AUDIT_LEVEL_FIELDS, AUDIT_PRIVACY_LEVELS } from '@shared/model/credential.js';
import { firstLocalIpv4, OriginCapture } from './origin.js';
import { activeInterfaceName, parseAirportNetwork, parseNetshSsid } from './network-name.js';

/**
 * Origin capture.
 *
 * The security-relevant test in this file is the privacy-level sweep: it asserts that each
 * level captures **exactly** what `AUDIT_LEVEL_FIELDS` says and not one field more. That
 * matters because the level is enforced at capture time — a field that leaks past it is
 * written into the encrypted file permanently, and no display-time filter can take it back
 * out of a vault the user has already copied to a USB stick.
 *
 * Every machine read is injected. No test here reads the real hostname, and no test spawns
 * a subprocess.
 */

/** Values chosen so a leak is unmistakable in a failure message. */
const READS = {
  deviceName: () => 'LEAK-DEVICE',
  osUser: () => 'LEAK-USER',
  osRelease: () => 'LEAK-RELEASE',
  localIp: () => 'LEAK-IP',
} as const;

function capture(overrides: Partial<ConstructorParameters<typeof OriginCapture>[0]> = {}) {
  return new OriginCapture({
    appVersion: '0.1.0',
    probe: { detect: () => Promise.resolve('LEAK-NETWORK') },
    platform: 'win32',
    ...READS,
    ...overrides,
  });
}

describe('privacy levels', () => {
  it.each(AUDIT_PRIVACY_LEVELS)('%s captures exactly what it declares', async (level) => {
    const subject = capture();
    // Warm the cache first, so a missing network name in the result means the level
    // excluded it rather than that the probe had not run yet.
    await subject.refreshNetwork();

    const origin = subject.capture('update', level);
    const permitted = new Set<string>(AUDIT_LEVEL_FIELDS[level]);

    for (const key of Object.keys(origin)) {
      expect(permitted.has(key), `${level} captured "${key}", which it does not permit`).toBe(true);
    }
  });

  it('records nothing but the verb at level none', () => {
    expect(capture().capture('create', 'none')).toEqual({ action: 'create' });
  });

  it('records the device but never the user or the network at the default level', () => {
    const origin = capture().capture('update', 'device');
    expect(origin.deviceName).toBe('LEAK-DEVICE');
    expect(origin.platform).toBe('Windows');
    expect(origin.appVersion).toBe('0.1.0');
    expect(origin.osUser).toBeUndefined();
    expect(origin.networkName).toBeUndefined();
    expect(origin.localIp).toBeUndefined();
  });

  it('adds the user and the network at level network, but not the IP', async () => {
    const subject = capture();
    await subject.refreshNetwork();

    const origin = subject.capture('update', 'network');
    expect(origin.osUser).toBe('LEAK-USER');
    expect(origin.networkName).toBe('LEAK-NETWORK');
    expect(origin.localIp).toBeUndefined();
    expect(origin.osRelease).toBeUndefined();
  });

  it('captures everything at level full', async () => {
    const subject = capture();
    await subject.refreshNetwork();

    expect(subject.capture('update', 'full')).toEqual({
      action: 'update',
      deviceName: 'LEAK-DEVICE',
      osUser: 'LEAK-USER',
      platform: 'Windows',
      osRelease: 'LEAK-RELEASE',
      appVersion: '0.1.0',
      networkName: 'LEAK-NETWORK',
      localIp: 'LEAK-IP',
    });
  });

  it('never probes the network at a level that would not record it', () => {
    const detect = vi.fn(() => Promise.resolve<string | null>('LEAK-NETWORK'));
    const subject = capture({ probe: { detect } });

    subject.capture('update', 'none');
    subject.capture('update', 'device');
    expect(detect).not.toHaveBeenCalled();

    subject.capture('update', 'network');
    expect(detect).toHaveBeenCalledTimes(1);
  });
});

describe('capture is synchronous and cannot hang a save', () => {
  it('returns immediately with no network name while the probe is still running', () => {
    // The property the whole design exists for: a credential save must not wait on a
    // subprocess. A cold cache means "no network name", never "block until we know".
    // A probe that never settles: the machine whose network stack has hung.
    const neverSettles = (): Promise<string | null> => new Promise<string | null>(() => undefined);
    const subject = capture({ probe: { detect: neverSettles } });

    const origin = subject.capture('update', 'network');
    expect(origin.networkName).toBeUndefined();
    expect(origin.deviceName).toBe('LEAK-DEVICE');
  });

  it('picks the name up on the next save once the probe resolves', async () => {
    const subject = capture();
    expect(subject.capture('update', 'network').networkName).toBeUndefined();

    await subject.refreshNetwork();
    expect(subject.capture('update', 'network').networkName).toBe('LEAK-NETWORK');
  });

  it('runs one probe at a time under a burst of saves', async () => {
    // Without the in-flight guard, a bulk import would spawn a `netsh` per record.
    const detect = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          setTimeout(() => {
            resolve('WIFI');
          }, 5);
        })
    );
    const subject = capture({ probe: { detect } });

    for (let index = 0; index < 20; index += 1) {
      subject.capture('update', 'network');
    }
    await subject.refreshNetwork();
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it('re-probes only after the cache goes stale', async () => {
    let now = 1_000;
    const detect = vi.fn(() => Promise.resolve<string | null>('WIFI'));
    const subject = capture({ probe: { detect }, now: () => now, networkTtlMs: 60_000 });

    await subject.refreshNetwork();
    expect(detect).toHaveBeenCalledTimes(1);

    now += 30_000;
    subject.capture('update', 'network');
    expect(detect).toHaveBeenCalledTimes(1);

    now += 40_000;
    subject.capture('update', 'network');
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it('forgets the network name when a probe fails rather than keeping a stale one', async () => {
    let fail = false;
    const subject = capture({
      probe: {
        detect: () =>
          fail ? Promise.reject(new Error('adapter gone')) : Promise.resolve<string | null>('WIFI'),
      },
    });

    await subject.refreshNetwork();
    expect(subject.cachedNetworkName).toBe('WIFI');

    fail = true;
    await subject.refreshNetwork();
    // Keeping "WIFI" would be a lie about *when* it was true, recorded in an audit trail.
    expect(subject.cachedNetworkName).toBeNull();
  });
});

describe('reading the machine cannot break a save', () => {
  it('omits a field whose read throws', () => {
    // `os.userInfo()` genuinely throws on a machine with no passwd entry for the running
    // uid. A credential save must not fail because the audit trail could not name the user.
    const origin = capture({
      osUser: () => {
        throw new Error('no passwd entry');
      },
    }).capture('update', 'network');

    expect(origin.osUser).toBeUndefined();
    expect(origin.deviceName).toBe('LEAK-DEVICE');
  });

  it('omits an empty or whitespace-only value rather than recording it', () => {
    const origin = capture({ deviceName: () => '   ' }).capture('update', 'device');
    expect('deviceName' in origin).toBe(false);
  });

  it('leaves no explicitly-undefined keys behind', () => {
    // `exactOptionalPropertyTypes` treats absent and undefined as different, and JSON drops
    // the latter — so the in-memory object must already agree with what the file will hold.
    const origin = capture({ deviceName: () => '' }).capture('update', 'full');
    expect(Object.values(origin).every((value) => value !== undefined)).toBe(true);
  });

  it('names the platform in words rather than in node trivia', () => {
    expect(capture({ platform: 'darwin' }).capture('update', 'device').platform).toBe('macOS');
    expect(capture({ platform: 'win32' }).capture('update', 'device').platform).toBe('Windows');
    // An unrecognised platform passes through rather than being dropped or guessed at.
    expect(capture({ platform: 'aix' }).capture('update', 'device').platform).toBe('aix');
  });
});

describe('network name parsing', () => {
  const netsh = [
    'There is 1 interface on the system:',
    '',
    '    Name                   : Wi-Fi',
    '    State                  : connected',
    '    SSID                   : Home Network',
    '    BSSID                  : a1:b2:c3:d4:e5:f6',
    '    Signal                 : 92%',
  ].join('\r\n');

  it('reads the SSID from netsh output', () => {
    expect(parseNetshSsid(netsh)).toBe('Home Network');
  });

  it('never mistakes the BSSID for the network name', () => {
    // The BSSID is the access point's MAC address. Recording it instead of the SSID would
    // be both wrong and a meaningfully worse privacy leak, so it is excluded by name.
    expect(parseNetshSsid(netsh)).not.toContain(':');
  });

  it('matches a localised SSID key', () => {
    // `netsh` prints its keys in the user display language. Matching the literal string
    // "SSID" would fail on every non-English Windows install.
    expect(parseNetshSsid('    Nombre de SSID       : Casa\r\n')).toBe('Casa');
  });

  it('returns null when there is no SSID line at all', () => {
    expect(parseNetshSsid('There is 0 interface on the system:')).toBeNull();
  });

  it('rejects a placeholder rather than recording it', () => {
    expect(parseNetshSsid('    SSID                   : \r\n')).toBeNull();
    expect(parseNetshSsid('    SSID                   : N/A\r\n')).toBeNull();
  });

  it('reads the network name from system_profiler output', () => {
    const output = [
      '      Current Network Information:',
      '        Home Network:',
      '          PHY Mode: 802.11ax',
      '          Channel: 44',
    ].join('\n');
    expect(parseAirportNetwork(output)).toBe('Home Network');
  });

  it('returns null when the profiler block is truncated', () => {
    expect(parseAirportNetwork('      Current Network Information:')).toBeNull();
  });

  it('falls back to the interface carrying the outbound address', () => {
    expect(
      activeInterfaceName({
        lo: [{ internal: true, family: 'IPv4' }],
        Ethernet: [{ internal: false, family: 'IPv4' }],
      })
    ).toBe('Ethernet');
  });

  it('never reports a loopback interface, which identifies nothing', () => {
    expect(activeInterfaceName({ lo: [{ internal: true, family: 'IPv4' }] })).toBeNull();
  });
});

describe('firstLocalIpv4', () => {
  it('skips internal addresses', () => {
    expect(
      firstLocalIpv4({
        lo: [{ internal: true, family: 'IPv4', address: '127.0.0.1' }],
        Wi_Fi: [{ internal: false, family: 'IPv4', address: '192.168.1.20' }],
      })
    ).toBe('192.168.1.20');
  });

  it('returns null on a machine with no external IPv4', () => {
    expect(firstLocalIpv4({ lo: [{ internal: true, family: 'IPv4', address: '127.0.0.1' }] })).toBe(
      null
    );
  });
});
