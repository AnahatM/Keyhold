// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_ONBOARDING_STATE, type OnboardingState } from './onboarding-state.js';
import {
  clearProgress,
  coerceProgress,
  isOnboardingActiveFor,
  moveProgress,
  PROGRESS_VERSION,
  readProgress,
  shouldShowOnboarding,
  storageKeyFor,
  writeProgress,
} from './onboarding-storage.js';

/**
 * Persistence, and the promise that nothing typed reaches it.
 *
 * Two properties are load-bearing here and both are asserted against the raw stored string
 * rather than against a parsed object, because the thing that would actually hurt someone
 * is a master password sitting in a file in their profile — and a parsed object would
 * happily hide it in a field the assertion did not look at.
 */

const A_VAULT = 'vault-aaaa-1111';
const ANOTHER_VAULT = 'vault-bbbb-2222';

/** A marker planted in every string the flow could conceivably be handed. */
const MARKER = 'MARKER-copper-lantern-drift-oyster';

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function stored(vaultKey: string | null): string | null {
  return window.localStorage.getItem(storageKeyFor(vaultKey));
}

describe('nothing the user typed is ever persisted', () => {
  it('writes only the six named fields, whatever it is handed', () => {
    /*
     * The hostile case: an object shaped like the state but carrying secrets on it, as
     * would happen the moment someone "conveniently" spread a form's values into the state
     * object. The write must drop every one of them, because it names its fields rather
     * than spreading.
     */
    const contaminated = {
      ...INITIAL_ONBOARDING_STATE,
      stepId: 'master-password',
      masterSecret: MARKER,
      confirmSecret: MARKER,
      secretPassword: MARKER,
      title: MARKER,
      username: MARKER,
      url: MARKER,
      draft: { secretPassword: MARKER },
    } as unknown as OnboardingState;

    writeProgress(A_VAULT, contaminated);

    const raw = stored(A_VAULT);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain(MARKER);
    expect(JSON.parse(raw ?? '')).toEqual({
      version: PROGRESS_VERSION,
      stepId: 'master-password',
      acknowledgedNoRecovery: false,
      vaultCreated: false,
      firstCredentialSaved: false,
      outcome: 'active',
    });
  });

  it('leaves nothing behind anywhere else in storage either', () => {
    writeProgress(A_VAULT, { ...INITIAL_ONBOARDING_STATE, stepId: 'vault-file' });

    const everything = Object.keys(window.localStorage)
      .map((key) => `${key}=${window.localStorage.getItem(key) ?? ''}`)
      .join('\n');
    expect(everything).not.toContain(MARKER);
  });
});

describe('keys', () => {
  it('scopes progress per vault so two vaults cannot share a record', () => {
    expect(storageKeyFor(A_VAULT)).not.toBe(storageKeyFor(ANOTHER_VAULT));
    expect(storageKeyFor(null)).not.toBe(storageKeyFor(A_VAULT));

    writeProgress(A_VAULT, { ...INITIAL_ONBOARDING_STATE, stepId: 'what-next' });
    expect(readProgress(ANOTHER_VAULT)).toEqual(INITIAL_ONBOARDING_STATE);
  });

  it('cannot be collided by a key that contains a separator', () => {
    // 'a.b' and 'a' + '.b' must not land on the same record.
    expect(storageKeyFor('a.b')).not.toBe(storageKeyFor('a%2Eb'));
    expect(storageKeyFor('a/b')).not.toContain('/');
  });

  it('treats an empty key as no vault at all', () => {
    expect(storageKeyFor('   ')).toBe(storageKeyFor(null));
  });

  it('re-scopes a pending record once the vault has an identity', () => {
    writeProgress(null, {
      stepId: 'vault-file',
      acknowledgedNoRecovery: true,
      vaultCreated: true,
      firstCredentialSaved: false,
      outcome: 'active',
    });

    moveProgress(null, A_VAULT);

    expect(stored(null)).toBeNull();
    expect(readProgress(A_VAULT).stepId).toBe('vault-file');
    // The next first run must not inherit this one.
    expect(readProgress(null)).toEqual(INITIAL_ONBOARDING_STATE);
  });
});

