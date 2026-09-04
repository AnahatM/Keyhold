// SPDX-License-Identifier: GPL-3.0-or-later
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretRef } from '@shared/model/credential.js';
import type { TotpCodeView } from '@shared/model/totp.js';
import { mountReact, type MountedTree } from '../chrome/test-dom.js';
import { useCredentials } from './credential-store.js';
import { TotpField } from './TotpField.js';

/**
 * The one-time code on screen.
 *
 * Three properties, and each one fails in a way the user would misread rather than notice:
 *
 *  1. **It refreshes itself when the window closes.** A code that silently went stale is worse
 *     than no code: it looks live, it is typed, and the service rejects it — leaving somebody
 *     to wonder whether the fault is the seed, the clock or the site.
 *  2. **The countdown comes from an absolute deadline**, recomputed against the renderer's own
 *     clock, never from a duration that was correct when it was serialised. This is the same
 *     reasoning the secret broker's grants follow, and the last five seconds are marked so a
 *     code about to expire is visibly about to expire.
 *  3. **Copying goes through the broker**, not `navigator.clipboard`. A one-time code is a live
 *     authentication factor, and it is the one secret in the app that would escape the
 *     auto-clear rule if it were written directly.
 *
 * The clock is faked because the whole component is a function of time. Real timers would make
 * this either slow or flaky, and "wait 30 seconds and see" is not an assertion.
 */

let mounted: MountedTree | null = null;
let fetches = 0;
const copySpy = vi.fn(() => Promise.resolve(true));

const CREDENTIAL = 'cred-1';
const FIELD = 'f-otp';
const REF: SecretRef = { kind: 'totp-code', credentialId: CREDENTIAL, fieldId: FIELD };

/** A 30-second window that began exactly at `now`. */
function view(overrides: Partial<TotpCodeView> = {}): TotpCodeView {
  return {
    secretCode: '809312',
    expiresAt: Date.now() + 30_000,
    periodSeconds: 30,
    digits: 6,
    issuer: 'Example',
    issuerMismatch: false,
    ...overrides,
  };
}

function mount(
  next: () => { ok: true; value: TotpCodeView | null } | { ok: false; message: string }
): MountedTree {
  const tree = mountReact(
    <TotpField
      label="One-time code"
      credentialId={CREDENTIAL}
      fieldId={FIELD}
      onCopyRef={REF}
      fetchCode={() => {
        fetches += 1;
        return Promise.resolve(next());
      }}
    />
  );
  mounted = tree;
  return tree;
}

/** Lets the mount effect's promise resolve and React commit. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Advances the fake clock and lets any timer that fires settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  fetches = 0;
  copySpy.mockClear();
  useCredentials.setState({ copy: copySpy });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('showing a one-time code', () => {
  it('renders the digits grouped, with the issuer and the seconds left', async () => {
    const tree = mount(() => ({ ok: true, value: view() }));
    await settle();

    // Grouped as every authenticator shows them, and as eyes read them.
    expect(tree.container.textContent).toContain('809 312');
    expect(tree.container.textContent).toContain('Example');
    expect(tree.container.textContent).toContain('30s');
  });

  it('counts down against its own clock rather than a duration it was handed', async () => {
    const tree = mount(() => ({ ok: true, value: view() }));
    await settle();

    await advance(10_000);
    expect(tree.container.textContent).toContain('20s');
  });

  it('marks the last five seconds, without hiding the code', async () => {
    const tree = mount(() => ({ ok: true, value: view() }));
    await settle();
    expect(tree.container.querySelector('.kh-totp--expiring')).toBeNull();

    await advance(26_000);

    expect(tree.container.querySelector('.kh-totp--expiring')).not.toBeNull();
    // Still readable. Hiding a code somebody is mid-way through typing is worse than letting
    // them watch it run out.
    expect(tree.container.textContent).toContain('809 312');
  });

  it('fetches a fresh code when the window closes', async () => {
    let issued = 0;
    const tree = mount(() => {
      issued += 1;
      return {
        ok: true,
        value: view({ secretCode: issued === 1 ? '111111' : '222222' }),
      };
    });
    await settle();
    expect(tree.container.textContent).toContain('111 111');

    // Past the deadline, plus the slack the component allows for clock skew between the two
    // processes. A code that stayed on screen here is the failure this component is built to
    // avoid: it looks live, and it is not.
    await advance(31_000);

    expect(fetches).toBeGreaterThan(1);
    expect(tree.container.textContent).toContain('222 222');
  });
});

describe('copying', () => {
  it('goes through the broker, with the code’s own ref', async () => {
    const tree = mount(() => ({ ok: true, value: view() }));
    await settle();

    const button = [...tree.container.querySelectorAll('button')].find((candidate) =>
      (candidate.getAttribute('aria-label') ?? '').includes('Copy')
    );
    expect(button, 'no copy control on the field').toBeDefined();

    act(() => {
      button?.click();
    });

    // The ref matters as much as the call: `totp-code` is rate-limited separately from the
    // seed on the same field, so copying a code every thirty seconds cannot exhaust the
    // grants that would let the same person reveal the seed.
    expect(copySpy).toHaveBeenCalledWith(REF, CREDENTIAL);
  });
});

describe('when there is nothing to show', () => {
  it('says what went wrong rather than rendering an empty field', async () => {
    const tree = mount(() => ({ ok: false, message: 'The vault is locked.' }));
    await settle();

    expect(tree.container.textContent).toContain('The vault is locked.');
    expect(tree.container.querySelector('.kh-totp__code')).toBeNull();
  });
});
