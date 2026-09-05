// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHUNK_ID_BYTES,
  DEFAULT_KDF_PARAMS,
  FORMAT_VERSION,
  KEY_BYTES,
  LENGTH_FIELD_BYTES,
  MAGIC,
  MAGIC_LENGTH,
  MAX_KDF_PARAMS,
  MIN_KDF_PARAMS,
  NONCE_BYTES,
  SALT_BYTES,
  TAG_BYTES,
  VERSION_FIELD_BYTES,
} from '../src/shared/format/types.js';

/**
 * Guard: **the KEEP format spec still describes the code.**
 *
 * Hard rule 9 — "a number written in prose gets a test that parses it back out of the doc" —
 * and this is the document where it matters most.
 * `docs/04-Vault-Format/00-KEEP-Format-Spec.md` is not an explainer. It is written to be
 * *implementable by a third party*, and the no-lock-in claim rests on that: "you can leave
 * whenever you want" is only worth saying if somebody else can write a reader. So a drifted
 * number here does not confuse a colleague — it produces a **wrong reader**, on somebody
 * else's machine, months later, with no way to trace it back.
 *
 * Nothing else could catch it. The spec is prose; the constants are code; the two agree today
 * because a person made them agree, and there was no mechanism keeping them that way. Every
 * other guard in this repository reads code, and code that stops matching its documentation
 * compiles perfectly.
 *
 * ## What it checks
 *
 * 1. **The byte-layout block is internally consistent.** Each numbered offset equals the
 *    previous offset plus the previous size. This is checked *before* any comparison with the
 *    code, because a table that does not add up is wrong even if every individual figure has
 *    a matching constant.
 * 2. **Each named size matches its constant.** The field-name-to-constant mapping below is
 *    the assertion itself, not a second copy of the data — the sizes live only in
 *    `src/shared/format/types.ts`, and this says which of them each row is claiming.
 * 3. **The magic bytes are byte-for-byte.** Parsed out of the spec's hex block and compared
 *    with `MAGIC`, so the eight bytes a third-party reader would match on cannot drift.
 * 4. **The KDF table's defaults, minimums and maximums** match `DEFAULT_KDF_PARAMS`,
 *    `MIN_KDF_PARAMS` and `MAX_KDF_PARAMS`. These are the numbers most likely to be tuned
 *    later, and tuning them without touching the spec is exactly the drift this exists for.
 * 5. **The encryption table's nonce, tag and chunk-id sizes**, which a reader must get right
 *    or every decryption fails with no useful diagnosis.
 *
 * Fault injections performed, each reverted:
 *  - Changed the spec's `formatVersion` size from 2 to 3 — failed **both** the consistency
 *    check (the following offset no longer follows) and the size check, which is the right
 *    outcome: one says the table contradicts itself, the other says which figure is wrong.
 *  - Changed the spec's body nonce from 12 to 16 — failed `body nonce`.
 *  - Changed `memoryKib`'s minimum in the spec from 19 456 to 19 000 — failed the KDF table.
 *  - Flipped one hex digit in the magic block — failed the byte comparison.
 *  - Changed `NONCE_BYTES` in the **code** from 12 to 13 — failed, which is the direction
 *    that matters most: the guard has to fire when the code moves away from the spec, not
 *    only when somebody edits the document.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SPEC = join(ROOT, 'docs/04-Vault-Format/00-KEEP-Format-Spec.md');

const spec = readFileSync(SPEC, 'utf8');

/** The fenced block introduced by the `offset  size  field` heading. */
function layoutBlock(): string {
  const match = /```\n\s*offset\s+size\s+field\n([\s\S]*?)```/.exec(spec);
  if (match?.[1] === undefined) throw new Error('the byte-layout block is missing from the spec');
  return match[1];
}

interface LayoutRow {
  /** Absent for the rows the spec writes as `…` or as a derived expression like `14+N`. */
  readonly offset: number | null;
  readonly size: number | null;
  readonly field: string;
}

/**
 * Reads the layout table.
 *
 * A row's offset is a number, `…`, or an expression such as `14+N`; its size is a number, `N`
 * or `…`. Anything non-numeric becomes `null` rather than being guessed at — the point of
 * this file is to check what the document *states*, and inventing a value for a row that
 * deliberately does not state one would be checking this parser instead.
 */
