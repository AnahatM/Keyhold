// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compareVaultContent,
  createBaseSnapshotStore,
  serialiseSnapshot,
  snapshotIsSafeToStore,
} from './base-snapshot.js';
import { DEFAULT_VAULT_SETTINGS, VAULT_DOCUMENT_VERSION } from '@shared/model/vault-document.js';

/**
 * Guard: the ancestor a three-way merge reads.
 *
 * `mergeDocuments` accepts `base | null` and works either way, which is exactly why this
 * needs testing rather than trusting: the two behave very differently and nothing crashes
 * when the ancestor is wrong. A stale or foreign ancestor does not fail — it silently
 * resolves conflicts in the wrong direction and resurrects deletions.
 */

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'keyhold-base-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const SEALED = new Uint8Array([1, 2, 3, 4, 5]);

describe('the store', () => {
  it('answers null before the first merge rather than throwing', () => {
    // The normal case for every vault that has never synced. An error here would make "we
    // have never merged" an exception on the path where it is the expected answer.
    expect(createBaseSnapshotStore(directory).read('vault-1')).toBeNull();
  });

  it('round-trips the bytes it was given, exactly', () => {
    const store = createBaseSnapshotStore(directory);
    store.write('vault-1', SEALED);
    expect(store.read('vault-1')).toEqual(SEALED);
  });

  it('keeps vaults apart', () => {
    // Two vaults open on one machine must not share an ancestor. Sharing one would mean the
    // second merge reads the first vault's agreed state, which is the input a three-way
    // merge cannot survive being wrong about.
    const store = createBaseSnapshotStore(directory);
    store.write('vault-1', SEALED);
    store.write('vault-2', new Uint8Array([9, 9]));

    expect(store.read('vault-1')).toEqual(SEALED);
    expect(store.read('vault-2')).toEqual(new Uint8Array([9, 9]));
  });

  it('replaces rather than appends', () => {
    const store = createBaseSnapshotStore(directory);
    store.write('vault-1', SEALED);
    store.write('vault-1', new Uint8Array([7]));
    expect(store.read('vault-1')).toEqual(new Uint8Array([7]));
  });

  it('forgets, and forgetting twice is not an error', () => {
    // `forget` runs on "stop remembering this vault" and on a snapshot that will not open —
    // both paths can reach it with nothing there.
    const store = createBaseSnapshotStore(directory);
    store.write('vault-1', SEALED);
    store.forget('vault-1');
    expect(store.read('vault-1')).toBeNull();
    expect(() => {
      store.forget('vault-1');
    }).not.toThrow();
  });

  it('treats a damaged snapshot as no snapshot', () => {
    // Degrading to a two-way merge asks more questions; reading a corrupt ancestor answers
    // them wrongly. The first is a worse experience, the second is lost data.
    const store = createBaseSnapshotStore(directory);
    store.write('vault-1', SEALED);
    const [name] = readdirSync(join(directory, 'base-snapshots'));
    writeFileSync(join(directory, 'base-snapshots', name ?? ''), '');
    expect(store.read('vault-1')).toEqual(new Uint8Array());
  });

  it('does not name its files after the vault ids', () => {
    // The directory is readable by anything running as this user, and a listing that
    // enumerates which vaults somebody has is a fact worth not publishing for free. Not
    // confidentiality against someone holding the id — they can compute the same digest.
    const store = createBaseSnapshotStore(directory);
    store.write('11111111-2222-3333-4444-555555555555', SEALED);

    const names = readdirSync(join(directory, 'base-snapshots'));
    expect(names).toHaveLength(1);
    expect(names[0]).not.toContain('11111111');
    expect(names[0]).toMatch(/^[0-9a-f]{32}\.keepbase$/);
  });

  it('creates its directory on first write rather than requiring setup', () => {
    const store = createBaseSnapshotStore(join(directory, 'not', 'made', 'yet'));
    expect(() => {
      store.write('vault-1', SEALED);
    }).not.toThrow();
    expect(store.read('vault-1')).toEqual(SEALED);
  });
});

