// SPDX-License-Identifier: GPL-3.0-or-later
import { credentialTypeDefinition } from '../model/credential-templates.js';
import type { CredentialProjection, CustomFieldType } from '../model/credential.js';
import type { Folder, Tag } from '../model/vault-document.js';
import {
  EMPTY_QUERY,
  foldText,
  type ParsedQuery,
  type QueryField,
  type QueryFlagToken,
  type QueryTerm,
} from './query.js';

/**
 * Applying a `ParsedQuery`, plus the structured filters the sidebar owns, to a list of
 * records — **and saying why each one matched**.
 *
 * Everything here is a pure function of (records, options). No clock, no I/O, no mutation:
 * the same inputs give the same output and the same order, which is what makes the list
 * stable between renders and the whole thing testable without a vault.
 *
 * ## This runs over the safe projection, and only over the safe projection
 *
 * A `CredentialProjection` has no password, no note body, no security answer and no hidden
 * custom-field value (decision D13). Nothing in this file asks for one, and the haystack
 * builder skips any custom field flagged `isSecret` **before reading `value`** rather than
 * relying on the projection builder having already stripped it. Belt and braces on purpose:
 * a bug upstream that leaked a value into a secret field would otherwise turn this module
 * into an oracle that reports, one keystroke at a time, whether a password contains a given
 * substring. `filter.test.ts` feeds it exactly that malformed record to prove it does not.
 *
 * Note text *is* searchable — in the main process, over `kh:credentials:deep-search`, which
 * returns ids and nothing else. Pass those ids in as `deepMatchIds` and they are merged in
 * here without any secret crossing the bridge.
 */

// ── Where a match happened ───────────────────────────────────────────────────

/**
 * The searchable surfaces, in the order they are worth. `deep` is not a field of the record
 * at all — it means "the main process matched this against material the renderer cannot
 * see", which is why it ranks last: we know that it matched, never where.
 */
export const MATCH_FIELDS = [
  'title',
  'username',
  'email',
  // The record's kind, matched against its id and its label alike — somebody types
  // `type:card` and somebody else types `type:payment`, and both mean the same thing.
  'type',
  'tag',
  'url',
  'folder',
  'customLabel',
  'customValue',
  'question',
  'deep',
] as const;

export type MatchField = (typeof MATCH_FIELDS)[number];

export type MatchKind = 'exact' | 'prefix' | 'substring';

/**
 * How much each surface is worth. Title dominates because it is the thing the user named
 * the record, and a person searching "github" wants the record called GitHub before the
 * five records that happen to have a github.com URL in them.
 */
export const MATCH_FIELD_WEIGHTS: Readonly<Record<MatchField, number>> = {
  title: 10,
  username: 8,
  email: 7,
  tag: 6,
  url: 5,
  // Below tag and above folder. A type is a coarse bucket — a card is one of possibly
  // hundreds — so a bare search matching a type should not outrank one matching a name the
  // user actually chose.
  type: 4.5,
  folder: 4,
  customLabel: 3,
  customValue: 2,
  question: 2,
  deep: 1,
};

export const MATCH_KIND_WEIGHTS: Readonly<Record<MatchKind, number>> = {
  exact: 3,
  prefix: 2,
  substring: 1,
};

/**
 * Field beats kind, always.
 *
 * Multiplying the two would let a URL's exact match outrank a title's substring match, and
 * "github" would then put `api.github.com` above the record actually called GitHub. So the
 * field weight is scaled past the largest kind weight and the kind only breaks ties within
 * one field. That is the ordering the requirement states — title over URL, and exact over
 * prefix over substring — rather than an emergent product of two numbers.
 */
const KIND_SCALE = 10;

export function matchScore(field: MatchField, kind: MatchKind): number {
  return MATCH_FIELD_WEIGHTS[field] * KIND_SCALE + MATCH_KIND_WEIGHTS[kind];
}

export interface FieldMatch {
  readonly field: MatchField;
  readonly kind: MatchKind;
  /** The value that matched, as stored — never folded, never secret. */
  readonly text: string;
  /** Which term of the query this satisfies, so the UI can highlight per term. */
  readonly termIndex: number;
  readonly score: number;
}

export interface SearchResult {
  readonly record: CredentialProjection;
  readonly score: number;
  /** The best match for each positive term, in term order. Empty for an empty query. */
  readonly matches: readonly FieldMatch[];
}

// ── Options ──────────────────────────────────────────────────────────────────

/**
 * Names for the ids a record carries.
 *
 * Optional because a search still works without them — an unresolved tag id is matched as
 * text, which is what the old renderer-side filter did. Supply them and `tag:` and
 * `folder:` search what the user actually sees.
 */
