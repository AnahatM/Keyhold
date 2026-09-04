// SPDX-License-Identifier: GPL-3.0-or-later

import type { CredentialProjection } from '@shared/model/credential.js';
import {
  DEFAULT_SORT_DIRECTION,
  parseQuery,
  scoresById,
  searchCredentials,
  sortCredentials,
  TITLE_COLLATOR,
  type FieldMatch,
  type MatchField,
  type ParsedQuery,
} from '@shared/search/index.js';
import { searchCommands } from './command-match.js';
import type { ResolvedCommand } from './command-registry.js';

/**
 * One ranked list of commands and credentials.
 *
 * The palette searches both at once because that is the question a user is actually
 * asking — "github" is either the record or nothing, "lock" is either the command or
 * nothing, and making them choose a mode first is making them do the disambiguation the
 * computer is better at. Two side-by-side lists would need an invented interleave rule; one
 * list needs a shared score, which is why `command-match.ts` scores on the credential
 * engine's own scale.
 *
 * **No secret is in this file, this type, or anything it returns.** A credential item
 * carries the `CredentialProjection` the renderer already holds — title, username, email —
 * and the palette renders exactly those. There is no reveal path here and there must never
 * be one: a fuzzy search surface where the highlighted row changes as you type is the worst
 * possible place to attach an action that puts a password on the clipboard.
 */

export type PaletteItem =
  | {
      readonly kind: 'command';
      /** Stable across both kinds. The recents list and the option ids are keyed on it. */
      readonly key: string;
      readonly command: ResolvedCommand;
      readonly score: number;
      readonly matches: readonly FieldMatch[];
    }
  | {
      readonly kind: 'credential';
      readonly key: string;
      readonly record: CredentialProjection;
      readonly score: number;
      readonly matches: readonly FieldMatch[];
    };

export function commandKey(id: string): string {
  return `command:${id}`;
}

export function credentialKey(id: string): string {
  return `credential:${id}`;
}

/**
 * How many records the palette will show.
 *
 * A vault can hold tens of thousands. The palette is a "jump to the thing I am thinking of"
 * surface, not a browser — past a couple of dozen rows a user reaches for the real list, and
 * rendering the rest costs a frame on every keystroke. Commands are never capped: there are
 * eleven of them and hiding one would make the palette feel unreliable.
 */
export const MAX_CREDENTIAL_RESULTS = 25;

export interface PaletteSearchInput {
  readonly commands: readonly ResolvedCommand[];
  readonly credentials: readonly CredentialProjection[];
  /**
   * Keys of recently run items, most recent first. Only consulted for an empty query — with
   * a query, relevance decides, because a stale recent outranking an exact title match is
   * the behaviour that makes people stop trusting a palette.
   */
  readonly recentKeys: readonly string[];
  /** Ids the main process matched inside secret material. Merged by the engine, never read. */
  readonly deepMatches?: readonly string[] | undefined;
}

export interface PaletteSearchResult {
  readonly items: readonly PaletteItem[];
  readonly query: ParsedQuery;
}

/**
 * Ranks the merged list.
 *
 * Score first, on the shared scale. Then commands, because the palette's own name says what
 * it is for and a user who typed a verb wants the verb. Then title, through the engine's
 * collator rather than a fresh one — `sort.ts` built it once with the right options
 * (numeric, base sensitivity) and a second collator would order "Item 10" and "Item 9"
 * differently in this list than in the credential list two panes away.
 */
function compareItems(a: PaletteItem, b: PaletteItem): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.kind !== b.kind) return a.kind === 'command' ? -1 : 1;
  return TITLE_COLLATOR.compare(itemTitle(a), itemTitle(b));
}

export function itemTitle(item: PaletteItem): string {
  return item.kind === 'command' ? item.command.definition.title : item.record.title;
}

/**
 * The secondary line: what the row is, or who it is for.
 *
 * For a credential this is the username or, failing that, the email — both of which are in
 * the safe projection. Never a password length, never a hint, never anything derived from
 * secret material.
 */
export function itemDetail(item: PaletteItem): string {
  if (item.kind === 'command') return item.command.definition.section;
  const record = item.record;
  if (record.username !== '') return record.username;
  return record.email;
}