describe('when a snapshot may be stored', () => {
  it('refuses when the merged vault was not written', () => {
    // The dangerous case. An ancestor describing a state no file ever held means the *next*
    // merge treats the user's real edits as changes away from something that never existed,
    // and silently resolves toward the other device.
    expect(snapshotIsSafeToStore({ mergedWasWritten: false, unresolvedConflicts: 0 })).toBe(false);
  });

  it('refuses while a conflict is unresolved', () => {
    // An unresolved conflict means the merge is not finished. Recording it as the agreed
    // ancestor would have the next merge believe both sides settled a question nobody
    // answered.
    expect(snapshotIsSafeToStore({ mergedWasWritten: true, unresolvedConflicts: 1 })).toBe(false);
  });

  it('allows it only when both are true', () => {
    expect(snapshotIsSafeToStore({ mergedWasWritten: true, unresolvedConflicts: 0 })).toBe(true);
    expect(snapshotIsSafeToStore({ mergedWasWritten: false, unresolvedConflicts: 3 })).toBe(false);
  });
});

describe('serialisation', () => {
  it('produces the same bytes for the same document', () => {
    // The snapshot is read back by the vault body's own parser, so this has to be the same
    // shape the body is written in — a second format here is a second thing to keep in step.
    const document = {
      documentVersion: VAULT_DOCUMENT_VERSION,
      records: [],
      folders: [],
      tags: [],
      settings: DEFAULT_VAULT_SETTINGS,
    };

    expect(serialiseSnapshot(document)).toEqual(serialiseSnapshot(document));
    expect(JSON.parse(Buffer.from(serialiseSnapshot(document)).toString('utf8'))).toEqual(document);
  });
});

describe('comparing two vault files', () => {
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);

  it('says identical for the same content, whatever the generations', () => {
    // The case that stops every cloud-client touch becoming a resolver prompt. A file copied
    // and copied back has a higher generation and identical content, and merging it would
    // cost a mandatory backup, a full three-way pass and a dialog — for nothing.
    expect(
      compareVaultContent(
        { contentHash: HASH_A, generation: 3 },
        { contentHash: HASH_A, generation: 91 }
      )
    ).toBe('identical');
  });

  it('says differs for different content, even at the same generation', () => {
    // The case a generation counter gets wrong. Two devices editing from the same ancestor
    // both reach 8 and disagree completely — equal generations are not evidence of equal
    // content, which is the whole reason the hash exists.
    expect(
      compareVaultContent(
        { contentHash: HASH_A, generation: 8 },
        { contentHash: HASH_B, generation: 8 }
      )
    ).toBe('differs');
  });

  it('says unknown when either side predates the field', () => {
    // Correct-but-noisy, and noisy in the safe direction. Reporting `identical` here would
    // skip a merge and lose an edit; reporting `unknown` costs a comparison the caller can
    // choose to pay for.
    expect(compareVaultContent({ generation: 1 }, { contentHash: HASH_A, generation: 2 })).toBe(
      'unknown'
    );
    expect(compareVaultContent({ contentHash: HASH_A, generation: 1 }, { generation: 2 })).toBe(
      'unknown'
    );
    expect(compareVaultContent({ generation: 1 }, { generation: 1 })).toBe('unknown');
  });

  it('never claims identical without evidence', () => {
    // The property that matters, stated as one: a false `identical` skips a merge and loses
    // an edit, and there is no input that should produce one without two matching hashes.
    for (const ours of [{ generation: 1 }, { contentHash: HASH_A, generation: 1 }]) {
      for (const theirs of [{ generation: 1 }, { contentHash: HASH_B, generation: 1 }]) {
        expect(compareVaultContent(ours, theirs)).not.toBe('identical');
      }
    }
  });
});
