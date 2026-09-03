// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { emptyVaultDocument, type VaultDocument } from '@shared/model/vault-document.js';
import { normaliseTags } from '../vault/credential-ops.js';
import { OrganisationError } from './errors.js';
import type { OrganisationContext } from './folder-ops.js';
import { DEFAULT_TAG_COLOUR } from './tag-colours.js';
import {
  MAX_TAGS,
  MAX_TAG_NAME_LENGTH,
  createTag,
  deleteTag,
  ensureTags,
  findTagByName,
  mergeTags,
  renameTag,
  setTagColour,
  tagKey,
  tagUsage,
  tagUsageCounts,
  unusedTags,
} from './tag-ops.js';
import { addRecord, credential, trashedCredential } from './test-support.js';

/**
 * Tag operations.
 *
 * The load-bearing fact, stated in `tag-ops.ts`: a record stores a tag's **name**, not its
 * id. Everything worth testing here follows from that — a rename that does not reach the
 * records leaves the tag on them and nowhere else, which is the classic version of this bug
 * and the first thing asserted below.
 */

let nextId = 0;
const context = (): OrganisationContext => ({ newId: () => `t${++nextId}` });

const tagsOf = (document: VaultDocument, title: string): readonly string[] =>
  document.records.find((record) => record.title === title)?.tags ?? [];

/** A vault with three tags and four records carrying them in various combinations. */
function vault(): { document: VaultDocument; id: (name: string) => string } {
  let document = emptyVaultDocument();
  const ids = new Map<string, string>();

  for (const name of ['Work', 'Personal', 'Finance']) {
    const created = createTag(document, { name }, context());
    document = created.document;
    ids.set(name, created.tag.id);
  }

  document = addRecord(document, credential('one', { tags: ['Work'] }));
  document = addRecord(document, credential('two', { tags: ['Work', 'Personal'] }));
  document = addRecord(document, credential('three', { tags: ['Personal'] }));
  document = addRecord(document, trashedCredential('gone', { tags: ['Work'] }));

  return {
    document,
    id: (name) => {
      const found = ids.get(name);
      if (found === undefined) throw new Error(`no tag named ${name} in the fixture`);
      return found;
    },
  };
}

describe('the tag name rule', () => {
  it('agrees with normaliseTags, which is the rule’s authority', () => {
    // Two definitions of "the same tag" would disagree within a month. This is the guard
    // that binds tagKey to the deduplication normaliseTags already performs.
    const cases = ['Work', ' Work ', 'WORK', 'work ', 'Work Stuff', ' münchen ', 'MÜNCHEN'];
    for (const a of cases) {
      for (const b of cases) {
        const collapsed = normaliseTags([a, b]).length === 1;
        expect(tagKey(a) === tagKey(b)).toBe(collapsed);
      }
    }
  });

  it('refuses a name that is empty, over the cap, or carrying a control character', () => {
    const document = emptyVaultDocument();
    const reject = (name: string): OrganisationError => {
      try {
        createTag(document, { name }, context());
      } catch (error) {
        if (error instanceof OrganisationError) return error;
      }
      throw new Error(`expected "${name}" to be refused`);
    };

    expect(reject('  ').code).toBe('INVALID_NAME');
    expect(reject('x'.repeat(MAX_TAG_NAME_LENGTH + 1)).code).toBe('INVALID_NAME');
    // In the middle, not at the end: a trailing tab is whitespace and is trimmed away
    // before the check ever sees it, so an edge-only case would prove nothing.
    expect(reject(`Work${String.fromCharCode(9)}Stuff`).code).toBe('INVALID_NAME');
    expect(reject(`Work${String.fromCharCode(0)}`).code).toBe('INVALID_NAME');
  });
});

describe('creating a tag', () => {
  it('trims, defaults the colour, and mints an id', () => {
    const { tag } = createTag(emptyVaultDocument(), { name: '  Work ' }, context());
    expect(tag.name).toBe('Work');
    expect(tag.colour).toBe(DEFAULT_TAG_COLOUR);
    expect(tag.id).not.toBe('');
  });

  it('is case-insensitively unique, and idempotent rather than an error', () => {
    // The opposite call to folders, for the opposite reason: a tag's identity IS its name,
    // because that is the string records store. An import bringing a label the vault
    // already has must land, not fail.
    const first = createTag(emptyVaultDocument(), { name: 'Work', colour: 'info' }, context());
    const second = createTag(first.document, { name: 'WORK' }, context());

    expect(second.document.tags).toHaveLength(1);
    expect(second.tag.id).toBe(first.tag.id);
    // The existing colour survives — an idempotent create is not a silent restyle.
    expect(second.tag.colour).toBe('info');
  });

  it('refuses a colour that is not a theme token', () => {
    const document = emptyVaultDocument();
    for (const colour of ['#ff0000', 'red', 'success', 'bg', '']) {
      expect(() => createTag(document, { name: 'X', colour }, context())).toThrow(
        expect.objectContaining({ code: 'INVALID_TAG_COLOUR' })
      );
    }
  });
});

