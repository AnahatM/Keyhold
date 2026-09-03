// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The sync and merge engine's public surface.
 *
 * One function. Everything else in this directory is an implementation detail of it, exported
 * only so the tests can aim at a single rule at a time — and the tests import those directly,
 * so that a caller reaching past `mergeDocuments` is visible in a review as an unusual import
 * path rather than an ordinary one.
 *
 * The intended call sequence, in the order the safety properties depend on:
 *
 *   1. Decrypt both vaults, and the stored base snapshot if there is one.
 *   2. **Take the pre-merge backup.** `PreMergeBackup.runMerge` — mandatory, and enforced
 *      rather than requested: it is the only thing that can mint the receipt every later step
 *      requires, and it mints it after the copy is verified on disk. This engine cannot lose
 *      data it never writes; the caller can, which is why the precondition is attached to the
 *      merge rather than written beside it.
 *   3. `mergeDocuments(base, ours, theirs, { now })` — reached through the session
 *      `runMerge` hands over, which is the same function with that precondition satisfied.
 *   4. If `report.requiresResolution`, show the conflicts and collect a side for each, then
 *      call `mergeDocuments` again with `resolutions`. Repeat until nothing is unresolved.
 *   5. Copy every chunk in `report.attachmentsToImport` out of the other container.
 *   6. Write the merged document, and store it as the new base snapshot for next time.
 *
 * Step 6's second half is what turns the *next* merge from two-way into three-way, which is
 * the difference between a merge that mostly answers itself and one that asks about every
 * field that differs.
 */

export { mergeDocuments } from './merge-document.js';
export type { MergeOptions, MergeOutcome } from './merge-document.js';

/**
 * The one refusal a merge can raise.
 *
 * Exported here because this file is the engine's front door, and a caller having to reach
 * past it into `merge-document.js` to catch the error the front door throws is a doorway
 * with a hole beside it. A duplicate record id means one of the two vaults is corrupt, and
 * the caller's answer is to route the user to `diagnose()` — which needs `side` and `entity`
 * off this error to say *which file* and *what to repair*.
 */
export { DuplicateIdError } from './merge-document.js';
export type { DocumentSide, DuplicatedEntity } from './merge-document.js';

/**
 * Noticing that the file changed, which is step 0 of the sequence above.
 *
 * The merge engine answers "these two vaults disagree, now what"; the watcher is what makes
 * anyone ask. It is deliberately not wired into the merge: it reports a generation counter
 * moving and stops there, because reloading, backing up, and merging are decisions with
 * consequences and this is a component that only reads a header.
 */
export { probeVaultHeader, VaultWatcher } from './vault-watcher.js';
export type {
  CancelTimer,
  DirectoryWatch,
  DirectoryWatchCallbacks,
  ExternalChange,
  ScheduleFn,
  UnreadableReason,
  VaultFileState,
  VaultWatcherOptions,
  WatchDirectoryFn,
} from './vault-watcher.js';

/**
 * The ancestor a three-way merge reads.
 *
 * Step 1 of the sequence above — "the stored base snapshot if there is one" — and step 6's
 * second half, which is what turns the *next* merge from two-way into three-way. Machine
 * scoped and never travelling with the vault: a snapshot that arrived from another device
 * is not this device's last-agreed state, and that is the one input a three-way merge
 * cannot survive being wrong about.
 */
export {
  createBaseSnapshotStore,
  serialiseSnapshot,
  snapshotIsSafeToStore,
  type BaseSnapshotStore,
} from './base-snapshot.js';

/**
 * Step 2 of the sequence above, and the reason it is no longer a rule with nobody to follow it.
 *
 * `PreMergeBackup.runMerge` is the door: it copies the vault, flushes it, reads it back,
 * proves it is byte-identical and still a readable KEEP file, and only then hands the caller
 * a session whose `merge` is `mergeDocuments`. A backup that fails throws before the session
 * exists, so the merge does not run.
 *
 * The receipt has a private constructor and a private field, so it cannot be written by hand.
 * Any later step that wants proof — the write, the snapshot store — takes a `PreMergeBackup`
 * and is thereby unreachable to a caller who skipped this. `mergeDocuments` above stays
 * exported for the tests and for the resolver loop *inside* a session; reaching for it
 * directly is the unusual import this barrel exists to make visible.
 */
export {
  DEFAULT_PRE_MERGE_RETAIN,
  isPreMergeBackupPath,
  listPreMergeBackups,
  PRE_MERGE_INFIX,
  PreMergeBackup,
  PreMergeBackupError,
} from './pre-merge-backup.js';
export type {
  MergeSession,
  MergeSessionResult,
  PreMergeBackupFailure,
  PreMergeBackupFile,
  PreMergeBackupIo,
  PreMergeBackupRequest,
} from './pre-merge-backup.js';

/**
 * The stateful half: one merge in progress, held between rounds of resolution.
 *
 * The engine is pure and stays that way. This exists because resolving is a conversation —
 * the user picks a side, the merge re-runs with that choice folded in, and re-running needs
 * both documents and the ancestor to still be here.
 */
export { MergeSessionStore, type OpenMerge } from './merge-session.js';
