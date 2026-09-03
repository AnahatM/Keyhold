// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type { VaultDocument } from '@shared/model/vault-document.js';
import type { ConflictChoice, MergeReport } from '@shared/model/sync.js';
import type { MergeCommitResult, MergePreview } from '@shared/model/sync-plan.js';
import type { SyncErrorCode } from '@shared/model/sync-plan.js';
import { mergeDocuments } from './merge-document.js';
import { PreMergeBackup } from './pre-merge-backup.js';

/**
 * A refusal the resolver can act on.
 *
 * Coded rather than a bare `Error`, because the resolver branches on these: a stale plan gets
 * "start it again", an unresolved commit is a bug and is reported as one. Without a code both
 * fall into the generic error slot and the screen loses the only thing that made them worth
 * distinguishing — which is the same gap `ImportServiceError` was written to close, and the
 * same shape.
 *
 * A message never carries a value out of either vault. The whole report is built to carry
 * lengths rather than values, and a failure message is exactly where that guarantee would
 * leak if nobody was watching for it.
 */
export class MergeSessionError extends Error {
  readonly code: SyncErrorCode;
  /** True when the user can do something and try again. */
  readonly recoverable: boolean;

  constructor(code: SyncErrorCode, message: string, recoverable: boolean) {
    super(message);
    this.name = 'MergeSessionError';
    this.code = code;
    this.recoverable = recoverable;
  }
}

/**
 * A merge in progress: the other copy, the ancestor, and the choices made so far.
 *
 * ## Why this holds state at all, when the engine is pure
 *
 * Because resolving is a conversation. The user sees a report, picks a side, sees the report
 * again, picks another — and each round is a *complete re-run* of the merge with one more
 * choice folded in, not a patch of a previous result. Re-running needs the two documents and
 * the ancestor to still be here, so something has to hold them between calls.
 *
 * That is the entire justification, and it is worth being uncomfortable about: what is held
 * is a **decrypted copy of another whole vault**, which is the largest amount of somebody's
 * data this process ever holds outside the open vault itself. So it is held under an opaque
 * id, one plan at a time, and dropped whenever the resolver closes — however it closes.
 *
 * ## Why re-running beats patching
 *
 * A merge is a pure function of its inputs. Re-running it with an extra choice produces a
 * document the engine sanctions. Patching one field of a previously-merged document produces
 * a state the engine never produced and cannot reason about — and the difference shows up
 * precisely in the cases the engine exists for, where two fields of one record interact.
 *
 * The cost is running a pure function over two documents again. That is nothing next to
 * being able to trust the result.
 *
 * ## The backup is taken at `prepare`, not at `commit`
 *
 * Deliberately early. By the time somebody is looking at four hundred conflicts, the copy
 * that lets them walk away should already exist — and `PreMergeBackup.runMerge` is what mints
 * the receipt every later step here requires, so taking it late would mean the merge could
 * not have run at all.
 */

export interface OpenMerge {
  readonly planId: string;
  readonly backup: PreMergeBackup;
  readonly backupFileName: string;
  readonly ours: VaultDocument;
  readonly theirs: VaultDocument;
  /** `null` when there is no stored snapshot — the merge then degrades to two-way. */
  readonly base: VaultDocument | null;
  /** Conflict id → side. Accumulated across rounds; the engine is re-run from scratch. */
  readonly choices: Map<string, ConflictChoice>;
  /** The most recent result, so `commit` never re-merges behind the user's back. */
  latest: { readonly document: VaultDocument; readonly report: MergeReport };
}

export interface MergeSessionStoreOptions {
  readonly now: () => number;
  readonly newId?: (() => string) | undefined;
}

/**
 * Holds at most one merge, because two is not a state worth being able to represent.
 *
 * A second merge started while one is open would be a second whole vault in memory and a
 * second set of pending choices, and the only way to reach it is a bug — the resolver is
 * modal. Starting a new one drops the old one rather than refusing, so a crashed or abandoned
 * resolver cannot wedge the feature shut.
 */
export class MergeSessionStore {
  readonly #now: () => number;
  readonly #newId: () => string;
  #open: OpenMerge | null = null;