describe('renaming a tag', () => {
  it('rewrites every record that carries it', () => {
    // The bug this module exists to not have: a rename that edits only the Tag entry leaves
    // every record pointing at a name nothing answers to.
    const { document, id } = vault();
    const result = renameTag(document, id('Work'), 'Employment');

    expect(findTagByName(result.document, 'Employment')?.id).toBe(id('Work'));
    expect(findTagByName(result.document, 'Work')).toBeNull();
    expect(tagsOf(result.document, 'one')).toEqual(['Employment']);
    expect(tagsOf(result.document, 'two')).toEqual(['Employment', 'Personal']);
    expect(tagsOf(result.document, 'three')).toEqual(['Personal']);
  });

  it('reaches trashed records too', () => {
    // A restored record must not come back carrying a name nothing answers to.
    const { document, id } = vault();
    const result = renameTag(document, id('Work'), 'Employment');
    expect(tagsOf(result.document, 'gone')).toEqual(['Employment']);
  });

  it('reports exactly the records it changed', () => {
    const { document, id } = vault();
    const result = renameTag(document, id('Work'), 'Employment');
    expect([...result.changedRecordIds].sort()).toEqual(
      document.records
        .filter((record) => record.tags.includes('Work'))
        .map((record) => record.id)
        .sort()
    );
  });

  it('keeps the id and the colour', () => {
    const { document, id } = vault();
    const coloured = setTagColour(document, id('Work'), 'accent');
    const result = renameTag(coloured, id('Work'), 'Employment');

    const tag = result.document.tags.find((candidate) => candidate.id === id('Work'));
    expect(tag?.colour).toBe('accent');
  });

  it('allows a change of case only, and pushes it to the records', () => {
    const { document, id } = vault();
    const result = renameTag(document, id('Work'), 'WORK');
    expect(tagsOf(result.document, 'one')).toEqual(['WORK']);
  });

  it('refuses a collision instead of silently merging', () => {
    // A silent merge would destroy the other tag's entry and colour on the strength of a
    // typo. The user asked to rename one tag, not to fold two together.
    const { document, id } = vault();
    expect(() => renameTag(document, id('Work'), 'personal')).toThrow(
      expect.objectContaining({ code: 'DUPLICATE_TAG_NAME' })
    );
    expect(document.tags).toHaveLength(3);
  });

  it('refuses an unknown tag', () => {
    expect(() => renameTag(emptyVaultDocument(), 'nope', 'X')).toThrow(
      expect.objectContaining({ code: 'NO_SUCH_TAG' })
    );
  });
});

describe('merging tags', () => {
  it('moves every record onto the target and removes the source entry', () => {
    const { document, id } = vault();
    const result = mergeTags(document, id('Work'), id('Personal'));

    expect(result.document.tags.map((tag) => tag.id)).toEqual([id('Personal'), id('Finance')]);
    expect(tagsOf(result.document, 'one')).toEqual(['Personal']);
    expect(tagsOf(result.document, 'three')).toEqual(['Personal']);
  });

  it('collapses a record that carried both to a single entry', () => {
    // Not exotic: it is precisely what a merge does to a record tagged with both.
    const { document, id } = vault();
    const result = mergeTags(document, id('Work'), id('Personal'));
    expect(tagsOf(result.document, 'two')).toEqual(['Personal']);
  });

  it('keeps the target’s colour, not the source’s', () => {
    const { document, id } = vault();
    const coloured = setTagColour(
      setTagColour(document, id('Work'), 'accent'),
      id('Personal'),
      'info'
    );
    const result = mergeTags(coloured, id('Work'), id('Personal'));

    expect(result.document.tags.find((tag) => tag.id === id('Personal'))?.colour).toBe('info');
  });

  it('refuses a merge into itself', () => {
    const { document, id } = vault();
    expect(() => mergeTags(document, id('Work'), id('Work'))).toThrow(
      expect.objectContaining({ code: 'MERGE_INTO_SELF' })
    );
  });

  it('refuses an unknown tag on either side', () => {
    const { document, id } = vault();
    expect(() => mergeTags(document, 'nope', id('Work'))).toThrow(
      expect.objectContaining({ code: 'NO_SUCH_TAG' })
    );
    expect(() => mergeTags(document, id('Work'), 'nope')).toThrow(
      expect.objectContaining({ code: 'NO_SUCH_TAG' })
    );
  });
});