export interface SearchContext {
  readonly folders?: readonly Folder[] | undefined;
  readonly tags?: readonly Tag[] | undefined;
}

export interface FilterOptions extends SearchContext {
  readonly query?: ParsedQuery | undefined;
  /** `undefined` means no folder filter; `null` means records filed in no folder. */
  readonly folderId?: string | null | undefined;
  /** Only meaningful with a non-null `folderId`. Off by default: a folder means that folder. */
  readonly includeDescendantFolders?: boolean | undefined;
  readonly tagIds?: readonly string[] | undefined;
  /** `any` (default) is what a tag sidebar does; `all` is for narrowing. */
  readonly tagMatch?: 'any' | 'all' | undefined;
  /** Trashed records are excluded unless this is true — see `resolveTrashPolicy`. */
  readonly includeTrashed?: boolean | undefined;
  /** The trash view. Wins over `includeTrashed`. */
  readonly trashedOnly?: boolean | undefined;
  readonly favouritesOnly?: boolean | undefined;
  /**
   * Ids the main process matched against secret material for this same query string. Merged
   * in as a match of last resort; never used to satisfy a negated term, because a deep
   * search cannot tell us that something is *absent* from a record it did not report.
   */
  readonly deepMatchIds?: ReadonlySet<string> | undefined;
}

// ── Flags ────────────────────────────────────────────────────────────────────

/** Named through the type so a rename in the model breaks this line rather than search. */
const TOTP_FIELD_TYPE: CustomFieldType = 'otp-secret';

/**
 * One predicate per flag, keyed by the registry's token type — so a flag added to
 * `QUERY_FLAGS` without a predicate here is a compile error, not a filter that silently
 * matches everything.
 */
const FLAG_PREDICATES: Readonly<Record<QueryFlagToken, (record: CredentialProjection) => boolean>> =
  {
    'is:favorite': (record) => record.favorite,
    'is:trashed': (record) => record.trashedAt !== null,
    'is:untagged': (record) => record.tags.length === 0,
    'is:unfiled': (record) => record.folderId === null,
    'has:password': (record) => record.hasPassword,
    'has:notes': (record) => record.hasNotes,
    'has:attachment': (record) => record.attachments.length > 0,
    'has:totp': (record) => record.custom.some((field) => field.type === TOTP_FIELD_TYPE),
    'has:url': (record) => record.urls.length > 0,
    'has:history': (record) => record.historyCount > 0,
  };

/** Which surfaces a scoped term is allowed to look at. Bare terms look at all but `deep`. */
const FIELDS_BY_QUERY_FIELD: Readonly<Record<QueryField, readonly MatchField[]>> = {
  title: ['title'],
  user: ['username'],
  email: ['email'],
  url: ['url'],
  tag: ['tag'],
  folder: ['folder'],
  field: ['customLabel'],
  type: ['type'],
  // Unreachable: the parser rewrites `note:` to the `has:notes` flag before a term is made.
  // Present so this record stays exhaustive over QueryField, which is what makes a newly
  // added prefix a type error here instead of a term that matches nothing.
  note: [],
};

const BARE_TERM_FIELDS: readonly MatchField[] = MATCH_FIELDS.filter((field) => field !== 'deep');

// ── Folder trees ─────────────────────────────────────────────────────────────

/**
 * A folder and everything beneath it.
 *
 * The `seen` set is not defensive programming for its own sake: folder parentage arrives
 * from a file that may have been merged, imported, or hand-edited, and a cycle there would
 * spin this loop forever with the UI thread inside it. A malformed vault must render badly,
 * not hang. The cycle's records are still reachable — the walk simply stops re-entering.
 */
export function collectDescendantFolderIds(
  folders: readonly Folder[],
  rootId: string
): ReadonlySet<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const folder of folders) {
    if (folder.parentId === null) continue;
    const siblings = childrenByParent.get(folder.parentId);
    if (siblings === undefined) {
      childrenByParent.set(folder.parentId, [folder.id]);
    } else {
      siblings.push(folder.id);
    }
  }

  const seen = new Set<string>([rootId]);
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    for (const child of childrenByParent.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return seen;
}

// ── Haystacks ────────────────────────────────────────────────────────────────

interface HaystackEntry {
  readonly field: MatchField;
  readonly text: string;
  readonly folded: string;
}

interface NameLookup {
  readonly folderNames: ReadonlyMap<string, string>;
  readonly tagNames: ReadonlyMap<string, string>;
}

function buildNameLookup(context: SearchContext): NameLookup {
  const folderNames = new Map<string, string>();
  for (const folder of context.folders ?? []) folderNames.set(folder.id, folder.name);
  const tagNames = new Map<string, string>();
  for (const tag of context.tags ?? []) tagNames.set(tag.id, tag.name);
  return { folderNames, tagNames };
}

