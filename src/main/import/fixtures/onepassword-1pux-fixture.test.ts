// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildOnePassword1pux, ONEPASSWORD_EXPORT_DATA } from './build-1pux.js';

/**
 * Guard: the committed `.1pux` fixture is the artefact of source anybody can read.
 *
 * Every other import fixture is text — a reviewer opens `bitwarden.json` and can say whether
 * it looks like a real export. A `.1pux` is a ZIP archive, so committing one on its own would
 * put an unreadable binary in the repository, and it would be the fixture for the format with
 * the largest attack surface, since a ZIP reader parses a hostile file. "Trust this blob" is
 * the wrong answer there.
 *
 * So `build-1pux.ts` holds the contents in the open and this test keeps the two in step. It
 * **writes the file when it is missing** rather than failing, because a fixture that a fresh
 * clone cannot produce is a fixture that makes the whole suite unrunnable on a new machine —
 * and because the bytes are fully determined by source that is already under review.
 *
 * It can only do that because the entries are *stored*, not deflated: deflate output is not
 * byte-stable across zlib versions, and a fixture that changed when Node changed would fail
 * for a reason that has nothing to do with Keyhold. The deflate path is covered by the
 * archives `zip-reader.test.ts` builds in memory.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../../../../tests/fixtures/import/onepassword.1pux');

describe('the 1pux fixture', () => {
  it('matches what build-1pux.ts produces', () => {
    const expected = Buffer.from(buildOnePassword1pux());

    if (!existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, expected);
    }

    // A mismatch means somebody edited `build-1pux.ts` without regenerating, or edited the
    // binary by hand. Deleting the file and re-running is the fix, and this message says so
    // because the diff of a ZIP tells a reader nothing.
    expect(
      Buffer.from(readFileSync(FIXTURE)).equals(expected),
      'tests/fixtures/import/onepassword.1pux is out of step with build-1pux.ts — delete it and re-run to regenerate'
    ).toBe(true);
  });

  it('describes an export with something to skip and something to warn about', () => {
    // Keeps the fixture honest about being a *useful* fixture. A `.1pux` holding one perfect
    // login would let a parser that ignores trashed items, and one that never counts
    // attachments, both pass every test built on it.
    const items = ONEPASSWORD_EXPORT_DATA.accounts[0]?.vaults[0]?.items ?? [];

    expect(items.some((item) => item.state === 'trashed')).toBe(true);
    expect(items.some((item) => item.categoryUuid === '002')).toBe(true);
  });
});