describe('deleting a tag', () => {
  it('strips the name from every record, trashed ones included', () => {
    const { document, id } = vault();
    const result = deleteTag(document, id('Work'));

    expect(result.document.tags.map((tag) => tag.id)).toEqual([id('Personal'), id('Finance')]);
    expect(tagsOf(result.document, 'one')).toEqual([]);
    expect(tagsOf(result.document, 'two')).toEqual(['Personal']);
    expect(tagsOf(result.document, 'gone')).toEqual([]);
  });

  it('leaves no record carrying a name the vault does not declare', () => {
    const { document, id } = vault();
    const result = deleteTag(document, id('Work'));
    const declared = new Set(result.document.tags.map((tag) => tagKey(tag.name)));
    for (const record of result.document.records) {
      for (const name of record.tags) expect(declared.has(tagKey(name))).toBe(true);
    }
  });

  it('does not touch a record that never had it', () => {
    const { document, id } = vault();
    const result = deleteTag(document, id('Finance'));
    expect(result.changedRecordIds).toEqual([]);
    expect(result.document.records).toEqual(document.records);
  });
});

describe('colours', () => {
  it('accepts a theme token and refuses anything else', () => {
    const { document, id } = vault();
    expect(setTagColour(document, id('Work'), 'accent').tags[0]?.colour).toBe('accent');
    expect(() => setTagColour(document, id('Work'), '#abcdef')).toThrow(
      expect.objectContaining({ code: 'INVALID_TAG_COLOUR' })
    );
  });

  it('returns the same document when nothing changes', () => {
    const { document, id } = vault();
    expect(setTagColour(document, id('Work'), DEFAULT_TAG_COLOUR)).toBe(document);
  });
});

describe('usage', () => {
  it('counts live records by folded name, excluding the trash by default', () => {
    const { document } = vault();
    const counts = tagUsageCounts(document);
    expect(counts.get('work')).toBe(2);
    expect(counts.get('personal')).toBe(2);
    expect(counts.get('finance')).toBeUndefined();
  });

  it('includes the trash when asked', () => {
    const { document } = vault();
    expect(tagUsageCounts(document, { includeTrashed: true }).get('work')).toBe(3);
  });

  it('counts a name that has no Tag entry — the case counting by id would miss', () => {
    const { document } = vault();
    const withStray = addRecord(document, credential('stray', { tags: ['Imported'] }));
    expect(tagUsageCounts(withStray).get('imported')).toBe(1);
  });

  it('reports every declared tag with its count, in document order', () => {
    const { document } = vault();
    expect(tagUsage(document).map((entry) => [entry.tag.name, entry.count])).toEqual([
      ['Work', 2],
      ['Personal', 2],
      ['Finance', 0],
    ]);
  });

  it('finds unused tags, and does not sweep them', () => {
    const { document } = vault();
    expect(unusedTags(document).map((tag) => tag.name)).toEqual(['Finance']);
    // A tag whose only records are in the trash is not unused once one is restored.
    expect(unusedTags(document, { includeTrashed: true }).map((tag) => tag.name)).toEqual([
      'Finance',
    ]);
  });
});

describe('ensureTags', () => {
  it('creates an entry for every name that lacks one, and nothing more', () => {
    const { document, id } = vault();
    const result = ensureTags(document, ['work', 'Imported', ' Imported ', ''], context());

    expect(result.document.tags).toHaveLength(4);
    expect(result.tags.map((tag) => tag.id)).toEqual([id('Work'), result.tags[1]?.id]);
    expect(findTagByName(result.document, 'Imported')).not.toBeNull();
  });

  it('is idempotent', () => {
    const once = ensureTags(emptyVaultDocument(), ['A', 'B'], context());
    const twice = ensureTags(once.document, ['a', 'b'], context());
    expect(twice.document.tags).toHaveLength(2);
    expect(twice.document).toBe(once.document);
  });
});

describe('the tag-count cap', () => {
  it('refuses the tag past MAX_TAGS, and does not count a name it already has', () => {
    // N33: `MAX_TAGS`, `tooManyTags` and `TOO_MANY_TAGS` appeared only in source, while every
    // neighbouring limit had a test. The second half matters as much as the first — the cap
    // sits *after* the existing-name short-circuit, so a full vault must still resolve a tag
    // it already holds rather than refusing to touch anything.
    const tags = Array.from({ length: MAX_TAGS }, (_value, index) => ({
      id: `pre-${index}`,
      name: `Tag ${index}`,
      colour: DEFAULT_TAG_COLOUR,
    }));
    const full: VaultDocument = { ...emptyVaultDocument(), tags };

    expect(() => createTag(full, { name: 'One too many' }, context())).toThrow(
      expect.objectContaining({ code: 'TOO_MANY_TAGS' })
    );
    try {
      createTag(full, { name: 'One too many' }, context());
    } catch (error) {
      expect(error).toBeInstanceOf(OrganisationError);
      expect((error as OrganisationError).message).toContain(String(MAX_TAGS));
    }

    // Already present, so nothing is created and nothing is refused.
    const existing = createTag(full, { name: 'tag 7' }, context());
    expect(existing.tag.id).toBe('pre-7');
    expect(existing.document).toBe(full);
  });
});
