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
 *   2. **Take the pre-merge backup.** Mandatory, and not this engine's job — this engine
 *      cannot lose data it never writes, but the caller can.
 *   3. `mergeDocuments(base, ours, theirs, { now })`.
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
