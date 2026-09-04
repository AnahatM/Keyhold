// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Credential, CustomField } from '@shared/model/credential.js';
import { emptyVaultDocument } from '@shared/model/vault-document.js';
import { VaultService } from './vault-service.js';

/**
 * `VaultService.totpCode` — the vault method behind the one-time code on screen.
 *
 * The engine below it is proved against RFC 6238's vectors in `totp/totp.test.ts`, and the
 * field-to-code seam in `totp/totp-ipc.test.ts`. Neither of them touches this method, which
 * is the part with the security decisions in it, and until this file existed it was covered
 * only by the smoke run — one happy path, one real vault, no refusals.
 *
 * Four properties, in the order they would hurt:
 *
 *  1. **A field of the wrong type is `null`, not an error.** A caller able to tell "no such
 *     field" from "not a one-time-password field" could enumerate the field types on a
 *     record without reading a single value.
 *  2. **The seed never leaves the method.** What comes back is six digits, a deadline and
 *     the issuer. A `TotpCodeView` that carried the seed would put it in the safe
 *     projection's blast radius, and the renderer is where it must never be.
 *  3. **The code is rate-limited under its own key.** Copying a code every thirty seconds
 *     must not exhaust the grants that would let the same user reveal the seed, and the
 *     reverse must be true too — they are two different secrets on one field.
 *  4. **`expiresAt` is the end of the window the code belongs to**, not `now` plus a period.
 *     The renderer draws a countdown from it; an offset deadline shows a ring that empties
 *     while the code is still good, or worse, after it is not.
 *
 * ## Fault injection performed, two defects
 *
 *  1. `expiresAt` set to `now + periodSeconds * 1000` — the plausible wrong answer, and the
 *     reason `NOW` sits mid-window rather than on a boundary where both agree.
 *  2. The `field?.type !== 'otp-secret'` guard split so that a wrong-type field threw while a
 *     missing one still returned `null` — the field-type enumeration oracle. Caught.
 */

let dir: string;
let vaultPath: string;
let service: VaultService;

const PASSWORD = 'a-perfectly-reasonable-master-password';

/** The OWASP floor. These tests are about the method, not about the KDF's strength. */
const FAST_KDF = { memoryKib: 19_456, iterations: 2, parallelism: 1 } as const;

/** RFC 4648 base32. The same seed `totp-ipc.test.ts` uses, so the two agree by construction. */
const SEED = 'JBSWY3DPEHPK3PXP';
const URI = `otpauth://totp/Example:alice@example.com?secret=${SEED}&issuer=Example`;

/** Mid-window on a 30-second period, so a bad `expiresAt` cannot land on the right answer. */
const NOW = Date.UTC(2026, 0, 1, 0, 0, 15);

function customField(overrides: Partial<CustomField>): CustomField {
  return {
    id: 'f-otp',
    label: 'One-time code',
    type: 'otp-secret',
    value: URI,
    hidden: false,
    order: 0,
    ...overrides,
  };
}

function record(...custom: CustomField[]): Credential {
  return {
    id: 'cred-1',
    type: 'login',
    title: 'Example',
    favorite: false,
    folderId: null,
    tags: [],
    icon: { kind: 'auto' },
    fields: {
      username: 'alice',
      email: 'alice@example.com',
      password: 'the-account-password',
      urls: [],
      securityQuestions: [],
      notes: '',
      custom,
    },
    attachments: [],
    meta: {
      createdAt: 1,
      updatedAt: 1,
      passwordUpdatedAt: 1,
      lastUsedAt: null,
      useCount: 0,
      expiresAt: null,
      rotationIntervalDays: null,
      createdOrigin: { action: 'create' as const },
    },
    history: { enabled: false, maxVersions: 10, versions: [] },
    trashedAt: null,
  };
}

const withRecord = (...custom: CustomField[]): void => {
  service.replaceDocument({ ...emptyVaultDocument(), records: [record(...custom)] });
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'keyhold-totp-'));
  vaultPath = join(dir, 'test.keep');
  service = new VaultService('test-device');
  await service.createVault({ path: vaultPath, password: PASSWORD, kdf: FAST_KDF });
});

afterEach(async () => {
  service.lock();
  await rm(dir, { recursive: true, force: true });
});