/**
 * The searchable text of one record, folded once.
 *
 * `needed` keeps this honest on a large vault: a `title:` query folds one string per record
 * instead of thirty. Folding is the expensive part of a keystroke, so it is only done for
 * surfaces some term can actually look at.
 */
function buildHaystack(
  record: CredentialProjection,
  needed: ReadonlySet<MatchField>,
  names: NameLookup
): readonly HaystackEntry[] {
  const entries: HaystackEntry[] = [];
  const push = (field: MatchField, text: string): void => {
    if (text === '' || !needed.has(field)) return;
    entries.push({ field, text, folded: foldText(text) });
  };

  push('title', record.title);
  push('username', record.username);
  push('email', record.email);
  // Both the id and the human label, so `type:ssh-key` and `type:SSH key` both work. Not
  // pushed for a login: it is the default and the overwhelming majority, so indexing it would
  // make a bare search for "login" return the entire vault.
  if (record.type !== 'login') {
    push('type', record.type);
    push('type', credentialTypeDefinition(record.type).label);
  }
  for (const url of record.urls) push('url', url);
  for (const tagId of record.tags) push('tag', names.tagNames.get(tagId) ?? tagId);
  if (record.folderId !== null) {
    push('folder', names.folderNames.get(record.folderId) ?? record.folderId);
  }
  for (const field of record.custom) {
    push('customLabel', field.label);
    // The secret gate. Read `isSecret` first and never touch `value` behind it — see the
    // file header for why this is checked here rather than trusted from upstream.
    if (field.isSecret) continue;
    if (field.value !== undefined) push('customValue', field.value);
  }
  // The prompt is not a secret; the answer is, and the projection does not carry it.
  for (const question of record.securityQuestions) push('question', question.question);

  return entries;
}

/**
 * Classifies one already-folded haystack against one already-folded needle.
 *
 * Exported because this engine is the project's single ranked matcher, and the command
 * palette matches on the same rule. It used to be private, so `command-match.ts` mirrored
 * these three lines and pinned itself against this engine's observable output to stay
 * honest; exporting it deletes both the copy and the pin (hard rule 8). Both inputs must
 * already be through `foldText` — this function does no normalisation of its own.
 */
export function classifyMatch(haystack: string, needle: string): MatchKind | null {
  if (haystack === needle) return 'exact';
  if (haystack.startsWith(needle)) return 'prefix';
  if (haystack.includes(needle)) return 'substring';
  return null;
}

function bestMatchForTerm(
  term: QueryTerm,
  termIndex: number,
  entries: readonly HaystackEntry[]
): FieldMatch | null {
  const allowed = term.field === null ? BARE_TERM_FIELDS : FIELDS_BY_QUERY_FIELD[term.field];
  let best: FieldMatch | null = null;

  for (const entry of entries) {
    if (!allowed.includes(entry.field)) continue;
    const kind = classifyMatch(entry.folded, term.folded);
    if (kind === null) continue;
    const score = matchScore(entry.field, kind);
    if (best === null || score > best.score) {
      best = { field: entry.field, kind, text: entry.text, termIndex, score };
    }
  }
  return best;
}

/** Which surfaces this query could possibly need. */
function neededFields(query: ParsedQuery): ReadonlySet<MatchField> {
  const needed = new Set<MatchField>();
  for (const term of query.terms) {
    const fields = term.field === null ? BARE_TERM_FIELDS : FIELDS_BY_QUERY_FIELD[term.field];
    for (const field of fields) needed.add(field);
  }
  return needed;
}

// ── Matching one record ──────────────────────────────────────────────────────

export interface MatchOptions extends SearchContext {
  readonly deepMatched?: boolean | undefined;
}

/**
 * Scores one record against a query, or returns `null` if it does not match.
 *
 * Terms are ANDed: every positive term must find a home somewhere, and no negated term may
 * find one. Exposed on its own so a caller with a single record — a detail pane asking
 * "does this still match?" — does not have to run the whole list.
 */
export function matchCredential(
  record: CredentialProjection,
  query: ParsedQuery,
  options: MatchOptions = {}
): SearchResult | null {
  return matchWithHaystack(
    record,
    query,
    buildHaystack(record, neededFields(query), buildNameLookup(options)),
    options.deepMatched === true
  );
}

