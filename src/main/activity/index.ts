// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The session activity log.
 *
 * Two layers: `ActivityLog` is a bounded, privacy-gated ring buffer that knows nothing about
 * vaults, and `SessionActivity` is the vocabulary the session speaks to it in. Bind the
 * latter; the former exists so the buffer's behaviour can be tested without a vault.
 *
 * Nothing here persists anything, and there is deliberately no serialiser to make it easy —
 * see the header of `activity-log.ts`.
 */

export { ActivityLog, type ActivityInput, type ActivityLogOptions } from './activity-log.js';
export { SessionActivity, type ActivityVaultRef } from './session-activity.js';