describe('a corrupt or missing record means "start at the beginning"', () => {
  it('handles nothing stored at all', () => {
    expect(readProgress(A_VAULT)).toEqual(INITIAL_ONBOARDING_STATE);
    expect(isOnboardingActiveFor(A_VAULT)).toBe(true);
  });

  it('handles every shape of damage without throwing', () => {
    const damaged = [
      'not json at all',
      '',
      'null',
      '[]',
      '"a string"',
      '42',
      '{}',
      '{"version":0,"stepId":"welcome"}',
      `{"version":${PROGRESS_VERSION},"stepId":"nope","acknowledgedNoRecovery":false,"vaultCreated":false,"firstCredentialSaved":false,"outcome":"active"}`,
      `{"version":${PROGRESS_VERSION},"stepId":"welcome","acknowledgedNoRecovery":"yes","vaultCreated":false,"firstCredentialSaved":false,"outcome":"active"}`,
      `{"version":${PROGRESS_VERSION},"stepId":"welcome","acknowledgedNoRecovery":false,"vaultCreated":false,"firstCredentialSaved":false,"outcome":"finished"}`,
    ];

    for (const raw of damaged) {
      window.localStorage.setItem(storageKeyFor(A_VAULT), raw);
      expect(() => readProgress(A_VAULT)).not.toThrow();
      expect(readProgress(A_VAULT)).toEqual(INITIAL_ONBOARDING_STATE);
    }
  });

  it('rejects a record that claims completion without the acknowledgement', () => {
    /*
     * The one piece of tampering that would actually cost somebody their vault: a stored
     * record saying setup finished for a vault whose owner was never told it cannot be
     * recovered. Repeating the tour is cheap; accepting this is not.
     */
    window.localStorage.setItem(
      storageKeyFor(A_VAULT),
      `{"version":${PROGRESS_VERSION},"stepId":"what-next","acknowledgedNoRecovery":false,"vaultCreated":true,"firstCredentialSaved":false,"outcome":"completed"}`
    );

    expect(readProgress(A_VAULT)).toEqual(INITIAL_ONBOARDING_STATE);
    expect(isOnboardingActiveFor(A_VAULT)).toBe(true);
  });

  it('clamps a record that points past the vault it does not have', () => {
    window.localStorage.setItem(
      storageKeyFor(A_VAULT),
      `{"version":${PROGRESS_VERSION},"stepId":"what-next","acknowledgedNoRecovery":true,"vaultCreated":false,"firstCredentialSaved":false,"outcome":"active"}`
    );
    expect(readProgress(A_VAULT).stepId).toBe('master-password');
  });

  it('survives storage that throws outright', () => {
    // Storage disabled by policy, or a quota error. The flow forgets; it does not break.
    vi.spyOn(window.localStorage.__proto__ as Storage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readProgress(A_VAULT)).toEqual(INITIAL_ONBOARDING_STATE);

    vi.restoreAllMocks();
    vi.spyOn(window.localStorage.__proto__ as Storage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => {
      writeProgress(A_VAULT, INITIAL_ONBOARDING_STATE);
    }).not.toThrow();
  });
});

describe('round trip', () => {
  it('reads back exactly what it wrote', () => {
    const state: OnboardingState = {
      stepId: 'first-credential',
      acknowledgedNoRecovery: true,
      vaultCreated: true,
      firstCredentialSaved: true,
      outcome: 'active',
    };
    writeProgress(A_VAULT, state);
    expect(readProgress(A_VAULT)).toEqual(state);
  });

  it('stops offering the flow once it is finished or skipped', () => {
    for (const outcome of ['completed', 'dismissed'] as const) {
      writeProgress(A_VAULT, {
        stepId: 'what-next',
        acknowledgedNoRecovery: true,
        vaultCreated: true,
        firstCredentialSaved: false,
        outcome,
      });
      expect(isOnboardingActiveFor(A_VAULT)).toBe(false);
    }
  });

  it('forgets on request', () => {
    writeProgress(A_VAULT, { ...INITIAL_ONBOARDING_STATE, stepId: 'vault-file' });
    clearProgress(A_VAULT);
    expect(stored(A_VAULT)).toBeNull();
  });

  it('exposes the show/hide decision as one predicate', () => {
    expect(shouldShowOnboarding(INITIAL_ONBOARDING_STATE)).toBe(true);
    expect(shouldShowOnboarding({ ...INITIAL_ONBOARDING_STATE, outcome: 'dismissed' })).toBe(false);
  });

  it('accepts only well-formed records', () => {
    expect(coerceProgress({ version: PROGRESS_VERSION })).toBeNull();
    expect(
      coerceProgress({
        version: PROGRESS_VERSION,
        stepId: 'welcome',
        acknowledgedNoRecovery: false,
        vaultCreated: false,
        firstCredentialSaved: false,
        outcome: 'active',
      })
    ).toEqual(INITIAL_ONBOARDING_STATE);
  });
});