function matchWithHaystack(
  record: CredentialProjection,
  query: ParsedQuery,
  entries: readonly HaystackEntry[],
  deepMatched: boolean
): SearchResult | null {
  for (const flag of query.flags) {
    if (FLAG_PREDICATES[flag.flag](record) === flag.negated) return null;
  }

  const matches: FieldMatch[] = [];
  let score = 0;
  let deepCredited = false;

  for (const [index, term] of query.terms.entries()) {
    const best = bestMatchForTerm(term, index, entries);

    if (term.negated) {
      if (best !== null) return null;
      continue;
    }

    if (best !== null) {
      matches.push(best);
      score += best.score;
      continue;
    }

    // Nothing visible matched. The main process may still have matched it against note
    // text or a hidden field; credit that once, at the lowest weight, since we know only
    // that it matched and not where.
    if (!deepMatched) return null;
    if (!deepCredited) {
      deepCredited = true;
      const deepScore = matchScore('deep', 'substring');
      matches.push({
        field: 'deep',
        kind: 'substring',
        text: '',
        termIndex: index,
        score: deepScore,
      });
      score += deepScore;
    }
  }

  return { record, score, matches };
}

// ── Filtering a list ─────────────────────────────────────────────────────────

/**
 * Whether trashed records are in scope.
 *
 * Excluded by default, because the overwhelmingly common case is browsing a vault, and a
 * deleted record reappearing in that list is the kind of bug that makes someone delete it
 * twice. An explicit `is:trashed` in the query counts as asking for them — otherwise typing
 * the flag would return nothing at all, which reads as a broken filter rather than as a
 * default being enforced.
 */
function resolveTrashPolicy(options: FilterOptions): 'exclude' | 'include' | 'only' {
  if (options.trashedOnly === true) return 'only';
  if (options.includeTrashed === true) return 'include';
  const asksForTrash = options.query?.flags.some(
    (flag) => flag.flag === 'is:trashed' && !flag.negated
  );
  return asksForTrash === true ? 'include' : 'exclude';
}

function passesStructuredFilters(
  record: CredentialProjection,
  options: FilterOptions,
  trash: 'exclude' | 'include' | 'only',
  folderIds: ReadonlySet<string> | null
): boolean {
  const trashed = record.trashedAt !== null;
  if (trash === 'exclude' && trashed) return false;
  if (trash === 'only' && !trashed) return false;

  if (options.favouritesOnly === true && !record.favorite) return false;

  if (options.folderId === null && record.folderId !== null) return false;
  if (folderIds !== null && (record.folderId === null || !folderIds.has(record.folderId))) {
    return false;
  }

  const tagIds = options.tagIds;
  if (tagIds !== undefined && tagIds.length > 0) {
    const has = (tagId: string): boolean => record.tags.includes(tagId);
    if (options.tagMatch === 'all' ? !tagIds.every(has) : !tagIds.some(has)) return false;
  }

  return true;
}

/**
 * The set of folder ids a record may be filed under, or `null` for "no folder filter".
 *
 * `folderId: null` (the unfiled view) returns `null` too — it is handled as its own rule in
 * `passesStructuredFilters`, because "in no folder" is not a set of ids.
 */
function resolveFolderIds(options: FilterOptions): ReadonlySet<string> | null {
  const folderId = options.folderId;
  if (folderId === undefined || folderId === null) return null;
  if (options.includeDescendantFolders !== true) return new Set([folderId]);
  return collectDescendantFolderIds(options.folders ?? [], folderId);
}

/**
 * The full pipeline: structured filters, then the query, with a score for each survivor.
 *
 * Order is deliberately cheapest-first — a boolean on the record rejects most of a vault
 * before any string is folded. Results come back in input order; ordering them is
 * `sort.ts`'s job, and doing it here would mean two places deciding what order a list is in.
 */
export function searchCredentials(
  records: readonly CredentialProjection[],
  options: FilterOptions = {}
): readonly SearchResult[] {
  const query = options.query ?? EMPTY_QUERY;
  const trash = resolveTrashPolicy(options);
  const names = buildNameLookup(options);
  const needed = neededFields(query);
  const deepMatchIds = options.deepMatchIds;

  const folderIds = resolveFolderIds(options);

  const results: SearchResult[] = [];
  for (const record of records) {
    if (!passesStructuredFilters(record, options, trash, folderIds)) continue;
    if (query.isEmpty) {
      results.push({ record, score: 0, matches: [] });
      continue;
    }
    const entries = buildHaystack(record, needed, names);
    const result = matchWithHaystack(record, query, entries, deepMatchIds?.has(record.id) === true);
    if (result !== null) results.push(result);
  }
  return results;
}

/** The same pipeline when the caller only wants the records. */
export function filterCredentials(
  records: readonly CredentialProjection[],
  options: FilterOptions = {}
): readonly CredentialProjection[] {
  return searchCredentials(records, options).map((result) => result.record);
}

/** Relevance scores in the shape `sortCredentials` wants, so nobody rebuilds this by hand. */
export function scoresById(results: readonly SearchResult[]): ReadonlyMap<string, number> {
  const scores = new Map<string, number>();
  for (const result of results) scores.set(result.record.id, result.score);
  return scores;
}
