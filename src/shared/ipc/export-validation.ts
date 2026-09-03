// SPDX-License-Identifier: GPL-3.0-or-later
import { EXPORT_FORMAT_IDS, type ExportFormatId } from '../model/export.js';
import type { ExportPlan, ExportPreviewRequest, ExportScope } from '../model/export-plan.js';
import { IpcValidationError, requireNonEmptyString } from './validation.js';

/**
 * Validating an export request at the boundary.
 *
 * This is the one channel in the app that turns an encrypted vault into a file, and one of
 * its two branches produces a file anybody can read. So the main process re-derives every
 * decision from the raw message rather than trusting a shape the renderer says it built:
 *
 *  - the **format** must be one the registry knows, by id, from the shared list;
 *  - `kind` must **agree with the registry** about whether that format is encrypted. A plan
 *    claiming `plaintext` for the parcel, or `encrypted` for a CSV, is either a bug or a
 *    renderer trying to route around the confirmation, and both deserve a refusal;
 *  - the **confirmation** arrives as raw typed text and is matched here, by the one matcher.
 *    A boolean computed in the renderer would make the gate exactly as strong as the
 *    renderer, which is the assumption decision D13 exists to refuse to make;
 *  - `includeTrashed` must be **present and boolean**. Not defaulted: at the boundary where
 *    a person is choosing, an omission is a bug, and silently reading it as `false` would
 *    quietly export less than was asked for.
 *
 * Nothing here looks at a path, because a plan has no path. See `EXPORT_CHANNELS`.
 */

function requireObject(channel: string, value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new IpcValidationError(channel, `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireExportFormatId(channel: string, value: unknown): ExportFormatId {
  const id = requireNonEmptyString(channel, value, 'format');
  if (!(EXPORT_FORMAT_IDS as readonly string[]).includes(id)) {
    // The id, not the whole message: format ids are a closed set written in this repo, so
    // echoing one back cannot disclose anything the renderer did not already have.
    throw new IpcValidationError(channel, `format must be a known export format, not "${id}"`);
  }
  return id as ExportFormatId;
}

export function requireExportScope(channel: string, value: unknown): ExportScope {
  const scope = requireObject(channel, value, 'scope');

  if (typeof scope.includeTrashed !== 'boolean') {
    throw new IpcValidationError(channel, 'scope.includeTrashed must be a boolean');
  }

  const ids = scope.recordIds;
  if (ids === null) return { includeTrashed: scope.includeTrashed, recordIds: null };
  if (!Array.isArray(ids)) {
    throw new IpcValidationError(channel, 'scope.recordIds must be an array of ids, or null');
  }
  const recordIds = ids.map((id, index) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new IpcValidationError(channel, `scope.recordIds[${index}] must be a non-empty string`);
    }
    return id;
  });
  return { includeTrashed: scope.includeTrashed, recordIds };
}

export function requireExportPreviewRequest(channel: string, value: unknown): ExportPreviewRequest {
  const request = requireObject(channel, value, 'request');
  return {
    format: requireExportFormatId(channel, request.format),
    scope: requireExportScope(channel, request.scope),
  };
}

/**
 * Validates a plan's shape. **The registry cross-check and the confirmation are not done
 * here** — they live in the handler, which is the only place that has both the descriptor
 * and the ability to refuse with an `ExportOutcome` the dialog can render.
 */
export function requireExportPlan(channel: string, value: unknown): ExportPlan {
  const plan = requireObject(channel, value, 'plan');
  const format = requireExportFormatId(channel, plan.format);
  const scope = requireExportScope(channel, plan.scope);

  const kind = plan.kind;
  if (kind === 'encrypted') {
    if (format !== 'keyhold-parcel') {
      throw new IpcValidationError(channel, 'an encrypted plan must name the parcel format');
    }
    // Non-empty only. Strength is the dialog's business to advise on and the user's to
    // decide; a length rule enforced here would be a second, invisible password policy.
    const secretPassphrase = requireNonEmptyString(
      channel,
      plan.secretPassphrase,
      'secretPassphrase'
    );
    return { kind: 'encrypted', format: 'keyhold-parcel', scope, secretPassphrase };
  }

  if (kind === 'plaintext') {
    if (format === 'keyhold-parcel') {
      throw new IpcValidationError(channel, 'the parcel format cannot be exported as plaintext');
    }
    // Whatever was typed, unnormalised and unjudged. `requireString`, not
    // `requireNonEmptyString`: an empty confirmation is a *refusal*, which the handler
    // reports as an outcome the dialog can show, not a validation error the user cannot act
    // on.
    const confirmation = plan.confirmation;
    if (typeof confirmation !== 'string') {
      throw new IpcValidationError(channel, 'confirmation must be a string');
    }
    return { kind: 'plaintext', format, scope, confirmation };
  }

  throw new IpcValidationError(channel, 'kind must be "plaintext" or "encrypted"');
}
