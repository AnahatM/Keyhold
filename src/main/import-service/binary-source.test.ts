// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { onePassword1puxParser } from '../import/index.js';
import { decodeSourceText } from './source-store.js';

/**
 * Guard: a binary export survives the trip from disk to parser.
 *
 * Every parser takes a `string`, which is right for the eleven text formats and structurally
 * wrong for a `.1pux` — it is a ZIP archive. The join between them is `decodeSourceText`, and
 * the failure it exists to prevent is silent and total: UTF-8 decoding replaces every invalid
 * byte sequence with U+FFFD, irreversibly, so a compressed stream arrives as noise and the
 * only symptom is a user being told their export is damaged when it is not.
 *
 * The parser's own tests all build their archives in memory and never cross this join, so
 * nothing else in the suite would notice it breaking. That is what this file is for.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../../../tests/fixtures/import/onepassword.1pux');

describe('a .1pux through the source store', () => {
  it('reaches the parser with every byte intact', () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const text = decodeSourceText(bytes);

    // Byte-for-byte, which is the whole property. A length check alone would pass on a
    // decoding that replaced bytes one-for-one with U+FFFD.
    const roundTripped = new Uint8Array(Buffer.from(text, 'latin1'));
    expect(roundTripped).toEqual(bytes);
  });

  it('parses into records after that trip', () => {
    // The end-to-end version: not just that the bytes survive, but that the parser can still
    // read them. This is the assertion that would have caught the UTF-8 path.
    const text = decodeSourceText(new Uint8Array(readFileSync(FIXTURE)));
    const result = onePassword1puxParser.parse(text);

    expect(result.records.length).toBeGreaterThan(0);
    expect(result.records.map((record) => record.title)).toContain('Example Mail');
  });

  it('is not what a UTF-8 decode would have produced', () => {
    // The control. Without it the two assertions above could both pass on a decoder that
    // happened to be lossless for this particular fixture, and the guard would be a
    // coincidence rather than a check.
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const asUtf8 = new TextDecoder('utf-8').decode(bytes);

    expect(new Uint8Array(Buffer.from(asUtf8, 'latin1'))).not.toEqual(bytes);
  });
});
