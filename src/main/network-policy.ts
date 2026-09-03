// SPDX-License-Identifier: GPL-3.0-or-later
import type { BreachCheckSettings } from '@shared/model/breach.js';

/**
 * The global network kill-switch — the one authority on whether Keyhold may make a request.
 *
 * ## Why it exists
 *
 * Hard rule 5 says zero network by default, with one exception: the opt-in HIBP check,
 * "off by default, behind a global network kill-switch". The opt-in existed. The
 * kill-switch did not — an audit found no flag anywhere in `src/` gating it — so the rule
 * described two switches and the code had one.
 *
 * That gap matters more than it sounds. A per-vault "check my passwords" toggle answers
 * *should this vault use the service*. It does not answer *may this installation talk to
 * the network at all*, which is the question someone on an air-gapped machine, a corporate
 * build, or a threat model that treats any egress as a signal actually needs answered — and
 * it is the question they need answered **once**, not per vault and not per feature.
 *
 * ## Two switches, ANDed, kill-switch dominant
 *
 * ```
 * transport = policy.allowsNetwork() && settings.enabled ? createHttpsTransport() : undefined
 * ```
 *
 * Neither switch is redundant. The vault setting travels with the `.keep` file; the
 * kill-switch is machine-scoped and stays behind. A vault carried to a friend's laptop must
 * not be able to turn that machine's network on, which is exactly what would happen if the
 * only switch lived in the vault.
 *
 * ## Off means the capability is absent, not disabled
 *
 * The strongest property of the existing design is that "off" is the **absence of a
 * transport** rather than a flag some code path could forget to read: with no transport the
 * password is never even hashed. This preserves that. The policy decides whether the
 * transport is *constructed*; there is no `if (allowed)` inside the request path to be
 * skipped by a future refactor, and no way to reach the network by holding a client that
 * was built while the switch was on — see {@link NetworkPolicyObserver}.
 *
 * ## Fail closed
 *
 * Only the literal boolean `true` enables it. A missing key, `null`, the string `"true"`, a
 * truncated file, or a preferences file written by a future build all read as `false`.
 * A kill-switch that fails open on corruption is not a kill-switch.
 *
 * ## What it does not gate
 *
 * `shell.openExternal`. Opening a link hands a URL to the user's own browser, which then
 * makes the request as the user — Keyhold is not the one talking to the network, and a
 * switch that silently broke every documentation link would be surprising in a way that
 * teaches people to leave it on. This is a decision rather than an oversight, which is why
 * the setting is worded "let Keyhold make network requests" rather than "go offline", and
 * why it is written down here.
 *
 * It also does not touch the renderer's CSP. `connect-src 'none'` is unconditional and
 * stays that way: the renderer may never make a request under any setting.
 */

/** Told when the answer changes, so anything holding a transport can drop it. */
export type NetworkPolicyObserver = (allowed: boolean) => void;

export interface NetworkPolicySource {
  /** The stored preference. Read on every question, never cached here. */
  readonly networkAllowed: () => boolean;
}

export class NetworkPolicy {
  readonly #source: NetworkPolicySource;
  readonly #observers = new Set<NetworkPolicyObserver>();

  constructor(source: NetworkPolicySource) {
    this.#source = source;
  }

  /**
   * Whether this installation may make a request at all.
   *
   * Read through on every call rather than cached, so flipping the switch off takes effect
   * at the next question instead of at the next restart. A cached "yes" outliving the
   * user's decision to go offline is the one failure mode this class exists to prevent.
   */
  allowsNetwork(): boolean {
    // `=== true` against a value TypeScript already calls a boolean, deliberately. What
    // reaches here came out of a JSON file a person can edit and a half-finished write can
    // truncate, and the annotation is erased long before any of that. The lint rule is right
    // that the comparison is redundant *by the types*; the types are the thing being
    // defended against. Anywhere else this would be noise — here it is the difference
    // between failing closed and trusting an annotation.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
    return this.#source.networkAllowed() === true;
  }

  /**
   * Whether the breach check may run: **both** switches, in one place.
   *
   * Composed here rather than at the call site so there is one expression of the rule. A
   * caller writing `policy.allowsNetwork() && settings.enabled` itself would be a second
   * copy of it, and the second copy is the one that forgets a switch.
   */
  allowsBreachCheck(settings: Pick<BreachCheckSettings, 'enabled'>): boolean {
    // `settings` comes out of a `.keep` file, so the same argument as in `allowsNetwork`
    // applies: the annotation says boolean, the bytes on disk say whatever they say.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
    return this.allowsNetwork() && settings.enabled === true;
  }

  /**
   * Registers something to be torn down when the switch changes.
   *
   * The breach client caches range responses across sweeps, and a client built while the
   * switch was on would keep working after it was turned off. Observers are how the
   * composition root discards and rebuilds rather than gating inside the transport — which
   * is what keeps "off" meaning *no transport exists* rather than *a transport that
   * promises not to*.
   */
  observe(observer: NetworkPolicyObserver): () => void {
    this.#observers.add(observer);
    return () => this.#observers.delete(observer);
  }

  /**
   * Announces the current answer to every observer.
   *
   * Called by whoever writes the preference. One that throws does not stop the others: this
   * is a teardown path, and a failed teardown must not leave the rest of them holding a
   * transport.
   */
  notifyChanged(): void {
    const allowed = this.allowsNetwork();
    for (const observer of this.#observers) {
      try {
        observer(allowed);
      } catch (error) {
        console.error('[network-policy] an observer threw:', error);
      }
    }
  }
}
