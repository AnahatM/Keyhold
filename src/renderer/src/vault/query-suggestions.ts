// SPDX-License-Identifier: GPL-3.0-or-later
import { QUERY_FIELDS, QUERY_FLAGS } from '@shared/search/query.js';

/**
 * What to offer as somebody types a search.
 *
 * `QUERY_FIELDS` says in its own comment that it is exported so an autocomplete renders from it
 * and cannot drift from what the parser accepts. Nothing ever did. The prefixes have been
 * parsed, mapped and tested since the search engine was written, and the only way to learn one
 * exists has been to read the source.
 *
 * That is the whole case for this: a query language nobody can discover is a query language
 * nobody uses. Every entry below is generated from the parser's own tables, so a prefix added
 * there appears here without anyone remembering to.
 *
 * **Completions are computed for the last token, not the caret.** A caret-aware version would
 * be more correct and is not worth it here: the box is one line, editing mid-query is rare, and
 * the failure mode of getting it wrong — suggesting a completion for the wrong word — is more
 * confusing than offering nothing. Stated rather than left as a subtlety for whoever finds it.
 */

export interface QuerySuggestion {
  /** What the token becomes when this is chosen. */
  readonly insert: string;
  /** What the row reads as. */
  readonly label: string;
  readonly hint: string;
}

/** The token being typed: everything after the last space. */
export function activeToken(input: string): string {
  const trimmedEnd = input.replace(/\s+$/, '');
  // A trailing space means the previous word is finished and a new, empty one has started —
  // which is a real state, and one where every prefix is a candidate.
  if (trimmedEnd !== input) return '';
  const parts = input.split(/\s+/);
  return parts[parts.length - 1] ?? '';
}

/** Replaces the last token with `insert`, preserving everything before it. */
export function applySuggestion(input: string, insert: string): string {
  const token = activeToken(input);
  const head = token === '' ? input : input.slice(0, input.length - token.length);
  // A field prefix ends in a colon and wants a value typed next, so no trailing space; a flag
  // is complete on its own and gets one, so the next word starts cleanly.
  const tail = insert.endsWith(':') ? '' : ' ';
  return `${head}${insert}${tail}`;
}

/**
 * The suggestions for the current input, most useful first.
 *
 * Fields before flags, because a field prefix is the one that takes an argument and is
 * therefore the one somebody is part-way through typing. Within each group, the parser's own
 * order is kept rather than sorted alphabetically — that order was chosen for how common each
 * one is.
 */
export function suggestionsFor(input: string, limit = 6): readonly QuerySuggestion[] {
  const token = activeToken(input).toLowerCase();

  // Nothing is offered once a value is being typed — `title:git` matches no prefix and no
  // flag, so the filters below return nothing on their own. There was an explicit early return
  // here for that case; injecting its removal failed no test, because it could not: the prefix
  // matching already excludes every token it was guarding against. Dead code that reads like a
  // rule is worse than no code, so it is gone and this comment is what remains of it.
  const fields: QuerySuggestion[] = QUERY_FIELDS.filter(
    (field) =>
      token === '' ||
      field.prefix.startsWith(token) ||
      field.aliases.some((alias) => alias.startsWith(token))
  ).map((field) => ({
    insert: `${field.prefix}:`,
    label: field.label,
    hint: field.presenceOnly ? `${field.hint} (presence only)` : field.hint,
  }));

  const flags: QuerySuggestion[] = QUERY_FLAGS.filter(
    (flag) =>
      token === '' ||
      flag.token.startsWith(token) ||
      flag.aliases.some((alias) => alias.startsWith(token))
  ).map((flag) => ({ insert: flag.token, label: flag.token, hint: flag.hint }));

  return [...fields, ...flags].slice(0, limit);
}
