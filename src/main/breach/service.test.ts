// SPDX-License-Identifier: GPL-3.0-or-later
import { DEFAULT_BREACH_CHECK_SETTINGS, type BreachCheckSettings } from '@shared/model/breach.js';
import { describe, expect, it, vi } from 'vitest';
import { NetworkPolicy } from '../network-policy.js';
import { PwnedPasswordsClient } from './client.js';
import { BreachService } from './service.js';

/**
 * Guard: the two obligations a composition root owes.
 *
 * Both were written into comments and left for whoever finally built one — an audit found
 * them, and `network-policy.test.ts` asserts that the file importing the transport at least
 * *mentions* them. Mentioning is not honouring, which is what this file is for.
 *
 *  1. Ask `NetworkPolicy` before constructing, and stop being permitted the moment either
 *     switch moves.
 *  2. Drop the client — and its range cache — on lock. Those cached keys are the 20-bit
 *     prefixes of the open vault's passwords.
 *
 * Nothing here opens a socket: `build` is injected, so a "client" is a marker object and the
 * question is only ever *whether one was built*.
 */

interface FakeClient {
  readonly id: number;
  cleared: number;
  clearCache: () => void;
}

function harness(options: { networkAllowed: boolean; settings?: BreachCheckSettings }) {
  const state = {
    networkAllowed: options.networkAllowed,
    settings: options.settings ?? { ...DEFAULT_BREACH_CHECK_SETTINGS, enabled: true },
  };
  const built: FakeClient[] = [];

  const policy = new NetworkPolicy({ networkAllowed: () => state.networkAllowed });
  const service = new BreachService({
    policy,
    settings: () => state.settings,
    build: () => {
      const client: FakeClient = {
        id: built.length,
        cleared: 0,
        clearCache: () => {
          client.cleared += 1;
        },
      };
      built.push(client);
      return client as never;
    },
  });

  return { state, policy, service, built };
}

describe('asking the policy before constructing', () => {
  it('builds nothing while the kill-switch is off', () => {
    // The load-bearing assertion. "Off" has to mean no transport was ever constructed, not a
    // transport that promises not to be used — with none, a password is never even hashed.
    const { service, built } = harness({ networkAllowed: false });
    expect(service.client()).toBeNull();
    expect(built).toEqual([]);
  });

  it('builds nothing while the vault setting is off, even with the network allowed', () => {
    const { service, built } = harness({
      networkAllowed: true,
      settings: { ...DEFAULT_BREACH_CHECK_SETTINGS, enabled: false },
    });
    expect(service.client()).toBeNull();
    expect(built).toEqual([]);
  });

  it('builds one only when both switches say yes', () => {
    const { service, built } = harness({ networkAllowed: true });
    expect(service.client()).not.toBeNull();
    expect(built).toHaveLength(1);
  });

  it('reuses the client across calls, so the range cache survives a second sweep', () => {
    // Reuse is the point: rebuilding per sweep would re-ask the service for prefixes it
    // already had, which is both slower and more of someone's free API than we need.
    const { service, built } = harness({ networkAllowed: true });
    expect(service.client()).toBe(service.client());
    expect(built).toHaveLength(1);
  });
});

describe('the switch moving underneath it', () => {
  it('stops permitting the check the moment the kill-switch goes off', () => {
    // A cached "yes" outliving the user's decision to go offline is the failure the whole
    // policy exists to prevent, and a service that captured its answer would have it.
    const { service, state } = harness({ networkAllowed: true });
    expect(service.client()).not.toBeNull();

    state.networkAllowed = false;
    expect(service.client()).toBeNull();
  });

  it('clears the cache when the kill-switch is flipped, not merely on the next question', () => {
    // Turning it off has to take the prefixes with it there and then. Waiting until someone
    // next asks would leave them in memory for as long as nobody did.
    const { service, policy, state, built } = harness({ networkAllowed: true });
    service.client();

    state.networkAllowed = false;
    policy.notifyChanged();

    expect(built[0]?.cleared).toBe(1);
  });

  it('rebuilds when the vault s pacing changes', () => {
    const { service, state, built } = harness({ networkAllowed: true });
    service.client();

    state.settings = { ...state.settings, requestIntervalMs: 500 };
    service.client();

    expect(built).toHaveLength(2);
    expect(built[0]?.cleared).toBe(1);
  });

  it('does not rebuild when an unrelated edit replaces the settings object', () => {
    // `settings()` reads out of the vault document, which is replaced wholesale on every
    // edit. Comparing by identity would throw the range cache away whenever anything at all
    // changed — so the comparison is field by field, and this is what says so.
    const { service, state, built } = harness({ networkAllowed: true });
    service.client();

    state.settings = { ...state.settings };
    service.client();

    expect(built).toHaveLength(1);
  });

  it('drops the client when the vault setting is turned off', () => {
    const { service, state, built } = harness({ networkAllowed: true });
    service.client();

    state.settings = { ...state.settings, enabled: false };
    expect(service.client()).toBeNull();
    expect(built[0]?.cleared).toBe(1);
  });
});

