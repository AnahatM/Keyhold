// SPDX-License-Identifier: GPL-3.0-or-later
import type { IpcResult } from '@shared/ipc/api.js';
import type {
  ConflictCandidateView,
  MergeCommitResult,
  MergePreview,
  MergeResolveRequest,
  SyncApi,
} from '@shared/model/sync-plan.js';
import type { MergeReport } from '@shared/model/sync.js';
import { SyncGatewayError, type SyncGateway } from './sync-gateway.js';

/**
 * Adapts the preload bridge to {@link SyncGateway}.
 *
 * The whole file is `unwrap`. That is the point: the `IpcResult` union is checked in one place
 * instead of at every call site, and the resolver's components never learn that IPC exists.
 *
 * It takes the bridge as an **argument** rather than reaching for `window.keyhold.sync` itself,
 * for two reasons. It compiles today, before the channels are wired — the contract it adapts
 * (`SyncApi`) is already declared in `@shared/model/sync-plan.ts`, and the preload will satisfy
 * it. And it stays substitutable: a test wanting the adapter's unwrapping without an Electron
 * process passes a stub bridge.
 *
 * Wiring, once `window.keyhold.sync` exists:
 *
 * ```ts
 * const gateway = createIpcSyncGateway(window.keyhold.sync);
 * ```
 */
export function createIpcSyncGateway(bridge: SyncApi): SyncGateway {
  return {
    candidates: async (): Promise<readonly ConflictCandidateView[]> =>
      unwrap(await bridge.candidates()),

    prepare: async (candidateId?: string): Promise<MergePreview | null> =>
      unwrap(await bridge.prepare(candidateId)),

    resolve: async (request: MergeResolveRequest): Promise<MergeReport> =>
      unwrap(await bridge.resolve(request)),

    commit: async (planId: string): Promise<MergeCommitResult> =>
      unwrap(await bridge.commit(planId)),

    discard: async (planId: string): Promise<void> => {
      unwrap(await bridge.discard(planId));
    },
  };
}

function unwrap<T>(result: IpcResult<T>): T {
  if (result.ok) return result.value;
  throw new SyncGatewayError(result.code, result.message, result.recoverable);
}
