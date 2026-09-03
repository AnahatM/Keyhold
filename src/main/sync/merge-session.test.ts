// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeOrigin } from '@shared/model/credential.js';
import { MergeSessionError, MergeSessionStore } from './merge-session.js';
import { doc, NOW, record } from './test-fixtures.js';
import { writeVaultFileAtomically } from '../vault/atomic-write.js';
import { buildContainer } from '../recovery/test-support.js';

/**
 * Guard: the conversation a resolver has with the engine.
 *
 * The engine is pure and already tested. What is tested here is the stateful part around it,
 * and specifically the two things that lose data if they are wrong: **committing while
 * anything is unresolved**, and **holding another vault's decrypted contents longer than the
 * resolver is open**.
 *
 * The merged document is complete and renderable at every stage — every unresolved conflict
 * has *a* value in it — which is exactly why `commit` has to check rather than trust.
 */

let directory: string;
let vaultPath: string;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'keyhold-merge-'));
  vaultPath = join(directory, 'vault.keep');
  // A real KEEP container, because `PreMergeBackup` copies the file and then re-parses the
  // copy before it will mint a receipt. Dummy bytes fail with `NOT_A_VAULT`, which is the
  // verification doing its job — and is why this fixture is a real container rather than a
  // stub that would make the whole test prove nothing.
  await writeVaultFileAtomically(vaultPath, buildContainer());
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const store = (): MergeSessionStore => new MergeSessionStore({ now: () => NOW });

/** Two sides that changed the same field, which is what makes a conflict. */
const CONFLICTING = {
  base: doc({ records: [record({ id: 'r1', title: 'Bank' })] }),
  ours: doc({ records: [record({ id: 'r1', title: 'Bank - personal' })] }),
  theirs: doc({ records: [record({ id: 'r1', title: 'Bank - joint' })] }),
};

/** One side changed, the other did not. Three-way settles this with no question. */
const AGREEABLE = {
  base: doc({ records: [record({ id: 'r1', title: 'Bank' })] }),
  ours: doc({ records: [record({ id: 'r1', title: 'Bank' })] }),
  theirs: doc({ records: [record({ id: 'r1', title: 'Bank - joint' })] }),
};

describe('preparing a merge', () => {
  it('takes the backup before the user sees a single conflict', async () => {
    // Deliberately early. By the time somebody is looking at four hundred conflicts, the copy
    // that lets them walk away should already exist.
    const preview = await store().prepare({ vaultPath, ...CONFLICTING });

    expect(preview.backupFileName).toContain('pre-merge');
    expect(preview.report.requiresResolution).toBe(true);
  });

  it('reports no resolution needed when the two sides do not disagree', async () => {
    const preview = await store().prepare({ vaultPath, ...AGREEABLE });
    expect(preview.report.requiresResolution).toBe(false);
  });

  it('replaces an abandoned merge rather than refusing a new one', async () => {
    // A crashed or closed resolver must not wedge the feature shut. Dropping the old plan is
    // also what stops two decrypted vaults being held at once.
    const sessions = store();
    const first = await sessions.prepare({ vaultPath, ...CONFLICTING });
    const second = await sessions.prepare({ vaultPath, ...CONFLICTING });

    expect(second.planId).not.toBe(first.planId);
    expect(sessions.openPlanId).toBe(second.planId);
    expect(() => sessions.commit(first.planId)).toThrow(
      expect.objectContaining({ code: 'sync/stale-plan' })
    );
  });
});

describe('committing', () => {
  it('refuses while anything is unresolved', async () => {
    // The load-bearing assertion. The document is complete at this point — every unresolved
    // conflict has a value in it — so committing would silently take one side of every
    // unsettled disagreement, which is the last-writer-wins behaviour the engine exists to
    // prevent.
    const sessions = store();
    const preview = await sessions.prepare({ vaultPath, ...CONFLICTING });

    expect(() => sessions.commit(preview.planId)).toThrow(MergeSessionError);
    // By code, not by message. The resolver branches on this one — an unresolved commit is a
    // bug and is reported as one — and matching on prose would break the moment the wording
    // is improved.
    expect(() => sessions.commit(preview.planId)).toThrow(
      expect.objectContaining({ code: 'sync/unresolved' })
    );
  });

  it('allows it once every conflict has a side', async () => {
    const sessions = store();
    const preview = await sessions.prepare({ vaultPath, ...CONFLICTING });

    const choices = Object.fromEntries(
      preview.report.conflicts.map((conflict) => [conflict.id, 'ours' as const])
    );
    const resolved = sessions.resolve(preview.planId, choices);
    expect(resolved.requiresResolution).toBe(false);

    const { result } = sessions.commit(preview.planId);
    expect(result.backupFileName).toBe(preview.backupFileName);
  });

  it('commits what the last resolve produced, never a fresh merge', async () => {
    // `commit` must not re-run the engine: re-running behind the user's back could produce a
    // different document from the one they just approved, and they would never know.
    const sessions = store();
    const preview = await sessions.prepare({ vaultPath, ...CONFLICTING });
    const choices = Object.fromEntries(
      preview.report.conflicts.map((conflict) => [conflict.id, 'theirs' as const])
    );
    sessions.resolve(preview.planId, choices);

    const first = sessions.commit(preview.planId);
    const second = sessions.commit(preview.planId);
    expect(second.document).toEqual(first.document);
  });
});

