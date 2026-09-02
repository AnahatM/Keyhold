// SPDX-License-Identifier: GPL-3.0-or-later
import type { AttachmentMeta, Credential } from '@shared/model/credential.js';
import { emptyVaultDocument, type VaultDocument } from '@shared/model/vault-document.js';
import { SecretBytes } from '../crypto/secret.js';
import { sha256Hex } from './digest.js';

/**
 * Fixtures for the attachment tests.
 *
 * Beside the code rather than in `tests/fixtures/` because these are hand-built objects,
 * not sample files: the import parsers keep real-world exports out of the source tree, and
 * that rule is about *data files*, not about a four-line record builder.
 */

/** PNG's eight-byte signature, so a fixture can be a file the sniffer actually recognises. */
export const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** `length` bytes, all `fill`, with a PNG signature in front when there is room. */
export function pngBytes(length: number, fill = 0x42): Uint8Array {
  const bytes = new Uint8Array(length).fill(fill);
  bytes.set(PNG_MAGIC.slice(0, Math.min(PNG_MAGIC.length, length)), 0);
  return bytes;
}

/** `length` bytes of `fill` and nothing recognisable. */
export function opaqueBytes(length: number, fill = 0x01): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

export function secretOf(bytes: Uint8Array): SecretBytes {
  return SecretBytes.adopt(Uint8Array.from(bytes));
}

export function metaFor(
  bytes: Uint8Array,
  overrides: Partial<AttachmentMeta> = {}
): AttachmentMeta {
  return {
    id: 'a'.repeat(32),
    name: 'scan.png',
    mime: 'image/png',
    size: bytes.length,
    sha256: sha256Hex(bytes),
    addedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function recordOf(id: string, attachments: readonly AttachmentMeta[] = []): Credential {
  return {
    id,
    type: 'login',
    title: `Record ${id}`,
    favorite: false,
    folderId: null,
    tags: [],
    icon: { kind: 'auto' },
    fields: {
      username: '',
      email: '',
      password: '',
      urls: [],
      securityQuestions: [],
      notes: '',
      custom: [],
    },
    attachments: [...attachments],
    meta: {
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      passwordUpdatedAt: 1_700_000_000_000,
      lastUsedAt: null,
      useCount: 0,
      expiresAt: null,
      rotationIntervalDays: null,
      createdOrigin: { action: 'create' },
    },
    history: { enabled: false, maxVersions: null, versions: [] },
    trashedAt: null,
  };
}

export function documentOf(...records: readonly Credential[]): VaultDocument {
  return { ...emptyVaultDocument(), records: [...records] };
}