function layoutRows(): readonly LayoutRow[] {
  const rows: LayoutRow[] = [];
  for (const line of layoutBlock().split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('─')) continue;
    if (line.trimStart().startsWith('then,')) continue;
    const match = /^(\S*)\s+(\S+)\s+(.*\S)\s*$/.exec(line);
    if (match === null) continue;
    const [, rawOffset, rawSize, field] = match;
    const asNumber = (value: string | undefined): number | null =>
      value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
    rows.push({ offset: asNumber(rawOffset), size: asNumber(rawSize), field: field ?? '' });
  }
  return rows;
}

/** Finds the one row whose field description starts with this label. */
function row(label: string): LayoutRow {
  const found = layoutRows().find((entry) => entry.field.startsWith(label));
  if (found === undefined) throw new Error(`no layout row for "${label}"`);
  return found;
}

/** `| a | b | c |` table rows under a heading, as trimmed cells. */
function tableRows(afterHeading: string): readonly (readonly string[])[] {
  const start = spec.indexOf(afterHeading);
  if (start === -1) throw new Error(`heading not found: ${afterHeading}`);
  const rows: string[][] = [];
  for (const line of spec.slice(start).split('\n').slice(1)) {
    if (!line.trimStart().startsWith('|')) {
      if (rows.length > 0) break;
      continue;
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^-+$/.test(cell))) continue;
    rows.push(cells);
  }
  return rows;
}

/**
 * The number a cell leads with. `null` when it does not lead with one.
 *
 * Takes the opening run of digits and spaces and nothing after it, because the cells are
 * prose as often as they are figures: `65 536 (64 MiB)`, `16 random bytes`,
 * `12 bytes, **freshly generated from a CSPRNG for every encryption**`, and `—`. Spaces are
 * this document's thousands separator, so they are stripped rather than treated as a
 * terminator — which is why the run is taken first and cleaned second.
 */
function figure(cell: string): number | null {
  const leading = /^\s*(\d[\d ]*)/.exec(cell);
  if (leading?.[1] === undefined) return null;
  return Number(leading[1].replace(/\s/g, ''));
}

describe('the KEEP spec byte layout', () => {
  it('adds up on its own terms', () => {
    // Checked before anything is compared with the code: a table whose offsets do not follow
    // from its sizes is wrong even when every individual figure has a matching constant, and
    // it is the error a third-party implementer would hit first.
    const problems: string[] = [];
    // `null` means "the rows above stopped stating a length", which the table does
    // deliberately once the header's variable-length `N` appears. From there on there is
    // nothing to check against until a row states an offset again.
    let runningOffset: number | null = 0;

    for (const entry of layoutRows()) {
      const stated: number | null = entry.offset;
      if (stated !== null && runningOffset !== null && stated !== runningOffset) {
        problems.push(
          `${entry.field}: stated offset ${String(stated)}, but the rows above it end at ${String(runningOffset)}`
        );
      }

      const start: number | null = stated ?? runningOffset;
      const size: number | null = entry.size;
      runningOffset = start === null || size === null ? null : start + size;
    }

    expect(problems).toEqual([]);
  });

  it('states the sizes the code actually uses', () => {
    // The mapping is the assertion. Each size has exactly one home in
    // `src/shared/format/types.ts`; this says which home each row of prose is claiming.
    const cases: readonly { readonly label: string; readonly bytes: number }[] = [
      { label: 'MAGIC', bytes: MAGIC_LENGTH },
      { label: 'formatVersion', bytes: VERSION_FIELD_BYTES },
      { label: 'headerLength', bytes: LENGTH_FIELD_BYTES },
      { label: 'bodyLength', bytes: LENGTH_FIELD_BYTES },
      { label: 'body nonce', bytes: NONCE_BYTES },
      { label: 'body authentication tag', bytes: TAG_BYTES },
      { label: 'chunkCount', bytes: LENGTH_FIELD_BYTES },
      { label: 'chunk id', bytes: CHUNK_ID_BYTES },
      { label: 'chunkLength', bytes: LENGTH_FIELD_BYTES },
      { label: 'chunk nonce', bytes: NONCE_BYTES },
      { label: 'chunk authentication tag', bytes: TAG_BYTES },
    ];

    const mismatches = cases
      .filter(({ label, bytes }) => row(label).size !== bytes)
      .map(
        ({ label, bytes }) =>
          `${label}: spec says ${String(row(label).size)}, code says ${String(bytes)}`
      );

    expect(mismatches).toEqual([]);
  });

  it('starts the header where the fields before it end', () => {
    // Stated separately because it is the one offset a reader computes rather than reads, and
    // getting it wrong puts every subsequent field one or two bytes out.
    expect(row('header —').offset).toBe(MAGIC_LENGTH + VERSION_FIELD_BYTES + LENGTH_FIELD_BYTES);
  });

  it('prints the magic bytes exactly, so a reader can match on them', () => {
    const block = /```\n((?:[0-9A-F]{2}\s+)+[0-9A-F]{2})\n```/.exec(spec);
    expect(block?.[1], 'the magic-bytes hex block is missing').toBeDefined();
    const bytes = (block?.[1] ?? '')
      .trim()
      .split(/\s+/)
      .map((hex) => Number.parseInt(hex, 16));
    expect(bytes).toEqual([...MAGIC]);
  });

  it('names the format version the code writes', () => {
    expect(spec).toContain(`version ${String(FORMAT_VERSION)}`);
  });
});

