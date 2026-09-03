// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  MergeCommitResult,
  MergePreview,
  MergeResolveRequest,
} from '@shared/model/sync-plan.js';
import type { MergeReport } from '@shared/model/sync.js';
import { SYNC_ERROR_CODES, isSyncErrorCode, type SyncErrorCode } from '@shared/model/sync-plan.js';

/**
 * The one seam between the conflict resolver and the outside world.
 *
 * Written against the same pattern as `../export/export-gateway.ts` and `../import/gateway.ts`,
 * and for the same three reasons: the screen is testable without an Electron process, wiring the
 * real `kh:sync:*` channels is one adapter file, and nothing else in this folder learns that IPC
 * exists.
 *
 * ## This is `SyncApi`, unwrapped — not a second copy of it
 *
 * Every payload here is imported from `@shared/model/sync-plan.ts`, which already declares the
 * channel group, its request shapes and its results. Re-declaring them would be exactly the
 * second list hard rule 8 is about, and the copy that went stale would be this one. The only
 * thing this interface adds is the `IpcResult` unwrapping, which is why the adapter beside it is
 * six lines long.
 *
 * ## What this port deliberately does NOT have
 *
 * **There is no `reveal`, no `copySecret`, and no way to read a conflicting value.** That is the
 * single most important line in this file, and it is a decision rather than an omission.
 *
 * A conflict is by construction *two of the thing that differs*, and for `password`, `notes`,
 * `securityQuestions` and `custom` the thing that differs is secret material. `ConflictSide`
 * already refuses to carry it — a secret crosses as a length and nothing else. The temptation is
 * then to add "…but let the user peek at this one", and the reason to refuse is that this is the
 * one screen in the app that shows *many records at once*. A reveal affordance here turns a
 * merge into a bulk secret-disclosure surface: four hundred rows, each one click from a
 * plaintext password, all under a single act of consent ("I opened the merge screen"). Rate
 * limits do not fix that; they only slow it down.
 *
 * The deliberate act stays where it already is. `MergeResolverProps.onOpenRecord` navigates to
 * the record's own detail view, which reveals one item at a time through the secret broker under
 * the existing rules. Nothing in `src/renderer/src/sync/` calls a reveal path itself.
 *
 * ## Why the screen does not call `prepare`
 *
 * `prepare` opens a native file dialog, decrypts another whole vault (Argon2id, which takes real
 * time by design) and takes the mandatory pre-merge backup. That belongs to the gesture that
 * *starts* a merge — a menu item, a settings button — not to a screen that renders its result.
 * `MergeResolver` therefore takes a `MergePreview` it was handed. `prepare` stays on the port
 * because the port is the app's whole door to `kh:sync:*` and the caller opening the resolver
 * goes through it.
 */
export interface SyncGateway {
  /**
   * Opens the file dialog, backs up, and merges once. `null` when the user cancelled.
   *
   * Slow, and unavoidably so — it decrypts a second vault. Whatever calls it must show a busy
   * state; `SyncApi` has no progress channel, so that state is indeterminate today.
   */
  prepare(): Promise<MergePreview | null>;
  /**
   * Re-runs the merge with every choice made so far, and returns the fresh report.
   *
   * The engine has exactly one merge path — there is no separate "apply resolutions" that could
   * diverge from it — so this is `mergeDocuments` again with `options.resolutions`. It may
   * return conflicts the previous report did not have: answering one question can change what
   * the next one is, and the resolver is written for that.
   */
  resolve(request: MergeResolveRequest): Promise<MergeReport>;
  /**
   * Writes the merged vault. Refuses while `report.requiresResolution` is true.
   *
   * The refusal exists on **both** sides. The UI disables the button; `MergeSessionStore.commit`
   * throws anyway. A UI guard is a convenience and this one is a data-loss boundary, so it is
   * not the only thing standing there.
   */
  commit(planId: string): Promise<MergeCommitResult>;
  /**
   * Drops the plan and the decrypted copy of the other vault.
   *
   * Called however the resolver closes — applied, cancelled, or unmounted. Not politeness: what
   * is being dropped is the largest amount of the user's data this process ever holds outside
   * their own open vault.
   */
  discard(planId: string): Promise<void>;
}

/**
 * Codes the screen reacts to by name rather than by message.
 *
 * Declared here because the `kh:sync:*` handlers do not exist yet, and deliberately shaped as
 * the list to move into `@shared/model/sync-plan.ts` beside `SYNC_CHANNELS` — at which point
 * this becomes a re-export, exactly as `../import/gateway.ts` re-exports `IMPORT_ERROR_CODES`
 * after its own copy became the thing that drifted.
 */
/**
 * The refusal codes, re-exported from `@shared/model/sync-plan.ts`.
 *
 * Declared here first and moved, because both processes need the same strings and the main
 * side has to raise what this side matches on. Same arrangement as `IMPORT_ERROR_CODES`, and
 * for the same reason: two copies either side of a process boundary drift before anything
 * uses both, and the drift is invisible until a code stops being recognised.
 */
export { SYNC_ERROR_CODES, isSyncErrorCode, type SyncErrorCode };

/**
 * The one failure shape the resolver handles.
 *
 * Carries the structured code so the handful of failures with a specific answer can be given
 * one, and falls back to the already-scrubbed message otherwise. The message is never allowed to
 * carry a value from either vault — that is `IpcFailure.message`'s documented invariant, and
 * this type inherits it rather than restating it.
 */
export class SyncGatewayError extends Error {
  readonly code: string;
  /** True when retrying, or answering differently, could work. */
  readonly recoverable: boolean;

  constructor(code: string, message: string, recoverable: boolean) {
    super(message);
    this.name = 'SyncGatewayError';
    this.code = code;
    this.recoverable = recoverable;
  }
}

/**
 * What the screen says when a failure has a specific answer.
 *
 * A partial `Record`, not an exhaustive one: most failures deserve the scrubbed message the main
 * process sent, and inventing copy for them here would replace something specific with something
 * generic. Only the codes with a *different next action* are listed.
 */
export const SYNC_ERROR_ADVICE: Readonly<Partial<Record<SyncErrorCode, string>>> = {
  'sync/stale-plan': 'This merge is no longer open. Start it again from the beginning.',
  'sync/vault-moved':
    'Your vault changed on disk while this merge was open, so it was not written. Start the merge again to pick the change up.',
  'sync/duplicate-id':
    'One of the two files holds the same record twice, which a merge cannot reconcile. Run the vault check before trying again.',
  'sync/backup-failed':
    'The safety copy could not be verified, so nothing was merged and your vault is untouched.',
  'sync/write-failed':
    'The merged vault could not be written. Your vault is untouched, and the pre-merge backup still stands.',
};

/** The advice for a code, or the scrubbed message the main process sent. */
export function syncErrorMessage(error: SyncGatewayError): string {
  const advice = (SYNC_ERROR_ADVICE as Readonly<Record<string, string | undefined>>)[error.code];
  return advice ?? error.message;
}
