// SPDX-License-Identifier: GPL-3.0-or-later

import type { IpcResult } from '@shared/ipc/api.js';
import type { ExportFormatDescriptor } from '@shared/model/export.js';
import type {
  ExportOutcome,
  ExportPlan,
  ExportPreview,
  ExportPreviewRequest,
} from '@shared/model/export-plan.js';
import type { PasswordStrength } from '@shared/model/strength.js';
import { unwrap } from '../vault/session-store.js';

/**
 * The dialog's one door to the outside world.
 *
 * Four calls, no state, nothing that returns bytes. Everything the export dialog knows
 * about the export engine comes through here, which is what makes the dialog testable
 * without Electron, without a vault, and without producing a single readable byte — see
 * `fake-export-gateway.ts`.
 *
 * ## Why an interface rather than calling `window.keyhold` directly
 *
 * Every other view in this app talks to a Zustand store that talks to the bridge. That is
 * the right shape for state the whole app shares. An export is not state the app shares:
 * it is one modal, opened, completed and thrown away, and the thing worth testing about it
 * is the *sequence of decisions* — which formats were offered, what the losses said, and
 * whether the confirmation had been satisfied before `run` was reached. A port lets those
 * be asserted against a fake that records calls, rather than against a mocked global.
 *
 * ## Why `preview` and `run` are separate calls
 *
 * `preview` describes what would happen and writes nothing; `run` writes a file. They take
 * different arguments on purpose — a preview request cannot carry a confirmation or a
 * passphrase, because the preview happens before the user has been asked for either, and a
 * type that *could* carry a passphrase is a type that eventually does.
 */
export interface ExportGateway {
  /**
   * The engine's own format registry.
   *
   * Fetched rather than declared. The dialog renders whatever comes back, in the order it
   * comes back in — which is deliberate on the engine's side, with the encrypted parcel
   * first so that the dangerous option is never the obvious one. A hand-written list here
   * would be a second list (rule 8) and would be the copy that went stale.
   */
  readonly formats: () => Promise<readonly ExportFormatDescriptor[]>;
  /** What this format and scope would cost. Writes nothing, returns no bytes. */
  readonly preview: (request: ExportPreviewRequest) => Promise<ExportPreview>;
  /**
   * Executes the plan: the **main process** opens the save dialog, writes the file, and
   * returns a description of what it wrote. No path is sent, and no bytes come back.
   */
  readonly run: (plan: ExportPlan) => Promise<ExportOutcome>;
  /** Scores a parcel passphrase. The passphrase never leaves the main process. */
  readonly estimateStrength: (password: string) => Promise<PasswordStrength | null>;
}

/**
 * The main-process half of the contract, as the preload will expose it.
 *
 * Declared here as the *shape the adapter needs* rather than imported from `@shared/ipc`,
 * because the `kh:export:*` channels do not exist yet — the engine is built, the bridge is
 * not. When they land, `ImportExportApi` in `@shared/ipc/api.ts` should be written to match
 * this interface exactly and this declaration replaced by an import of it.
 */
export interface ExportBridge {
  readonly formats: () => Promise<IpcResult<readonly ExportFormatDescriptor[]>>;
  readonly preview: (request: ExportPreviewRequest) => Promise<IpcResult<ExportPreview>>;
  readonly run: (plan: ExportPlan) => Promise<IpcResult<ExportOutcome>>;
}

/** Scoring is `session.estimateStrength`, which already exists. Passed in, not reached for. */
export type StrengthEstimator = (password: string) => Promise<IpcResult<PasswordStrength>>;

/**
 * Adapts the preload bridge to the port.
 *
 * Takes the bridge as an argument rather than reading `window.keyhold` itself, so that this
 * module compiles and is exercised before the channels exist, and so that wiring it up is
 * one expression at the call site instead of a global this file depends on.
 *
 * Strength is the one call that is allowed to fail quietly: a passphrase meter that throws
 * because zxcvbn's dictionaries did not load should not take the export dialog down with
 * it. Everything else propagates, because a preview that silently returned "nothing will be
 * lost" would be the most dangerous possible failure mode here.
 */
export function exportGatewayFrom(
  bridge: ExportBridge,
  estimateStrength: StrengthEstimator
): ExportGateway {
  return {
    formats: async () => unwrap(await bridge.formats()),
    preview: async (request) => unwrap(await bridge.preview(request)),
    run: async (plan) => unwrap(await bridge.run(plan)),
    estimateStrength: async (password) => {
      try {
        return unwrap(await estimateStrength(password));
      } catch {
        return null;
      }
    },
  };
}
