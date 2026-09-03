// SPDX-License-Identifier: GPL-3.0-or-later
import { DEFAULT_ATTACHMENT_SETTINGS } from '@shared/model/attachment.js';
import {
  DEFAULT_VAULT_SETTINGS,
  VAULT_DOCUMENT_VERSION,
  type VaultDocument,
} from '@shared/model/vault-document.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addAttachmentToDocument } from '../attachments/store.js';
import { SecretBytes } from '../crypto/secret.js';
import { buildCredential } from './credential-ops.js';
import { VaultService } from './vault-service.js';

/**
 * Guard: the attachment caps in the vault are the caps that apply.
 *
 * `VaultService.addAttachment` called the store without passing them, so the store folded
 * `undefined` and got the shipped defaults back. Raising the limit in settings therefore
 * changed nothing at all — a control that moved and did not connect, which is the worst
 * kind of setting because the user has no way to tell it did not work until a file they
 * were told would fit is refused.
 *
 * Asserted through the store rather than through `VaultService`, so no key derivation, no
 * file and no Argon2 is involved: the claim is about which numbers reach the check, and a
 * test that needed an unlocked vault to say so would be slower and would fail for reasons
 * that have nothing to do with it.
 */

const NOW = 1_800_000_000_000;

function documentWithRecord(caps: Partial<typeof DEFAULT_ATTACHMENT_SETTINGS> = {}): VaultDocument {
  const record = buildCredential(
    { title: 'Bank' },
    { newId: () => 'record-1', now: () => NOW, settings: DEFAULT_VAULT_SETTINGS }
  );
  return {
    documentVersion: VAULT_DOCUMENT_VERSION,
    records: [record],
    folders: [],
    tags: [],
    savedSearches: [],
    settings: {
      ...DEFAULT_VAULT_SETTINGS,
      attachments: { ...DEFAULT_ATTACHMENT_SETTINGS, ...caps },
    },
  };
}

function attach(document: VaultDocument, bytes: Uint8Array) {
  return addAttachmentToDocument(document, 'record-1', {
    name: 'scan.png',
    mime: 'image/png',
    bytes: SecretBytes.adopt(bytes),
    now: NOW,
    newId: 'chunk-1',
    settings: document.settings.attachments,
  });
}

describe('the vault s own attachment caps', () => {
  it('are part of the default settings, so every vault has them', () => {
    // Without this, a vault created before the caps travelled would have `undefined` here
    // and every read of `settings.attachments.x` would throw at the moment someone attached
    // a file — which is the least convenient moment available.
    expect(DEFAULT_VAULT_SETTINGS.attachments).toEqual(DEFAULT_ATTACHMENT_SETTINGS);
  });

  it('refuse a file above the vault s own lowered cap', () => {
    // 1 KiB cap, 2 KiB file. Under the shipped default of 25 MiB this would be accepted,
    // so a pass here means the *vault's* number was the one consulted.
    const document = documentWithRecord({ maxAttachmentBytes: 1024 });
    expect(() => attach(document, new Uint8Array(2048))).toThrow();
  });

  it('accept a file the shipped default would refuse, when the vault allows it', () => {
    // The other direction, and the one a defaults-only implementation also fails. Raising
    // the cap has to actually raise it, or the setting is decoration.
    const big = DEFAULT_ATTACHMENT_SETTINGS.maxAttachmentBytes + 1024;
    const document = documentWithRecord({
      maxAttachmentBytes: big + 1,
      maxVaultAttachmentBytes: big * 4,
    });
    expect(() => attach(document, new Uint8Array(big))).not.toThrow();
  });

  it('warn above the vault s own threshold rather than the shipped one', () => {
    const document = documentWithRecord({ warnAboveBytes: 512 });
    expect(attach(document, new Uint8Array(1024)).warnLarge).toBe(true);

    const quiet = documentWithRecord({ warnAboveBytes: 4096 });
    expect(attach(quiet, new Uint8Array(1024)).warnLarge).toBe(false);
  });
});

/**
 * The wiring, through a real `VaultService`.
 *
 * The store-level tests above prove the caps *work* when they are handed over. They do not
 * prove they are handed over, and that was the actual bug — removing the `settings:` line
 * from `VaultService.addAttachment` failed none of them. A guard that cannot fail on the
 * defect it was written for is the thing this project keeps finding, so this one goes
 * through the real service, real Argon2 at the floor, and a real file.
 */
describe('VaultService hands the vault s caps to the store', () => {
  let dir: string;
  let service: VaultService;

  /** The OWASP floor. The KDF's strength is tested in `crypto.test.ts`, not here. */
  const FAST_KDF = { memoryKib: 19_456, iterations: 2, parallelism: 1 } as const;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'keyhold-attach-'));
    service = new VaultService();
    await service.createVault({
      path: join(dir, 'vault.keep'),
      password: 'a-perfectly-reasonable-master-password',
      kdf: FAST_KDF,
    });
  });

  afterEach(() => {
    service.lock();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a file above the cap this vault stores', () => {
    service.updateSettings({
      attachments: { ...DEFAULT_ATTACHMENT_SETTINGS, maxAttachmentBytes: 1024 },
    });
    const created = service.createCredential({ title: 'Bank' });

    // 2 KiB, against a 1 KiB vault cap and a 25 MiB shipped default. Accepted before the
    // settings were passed through; refused now.
    expect(() =>
      service.addAttachment(created.id, {
        name: 'scan.png',
        mime: 'image/png',
        bytes: new Uint8Array(2048),
      })
    ).toThrow();
  });

  it('accepts the same file once the vault s cap allows it', () => {
    // The other direction, and the one that proves the refusal above was the *vault's*
    // number rather than any number at all.
    service.updateSettings({
      attachments: { ...DEFAULT_ATTACHMENT_SETTINGS, maxAttachmentBytes: 4096 },
    });
    const created = service.createCredential({ title: 'Bank' });

    expect(() =>
      service.addAttachment(created.id, {
        name: 'scan.png',
        mime: 'image/png',
        bytes: new Uint8Array(2048),
      })
    ).not.toThrow();
  });
});
