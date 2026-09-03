// SPDX-License-Identifier: GPL-3.0-or-later
import type { IpcResult } from '../ipc/api.js';
import type { ConflictChoice, MergeReport } from './sync.js';

/**
 * The sync IPC surface, and what each call carries.
 *
 * Declared here beside its payloads so `src/shared/ipc/api.ts` adds one line rather than a
 * second copy of these signatures — the same arrangement as `IMPORT_CHANNELS`, and for the
 * reason that arrangement earned: the copies diverge before anything uses both.
 *
 * ## Nothing here carries a credential, in either direction
 *
 * A `MergeReport` carries `ConflictSide`s, which carry a kind and — for a secret — a length.
 * The resolver picks a side **by name**; the choice comes back as `'ours' | 'theirs'` and the
 * merge is re-run in the main process with it folded in. No call in this group can be made to
 * hand over a value, which is decision D13 applied to a new surface rather than a new rule.
 *
 * ## Why `resolve` re-runs the merge instead of patching
 *
 * A merge is a pure function of its inputs. Re-running it with one more choice produces a
 * document the engine sanctions; patching a field of a previously-merged document produces a
 * state it never produced and cannot reason about. The cost is re-running a pure function
 * over two documents, which is nothing next to being able to trust the result.
 *
 * ## Why `commit` is separate from `resolve`
 *
 * Because the merged document is **provisional** while any conflict is unresolved, and the
 * engine says so in `requiresResolution`. Folding the write into the last `resolve` would
 * make the moment of committing invisible — and it is the moment a whole vault is rewritten
 * from an input that arrived over somebody else's network.
 */

/** The other file in a merge: another copy of this vault, on disk. */
/**
 * A conflicted copy found beside the vault, as the renderer sees it.
 *
 * Everything here comes from the plaintext header. `generation` is the useful one: higher than
 * the open vault's means this copy has saves that this device has never seen.
 */
export interface ConflictCandidateView {
  readonly id: string;
  readonly fileName: string;
  readonly modifiedAt: number;
  readonly recordCount: number;
  readonly generation: number;
}

export interface MergeSourceRef {
  /**
   * An opaque handle for the file, minted by `prepare`.
   *
   * Not a path. The renderer never names a file to merge for the same reason it never names
   * a vault to open: a path travelling renderer → main is attacker-controlled if the renderer
   * is ever compromised, and here it would name the input to an operation that rewrites the
   * whole vault.
   */
  readonly sourceId: string;
}

/**
 * What a merge would do, before anything is written.
 *
 * Produced by `prepare`, which takes the pre-merge backup and runs the engine once. The
 * backup happens here rather than at `commit` deliberately: by the time a user is looking at
 * four hundred conflicts, the copy that lets them walk away should already exist.
 */
export interface MergePreview {
  readonly planId: string;
  readonly report: MergeReport;
  /** Where the pre-merge backup went, so the user can be told a real filename. */
  readonly backupFileName: string;
}

export interface MergeResolveRequest {
  readonly planId: string;
  /**
   * Conflict id → side. Sent whole rather than as a delta.
   *
   * The engine re-runs from scratch each time, so the full map is what it needs, and a delta
   * would make the renderer responsible for accumulating state that main can simply be told.
   * Conflict ids are stable and independent of argument order, which is what lets a selection
   * survive a re-merge.
   */
  readonly choices: Readonly<Record<string, ConflictChoice>>;
}

/** What a finished merge did. No document, no values — the vault itself is the output. */
export interface MergeCommitResult {
  readonly recordsMerged: number;
  readonly conflictsResolved: number;
  /** Chunks copied across from the other file. Names only where they have one. */
  readonly attachmentsImported: number;
  readonly backupFileName: string;
}

/**
 * The refusal codes a merge can come back with.
 *
 * Here beside the channels rather than on either side, for the reason `IMPORT_ERROR_CODES`
 * ended up here: both processes need the same strings, and two copies either side of a
 * boundary drift before anything uses both. The resolver reacts to several of these **by
 * name** — a stale plan gets "start it again", a duplicate id gets routed to the diagnostic
 * report — which a generic error box cannot do.
 *
 * A message carrying one of these never contains a value out of either vault. The report the
 * resolver renders carries lengths rather than values, and a failure message that undid that
 * would be the one place the guarantee leaked.
 */
export const SYNC_ERROR_CODES = [
  /** The plan expired, or the app restarted. The merge must be started again. */
  'sync/stale-plan',
  /** `commit` was called while conflicts were unresolved. A bug, and reported as one. */
  'sync/unresolved',
  /** A vault file changed on disk under the merge. Re-read and merge again. */
  'sync/vault-moved',
  /** One of the two documents holds a duplicate id — `DuplicateIdError`. Route to diagnose. */
  'sync/duplicate-id',
  /** The pre-merge backup could not be verified, so nothing was merged. */
  'sync/backup-failed',
  /** The write failed. The vault is untouched and the backup still stands. */
  'sync/write-failed',
] as const;

export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];

export function isSyncErrorCode(value: unknown): value is SyncErrorCode {
  return typeof value === 'string' && (SYNC_ERROR_CODES as readonly string[]).includes(value);
}

export const SYNC_CHANNELS = {
  /** Opens a file dialog, reads the other copy, backs up, and merges once. */
  syncPrepare: 'kh:sync:prepare',
  /** Re-runs the merge with the choices so far. Writes nothing. */
  syncResolve: 'kh:sync:resolve',
  /** Writes the merged vault, then stores the new base snapshot. Refuses if unresolved. */
  syncCommit: 'kh:sync:commit',
  /** Drops the plan and the other copy. Called whenever the resolver closes. */
  syncDiscard: 'kh:sync:discard',
  /** Lists the conflicted copies a sync client left beside the vault. Reads no bodies. */
  syncCandidates: 'kh:sync:candidates',
} as const;

/**
 * The namespace the preload exposes as `window.keyhold.sync`.
 *
 * `discard` is not politeness. `prepare` holds a decrypted copy of *another* whole vault in
 * main-process memory, and that is the largest amount of somebody's data this app ever holds
 * outside the open vault itself. It goes when the resolver closes, however it closes.
 */
export interface SyncApi {
  /**
   * Lists the conflicted copies sitting beside the open vault.
   *
   * Described from each file's plaintext header, so no key is used and nothing is decrypted —
   * that is what the header being authenticated-but-not-encrypted is for. Only copies of *this*
   * vault are listed; a file that merely looks like a conflicted copy but carries a different
   * `vaultId` is somebody else's, and merging it would put two people's credentials behind one
   * master password.
   *
   * **No path comes back.** Each candidate is an opaque id and a filename, and the id is what
   * `prepare` takes. That is the property that makes this safe to expose: a channel that read a
   * filename the renderer supplied would read any file the renderer named.
   */
  candidates: () => Promise<IpcResult<readonly ConflictCandidateView[]>>;
  /**
   * Prepares a merge.
   *
   * With no argument this opens a file dialog. With a candidate id from {@link candidates} it
   * skips the dialog and uses the file that id stands for — the renderer still never names a
   * path, and an id the main process does not recognise is refused rather than guessed at.
   */
  prepare: (candidateId?: string) => Promise<IpcResult<MergePreview | null>>;
  resolve: (request: MergeResolveRequest) => Promise<IpcResult<MergeReport>>;
  commit: (planId: string) => Promise<IpcResult<MergeCommitResult>>;
  discard: (planId: string) => Promise<IpcResult<null>>;
}
