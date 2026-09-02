// SPDX-License-Identifier: GPL-3.0-or-later

import {
  foldText,
  matchScore,
  type FieldMatch,
  type MatchField,
  type MatchKind,
  type ParsedQuery,
  type QueryTerm,
} from '@shared/search/index.js';
import type { ResolvedCommand } from './command-registry.js';

/**
 * Matching a **command** against the search box, on the vault's own search engine.
 *
 * ## Why this is not a second matcher
 *
 * `@shared/search` is the project's one ranked matcher and this file does not replace any
 * of it. The query language (`parseQuery`), the text normalisation (`foldText`) and the
 * scoring scale (`matchScore`, and the field/kind weights behind it) all come from there.
 * What is here is only the *adapter*: which of a command's three surfaces stands in for
 * which of the engine's fields.
 *
 * The alternative considered and rejected was to give every command a synthetic
 * `CredentialProjection` and run `matchCredential` over it unchanged. That reuses more
 * code and produces wrong answers: the engine's flag predicates would then be asked
 * whether a command `has:password` or `is:untagged`, and the honest answer for a menu item
 * is neither true nor false. `is:untagged` would have returned every command in the app.
 * Fabricating twenty fields of a security-boundary type to get three of them is also
 * exactly the sort of thing that later reads as "commands are credentials".
 *
 * ## The mapping
 *
 * | Command surface | Engine field | Why                                              |
 * | --------------- | ------------ | ------------------------------------------------ |
 * | title           | `title`      | The name of the thing, same as a record's title.  |
 * | keywords        | `tag`        | Alternative names the user might reach for.       |
 * | section         | `folder`     | Where it lives. Weakest, same as a record's.      |
 *
 * Because the scale is the engine's, a command hit and a credential hit are directly
 * comparable and the palette can merge them into one ranked list rather than showing two
 * lists side by side and inventing an interleave.
 *
 * ## Scoped terms and flags
 *
 * `has:totp`, `is:trashed` and friends are questions about a *record*. A query carrying one
 * is asking about the vault, so commands drop out entirely rather than each flag needing an
 * opinion about menu items. Likewise a field-scoped term: only `title:` means anything to a
 * command, and `url:github` should not surface "Lock the vault".
 */

/**
 * The engine fields a command can occupy, strongest first.
 *
 * Exported because it is the machine-readable half of the mapping table above, and
 * `command-match.test.ts` asserts `commandSurfaces` produces nothing outside it — hard rule
 * 9. Without that assertion this is a constant only the type system reads, which is another
 * way of saying the table in the comment is the only thing keeping it true.
 */
export const COMMAND_FIELDS = ['title', 'tag', 'folder'] as const satisfies readonly MatchField[];

/** One of the three fields above. A command has no other surface to be found by. */
export type CommandField = (typeof COMMAND_FIELDS)[number];

/** Query prefixes a command is allowed to answer. `null` is a bare term. */
const COMMAND_QUERY_FIELDS: ReadonlySet<string> = new Set(['title']);

interface Surface {
  readonly field: CommandField;
  readonly text: string;
  readonly folded: string;
}

/**
 * Classifies one folded haystack against one folded needle.
 *
 * This mirrors the private `classifyMatch` in `@shared/search/filter.ts`. It is three lines
 * and it is the one thing the engine does not export; `command-match.test.ts` pins it
 * against the engine's own observable output, so if the engine ever changes what counts as
 * a prefix, this file fails rather than quietly ranking commands on a different rule than
 * credentials. The permanent fix is a one-line `export` in `filter.ts`, which this agent
 * does not own — it is written up in the report.
 */
export function classifyMatch(haystack: string, needle: string): MatchKind | null {
  if (haystack === needle) return 'exact';
  if (haystack.startsWith(needle)) return 'prefix';
  if (haystack.includes(needle)) return 'substring';
  return null;
}

/**
 * A command's searchable text, folded once per search rather than once per term.
 *
 * Keywords are folded here rather than at authoring time so the registry stays plain
 * readable data — a table of pre-folded strings is a table nobody proofreads.
 */
export function commandSurfaces(command: ResolvedCommand): readonly Surface[] {
  const { definition } = command;
  const surfaces: Surface[] = [
    { field: 'title', text: definition.title, folded: foldText(definition.title) },
    { field: 'folder', text: definition.section, folded: foldText(definition.section) },
  ];
  for (const keyword of definition.keywords) {
    surfaces.push({ field: 'tag', text: keyword, folded: foldText(keyword) });
  }
  return surfaces;
}

function bestMatchForTerm(
  term: QueryTerm,
  termIndex: number,
  surfaces: readonly Surface[]
): FieldMatch | null {
  const scoped = term.field !== null;
  let best: FieldMatch | null = null;

  for (const surface of surfaces) {
    // A `title:` term may only look at the title, exactly as the engine restricts a scoped
    // term to its own field.
    if (scoped && surface.field !== 'title') continue;
    const kind = classifyMatch(surface.folded, term.folded);
    if (kind === null) continue;
    const score = matchScore(surface.field, kind);
    if (best === null || score > best.score) {
      best = { field: surface.field, kind, text: surface.text, termIndex, score };
    }
  }
  return best;
}

export interface CommandMatch {
  readonly command: ResolvedCommand;
  readonly score: number;
  /** The best match per positive term, in term order. Empty for an empty query. */
  readonly matches: readonly FieldMatch[];
}

/**
 * Scores one command, or returns `null` if the query excludes it.
 *
 * Terms are ANDed and negation is honoured, both to match the engine's semantics exactly —
 * a user who has learnt that `-trash` narrows their credential search should not find it
 * silently ignored for half the list.
 */
export function matchCommand(command: ResolvedCommand, query: ParsedQuery): CommandMatch | null {
  if (query.isEmpty) return { command, score: 0, matches: [] };

  // Record-shaped questions. See the file header.
  if (query.flags.length > 0) return null;

  const surfaces = commandSurfaces(command);
  const matches: FieldMatch[] = [];
  let score = 0;

  for (const [index, term] of query.terms.entries()) {
    if (term.field !== null && !COMMAND_QUERY_FIELDS.has(term.field)) {
      // `url:github` asks about records. A negated one — `-url:github` — is trivially true
      // of every command, so it narrows nothing and is simply skipped.
      if (term.negated) continue;
      return null;
    }

    const best = bestMatchForTerm(term, index, surfaces);

    if (term.negated) {
      if (best !== null) return null;
      continue;
    }

    if (best === null) return null;
    matches.push(best);
    score += best.score;
  }

  return { command, score, matches };
}

export function searchCommands(
  commands: readonly ResolvedCommand[],
  query: ParsedQuery
): readonly CommandMatch[] {
  const hits: CommandMatch[] = [];
  for (const command of commands) {
    const hit = matchCommand(command, query);
    if (hit !== null) hits.push(hit);
  }
  return hits;
}