  constructor(options: MergeSessionStoreOptions) {
    this.#now = options.now;
    this.#newId = options.newId ?? randomUUID;
  }

  get openPlanId(): string | null {
    return this.#open?.planId ?? null;
  }

  /**
   * Takes the backup, runs the merge once, and remembers everything needed to re-run it.
   *
   * Throws if the backup cannot be taken or verified — `PreMergeBackup` refuses in that case
   * and never invokes the session — so a failed backup means no merge ran and nothing was
   * held. That is the behaviour hard rule 6 wants and it is why this composes rather than
   * reimplements.
   */
  async prepare(input: {
    readonly vaultPath: string;
    readonly ours: VaultDocument;
    readonly theirs: VaultDocument;
    readonly base: VaultDocument | null;
  }): Promise<MergePreview> {
    this.discardAll();

    const { backup, result } = await PreMergeBackup.runMerge(
      { vaultPath: input.vaultPath },
      ({ merge }) => merge(input.base, input.ours, input.theirs, { now: this.#now() })
    );

    const planId = this.#newId();
    this.#open = {
      planId,
      backup,
      backupFileName: backup.fileName,
      ours: input.ours,
      theirs: input.theirs,
      base: input.base,
      choices: new Map(),
      latest: { document: result.document, report: result.report },
    };

    return { planId, report: result.report, backupFileName: backup.fileName };
  }

  /**
   * Folds in the choices and re-runs, returning the fresh report.
   *
   * The whole choice map is taken rather than a delta: the engine re-runs from scratch, so
   * the full map is what it needs, and a delta would make the renderer responsible for
   * accumulating state the main process can simply be told.
   */
  resolve(planId: string, choices: Readonly<Record<string, ConflictChoice>>): MergeReport {
    const open = this.#require(planId);

    open.choices.clear();
    for (const [id, choice] of Object.entries(choices)) open.choices.set(id, choice);

    const outcome = mergeDocuments(open.base, open.ours, open.theirs, {
      now: this.#now(),
      resolutions: Object.fromEntries(open.choices),
    });
    open.latest = { document: outcome.document, report: outcome.report };
    return outcome.report;
  }

  /**
   * The document to write, and what the merge did.
   *
   * Refuses while anything is unresolved. The merged document is complete and renderable at
   * every stage — every unresolved conflict has *a* value in it — which is exactly why this
   * has to check rather than trust: committing it unasked would silently take one side of
   * every unsettled disagreement, which is the last-writer-wins behaviour the engine exists
   * to prevent.
   */
  commit(planId: string): { readonly document: VaultDocument; readonly result: MergeCommitResult } {
    const open = this.#require(planId);
    if (open.latest.report.requiresResolution) {
      throw new MergeSessionError(
        'sync/unresolved',
        'The merge still has unresolved conflicts, so it cannot be applied yet.',
        // Not recoverable by retrying: the resolver is supposed to prevent this, so reaching
        // here means the screen and the engine disagree about what is settled. Saying "try
        // again" would send someone round a loop that cannot end.
        false
      );
    }

    const report = open.latest.report;
    return {
      document: open.latest.document,
      result: {
        recordsMerged: report.counts.merged,
        conflictsResolved: report.conflicts.length,
        attachmentsImported: report.attachmentsToImport.length,
        backupFileName: open.backupFileName,
      },
    };
  }

  /** Drops the plan. Called when the resolver closes, and on lock. */
  discard(planId: string): void {
    if (this.#open?.planId === planId) this.#open = null;
  }

  /**
   * Drops whatever is open.
   *
   * Wired to the vault lock: what is held is a decrypted copy of another whole vault, and a
   * lock means nothing derived from any vault is still in memory.
   */
  discardAll(): void {
    this.#open = null;
  }

  #require(planId: string): OpenMerge {
    const open = this.#open;
    if (open?.planId !== planId) {
      // Named as stale rather than "not found": the honest cause is almost always that the
      // resolver was closed and reopened, and telling somebody their plan expired is more
      // useful than telling them an id was wrong.
      throw new MergeSessionError(
        'sync/stale-plan',
        'That merge is no longer open. Start it again.',
        true
      );
    }
    return open;
  }
}
