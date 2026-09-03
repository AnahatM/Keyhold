// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { coercePreferences, DEFAULT_PREFERENCES } from './session/preferences.js';
import { NetworkPolicy } from './network-policy.js';

/**
 * Guard: hard rule 5's second switch.
 *
 * The rule says zero network by default, with one exception, "off by default, behind a
 * global network kill-switch". An audit found the opt-in and no kill-switch — the rule
 * described two switches and the code had one. These are the properties that make the
 * second one real rather than present.
 *
 * The last test is the load-bearing one. A policy object every caller is *supposed* to
 * consult is a convention; a policy nothing can route around is a guarantee. So the file
 * that opens a socket is asserted to have exactly one importer in the whole repository —
 * which is what stops the switch from being bypassed by a future module that builds its own
 * transport and never asks.
 */

function policyFor(networkAllowed: boolean): NetworkPolicy {
  return new NetworkPolicy({ networkAllowed: () => networkAllowed });
}

describe('the default', () => {
  it('is off', () => {
    // The single most important assertion in this file. Everything else is about the switch
    // working; this is about which way it points when nobody has touched it.
    expect(DEFAULT_PREFERENCES.networkAllowed).toBe(false);
  });

  it('is off for every value a damaged preferences file could hold', () => {
    // Every other field in `coercePreferences` falls back to what the user most likely
    // wanted. This one falls back to off, because a kill-switch that fails open on
    // corruption is not a kill-switch. `'true'` is in the list deliberately: a hand-edited
    // JSON file is exactly where a string lands where a boolean belongs.
    for (const stored of [undefined, null, 0, 1, 'true', 'yes', {}, [], NaN]) {
      const label = stored === undefined ? 'undefined' : JSON.stringify(stored);
      expect(coercePreferences({ networkAllowed: stored }).networkAllowed, label).toBe(false);
    }
  });

  it('is on only for the literal boolean', () => {
    expect(coercePreferences({ networkAllowed: true }).networkAllowed).toBe(true);
  });

  it('survives a file that is not an object at all', () => {
    for (const stored of [null, 'nonsense', 42, []]) {
      expect(coercePreferences(stored).networkAllowed).toBe(false);
    }
  });
});

describe('the two switches', () => {
  it('are ANDed, with the kill-switch dominant', () => {
    // The truth table, in full. The third row is the one the whole design exists for: a
    // vault that says "check my passwords" carried onto a machine that says "no network"
    // must not make a request, because vault settings travel inside the .keep file and the
    // kill-switch stays behind on the machine that set it.
    expect(policyFor(true).allowsBreachCheck({ enabled: true })).toBe(true);
    expect(policyFor(true).allowsBreachCheck({ enabled: false })).toBe(false);
    expect(policyFor(false).allowsBreachCheck({ enabled: true })).toBe(false);
    expect(policyFor(false).allowsBreachCheck({ enabled: false })).toBe(false);
  });

  it('treats a non-boolean vault setting as off', () => {
    const setting = { enabled: 'true' } as unknown as { enabled: boolean };
    expect(policyFor(true).allowsBreachCheck(setting)).toBe(false);
  });

  it('reads through on every question rather than caching an answer', () => {
    // A cached "yes" outliving the user's decision to go offline is the one failure this
    // class exists to prevent — and it is the failure mode a constructor-argument boolean
    // would have had, silently, until the next restart.
    let allowed = true;
    const policy = new NetworkPolicy({ networkAllowed: () => allowed });

    expect(policy.allowsNetwork()).toBe(true);
    allowed = false;
    expect(policy.allowsNetwork()).toBe(false);
  });
});

describe('observers', () => {
  it('are told the new answer when the switch moves', () => {
    let allowed = true;
    const policy = new NetworkPolicy({ networkAllowed: () => allowed });
    const seen: boolean[] = [];
    policy.observe((value) => seen.push(value));

    allowed = false;
    policy.notifyChanged();
    expect(seen).toEqual([false]);
  });

  it('all run even when one throws', () => {
    // This is a teardown path: a failed cleanup must not leave the next observer holding a
    // transport it was told to drop.
    const policy = policyFor(false);
    const after = vi.fn();
    const console_ = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    policy.observe(() => {
      throw new Error('teardown failed');
    });
    policy.observe(after);
    policy.notifyChanged();

    expect(after).toHaveBeenCalledOnce();
    console_.mockRestore();
  });

  it('stop being called once released', () => {
    const policy = policyFor(false);
    const observer = vi.fn();
    policy.observe(observer)();
    policy.notifyChanged();
    expect(observer).not.toHaveBeenCalled();
  });
});

