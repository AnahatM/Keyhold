// SPDX-License-Identifier: GPL-3.0-or-later
import {
  ATTACHMENT_CEILINGS,
  DEFAULT_ATTACHMENT_SETTINGS,
  type AttachmentSettings,
} from '@shared/model/attachment.js';
import { invalidAttachmentLimit } from './errors.js';

/**
 * Folding the caps: defaults, then the vault's own settings, then a caller's override.
 *
 * Same shape as `resolveHealthConfig` — the defaults are a fallback for a caller with no
 * document, not a second source of truth, and an explicit override still wins so a "what
 * if I raised this?" preview needs no settings write.
 *
 * ## Why the ceilings are enforced here and not at the setting's edit field
 *
 * A setting travels inside the vault, so it can arrive from a file written by another
 * build, an import, or a hand-edited export. Validating it where it is *used* is the only
 * place that catches all of those. And the failure mode is nasty in a specific way: a
 * per-file cap above `MAX_CHUNK_BYTES` would let this app write a chunk its own reader then
 * refuses. `readContainer` throws `TOO_LARGE` on that chunk before it returns anything, so
 * the whole vault stops opening — not just the oversized attachment. That is total data
 * loss dressed up as a configurable option.
 *
 * The lower bound matters just as much: a vault total below the per-file cap makes the
 * per-file cap a lie, because no file that size could ever fit. Rejecting the combination
 * beats letting the user discover it one 25 MB file at a time.
 */
export function resolveAttachmentLimits(
  overrides?: Partial<AttachmentSettings>
): AttachmentSettings {
  const merged: AttachmentSettings = { ...DEFAULT_ATTACHMENT_SETTINGS, ...overrides };

  requirePositiveInteger(merged.maxAttachmentBytes, 'the per-attachment size limit');
  requirePositiveInteger(merged.maxVaultAttachmentBytes, 'the per-vault attachment total');
  requirePositiveInteger(merged.maxAttachmentsPerRecord, 'the per-record attachment count');
  requirePositiveInteger(merged.warnAboveBytes, 'the large-attachment warning threshold');

  if (merged.maxAttachmentBytes > ATTACHMENT_CEILINGS.maxAttachmentBytes) {
    throw invalidAttachmentLimit(
      `the per-attachment limit is ${merged.maxAttachmentBytes} bytes, above the ${ATTACHMENT_CEILINGS.maxAttachmentBytes}-byte chunk the KEEP container can read back`
    );
  }
  if (merged.maxVaultAttachmentBytes > ATTACHMENT_CEILINGS.maxVaultAttachmentBytes) {
    throw invalidAttachmentLimit(
      `the per-vault total is ${merged.maxVaultAttachmentBytes} bytes, above the ${ATTACHMENT_CEILINGS.maxVaultAttachmentBytes}-byte ceiling`
    );
  }
  if (merged.maxAttachmentsPerRecord > ATTACHMENT_CEILINGS.maxAttachmentsPerRecord) {
    throw invalidAttachmentLimit(
      `${merged.maxAttachmentsPerRecord} attachments per record is above the ${ATTACHMENT_CEILINGS.maxAttachmentsPerRecord} ceiling`
    );
  }
  if (merged.maxVaultAttachmentBytes < merged.maxAttachmentBytes) {
    throw invalidAttachmentLimit(
      `the per-vault total (${merged.maxVaultAttachmentBytes} bytes) is below the per-attachment limit (${merged.maxAttachmentBytes} bytes), so no file that size could ever be stored`
    );
  }

  return {
    ...merged,
    // A warning threshold above the cap can never fire, which is harmless but pointless.
    // Clamped rather than rejected: it is a nudge, not a rule, and refusing to open a vault
    // over the placement of a nudge would be absurd.
    warnAboveBytes: Math.min(merged.warnAboveBytes, merged.maxAttachmentBytes),
  };
}

function requirePositiveInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidAttachmentLimit(`${what} must be a positive whole number of bytes, got ${value}`);
  }
}