describe('the KEEP spec key-derivation table', () => {
  const rows = tableRows('| Parameter     | Default');
  const cells = (label: string): readonly string[] => {
    const found = rows.find((entry) => entry[0]?.includes(label));
    if (found === undefined) throw new Error(`no KDF row for ${label}`);
    return found;
  };

  it('states the defaults the code uses', () => {
    expect(figure(cells('memoryKib')[1] ?? '')).toBe(DEFAULT_KDF_PARAMS.memoryKib);
    expect(figure(cells('iterations')[1] ?? '')).toBe(DEFAULT_KDF_PARAMS.iterations);
    expect(figure(cells('parallelism')[1] ?? '')).toBe(DEFAULT_KDF_PARAMS.parallelism);
  });

  it('states the floors the code refuses to go below', () => {
    expect(figure(cells('memoryKib')[2] ?? '')).toBe(MIN_KDF_PARAMS.memoryKib);
    expect(figure(cells('iterations')[2] ?? '')).toBe(MIN_KDF_PARAMS.iterations);
    expect(figure(cells('parallelism')[2] ?? '')).toBe(MIN_KDF_PARAMS.parallelism);
  });

  it('states the ceilings that stop a hostile file hanging the app', () => {
    expect(figure(cells('memoryKib')[3] ?? '')).toBe(MAX_KDF_PARAMS.memoryKib);
    expect(figure(cells('iterations')[3] ?? '')).toBe(MAX_KDF_PARAMS.iterations);
    expect(figure(cells('parallelism')[3] ?? '')).toBe(MAX_KDF_PARAMS.parallelism);
  });

  it('states the salt and derived-key sizes', () => {
    expect(figure(cells('salt')[1] ?? '')).toBe(SALT_BYTES);
    expect(figure(cells('salt')[2] ?? '')).toBe(SALT_BYTES);
    expect(figure(cells('Output length')[1] ?? '')).toBe(KEY_BYTES);
  });
});

describe('the KEEP spec encryption table', () => {
  const rows = tableRows('## 6. Encryption');
  const value = (label: string): string => {
    const found = rows.find((entry) => entry[0]?.startsWith(label));
    if (found === undefined) throw new Error(`no encryption row for ${label}`);
    return found[1] ?? '';
  };

  it('states the nonce and tag sizes a reader must match', () => {
    expect(figure(value('Nonce'))).toBe(NONCE_BYTES);
    expect(figure(value('Tag'))).toBe(TAG_BYTES);
  });

  it('states the chunk id size used as that chunk’s AAD', () => {
    // Written in prose as "that chunk's raw 16-byte id", so the number is pulled out of the
    // sentence rather than read from a column.
    const stated = /(\d+)-byte id/.exec(value('Chunk AAD'));
    expect(stated?.[1], 'the chunk AAD row no longer states a byte count').toBeDefined();
    expect(Number(stated?.[1])).toBe(CHUNK_ID_BYTES);
  });
});
