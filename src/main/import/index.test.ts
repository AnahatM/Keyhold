// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FIXTURE_FOR_PARSER, loadFixture } from './fixtures/load.js';
import { synonymCollisions } from './generic-csv.js';
import {
  detectFormat,
  detectFormats,
  extensionOf,
  findParser,
  importFormatDescriptors,
  PARSERS,
  SPECIFIC_PARSERS,
} from './index.js';

/**
 * The registry's guards.
 *
 * Rule 9 in `CLAUDE.md`: a registry gets a uniqueness test. The load-bearing one here is
 * **"every fixture is claimed by exactly one specific parser"** — several of these formats
 * have overlapping headers, and the failure mode of an ambiguous `detect` is not an error
 * message. It is a Safari export parsed as 1Password, which quietly drops nothing but reads
 * the wrong columns and produces plausible-looking, wrong records.
 *
 * Fault injection performed: `safariCsvParser.detect` switched from `headerMatchesAny` (exact
 * set) to `headerContains` (subset), which is the obvious-looking simplification. Caught by
 * "claims each fixture with exactly one specific parser" — the 1Password fixture was then
 * claimed by two parsers.
 *
 * Worth recording what the injection did *not* break: "suggests the right format for each
 * fixture" kept passing, because 1Password sits before Safari in `PARSERS` and detection takes
 * the first match. The array ordering was silently doing the work the `detect` method is
 * supposed to do — which is exactly why the ambiguity check exists as its own test rather than
 * being folded into the detection one. Restored.
 */

describe('the registry', () => {
  it('gives every parser a unique id', () => {
    const ids = PARSERS.map((parser) => parser.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every parser a name, a description and at least one extension', () => {
    for (const parser of PARSERS) {
      expect(parser.name, parser.id).not.toBe('');
      expect(parser.description, parser.id).not.toBe('');
      expect(parser.extensions.length, parser.id).toBeGreaterThan(0);
      for (const extension of parser.extensions) {
        expect(extension, parser.id).toMatch(/^\.[a-z0-9]+$/);
      }
    }
  });

  it('registers a fixture for every parser', () => {
    // Without this, a new parser could join the registry and quietly skip the whole contract
    // suite, which keys off this map.
    for (const parser of PARSERS) {
      expect(FIXTURE_FOR_PARSER[parser.id], `no fixture for "${parser.id}"`).toBeDefined();
    }
  });

  it('treats exactly one parser as the mapping-driven catch-all', () => {
    expect(PARSERS.filter((parser) => parser.needsMapping)).toHaveLength(1);
    expect(SPECIFIC_PARSERS).toHaveLength(PARSERS.length - 1);
  });

  it('puts the catch-all last, because detection takes the first match', () => {
    expect(PARSERS[PARSERS.length - 1]?.needsMapping).toBe(true);
  });

  it('finds a parser by id and returns null for one that does not exist', () => {
    expect(findParser('lastpass-csv')?.name).toBe('LastPass (CSV)');
    expect(findParser('nope')).toBe(null);
  });

  it('describes every parser for the renderer without handing over a parser', () => {
    const descriptors = importFormatDescriptors();
    expect(descriptors).toHaveLength(PARSERS.length);
    for (const descriptor of descriptors) {
      expect(Object.keys(descriptor).sort()).toEqual([
        'description',
        'extensions',
        'id',
        'name',
        'needsMapping',
      ]);
    }
  });

  it('does not let two column synonyms claim the same name', () => {
    expect(synonymCollisions()).toEqual([]);
  });
});

describe('detection is unambiguous', () => {
  it('claims each fixture with exactly one specific parser', () => {
    for (const parser of SPECIFIC_PARSERS) {
      const fixtureName = FIXTURE_FOR_PARSER[parser.id];
      expect(fixtureName).toBeDefined();
      const content = loadFixture(fixtureName ?? '');
      const claimants = SPECIFIC_PARSERS.filter((candidate) => candidate.detect(content));
      expect(claimants.map((candidate) => candidate.id)).toEqual([parser.id]);
    }
  });

  it('suggests the right format for each fixture given its filename', () => {
    for (const parser of SPECIFIC_PARSERS) {
      const fixtureName = FIXTURE_FOR_PARSER[parser.id] ?? '';
      const detected = detectFormat(fixtureName, loadFixture(fixtureName));
      expect(detected?.id, fixtureName).toBe(parser.id);
    }
  });

  it('falls back to the catch-all for a CSV no named format claims', () => {
    const detected = detectFormat('mystery.csv', loadFixture('generic.csv'));
    expect(detected?.id).toBe('generic-csv');
  });

  it('suggests nothing at all for something that is not a table', () => {
    expect(detectFormat('photo.png', '\u0089PNG\r\n\u001a\n\0\0\0')).toBe(null);
    expect(detectFormat('empty.csv', '')).toBe(null);
  });

  it('ignores the extension when the content is unambiguous', () => {
    // A renamed file is still the file it was. Rejecting it over its extension would be the
    // app being pedantic at the user's expense.
    const detected = detectFormat('export.txt', loadFixture('lastpass.csv'));
    expect(detected?.id).toBe('lastpass-csv');
  });

  it('ranks a matching extension first when several formats claim a file', () => {
    const ranked = detectFormats('chrome.csv', loadFixture('chrome.csv'));
    expect(ranked.map((parser) => parser.id)).toEqual(['chrome-csv', 'generic-csv']);
  });
});

describe('extensionOf', () => {
  it('reads the extension from a bare name and from either kind of path', () => {
    expect(extensionOf('export.CSV')).toBe('.csv');
    expect(extensionOf('C:\\Users\\ada\\export.json')).toBe('.json');
    expect(extensionOf('/home/ada/export.json')).toBe('.json');
  });

  it('returns nothing for a name with no extension, or a dotfile', () => {
    expect(extensionOf('export')).toBe('');
    expect(extensionOf('.bashrc')).toBe('');
  });
});
