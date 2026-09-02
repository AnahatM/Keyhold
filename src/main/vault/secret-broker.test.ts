// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { SecretRef } from '@shared/model/credential.js';
import { RateLimitExceededError, refKey, SecretBroker } from './secret-broker.js';

/**
 * The broker governs the one deliberate hole in the D13 boundary: revealing a secret to
 * the renderer on demand.
 *
 * Time is injected rather than slept on. A TTL test that sleeps is slow, flaky under load,
 * and — worse — usually gets written with a generous margin that stops it testing the
 * boundary at all.
 */

const password = (id: string): SecretRef => ({ kind: 'password', credentialId: id });

/** A controllable clock, so expiry can be tested at the exact millisecond. */
function fakeClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('grants expire', () => {
  it('is granted immediately after asking', () => {
    const broker = new SecretBroker({ now: fakeClock().now });
    broker.grant(password('a'));
    expect(broker.isGranted(password('a'))).toBe(true);
  });

  it('is still granted one millisecond before the TTL', () => {
    const clock = fakeClock();
    const broker = new SecretBroker({ ttlMs: 30_000, now: clock.now });
    broker.grant(password('a'));

    clock.advance(29_999);
    expect(broker.isGranted(password('a'))).toBe(true);
  });

  it('expires exactly at the TTL, not merely eventually', () => {
    const clock = fakeClock();
    const broker = new SecretBroker({ ttlMs: 30_000, now: clock.now });
    broker.grant(password('a'));

    clock.advance(30_000);
    expect(broker.isGranted(password('a'))).toBe(false);
  });

  it('expires without anyone asking — a grant nobody checks must not linger', () => {
    const clock = fakeClock();
    const broker = new SecretBroker({ ttlMs: 1_000, now: clock.now });
    broker.grant(password('a'));
    broker.grant(password('b'));

    clock.advance(1_001);
    expect(broker.activeGrants()).toHaveLength(0);
  });

  it('re-granting extends the window', () => {
    const clock = fakeClock();
    const broker = new SecretBroker({ ttlMs: 1_000, now: clock.now });
    broker.grant(password('a'));

    clock.advance(900);
    broker.grant(password('a'));
    clock.advance(900);

    expect(broker.isGranted(password('a'))).toBe(true);
  });
});

describe('revocation', () => {
  it('revokes one grant without touching the others', () => {
    const broker = new SecretBroker({ now: fakeClock().now });
    broker.grant(password('a'));
    broker.grant(password('b'));

    broker.revoke(password('a'));
    expect(broker.isGranted(password('a'))).toBe(false);
    expect(broker.isGranted(password('b'))).toBe(true);
  });

  it('revokeAll clears everything — this is what makes lock mean locked', () => {
    const broker = new SecretBroker({ now: fakeClock().now });
    broker.grant(password('a'));
    broker.grant({ kind: 'notes', credentialId: 'a' });
    broker.grant({ kind: 'security-answer', credentialId: 'a', questionId: 'q1' });

    broker.revokeAll();
    expect(broker.activeGrants()).toHaveLength(0);
  });

  it('revokeAll also resets the rate window, so locking is not a punishment', () => {
    const clock = fakeClock();
    const broker = new SecretBroker({ maxGrantsPerWindow: 3, now: clock.now });
    broker.grant(password('a'));
    broker.grant(password('b'));
    broker.grant(password('c'));

    broker.revokeAll();
    expect(() => broker.grant(password('d'))).not.toThrow();
  });
});

