// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';

/**
 * The only place in Keyhold where a password is hashed for the Have I Been Pwned check,
 * and the boundary that makes the check safe.
 *
 * ## What leaves this module, exactly
 *
 * `passwordRange()` returns two strings. **Only `prefix` — five hex characters, twenty
 * bits — is ever sent anywhere.** `suffix` is the other thirty-five characters and never
 * leaves the process: it exists solely so the caller can compare it against the list the
 * service sends back. That asymmetry is the entire security argument for this feature, so
 * it is enforced by structure — the transport's signature accepts a prefix and nothing
 * else — rather than by a comment asking callers to be careful.
 *
 * Twenty bits partitions the ~900 million entry corpus into 1,048,576 buckets, so a prefix
 * names roughly 800 real passwords. The service cannot tell which of them was asked about,
 * and nothing identifying the account is sent in any form: no username, no URL, no record
 * id, and no stable ordering — `client.ts` shuffles a sweep's prefixes with the project's
 * CSPRNG before sending them, so the sequence cannot be recognised again next month.
 *
 * ## Why SHA-1, in 2026
 *
 * Not a choice. The Pwned Passwords corpus is indexed by SHA-1, so a lookup against it is
 * a SHA-1 lookup or it is nothing. This is **not** a security use of SHA-1: nothing here
 * relies on collision resistance, on preimage resistance, or on the hash protecting the
 * password. The hash is an index into someone else's table, and its brokenness is
 * irrelevant to that job. Keyhold's actual password hashing is Argon2id, elsewhere, and
 * this file must never be mistaken for it — hence the name, `hash.ts` in `breach/`, and
 * hence this paragraph.
 *
 * ## Never log any of this
 *
 * Not the password, not the digest, not the suffix, and not the prefix. The prefix is safe
 * to *send* — that is the whole design — but a prefix sitting in a log file next to a
 * record title re-attaches the anonymised half to the identifying half, which is the one
 * thing the k-anonymity argument depends on not happening. There is no logging in this
 * directory at all, and `client.test.ts` property-tests that nothing returned from it
 * carries any of the four.
 */

/** Hex characters of the digest sent to the service. The rest stays here. */
export const RANGE_PREFIX_LENGTH = 5;

/** Hex characters retained locally for matching. SHA-1 is 40 hex characters in total. */
export const RANGE_SUFFIX_LENGTH = 35;

/**
 * Upper-case hex SHA-1 of the UTF-8 encoding of `secretPassword`.
 *
 * UTF-8 and upper case are not stylistic: the corpus was built over UTF-8 bytes and is
 * published in upper case, so a password containing an accent or an emoji only matches if
 * it is encoded the same way. Node's default string encoding for `update()` is UTF-8, but
 * it is passed explicitly because a silent default change here would produce wrong answers
 * for exactly the users whose passwords are least likely to be in the corpus anyway — an
 * error nobody would ever notice.
 *
 * Not exported. The full digest is not something any caller in this codebase needs, and an
 * exported "give me the whole hash of this password" helper is precisely the shape of
 * function that ends up being called from somewhere it should not be.
 */
function sha1Hex(secretPassword: string): string {
  return createHash('sha1').update(secretPassword, 'utf8').digest('hex').toUpperCase();
}

/**
 * The five-character range prefix for a password — the only thing that is transmitted.
 *
 * `password` → `5BAA6`, which is the vector every implementation of this API is checked
 * against, and which `hash.test.ts` verifies from first principles rather than by trusting
 * a constant copied out of a blog post.
 */
export function rangePrefix(secretPassword: string): string {
  return sha1Hex(secretPassword).slice(0, RANGE_PREFIX_LENGTH);
}

/** A password's split digest: the part that is sent, and the part that never is. */
export interface PasswordRange {
  /** Five upper-case hex characters. Safe to transmit; see the file header. */
  readonly prefix: string;
  /** Thirty-five upper-case hex characters. **Must not leave the process.** */
  readonly suffix: string;
}

/**
 * Splits a password's digest into the transmitted prefix and the locally-retained suffix.
 *
 * Both halves come from one hashing pass. Computing them separately would hash the password
 * twice for no reason, and — more to the point — would give the codebase two functions that
 * take a password and return part of its hash, when it should have exactly one.
 */
export function passwordRange(secretPassword: string): PasswordRange {
  const digest = sha1Hex(secretPassword);
  return {
    prefix: digest.slice(0, RANGE_PREFIX_LENGTH),
    suffix: digest.slice(RANGE_PREFIX_LENGTH),
  };
}
