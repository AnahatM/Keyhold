// SPDX-License-Identifier: GPL-3.0-or-later
import type { Credential } from '@shared/model/credential.js';
import type { Tag, VaultDocument } from '@shared/model/vault-document.js';
import { normaliseTags } from '../vault/credential-ops.js';
import {
  duplicateTagName,
  invalidName,
  invalidTagColour,
  mergeIntoSelf,
  noSuchTag,
  tooManyTags,
} from './errors.js';
import { DEFAULT_TAG_COLOUR, isTagColour, type TagColour } from './tag-colours.js';
import type { OrganisationContext } from './folder-ops.js';

/**
 * Tag operations, as **pure functions over a document** — the sibling of `folder-ops.ts`
 * and of `vault/credential-ops.ts`, built to the same discipline. No key, no file, no clock
 * that was not passed in; everything returns a new document.
 *
 * ## A record stores a tag's NAME, not its id
 *
 * This is the fact the whole file turns on, and it is worth stating plainly because
 * `Credential.tags` is typed `readonly string[]` and says nothing either way. Three pieces
 * of the codebase already assume names: `normaliseTags` in `credential-ops.ts` trims and
 * case-folds them (an id needs neither), every import parser feeds raw label text straight
 * into `NewCredentialInput.tags`, and the exporter's tag scoping matches
 * `record.tags` against `tag.name.toLowerCase()` — with a comment saying so.
 *
 * The consequence is the reason this module exists: **renaming a tag must rewrite every
 * record that carries it.** A rename that only edits the `Tag` entry leaves every record
 * pointing at a name nothing answers to — the tag vanishes from the sidebar count, from
 * `tag:` searches, and from the export, while still sitting in the records. That is the
 * classic version of this bug, and `renameTag` exists to not have it.
 *
 * The `Tag` entry still has an id. It identifies the *entry* — the thing that owns a colour
 * and a sidebar row — so a rename preserves the colour and the id, and only the strings on
 * records move.
 *
 * ## One rule for what a tag name is
 *
 * `normaliseTags` already defines it: trimmed, empty dropped, case-insensitively unique,
 * order preserved. `tagKey` below is that rule's key function, and `tag-ops.test.ts` asserts
 * the two agree on every case it can think of rather than trusting that they do.
 */

// ── Limits ───────────────────────────────────────────────────────────────────

/**
 * A tag is a chip. 100 characters is already unreadable in one; the cap is here so a pasted
 * paragraph cannot become a tag that widens every row in the list.
 */
export const MAX_TAG_NAME_LENGTH = 100;

/**
 * The tag sidebar renders every tag, and `MAX_TAGS` in `credential-ops.ts` already caps a
 * single record at 64. Five hundred distinct tags across a vault is far past the point where
 * a flat list is navigable; beyond it the answer is folders or search, not more chips.
 */
export const MAX_TAGS = 500;

// ── Names ────────────────────────────────────────────────────────────────────

/**
 * The comparison key for a tag name: trimmed and lower-cased.
 *
 * Exactly what `normaliseTags` does inline when it deduplicates. Tags are compared this way
 * — rather than exactly — because `Work` and `work` typed a week apart are one tag to
 * everybody except a string comparison, and two chips that look identical and filter
 * differently is the worst of both.
 */
export function tagKey(name: string): string {
  return name.trim().toLowerCase();
}

export function normaliseTagName(raw: string): string {
  return raw.trim();
}

export function assertValidTagName(name: string): string {
  if (name === '') throw invalidName('a tag needs a name');
  if (name.length > MAX_TAG_NAME_LENGTH) {
    throw invalidName(`a tag name is limited to ${MAX_TAG_NAME_LENGTH} characters`);
  }
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is banned
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw invalidName('a tag name cannot contain control characters');
  }
  return name;
}

/** Rejects anything that is not one of `TAG_COLOUR_TOKENS`. See `tag-colours.ts`. */
export function assertValidTagColour(colour: string): TagColour {
  if (!isTagColour(colour)) throw invalidTagColour();
  return colour;
}

// ── Reading ──────────────────────────────────────────────────────────────────

export function findTag(document: VaultDocument, tagId: string): Tag | null {
  return document.tags.find((tag) => tag.id === tagId) ?? null;
}

/** The tag entry for a name, matched case-insensitively. */
export function findTagByName(document: VaultDocument, name: string): Tag | null {
  const key = tagKey(name);
  return document.tags.find((tag) => tagKey(tag.name) === key) ?? null;
}

function requireTag(document: VaultDocument, tagId: string): Tag {
  const tag = findTag(document, tagId);
  if (tag === null) throw noSuchTag();
  return tag;
}