describe('rate limiting', () => {
  it('allows a normal burst of human activity', () => {
    const broker = new SecretBroker({ maxGrantsPerWindow: 60, now: fakeClock().now });
    for (let i = 0; i < 60; i += 1) broker.grant(password(`cred-${i}`));
    expect(broker.activeGrants().length).toBeGreaterThan(0);
  });

  it('stops a loop harvesting the whole vault', () => {
    // The case that matters: a bug or hostile dependency iterating every record. A human
    // revealing passwords one at a time never approaches this.
    const broker = new SecretBroker({ maxGrantsPerWindow: 5, now: fakeClock().now });
    for (let i = 0; i < 5; i += 1) broker.grant(password(`cred-${i}`));

    expect(() => broker.grant(password('cred-6'))).toThrow(RateLimitExceededError);
  });

  it('throws rather than returning a failure nobody checks', () => {
    const broker = new SecretBroker({ maxGrantsPerWindow: 1, now: fakeClock().now });
    broker.grant(password('a'));
    expect(() => broker.grant(password('b'))).toThrow(/looks automated/);
  });

  it('lets the window slide, so a slow user is never blocked', () => {
    const clock = fakeClock();
    const broker = new SecretBroker({
      maxGrantsPerWindow: 2,
      rateWindowMs: 60_000,
      now: clock.now,
    });
    broker.grant(password('a'));
    broker.grant(password('b'));
    expect(() => broker.grant(password('c'))).toThrow(RateLimitExceededError);

    clock.advance(60_001);
    expect(() => broker.grant(password('c'))).not.toThrow();
  });

  it('counts re-grants of the same secret, so a tight retry loop still trips it', () => {
    const broker = new SecretBroker({ maxGrantsPerWindow: 3, now: fakeClock().now });
    broker.grant(password('a'));
    broker.grant(password('a'));
    broker.grant(password('a'));
    expect(() => broker.grant(password('a'))).toThrow(RateLimitExceededError);
  });
});

describe('reference keys', () => {
  it('gives every kind of reference a distinct key', () => {
    const keys = new Set([
      refKey({ kind: 'password', credentialId: 'a' }),
      refKey({ kind: 'notes', credentialId: 'a' }),
      refKey({ kind: 'security-answer', credentialId: 'a', questionId: 'q1' }),
      refKey({ kind: 'security-answer', credentialId: 'a', questionId: 'q2' }),
      refKey({ kind: 'custom-value', credentialId: 'a', fieldId: 'f1' }),
      refKey({ kind: 'historic-password', credentialId: 'a', versionNumber: 1 }),
      refKey({ kind: 'historic-notes', credentialId: 'a', versionNumber: 1 }),
      refKey({ kind: 'historic-answer', credentialId: 'a', versionNumber: 1, questionId: 'q1' }),
      refKey({ kind: 'historic-custom', credentialId: 'a', versionNumber: 1, fieldId: 'f1' }),
    ]);
    expect(keys.size).toBe(9);
  });

  it('gives each version of a historic secret its own key', () => {
    // Load-bearing for the rate limit, not cosmetic. Sharing a key across versions would
    // let a renderer walk a record's entire password history for the price of one grant —
    // which is exactly the automated harvesting the limit exists to notice.
    const at = (versionNumber: number): SecretRef => ({
      kind: 'historic-password',
      credentialId: 'a',
      versionNumber,
    });
    expect(refKey(at(1))).not.toBe(refKey(at(2)));

    const broker = new SecretBroker({ maxGrantsPerWindow: 2 });
    broker.grant(at(1));
    broker.grant(at(2));
    expect(() => broker.grant(at(3))).toThrow(RateLimitExceededError);
  });

  it('never confuses a live secret with a historic one', () => {
    // An optional `versionNumber` on the live kinds would have made a dropped property
    // mean "the current password" — a mistake that returns the *wrong* secret rather than
    // an error. Separate kinds make that impossible.
    expect(refKey({ kind: 'password', credentialId: 'a' })).not.toBe(
      refKey({ kind: 'historic-password', credentialId: 'a', versionNumber: 1 })
    );
  });

  it('does not collide across credentials', () => {
    expect(refKey(password('a'))).not.toBe(refKey(password('b')));
  });

  it('never embeds a secret in the key', () => {
    // Keys reach logs and the activity view. They must be safe there.
    expect(refKey(password('cred-1'))).toBe('password:cred-1');
  });
});
