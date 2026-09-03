// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The small string helpers every diagnostic message goes through.
 *
 * Small, and in their own file, because they are load-bearing in a way that would be invisible
 * inlined: they decide how a report reads, and they used to be asked to decide whether it was
 * safe. That second job has been taken away from them — see the note at the foot of this file.
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
 *  - **History failures are no longer borrowed at all.** They interpolated a snapshot key, a
 *    changed-field name and a version number straight out of a corrupt document, and
 *    `document-diagnosis.ts` now composes that finding itself. See `history-detail.ts`.
 *
 * The cap is a backstop, not a defence, and this function is not a redactor. A truncated
 * secret is still a secret — worse, truncation is what defeated the redactor that used to
 * live below this one. Nothing may rely on this for safety; it exists so that a pathological
 * file cannot turn one finding into a page of text.
 */
export function sanitiseDetail(message: string): string {
  const collapsed = message.replace(/\s+/g, ' ').trim();
  return collapsed.length <= MAX_DETAIL_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_DETAIL_LENGTH - 1)}…`;
}

/*
 * `redactUnknownFields` used to live here, and it is not coming back.
 *
 * It replaced any double-quoted run that was not a known field name with `"…"`, so that
 * `assertValidHistory`'s message could be repeated in a report even though the snapshot key it
 * quotes comes out of a corrupt file and could be a fragment of a decrypted note. Two shapes
 * walked straight past it:
 *
 *  - a key long enough that `sanitiseDetail`'s cap cut the closing quote off, leaving no pair
 *    to match and the entire message — key included — passing through untouched; and
 *  - a key containing a `"` of its own, which leaks everything *between* two pairs the scanner
 *    is perfectly happy with. Swapping the order of the two calls fixes the first and not the
 *    second.
 *
 * The lesson is not "write a better regex". A scrubber over a string built by interpolating
 * untrusted content has to win every time; the next adversarial key only has to be new once.
 * The replacement composes the sentence from a fixed vocabulary plus values that are safe by
 * construction, so nothing untrusted ever enters the string. See `history-detail.ts`, and
 * `document-diagnosis.test.ts` for both bypasses as live regression tests.
 */

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
