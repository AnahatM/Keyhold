// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  MergeCommitResult,
  MergePreview,
  MergeResolveRequest,
} from '@shared/model/sync-plan.js';
import type { ConflictChoice, MergeReport } from '@shared/model/sync.js';
import { SyncGatewayError, type SyncGateway } from './sync-gateway.js';

/**
 * An in-memory {@link SyncGateway}, for the tests.
 *
 * Deliberately not re-exported from `index.ts`: nothing in the app should be able to reach a
 * test double by importing the feature's barrel. Tests import this by path, which makes every
 * use of it visible in a search — the same arrangement the export dialog uses, and for the same
 * reason.
 *
 * It records what it was asked, because the assertions that matter here are about the
 * *sequence*: that `commit` was never reached while conflicts were unresolved, that `resolve`
 * was sent the whole accumulated choice map rather than a delta, and that `discard` happened on
 * unmount however the screen closed.
 */
export class FakeSyncGateway implements SyncGateway {
  /** The report `resolve` will return next. Push one per expected round. */
  readonly scripted: MergeReport[] = [];
  readonly resolveCalls: MergeResolveRequest[] = [];
  readonly commitCalls: string[] = [];
  readonly discardCalls: string[] = [];
  prepareCalls = 0;

  /** Set to make the next call of that name reject. Cleared once thrown. */
  failNext: { readonly call: 'resolve' | 'commit'; readonly error: SyncGatewayError } | null = null;

  #preview: MergePreview;
  #latest: MergeReport;
  #commit: MergeCommitResult;

  constructor(preview: MergePreview, commit?: MergeCommitResult) {
    this.#preview = preview;
    this.#latest = preview.report;
    this.#commit = commit ?? {
      recordsMerged: preview.report.counts.merged,
      conflictsResolved: preview.report.conflicts.length,
      attachmentsImported: preview.report.attachmentsToImport.length,
      backupFileName: preview.backupFileName,
    };
  }

  /** The report the fake currently considers current — what a real `commit` would write. */
  get latest(): MergeReport {
    return this.#latest;
  }

  /**
   * What `prepare` does next.
   *
   * `MergeResolver` is handed a preview and never calls `prepare` at all, so for its tests
   * this is always the default. `MergeFlow` is the component that owns the call, and its
   * three outcomes — a preview, a dismissed file dialog, and a file that would not open —
   * are three different screens. They live here rather than in a second double so that the
   * fake stays the one description of what the real channel can do.
   */
  prepareOutcome: 'preview' | 'cancelled' | { readonly error: SyncGatewayError } = 'preview';

  /**
   * Held open until resolved, for the one case that is about timing rather than outcome:
   * the vault locking, or the user cancelling, while Argon2 is still running. Without a way
   * to stop `prepare` mid-flight there is no way to unmount during it, and the plan-leak
   * that closes is invisible.
   */
  prepareGate: Promise<void> | null = null;

  async prepare(): Promise<MergePreview | null> {
    this.prepareCalls += 1;
    if (this.prepareGate !== null) await this.prepareGate;

    const outcome = this.prepareOutcome;
    if (outcome === 'cancelled') return null;
    if (outcome !== 'preview') throw outcome.error;
    return this.#preview;
  }

  resolve(request: MergeResolveRequest): Promise<MergeReport> {
    this.resolveCalls.push(request);
    this.#throwIfScripted('resolve');
    const next = this.scripted.shift() ?? applyChoices(this.#latest, request.choices);
    this.#latest = next;
    return Promise.resolve(next);
  }

  commit(planId: string): Promise<MergeCommitResult> {
    this.commitCalls.push(planId);
    this.#throwIfScripted('commit');
    // The real `MergeSessionStore.commit` refuses an unsettled report. The fake refuses too,
    // because a double that is more permissive than the thing it stands in for turns a genuine
    // regression into a passing test.
    if (this.#latest.requiresResolution) {
      throw new SyncGatewayError(
        'sync/unresolved',
        'The merge still has unresolved conflicts, so it cannot be applied yet.',
        false
      );
    }
    return Promise.resolve(this.#commit);
  }

  discard(planId: string): Promise<void> {
    this.discardCalls.push(planId);
    return Promise.resolve();
  }

  #throwIfScripted(call: 'resolve' | 'commit'): void {
    const failure = this.failNext;
    if (failure?.call !== call) return;
    this.failNext = null;
    throw failure.error;
  }
}

/**
 * The default `resolve` behaviour: fold the choices in, exactly as the engine would.
 *
 * A conflict named in `choices` becomes `resolution: 'user'` with `applied` set to the chosen
 * side, and `requiresResolution` recomputes from what is left. That is the engine's contract
 * rather than a convenience — a fake that returned the same report unchanged would let the
 * resolver's `needsRemerge` logic pass while being wrong.
 */
function applyChoices(
  report: MergeReport,
  choices: Readonly<Record<string, ConflictChoice>>
): MergeReport {
  const conflicts = report.conflicts.map((conflict) => {
    const choice = choices[conflict.id];
    if (choice === undefined) return conflict;
    if (conflict.applied === 'merged') return conflict;
    return { ...conflict, applied: choice, resolution: 'user' as const };
  });
  return {
    ...report,
    conflicts,
    requiresResolution: conflicts.some((conflict) => conflict.resolution === 'unresolved'),
  };
}