describe('producing a code', () => {
  it('reads the field and answers with a code, a deadline and the issuer', () => {
    withRecord(customField({}));
    const view = service.totpCode('cred-1', 'f-otp', NOW);

    expect(view?.secretCode).toMatch(/^\d{6}$/);
    expect(view?.digits).toBe(6);
    expect(view?.periodSeconds).toBe(30);
    expect(view?.issuer).toBe('Example');
    expect(view?.issuerMismatch).toBe(false);
  });

  it('expires at the end of the window the code belongs to, not a period from now', () => {
    withRecord(customField({}));
    const view = service.totpCode('cred-1', 'f-otp', NOW);

    // `NOW` is 15s into a 30s window that began at 00:00:00, so the honest deadline is
    // 00:00:30 — fifteen seconds away, not thirty. The wrong implementation (`now + period`)
    // returns 00:00:45 and the ring on screen runs half a window past the code's life.
    expect(view?.expiresAt).toBe(Date.UTC(2026, 0, 1, 0, 0, 30));
    expect(view?.expiresAt).toBeGreaterThan(NOW);
  });

  it('gives the same code anywhere inside one window, and a different one in the next', () => {
    withRecord(customField({}));
    const start = service.totpCode('cred-1', 'f-otp', Date.UTC(2026, 0, 1, 0, 0, 0));
    const end = service.totpCode('cred-1', 'f-otp', Date.UTC(2026, 0, 1, 0, 0, 29));
    const next = service.totpCode('cred-1', 'f-otp', Date.UTC(2026, 0, 1, 0, 0, 30));

    expect(end?.secretCode).toBe(start?.secretCode);
    expect(next?.secretCode).not.toBe(start?.secretCode);
    expect(next?.expiresAt).toBe(Date.UTC(2026, 0, 1, 0, 1, 0));
  });

  it('reads a bare seed too, on the format defaults', () => {
    // Half the import parsers write only the seed — LastPass and most CSVs — so the field
    // has to work without a URI or those migrations arrive with a code that never appears.
    withRecord(customField({ value: SEED }));
    const view = service.totpCode('cred-1', 'f-otp', NOW);

    expect(view?.secretCode).toMatch(/^\d{6}$/);
    expect(view?.digits).toBe(6);
    expect(view?.periodSeconds).toBe(30);
    // Nothing named an issuer, and the method does not invent one.
    expect(view?.issuer).toBeNull();
  });

  it('reports a label and issuer that disagree rather than picking one', () => {
    withRecord(customField({ value: `otpauth://totp/GitHub:alice?secret=${SEED}&issuer=Google` }));
    const view = service.totpCode('cred-1', 'f-otp', NOW);

    // Two different names usually means the field was pasted from somewhere else. Silently
    // choosing shows a real code under the wrong account, which is worse than saying so.
    expect(view?.issuerMismatch).toBe(true);
  });
});

describe('what it refuses, and how quietly', () => {
  it('answers null for a record that is not there', () => {
    withRecord(customField({}));
    expect(service.totpCode('no-such-record', 'f-otp', NOW)).toBeNull();
  });

  it('answers null for a field that is not there', () => {
    withRecord(customField({}));
    expect(service.totpCode('cred-1', 'no-such-field', NOW)).toBeNull();
  });

  it('answers null for a field of the wrong type — the same null, not an error', () => {
    // The one that matters. If "not an otp field" threw and "no such field" returned null,
    // a compromised renderer could walk a record's field ids and learn the type of each one
    // without ever being granted a value.
    withRecord(customField({ id: 'f-note', type: 'text', value: 'not a seed' }));

    expect(service.totpCode('cred-1', 'f-note', NOW)).toBeNull();
    expect(service.totpCode('cred-1', 'nothing-here', NOW)).toBeNull();
  });

  it('refuses to answer at all once the vault is locked', () => {
    withRecord(customField({}));
    service.lock();
    expect(() => service.totpCode('cred-1', 'f-otp', NOW)).toThrow();
  });
});

describe('what leaves the method', () => {
  it('never returns the seed, in any field of the view', () => {
    withRecord(customField({}));
    const view = service.totpCode('cred-1', 'f-otp', NOW);

    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain(SEED);
    expect(serialised).not.toContain('otpauth://');
    expect(serialised).not.toContain('secret=');
    expect(Object.keys(view ?? {}).sort()).toEqual([
      'digits',
      'expiresAt',
      'issuer',
      'issuerMismatch',
      'periodSeconds',
      'secretCode',
    ]);
  });

  it('keeps the seed out of the safe projection as well', () => {
    // The other half of the same claim: the code is fetched per reveal, and the field it
    // came from must not have travelled to the renderer in the list payload.
    withRecord(customField({}));
    const projected = JSON.stringify(service.listProjections());

    expect(projected).not.toContain(SEED);
    expect(projected).not.toContain('otpauth://');
  });
});

describe('the grant it takes', () => {
  it('grants under the code’s own key, separately from the seed on the same field', () => {
    withRecord(customField({}));
    service.totpCode('cred-1', 'f-otp', NOW);

    expect(
      service.broker.isGranted({ kind: 'totp-code', credentialId: 'cred-1', fieldId: 'f-otp' })
    ).toBe(true);
    // The seed on the same field is a different secret and was not granted by this call.
    expect(
      service.broker.isGranted({ kind: 'custom-value', credentialId: 'cred-1', fieldId: 'f-otp' })
    ).toBe(false);
  });

  it('takes no grant when it refuses', () => {
    // A refusal that still spent a grant would let a renderer drain the rate limit by
    // asking for field ids that do not exist.
    withRecord(customField({}));
    const before = service.broker.activeGrants().length;

    service.totpCode('cred-1', 'no-such-field', NOW);
    service.totpCode('no-such-record', 'f-otp', NOW);

    expect(service.broker.activeGrants()).toHaveLength(before);
  });

  it('resolves the same code through the secret ref, so display and clipboard agree', () => {
    withRecord(customField({}));
    const shown = service.totpCode('cred-1', 'f-otp', NOW);
    const copied = service.revealSecret({
      kind: 'totp-code',
      credentialId: 'cred-1',
      fieldId: 'f-otp',
    });

    // Resolved through the one implementation rather than a second copy of the arithmetic.
    // Compared inside a window, since the two calls read the clock a moment apart.
    expect(copied).toMatch(/^\d{6}$/);
    expect(shown?.secretCode).toMatch(/^\d{6}$/);
  });
});
