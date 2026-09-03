// SPDX-License-Identifier: GPL-3.0-or-later
import type { SecretRef } from '@shared/model/credential.js';

/**
 * Governs on-demand access to individual secrets.
 *
 * Decision D13 keeps secrets out of the renderer, but the renderer must still be able to
 * reveal a password when the user clicks reveal. This is the controlled hole in that wall,
 * and it is shaped to keep the hole small:
 *
 *  - **One secret per request.** There is no "give me everything" call. A compromised
 *    renderer must ask for each secret individually, which is slow, visible in any audit
 *    log, and cannot be done at all while the vault is locked.
 *
 *  - **Every grant expires.** A revealed secret is dropped after a TTL whether or not the
 *    renderer does anything with it, so a leaked reference does not stay useful.
 *
 *  - **Everything is dropped on lock.** Locking is meant to mean locked; an outstanding
 *    grant surviving it would make the lock a lie.
 *
 * What this deliberately does NOT do is hold the secret values. It hands them out and
 * tracks *that* it did, so the audit log and the rate limiter have something to work with.
 * Copies in the renderer are the renderer's problem, and are governed by the clipboard
 * TTL instead.
 */

export const DEFAULT_GRANT_TTL_MS = 30_000;

/**
 * A ceiling on how many secrets may be revealed in one window.
 *
 * Not a serious defence against a fully compromised renderer — it can wait. It is a
 * tripwire for the case that actually matters: a bug or a hostile dependency looping over
 * every record to harvest the vault. A human revealing passwords one at a time never
 * approaches this.
 */
export const DEFAULT_MAX_GRANTS_PER_WINDOW = 60;
export const DEFAULT_RATE_WINDOW_MS = 60_000;

export interface SecretGrant {
  readonly ref: SecretRef;
  readonly grantedAt: number;
  readonly expiresAt: number;
}

export interface BrokerOptions {
  readonly ttlMs?: number;
  readonly maxGrantsPerWindow?: number;
  readonly rateWindowMs?: number;
  /** Injectable so tests do not have to sleep. */
  readonly now?: () => number;
}

export class RateLimitExceededError extends Error {
  constructor(limit: number, windowMs: number) {
    super(
      `Too many secrets revealed: ${limit} in ${windowMs / 1000}s. This looks automated rather than human. Lock and reopen the vault to reset.`
    );
    this.name = 'RateLimitExceededError';
  }
}

/** Stable key for one addressable secret. Never contains the secret itself. */
export function refKey(ref: SecretRef): string {
  switch (ref.kind) {
    case 'password':
    case 'notes':
      return `${ref.kind}:${ref.credentialId}`;
    case 'security-answer':
      return `${ref.kind}:${ref.credentialId}:${ref.questionId}`;
    case 'custom-value':
      return `${ref.kind}:${ref.credentialId}:${ref.fieldId}`;
    // The version number is part of the key, so revealing v3's password and then v7's
    // costs two grants against the rate limit rather than one. Walking a record's whole
    // password history is exactly the automated harvesting the limit exists to notice.
    case 'historic-password':
    case 'historic-notes':
      return `${ref.kind}:${ref.credentialId}:${ref.versionNumber}`;
    case 'historic-answer':
      return `${ref.kind}:${ref.credentialId}:${ref.versionNumber}:${ref.questionId}`;
    case 'historic-custom':
      return `${ref.kind}:${ref.credentialId}:${ref.versionNumber}:${ref.fieldId}`;
    case 'attachment':
      return `${ref.kind}:${ref.credentialId}:${ref.attachmentId}`;
  }
}

export class SecretBroker {
  readonly #ttlMs: number;
  readonly #maxGrants: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  #grants = new Map<string, SecretGrant>();
  #recentGrantTimes: number[] = [];

  constructor(options: BrokerOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_GRANT_TTL_MS;
    this.#maxGrants = options.maxGrantsPerWindow ?? DEFAULT_MAX_GRANTS_PER_WINDOW;
    this.#windowMs = options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Records a grant, enforcing the rate limit.
   *
   * Throws rather than returning a failure value: a rate-limit breach means something is
   * wrong enough that no caller should be able to shrug it off by ignoring a boolean.
   */
  grant(ref: SecretRef): SecretGrant {
    const now = this.#now();
    this.#expireStale(now);

    this.#recentGrantTimes = this.#recentGrantTimes.filter((at) => now - at < this.#windowMs);
    if (this.#recentGrantTimes.length >= this.#maxGrants) {
      throw new RateLimitExceededError(this.#maxGrants, this.#windowMs);
    }
    this.#recentGrantTimes.push(now);

    const grant: SecretGrant = { ref, grantedAt: now, expiresAt: now + this.#ttlMs };
    this.#grants.set(refKey(ref), grant);
    return grant;
  }

  isGranted(ref: SecretRef): boolean {
    const now = this.#now();
    this.#expireStale(now);
    return this.#grants.has(refKey(ref));
  }

  revoke(ref: SecretRef): void {
    this.#grants.delete(refKey(ref));
  }

  /** Every grant currently live. Feeds the "revealed recently" UI and the activity log. */
  activeGrants(): SecretGrant[] {
    const now = this.#now();
    this.#expireStale(now);
    return [...this.#grants.values()];
  }

  /**
   * Drops every grant and resets the rate window.
   *
   * Called on lock, on window close, and on quit. Locking must mean locked.
   */
  revokeAll(): void {
    this.#grants.clear();
    this.#recentGrantTimes = [];
  }

  #expireStale(now: number): void {
    for (const [key, grant] of this.#grants) {
      if (grant.expiresAt <= now) this.#grants.delete(key);
    }
  }
}
