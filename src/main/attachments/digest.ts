// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * SHA-256 over attachment bytes, and the comparison that goes with it.
 *
 * The digest does three jobs, and it is worth being clear that only the first is about
 * security:
 *
 *  1. **Integrity.** The chunk is already authenticated by AES-GCM against tampering *in
 *     the file*, but the tag proves "these are the bytes that were encrypted", not "these
 *     are the bytes the user attached". The digest is recorded at attach time, before
 *     anything else touches the data, so a bug in our own write path is caught too.
 *  2. **Dedupe.** Two records attaching the same file compare digests, not contents.
 *  3. **A stable identity for the *content*** — which is deliberately not the chunk id.
 *     See the note in `store.ts` on why the id must stay random.
 */

/** Lowercase hex. Hex rather than base64 so it round-trips through JSON and a log unchanged. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Constant-time digest comparison.
 *
 * A digest is not secret, so this is not defending a key — it is defending against the
 * one place a naive compare would matter: a `===` on hex strings short-circuits at the
 * first differing character, and integrity checking is the sort of loop that eventually
 * gets run over attacker-supplied data in a tight loop. Doing it right costs nothing.
 *
 * Length is compared first and non-constant-time, which is fine: digest length is fixed
 * and public.
 */
export function digestsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
