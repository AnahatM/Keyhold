// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The two string helpers every diagnostic message goes through.
 *
 * Small, and in their own file, because both are load-bearing in a way that would be invisible
 * inlined: one keeps a report readable, the other keeps it safe.
 */

/**
 * Groups digits with commas — `4096` becomes `4,096`.
 *
 * Hand-rolled rather than `toLocaleString`, which is locale-dependent: the same report would
 * render `4.096` on a German machine and `4,096` on an English one, and the tests that assert
 * on these strings would pass on the developer's laptop and fail in CI. A diagnostic report is
 * pasted into an issue tracker and read by someone else, so it is deliberately not localised.
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const negative = value < 0;
  const digits = Math.trunc(Math.abs(value))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return negative ? `-${digits}` : digits;
}

/** How much of a borrowed message a report will carry. */
const MAX_DETAIL_LENGTH = 200;

/**
 * Normalises a message borrowed from another layer's error before it enters a report.
 *
 * Only three messages are ever borrowed — `parseHeader`'s, `assertUsableKdfParams`'s and
 * `assertValidHistory`'s — and all three are safe to repeat, for reasons worth writing down
 * because they are not obvious:
 *
 *  - **Header parse failures** quote our own field-name literals and, in two cases, an
 *    algorithm identifier read from the file. The header is plaintext by design; anything in
 *    it is already readable by whoever holds the file, and none of it is secret material. The
 *    salt and the wrapped key never appear in a message, only in fields this module reports as
 *    lengths.
 *  - **KDF range failures** quote numbers and the algorithm name.
 *  - **History failures** quote a record id, a version number, and a field name — except for
 *    one case, a snapshot key that came out of a corrupt file and could be any string at all.
 *    `redactUnknownFields` handles exactly that case; this function only bounds the length.
 *
 * The cap is a backstop, not the defence. A truncated secret is still a secret, so nothing
 * relies on it — it exists so a pathological file cannot turn one finding into a page of text.
 */
export function sanitiseDetail(message: string): string {
  const collapsed = message.replace(/\s+/g, ' ').trim();
  return collapsed.length <= MAX_DETAIL_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_DETAIL_LENGTH - 1)}…`;
}

/**
 * Replaces any double-quoted run that is not a known-safe token with `"…"`.
 *
 * `assertValidHistory` reports an unexpected snapshot key by quoting it. In a healthy vault
 * that key is a field name; in the corrupt vault this module exists to describe, it is
 * whatever the corruption put there — which could be a fragment of a decrypted note. Naming
 * the invariant that broke is worth keeping, so the message is kept and the unknown token is
 * removed, rather than throwing the whole message away.
 */
export function redactUnknownFields(message: string, allowed: readonly string[]): string {
  const safe = new Set(allowed);
  return message.replace(/"([^"]*)"/g, (whole, token: string) => (safe.has(token) ? whole : '"…"'));
}

/**
 * Greedy word wrap.
 *
 * The rendered report is read in a terminal and pasted into an issue tracker, both of which
 * are unkind to a 400-character paragraph on one line. Words longer than the width are left
 * alone rather than broken, because the only long tokens here are ids — and a hyphenated id
 * is one nobody can search for.
 */
export function wrapText(text: string, width: number): readonly string[] {
  const lines: string[] = [];
  let current = '';

  for (const word of text.split(/\s+/).filter((token) => token !== '')) {
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= width) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines.length > 0 ? lines : [''];
}
