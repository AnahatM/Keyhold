// SPDX-License-Identifier: GPL-3.0-or-later
import type { BreachCheckSettings } from '@shared/model/breach.js';
import { createHttpsTransport } from './https-transport.js';
import { PwnedPasswordsClient } from './client.js';
import type { NetworkPolicy } from '../network-policy.js';

/**
 * The one place a breach client is built, and the only importer of the module that opens a
 * socket.
 *
 * ## Why this file exists at all
 *
 * Everything else in `breach/` was finished and correct, and none of it could run, because
 * nothing constructed a client. Two obligations were written into comments and waiting for
 * a composition root to honour them — an audit found both, and `network-policy.test.ts`
 * asserts that whichever file finally imports `https-transport.ts` mentions them:
 *
 * 1. **Ask `NetworkPolicy` before constructing.** The machine-scoped kill-switch and the
 *    vault's own `breachCheck.enabled` are ANDed, kill-switch dominant. Both are consulted
 *    here, once, in `#rebuild`.
 * 2. **Drop the client on lock.** The range cache deliberately outlives a single sweep, so
 *    reopening the dashboard does not re-ask the service the same questions — which means it
 *    would also outlive a *lock*, holding the 20-bit prefixes of the open vault's passwords
 *    in memory after the event whose entire meaning is that nothing vault-derived still is.
 *
 * ## Off is the absence of a transport, not a flag
 *
 * The strongest property of the existing design is that "off" means no transport exists, so
 * a password is never even hashed. This preserves it exactly: the policy decides whether
 * `createHttpsTransport()` is *called*. There is no `if (allowed)` inside a request path for
 * a future refactor to skip, and no way to reach the network by holding a client built while
 * the switch was on — because the client is discarded when it changes.
 *
 * ## Why a class rather than a function
 *
 * Because the answer changes underneath it. The kill-switch can be flipped while the vault
 * is open, the vault setting can be edited, and the vault can lock — and all three have to
 * take effect at the next question rather than the next restart. A `createBreachClient()`
 * called once at startup would be a cached "yes" outliving the user's decision to go
 * offline, which is the single failure `NetworkPolicy` exists to prevent.
 */
export class BreachService {
  readonly #policy: NetworkPolicy;
  readonly #settings: () => BreachCheckSettings;
  readonly #build: (settings: BreachCheckSettings) => PwnedPasswordsClient;

  #client: PwnedPasswordsClient | null = null;
  /** What the client was built for, so a settings edit is noticed without a subscription. */
  #builtFor: BreachCheckSettings | null = null;

  constructor(options: {
    readonly policy: NetworkPolicy;
    /** The open vault's settings, read per question — never captured. */
    readonly settings: () => BreachCheckSettings;
    /** Injected so tests can build a client with a fake transport and no real socket. */
    readonly build?: ((settings: BreachCheckSettings) => PwnedPasswordsClient) | undefined;
  }) {
    this.#policy = options.policy;
    this.#settings = options.settings;
    this.#build =
      options.build ??
      ((settings) =>
        new PwnedPasswordsClient({
          transport: createHttpsTransport(),
          requestIntervalMs: settings.requestIntervalMs,
          requestTimeoutMs: settings.requestTimeoutMs,
        }));

    // Flipping the kill-switch off must take effect now, not at the next sweep.
    this.#policy.observe(() => {
      this.reset();
    });
  }

  /**
   * The client to use, or `null` when the check is not permitted.
   *
   * Rebuilt when the answer has changed and reused otherwise — reuse is the point, because
   * the range cache is what stops a second sweep re-asking for prefixes it already has.
   */
  client(): PwnedPasswordsClient | null {
    const settings = this.#settings();

    if (!this.#policy.allowsBreachCheck(settings)) {
      // Not merely "return null": drop the client too. Turning the check off has to take the
      // cached prefixes with it, or the setting is a hint rather than a switch.
      this.reset();
      return null;
    }

    if (this.#client === null || !sameSettings(this.#builtFor, settings)) {
      this.reset();
      this.#client = this.#build(settings);
      this.#builtFor = settings;
    }
    return this.#client;
  }

  /**
   * Discards the client and everything it cached.
   *
   * Wired to the vault lock in `src/main/index.ts` through `SessionController.onLock`, and
   * called again whenever the policy or the settings move. Idempotent, because a lock can
   * arrive when nothing was ever built.
   */
  reset(): void {
    this.#client?.clearCache();
    this.#client = null;
    this.#builtFor = null;
  }
}

/**
 * Whether a client built for `built` is still right for `wanted`.
 *
 * Compared field by field rather than by identity: `settings()` reads out of the vault
 * document, which is replaced wholesale on every edit, so identity would rebuild the client
 * — and throw away the range cache — every time any unrelated setting changed.
 */
function sameSettings(
  built: BreachCheckSettings | null,
  wanted: BreachCheckSettings
): built is BreachCheckSettings {
  return (
    built !== null &&
    built.enabled === wanted.enabled &&
    built.requestIntervalMs === wanted.requestIntervalMs &&
    built.requestTimeoutMs === wanted.requestTimeoutMs
  );
}