export interface TagUsageOptions {
  /**
   * Trashed records are excluded by default: usage feeds the sidebar's counts, and a tag
   * showing "3" that filters to nothing is a broken filter as far as the user is concerned.
   * Rename, merge and delete ignore this and always touch trashed records too — those are
   * data corrections, and a restored record must not come back carrying a dead tag name.
   */
  readonly includeTrashed?: boolean | undefined;
}

function countableRecords(
  document: VaultDocument,
  options: TagUsageOptions
): readonly Credential[] {
  if (options.includeTrashed === true) return document.records;
  return document.records.filter((record) => record.trashedAt === null);
}

/**
 * How many records carry each tag, keyed by `tagKey`.
 *
 * Keyed by the folded name rather than by tag id, because a record can carry a name that has
 * no `Tag` entry at all — after a merge, or an import that brought labels the vault has never
 * seen. Counting by id would silently report zero for exactly those, which is the case the
 * count is most useful for.
 */
export function tagUsageCounts(
  document: VaultDocument,
  options: TagUsageOptions = {}
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const record of countableRecords(document, options)) {
    // A record's own list is already case-insensitively unique, so no per-record dedupe is
    // needed here — but fold anyway, because that is what makes the key match the entry.
    for (const name of record.tags) {
      const key = tagKey(name);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

export interface TagUsage {
  readonly tag: Tag;
  readonly count: number;
}

/** Every declared tag with its usage count, in document order. */
export function tagUsage(
  document: VaultDocument,
  options: TagUsageOptions = {}
): readonly TagUsage[] {
  const counts = tagUsageCounts(document, options);
  return document.tags.map((tag) => ({ tag, count: counts.get(tagKey(tag.name)) ?? 0 }));
}

/**
 * Declared tags no record carries.
 *
 * Reported, never swept. A tag the user created ahead of using it is not garbage, and a tag
 * whose only records are in the trash comes back the moment one is restored — so the vault
 * offers the list and the user decides, which is decision D10 applied to the smallest
 * possible feature.
 */
export function unusedTags(document: VaultDocument, options: TagUsageOptions = {}): readonly Tag[] {
  const counts = tagUsageCounts(document, options);
  return document.tags.filter((tag) => (counts.get(tagKey(tag.name)) ?? 0) === 0);
}

// ── Rewriting records ────────────────────────────────────────────────────────

export interface TagRewriteResult {
  readonly document: VaultDocument;
  /**
   * The records whose tag list actually changed.
   *
   * Returned rather than swallowed because `VaultService` — not this module — owns the
   * question of whether a vocabulary change is worth a history version and an `updatedAt`
   * bump on every record it touched. Provenance reads the machine, which is I/O, which is
   * exactly what this file does not do.
   */
  readonly changedRecordIds: readonly string[];
}

/**
 * Applies a name mapping to every record's tag list — `null` drops the tag.
 *
 * The result goes back through `normaliseTags`, which is what makes rename-into-a-tag-the-
 * record-already-has collapse to one entry instead of producing a duplicate. That case is
 * not exotic: it is precisely what a merge does to a record tagged with both tags.
 *
 * Trashed records are rewritten too. A record in the trash that still names a deleted tag
 * would carry it back into the vault on restore.
 */
function retagRecords(
  document: VaultDocument,
  map: (name: string) => string | null
): TagRewriteResult {
  const changedRecordIds: string[] = [];

  const records = document.records.map((record) => {
    const mapped: string[] = [];
    for (const name of record.tags) {
      const next = map(name);
      if (next !== null) mapped.push(next);
    }
    const tags = normaliseTags(mapped);
    if (sameNames(tags, record.tags)) return record;

    changedRecordIds.push(record.id);
    return { ...record, tags };
  });

  return { document: { ...document, records }, changedRecordIds };
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// ── Writing ──────────────────────────────────────────────────────────────────

export interface TagResult {
  readonly document: VaultDocument;
  readonly tag: Tag;
}

export interface NewTagInput {
  readonly name: string;
  readonly colour?: string | undefined;
}

/**
 * Creates a tag entry, or returns the existing one for that name.
 *
 * **Tags are case-insensitively unique across the vault**, and here that uniqueness *is*
 * enforced — the opposite of the call made for folder names, for the opposite reason. A
 * folder's identity is its id and its name is a label; a tag's identity *is* its name,
 * because that is the string records store. Two `Tag` entries called `Work` and `work` would
 * be two sidebar rows, two colours, and one set of records that both of them claim.
 *
 * Creating an existing tag is therefore not an error — it is idempotent, and returns the
 * entry that already exists with its colour untouched. An import that brings a label the
 * vault already has must land, not fail.
 */
export function createTag(
  document: VaultDocument,
  input: NewTagInput,
  context: OrganisationContext
): TagResult {
  const name = assertValidTagName(normaliseTagName(input.name));

  const existing = findTagByName(document, name);
  if (existing !== null) return { document, tag: existing };

  if (document.tags.length >= MAX_TAGS) throw tooManyTags(MAX_TAGS);

  const tag: Tag = {
    id: context.newId(),
    name,
    colour: input.colour === undefined ? DEFAULT_TAG_COLOUR : assertValidTagColour(input.colour),
  };
  return { document: { ...document, tags: [...document.tags, tag] }, tag };
}

/**
 * Renames a tag, **and every record that carries it**.
 *
 * Colliding with another tag's name is refused rather than silently merged. A silent merge
 * would destroy the other tag's entry and its colour on the strength of a typo, and the user
 * asked to rename one tag, not to fold two together. `mergeTags` is that operation, and the
 * error message says so.
 *
 * Changing only the *case* of the name is allowed and is not a collision: the tag's own key
 * is unchanged, so there is nothing to collide with, and `Work` → `WORK` is a legitimate
 * edit that must reach the records.
 */
export function renameTag(document: VaultDocument, tagId: string, name: string): TagRewriteResult {
  const tag = requireTag(document, tagId);
  const renamed = assertValidTagName(normaliseTagName(name));
  if (renamed === tag.name) return { document, changedRecordIds: [] };

  const previousKey = tagKey(tag.name);
  const nextKey = tagKey(renamed);
  if (nextKey !== previousKey && findTagByName(document, renamed) !== null) {
    throw duplicateTagName();
  }

  const tags = document.tags.map((other) =>
    other.id === tagId ? { ...other, name: renamed } : other
  );
  return retagRecords({ ...document, tags }, (candidate) =>
    tagKey(candidate) === previousKey ? renamed : candidate
  );
}

export function setTagColour(
  document: VaultDocument,
  tagId: string,
  colour: string
): VaultDocument {
  const tag = requireTag(document, tagId);
  const validated = assertValidTagColour(colour);
  if (validated === tag.colour) return document;

  return {
    ...document,
    tags: document.tags.map((other) =>
      other.id === tagId ? { ...other, colour: validated } : other
    ),
  };
}

/**
 * Deletes a tag and strips its name from every record.
 *
 * Unlike a record deletion this is a real removal with no tombstone, and that is the right
 * call: a tag holds no content of its own, so nothing is lost that the undo stack — which
 * simply keeps the previous document — cannot put back. Leaving the name on records instead
 * would be worse than useless: they would carry a label with no entry, no colour and no
 * sidebar row, which is one of the states `integrity.ts` exists to report.
 */
export function deleteTag(document: VaultDocument, tagId: string): TagRewriteResult {
  const tag = requireTag(document, tagId);
  const key = tagKey(tag.name);

  const tags = document.tags.filter((other) => other.id !== tagId);
  return retagRecords({ ...document, tags }, (candidate) =>
    tagKey(candidate) === key ? null : candidate
  );
}

/**
 * Folds `sourceTagId` into `targetTagId`: every record carrying the source now carries the
 * target, and the source entry is removed.
 *
 * The target's colour survives and the source's does not, because the target is the tag that
 * continues to exist — a merge that adopted the disappearing tag's colour would change the
 * appearance of every record that was already correctly tagged.
 *
 * A record carrying **both** ends up with one entry, not two: `retagRecords` runs the result
 * through `normaliseTags`, which is the same case-insensitive dedupe that governs every
 * other tag list in the vault.
 */
export function mergeTags(
  document: VaultDocument,
  sourceTagId: string,
  targetTagId: string
): TagRewriteResult {
  const source = requireTag(document, sourceTagId);
  const target = requireTag(document, targetTagId);
  if (source.id === target.id) throw mergeIntoSelf();

  const sourceKey = tagKey(source.name);
  const tags = document.tags.filter((other) => other.id !== sourceTagId);
  return retagRecords({ ...document, tags }, (candidate) =>
    tagKey(candidate) === sourceKey ? target.name : candidate
  );
}

/**
 * Creates a `Tag` entry for every name that lacks one, leaving existing entries alone.
 *
 * The tag half of what `findOrCreateFolderPath` does for folders, and what the import commit
 * stage needs for the same reason: a parser emits label text, and a record carrying a name
 * with no entry behind it is a tag with no colour and no sidebar row. Idempotent, so running
 * an import twice does not double anything.
 */
export function ensureTags(
  document: VaultDocument,
  names: readonly string[],
  context: OrganisationContext
): { readonly document: VaultDocument; readonly tags: readonly Tag[] } {
  let current = document;
  const tags: Tag[] = [];

  for (const name of normaliseTags(names)) {
    const result = createTag(current, { name }, context);
    current = result.document;
    tags.push(result.tag);
  }
  return { document: current, tags };
}