describe('the lock obligation', () => {
  it('clears the cache on reset', () => {
    // Wired to `SessionController.onLock`. The cached keys are the prefixes of the open
    // vault's passwords — a partial fingerprint of it — and a lock means nothing derived
    // from the vault is still in memory.
    const { service, built } = harness({ networkAllowed: true });
    service.client();

    service.reset();

    expect(built[0]?.cleared).toBe(1);
  });

  it('is safe to reset when nothing was ever built', () => {
    // A lock can arrive on a vault whose owner never enabled the check. Throwing there would
    // take down the lock path, which is the one path that must never fail.
    const { service } = harness({ networkAllowed: false });
    expect(() => {
      service.reset();
    }).not.toThrow();
  });

  it('builds a fresh client after a reset rather than reviving the old one', () => {
    const { service, built } = harness({ networkAllowed: true });
    service.client();
    service.reset();
    service.client();

    expect(built).toHaveLength(2);
    expect(built[0]?.id).not.toBe(built[1]?.id);
  });

  it('survives an observer that throws, because teardown must not be interruptible', () => {
    const console_ = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { service, policy, state, built } = harness({ networkAllowed: true });
    policy.observe(() => {
      throw new Error('some other observer failed');
    });
    service.client();

    state.networkAllowed = false;
    policy.notifyChanged();

    expect(built[0]?.cleared).toBe(1);
    console_.mockRestore();
  });
});

/**
 * `availability()`, and the reason it lives here rather than in the IPC handler.
 *
 * The first version of this feature derived the answer in `register.ts` from the raw
 * `networkAllowed` preference, and `network-policy.test.ts` failed it immediately — a second
 * module branching on that preference is the copy that eventually says yes when it should say
 * no. The guard was right, and the fix was to ask the policy from the one place that already
 * holds it. These cases pin the ordering that decision produced.
 *
 * Fault injections performed: the `vaultOpen` branch moved below `networkPermitted` — "a
 * locked vault is reported as locked, even with everything else off" failed, and a user with
 * the kill-switch down would have been told to turn on a setting that would not have helped.
 * `canRun` hard-coded to `true` — three cases failed. The policy call replaced with the raw
 * setting — `network-policy.test.ts` failed, which is the guard above doing the work.
 */
describe('availability', () => {
  function serviceWith(input: {
    readonly networkAllowed: boolean;
    readonly enabled: boolean;
    readonly vaultOpen: boolean;
  }): BreachService {
    return new BreachService({
      policy: new NetworkPolicy({ networkAllowed: () => input.networkAllowed }),
      settings: () => ({ ...DEFAULT_BREACH_CHECK_SETTINGS, enabled: input.enabled }),
      vaultOpen: () => input.vaultOpen,
      build: () => new PwnedPasswordsClient(),
    });
  }

  it('can run only when the vault is open, the network is permitted and the check is on', () => {
    const availability = serviceWith({
      networkAllowed: true,
      enabled: true,
      vaultOpen: true,
    }).availability();

    expect(availability.canRun).toBe(true);
    expect(availability.reason).toBeNull();
  });

  it('reports a locked vault as locked, even when everything else is off too', () => {
    // The ordering, and it is the case that matters most. With `networkOff` reported first, a
    // user whose vault is simply locked would be sent to the settings screen to turn on a
    // switch that would not have helped — and would then have the kill-switch down as well.
    const availability = serviceWith({
      networkAllowed: false,
      enabled: false,
      vaultOpen: false,
    }).availability();

    expect(availability.reason).toBe('locked');
  });

  it('reports the kill-switch before the opt-in, because it dominates', () => {
    const availability = serviceWith({
      networkAllowed: false,
      enabled: false,
      vaultOpen: true,
    }).availability();

    expect(availability.reason).toBe('networkOff');
    expect(availability.canRun).toBe(false);
  });

  it('reports the opt-in last, which is the one the user is meant to meet', () => {
    const availability = serviceWith({
      networkAllowed: true,
      enabled: false,
      vaultOpen: true,
    }).availability();

    expect(availability.reason).toBe('notEnabled');
  });

  it('answers from the switches as they are now, not as they were at construction', () => {
    // The whole reason this is a class. A cached "yes" outliving the user's decision to go
    // offline is the single failure `NetworkPolicy` exists to prevent.
    let allowed = true;
    const service = new BreachService({
      policy: new NetworkPolicy({ networkAllowed: () => allowed }),
      settings: () => ({ ...DEFAULT_BREACH_CHECK_SETTINGS, enabled: true }),
      vaultOpen: () => true,
      build: () => new PwnedPasswordsClient(),
    });

    expect(service.availability().canRun).toBe(true);
    allowed = false;
    expect(service.availability().canRun).toBe(false);
    expect(service.availability().reason).toBe('networkOff');
  });
});