describe('resolving', () => {
  it('re-runs the merge rather than patching the previous document', async () => {
    // Choosing the other side has to change the document, which only happens if the engine
    // actually ran again. A patched document would keep whatever the first merge applied.
    const sessions = store();
    const preview = await sessions.prepare({ vaultPath, ...CONFLICTING });
    const ids = preview.report.conflicts.map((conflict) => conflict.id);

    sessions.resolve(preview.planId, Object.fromEntries(ids.map((id) => [id, 'ours' as const])));
    const mine = sessions.commit(preview.planId).document;

    sessions.resolve(preview.planId, Object.fromEntries(ids.map((id) => [id, 'theirs' as const])));
    const theirs = sessions.commit(preview.planId).document;

    expect(mine).not.toEqual(theirs);
  });

  it('takes the whole choice map, so a later round cannot inherit a stale pick', async () => {
    // Sent whole rather than as a delta: the engine re-runs from scratch, and a delta would
    // make the renderer responsible for accumulating state main can simply be told.
    const sessions = store();
    const preview = await sessions.prepare({ vaultPath, ...CONFLICTING });
    const ids = preview.report.conflicts.map((conflict) => conflict.id);

    sessions.resolve(preview.planId, Object.fromEntries(ids.map((id) => [id, 'ours' as const])));
    const afterEmpty = sessions.resolve(preview.planId, {});

    expect(afterEmpty.requiresResolution).toBe(true);
  });

  it('refuses a plan that is no longer open', async () => {
    const sessions = store();
    const preview = await sessions.prepare({ vaultPath, ...CONFLICTING });
    sessions.discard(preview.planId);

    expect(() => sessions.resolve(preview.planId, {})).toThrow(
      expect.objectContaining({ code: 'sync/stale-plan', recoverable: true })
    );
  });
});

describe('discarding', () => {
  it('drops the other copy when the resolver closes', async () => {
    // What is held is a decrypted copy of another whole vault — the largest amount of
    // somebody's data this process holds outside the open one.
    const sessions = store();
    const preview = await sessions.prepare({ vaultPath, ...CONFLICTING });

    sessions.discard(preview.planId);
    expect(sessions.openPlanId).toBeNull();
  });

  it('ignores a discard for a plan that is not the open one', async () => {
    const sessions = store();
    const preview = await sessions.prepare({ vaultPath, ...CONFLICTING });

    sessions.discard('some-other-plan');
    expect(sessions.openPlanId).toBe(preview.planId);
  });

  it('drops everything on lock, even mid-resolution', async () => {
    const sessions = store();
    await sessions.prepare({ vaultPath, ...CONFLICTING });

    sessions.discardAll();
    expect(sessions.openPlanId).toBeNull();
  });
});

describe('what a merge leaves in the audit trail', () => {
  /*
   * A merge rewrites records the user did not individually touch. It must not also be the one
   * operation their history cannot see — the same argument that makes a restore versioned.
   *
   * The engine has supported this since it was written: `mergeDocuments` takes a `mergeOrigin`
   * and its own comment ties omitting it to "write no merge versions". Nothing passed one. So
   * every merge in the app wrote no history at all, and the engine's tests could not notice
   * because they call the engine directly and pass what they are testing.
   *
   * That is the gap these two tests hold: the *session* is where the wiring lives, and this is
   * the layer where "nobody supplies it" is visible.
   *
   * Fault injection performed:
   *  1. Dropping `...this.#mergeOriginOption()` from either `mergeDocuments` call — fails
   *     "stamps the merge on every record it changed". This is the state the code was in.
   *  2. Returning the origin regardless of the setting — fails "writes nothing when the user
   *     has asked it not to".
   */

  const withOrigin = (origin: ChangeOrigin | null): MergeSessionStore =>
    new MergeSessionStore({ now: () => NOW, mergeOrigin: () => origin });

  it('stamps the merge on every record it changed', async () => {
    const merges = withOrigin({ action: 'merge', deviceName: 'the-laptop' });
    const preview = await merges.prepare({ vaultPath, ...AGREEABLE });
    const { document } = merges.commit(preview.planId);

    const merged = document.records.find((candidate) => candidate.id === 'r1');
    expect(merged).toBeDefined();

    const versions = merged?.history.versions ?? [];
    const fromMerge = versions.filter((version) => version.origin.action === 'merge');
    expect(fromMerge).toHaveLength(1);
    // The provenance the user chose to record, carried through rather than reduced to the verb.
    expect(fromMerge[0]?.origin.deviceName).toBe('the-laptop');
  });

  it('writes nothing when the user has asked it not to', async () => {
    // Hard rule 7. A large first merge can put a version on hundreds of records at once, and
    // somebody who would rather their timeline not fill up that way can say so — it costs the
    // account of what the merge did, and nothing else.
    const merges = withOrigin(null);
    const preview = await merges.prepare({ vaultPath, ...AGREEABLE });
    const { document } = merges.commit(preview.planId);

    const merged = document.records.find((candidate) => candidate.id === 'r1');
    const versions = merged?.history.versions ?? [];
    expect(versions.filter((version) => version.origin.action === 'merge')).toEqual([]);
    // And the merge still happened, which is the half that must not be lost with it.
    expect(merged?.title).toBe('Bank - joint');
  });
});
