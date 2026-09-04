// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CUSTOM_FIELD_TYPES } from '../src/shared/model/credential.js';
import { HEALTH_RULE_IDS } from '../src/shared/model/health.js';
import { EXPORT_FORMAT_IDS } from '../src/shared/model/export.js';
import { PARSERS } from '../src/main/import/index.js';

/**
 * Guard: numbers written as words in the docs, parsed back out and checked against the code.
 *
 * Hard rule 9 — "a number written in prose gets a test that parses it back out of the doc".
 * The doc audit found five of these had rotted (fourteen custom-field types that are
 * thirteen, eight health rules that are nine, eleven parsers that are twelve, eighteen
 * import formats that are twelve, seventeen decisions that are twenty-two), and every one of
 * them rotted for the same reason: a list grew, and nothing anywhere counted it again.
 *
 * The registries themselves are imported, so this measures the real thing. The doc side is
 * read as text because that is the point — a number nobody parses is a number nobody
 * checks.
 *
 * ## The exclusion that closed itself, and the better answer
 *
 * `docs/05-Features/_INDEX.md` used to say "the eight offline rules" when there were nine,
 * and this header recorded it as a known gap awaiting a row here. It was fixed differently
 * and better: the sentence now names `HEALTH_RULE_IDS` instead of counting, so there is no
 * number left to rot and nothing for this file to assert.
 *
 * That is worth preferring generally. A guarded count is a count that fails loudly when it
 * drifts; a named symbol is a count that cannot drift at all. Reach for a row in this file
 * when prose genuinely needs the number — "twelve parsers" reads better than "one parser per
 * entry in `PARSERS`" — and reach for the symbol name when it does not.
 *
 * Fault injection performed: changing "twelve parsers" back to "eleven parsers" in
 * `00-Import-Formats.md` fails "the import doc's parser count matches the registry";
 * deleting the Keyhold JSON row from its §3 table fails "the column-mapping table has one
 * row per parser".
 */

const ROOT = resolve(import.meta.dirname, '..');

const read = (file: string): string => readFileSync(resolve(ROOT, file), 'utf8');

/**
 * Number words, up to the largest any of these lists could plausibly reach.
 *
 * Written out rather than digits because that is how this project's prose reads, and a doc
 * rewritten to use a digit would silently stop being checked otherwise — so the assertions
 * below also require the word to be present at all.
 */
const NUMBER_WORDS: readonly string[] = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
];

/** The number word for `value`, capitalised as `sample` is. */
function word(value: number, capitalised = false): string {
  const found = NUMBER_WORDS[value];
  expect(found, `no number word for ${value}; extend NUMBER_WORDS`).toBeDefined();
  const text = found ?? '';
  return capitalised ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/**
 * Asserts the doc says the right number, and that no *other* number word is sitting in the
 * same phrase — otherwise "eleven parsers" would pass a test that only looked for "twelve".
 */
function expectCount(file: string, suffix: string, actual: number, capitalised = false): void {
  const source = read(file);
  const wrong = NUMBER_WORDS.map((candidate, index) => ({ candidate, index }))
    .filter(({ index }) => index !== actual)
    .map(({ candidate }) =>
      capitalised ? candidate[0]!.toUpperCase() + candidate.slice(1) : candidate
    )
    .filter((candidate) => source.includes(`${candidate} ${suffix}`));

  expect(wrong, `${file} states the wrong number of ${suffix}`).toEqual([]);
  expect(
    source.includes(`${word(actual, capitalised)} ${suffix}`),
    `${file} no longer states a count for "${suffix}" — it should say "${word(actual, capitalised)} ${suffix}"`
  ).toBe(true);
}

describe('counts stated in prose', () => {
  it("the credential model doc's custom-field-type count matches the registry", () => {
    expectCount(
      'docs/03-Data-Model/00-Credential-Model.md',
      'types:',
      CUSTOM_FIELD_TYPES.length,
      true
    );
  });

  it("the import doc's parser count matches the registry", () => {
    expectCount('docs/09-Import-Export/00-Import-Formats.md', 'parsers,', PARSERS.length);
    expectCount('docs/09-Import-Export/_INDEX.md', 'parsers,', PARSERS.length);
  });

  /**
   * The README is the one document most people read and the one least likely to be revisited
   * when a registry grows. It said "eighteen formats" for as long as there were nineteen.
   */
  it("the README's import-format count matches the registry", () => {
    // "import formats:" rather than "formats:" — the export line a few bullets down says
    // "six export formats:", and a suffix that matched both made one count fail the other.
    expectCount('README.md', 'import formats:', PARSERS.length);
  });

  it("the README's export-format count matches the registry", () => {
    expectCount('README.md', 'export formats:', EXPORT_FORMAT_IDS.length);
  });

  it("the README's health-rule count matches the registry", () => {
    expectCount('README.md', 'rules, eight of them on by default', HEALTH_RULE_IDS.length);
  });

  it("the testing policy's import-format count matches the registry", () => {
    const source = read('docs/11-Development/01-Testing-Policy.md');
    const count = word(PARSERS.length, true);
    expect(source).toContain(`${count} formats is ${word(PARSERS.length)} chances`);
  });

  it('the column-mapping table has one row per parser', () => {
    // The failure this catches is the one the audit actually found: the table had eleven
    // rows and omitted `keyholdJsonParser` entirely, so anyone using it as the inventory
    // would not know Keyhold's own export can be read back in.
    const source = read('docs/09-Import-Export/00-Import-Formats.md');
    const section = /## 3\. What each column becomes([\s\S]*?)\n---/.exec(source);
    expect(section, 'the §3 column-mapping table has moved or been renamed').not.toBeNull();

    const rows = [...(section?.[1] ?? '').matchAll(/^\| \*\*/gm)];
    expect(rows).toHaveLength(PARSERS.length);
  });

  it('the decision log holds the number of decisions its index claims', () => {
    const log = read('docs/12-Roadmap/02-Decision-Log.md');
    const ids = [...log.matchAll(/^### (D\d+)/gm)].map((match) => match[1]!);
    expect(ids).toHaveLength(new Set(ids).size);

    const index = read('docs/12-Roadmap/_INDEX.md');
    expect(index, 'the roadmap index no longer names the decision range').toContain(
      `D1-${ids[ids.length - 1] ?? ''}`
    );
  });

  it('every health rule the model declares has a row in the rules doc', () => {
    // Not a count in words — a per-id check, which is strictly stronger and does not depend
    // on anyone re-counting. The stale "eight offline rules" in `docs/05-Features/_INDEX.md`
    // is a separate, still-open finding; see the file header.
    const doc = read('docs/05-Features/01-Health-Rules.md');
    const missing = HEALTH_RULE_IDS.filter((id) => !doc.includes(id));
    expect(missing, 'health rules with no mention in their own doc').toEqual([]);
  });
});