/** Human names for the engine's fields, so a result can say why it is here. */
const CREDENTIAL_FIELD_LABELS: Readonly<Record<MatchField, string>> = {
  title: 'title',
  username: 'username',
  email: 'email',
  tag: 'tag',
  type: 'kind of record',
  url: 'web address',
  folder: 'folder',
  customLabel: 'field name',
  customValue: 'field value',
  question: 'security question',
  deep: 'hidden field',
};

/** The same fields, named as a *command* uses them — see `command-match.ts`'s mapping. */
const COMMAND_FIELD_LABELS: Partial<Readonly<Record<MatchField, string>>> = {
  title: 'name',
  tag: 'keyword',
  folder: 'section',
};

/**
 * "Matched on <field>", or `null` when the query was empty and nothing matched anything.
 *
 * Shown next to every result. Without it a fuzzy list is a magic list: a record appears for
 * a query that is nowhere in its visible title and the user cannot tell whether the search
 * is clever or broken. `deep` is the one that most needs saying — the record matched
 * something the renderer cannot see, and pretending otherwise would be a lie about where
 * the data is.
 */
export function matchReason(item: PaletteItem): string | null {
  const first = item.matches[0];
  if (first === undefined) return null;
  const label =
    item.kind === 'command'
      ? (COMMAND_FIELD_LABELS[first.field] ?? first.field)
      : CREDENTIAL_FIELD_LABELS[first.field];
  return `Matched on ${label}`;
}

/**
 * The whole pipeline.
 *
 * An empty query is a genuinely different question — "what can I do?" rather than "where is
 * this?" — so it is answered differently: recents first, then every available command, and
 * **no credentials at all**. Listing the vault on open would turn a keystroke into a wall of
 * account names for anyone standing behind the user, and it is not what the palette is for.
 */
export function searchPalette(text: string, input: PaletteSearchInput): PaletteSearchResult {
  const query = parseQuery(text);

  if (query.isEmpty) {
    return { items: emptyQueryItems(input), query };
  }

  const items: PaletteItem[] = searchCommands(input.commands, query).map((hit) => ({
    kind: 'command' as const,
    key: commandKey(hit.command.definition.id),
    command: hit.command,
    score: hit.score,
    matches: hit.matches,
  }));

  const results = searchCredentials(input.credentials, {
    query,
    deepMatchIds: input.deepMatches === undefined ? undefined : new Set(input.deepMatches),
  });

  // Sorted by the engine before the cap, so the cap keeps the twenty-five best rather than
  // the twenty-five that happened to be first in the vault file.
  //
  // `direction` is passed explicitly and read from the engine's own table. `sortCredentials`
  // defaults to ascending, and ascending relevance means *worst match first* — so a cap
  // applied to the default order would keep precisely the twenty-five records the user did
  // not want. `DEFAULT_SORT_DIRECTION` is the authority on which way each key should read,
  // so it is consulted rather than a literal 'desc' being written here.
  const ranked = sortCredentials(
    results.map((result) => result.record),
    {
      key: 'relevance',
      direction: DEFAULT_SORT_DIRECTION.relevance,
      scores: scoresById(results),
    }
  );
  const byId = new Map(results.map((result) => [result.record.id, result]));

  for (const record of ranked.slice(0, MAX_CREDENTIAL_RESULTS)) {
    const result = byId.get(record.id);
    items.push({
      kind: 'credential',
      key: credentialKey(record.id),
      record,
      score: result?.score ?? 0,
      matches: result?.matches ?? [],
    });
  }

  return { items: [...items].sort(compareItems), query };
}

/**
 * The open-with-nothing-typed list: what you did last, then everything you can do.
 *
 * A recent that is no longer available — the record it acted on was deselected, the handler
 * unmounted — simply does not appear. The recents list is keys, not commands, precisely so
 * a stale entry resolves to nothing instead of to a row that throws when pressed.
 */
function emptyQueryItems(input: PaletteSearchInput): readonly PaletteItem[] {
  const available = new Map(
    input.commands.map((command) => [commandKey(command.definition.id), command])
  );

  const items: PaletteItem[] = [];
  const used = new Set<string>();

  for (const key of input.recentKeys) {
    const command = available.get(key);
    if (command === undefined || used.has(key)) continue;
    used.add(key);
    items.push({ kind: 'command', key, command, score: 0, matches: [] });
  }

  for (const [key, command] of available) {
    if (used.has(key)) continue;
    items.push({ kind: 'command', key, command, score: 0, matches: [] });
  }

  return items;
}