describe('the switch cannot be routed around', () => {
  /**
   * Every `.ts` under `src/`, so a new module cannot hide by living somewhere new.
   *
   * Written here rather than borrowed from `breach/no-network.test.ts`: that guard proves
   * *no module makes a request*, this one proves *the one that can is reachable from one
   * place*. Different claims, and a shared helper would be one edit away from silently
   * narrowing both.
   */
  function sourceFiles(directory: string, found: string[] = []): string[] {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) sourceFiles(path, found);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(path);
    }
    return found;
  }

  it('has exactly one importer of the module that opens a socket', () => {
    const root = resolve('src');
    const importers = sourceFiles(root).filter((path) => {
      if (path.endsWith('https-transport.ts')) return false;
      // Its own test may import it; that is the point of a test.
      if (path.endsWith('https-transport.test.ts')) return false;
      // The no-network guard reads every file as text, so it names the transport without
      // importing it. Excluded by name rather than by pattern, so a real import in it would
      // still be caught.
      if (path.endsWith('no-network.test.ts')) return false;
      return /^\s*import[^;]*from\s*['"][^'"]*https-transport(\.js)?['"]/m.test(
        readFileSync(path, 'utf8')
      );
    });

    // Exactly one, and it is named. This started at zero — nothing constructed a breach
    // client — and the assertion was written to start constraining the moment a composition
    // root appeared. It did, and this is that root.
    //
    // Naming the file rather than counting to one: a second importer and a *moved* importer
    // are different mistakes, and only one of them is a mistake at all.
    expect(
      importers.map((path) => relative(resolve('src'), path).split(sep).join('/')),
      'the module that opens a socket must be imported from exactly one place, and that ' +
        'place must consult NetworkPolicy and drop the client on lock'
    ).toEqual(['main/breach/service.ts']);
  });

  it('makes the composition root prove it honours both obligations', () => {
    /**
     * The obligation that has nowhere to live yet, made impossible to lose.
     *
     * When something finally constructs the transport it owes two things, and neither is
     * expressible as a type: it must ask {@link NetworkPolicy} before constructing, and it
     * must drop the client on lock — the range cache outlives a sweep by design, and its
     * keys are the prefixes of the open vault's passwords, a partial twenty-bit fingerprint
     * sitting in memory after the event whose whole meaning is that nothing vault-derived
     * still is.
     *
     * A comment saying so is what the codebase already had, and it is why this was found by
     * an audit rather than by a test. This asserts nothing while there is no importer, and
     * becomes a hard requirement in the same commit that creates one.
     */
    const root = resolve('src');
    for (const path of sourceFiles(root)) {
      const source = readFileSync(path, 'utf8');
      if (path.endsWith('https-transport.ts') || path.endsWith('.test.ts')) continue;
      if (!/^\s*import[^;]*from\s*['"][^'"]*https-transport(\.js)?['"]/m.test(source)) continue;

      expect(source, `${path} constructs the transport without consulting NetworkPolicy`).toMatch(
        /NetworkPolicy|allowsBreachCheck|allowsNetwork/
      );
      expect(source, `${path} constructs the transport without dropping it on lock`).toMatch(
        /onLock|clearCache/
      );
    }
  });

  it('is the only place that decides on the stored preference', () => {
    /**
     * Hard rule 8, aimed at the thing that actually goes wrong.
     *
     * The setting has to be *mentioned* in several places — declared in `Preferences`,
     * coerced there, carried into `MachineSettings` so the screen can draw a toggle, passed
     * through `clampMachineSettings`. None of those is a second answer to "may we make a
     * request"; they are the value travelling.
     *
     * What must not exist twice is a *decision*: a second module branching on it. That is
     * the copy that forgets a case — and a "no other file mentions this" test could not have
     * told it apart from the legitimate ones, so it would have been quieted with an
     * exemption list and stopped guarding anything. This is the narrower claim that stays
     * true as the value gets carried further.
     */
    // A *presence* check in a patch validator — `!== undefined` — is not a decision about
    // whether the network is allowed; it asks whether the caller supplied the field at all.
    // Excluded by shape rather than by exempting the file, so a real branch appearing in
    // that same validator would still be caught.
    const PRESENCE = /\bnetworkAllowed\b\s*(?:!==|===)\s*undefined/g;
    const DECIDES =
      /(?:if\s*\(|\?(?!:)|&&|\|\||!)\s*[\w.#]*\bnetworkAllowed\b|\bnetworkAllowed\b\s*(?:\?(?!:)|&&|\|\||===|!==)/;

    const deciders = sourceFiles(resolve('src')).filter((path) => {
      if (path.endsWith('network-policy.ts') || path.endsWith('network-policy.test.ts')) {
        return false;
      }
      // Where the stored value is coerced. That *is* a decision, and it is the one place
      // entitled to make it — fail-closed, asserted above.
      if (path.endsWith(join('session', 'preferences.ts'))) return false;
      if (path.endsWith(join('session', 'preferences.test.ts'))) return false;
      return DECIDES.test(readFileSync(path, 'utf8').replace(PRESENCE, 'suppliedNetworkField'));
    });

    expect(deciders, 'only NetworkPolicy may branch on networkAllowed').toEqual([]);
  });

  it('does not exist in the renderer', () => {
    // The renderer may display the switch's state, never decide on it. A renderer that
    // could answer this question would be a renderer that could be persuaded to answer yes.
    const renderer = sourceFiles(resolve('src', 'renderer'));
    expect(renderer.filter((p) => /\bNetworkPolicy\b/.test(readFileSync(p, 'utf8')))).toEqual([]);
  });

  it('finds a meaningful number of files, so a broken walk cannot pass', () => {
    // Without this, a `sourceFiles` that returned nothing would satisfy every assertion
    // above. The number is a floor, not a count, so it does not rot.
    expect(sourceFiles(resolve('src')).length).toBeGreaterThan(150);
  });
});

/** A sanity check that the walk really reads files, not just names them. */
it('reads real source, not empty strings', () => {
  expect(readFileSync(resolve('src/main/network-policy.ts'), 'utf8').length).toBeGreaterThan(1000);
  expect(statSync(resolve('src/main/network-policy.ts')).size).toBeGreaterThan(1000);
});
