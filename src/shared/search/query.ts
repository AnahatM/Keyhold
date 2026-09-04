// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The search box's query language, as a **pure parser**.
 *
 * One box, one string, no modes. What comes out is a structured `ParsedQuery` rather than a
 * regex, because a regex cannot express "not this", "only in the title", or "has an
 * attachment" — and because a half-typed query has to survive parsing. Someone typing
 * `title:"my ba` is not making a mistake, they are one keystroke into a phrase, and a
 * search box that throws or empties itself at that moment is broken. **Nothing in this file
 * throws.** Anything the parser cannot make sense of becomes a diagnostic the UI can show,
 * and the rest of the query still works.
 *
 * ## The secret boundary applies here too
 *
 * This engine runs in the renderer over `CredentialProjection`, which by decision D13 holds
 * no password, no note body, no security answer and no hidden custom-field value. So the
 * language cannot offer a term that would need one. Two consequences are visible below:
 *
 *   - `note:` cannot search note text — see `NOTE_PREFIX_BEHAVIOUR` for what it does instead
 *   - there is no `is:weak`, because weakness is computed from the password itself in the
 *     main process. The health report already answers that question, and re-deriving it
 *     here would be both impossible and a second copy of `HEALTH_RULE_WEIGHTS`' rules.
 *
 * ## Grammar
 *
 *   term        := '-'? (field ':')? (phrase | word)
 *   phrase      := '"' <anything but '"'> '"'?
 *   flag        := '-'? ('is' | 'has') ':' name
 *
 * Terms are ANDed. A bare term may match any searchable field; a scoped term only its own.
 * Matching itself lives in `filter.ts` — this file decides only what was asked for.
 */

// ── Text folding ─────────────────────────────────────────────────────────────

/**
 * Module scope rather than per call: folding runs once per field per record per keystroke,
 * and a fresh `RegExp` on a 10,000-record vault is thousands of throwaway objects a
 * keystroke. `String.prototype.replace` resets `lastIndex` on a global regex, so sharing
 * this one carries no state between calls — unlike `.test()`, which would.
 */
const COMBINING_MARKS = /\p{M}/gu;

/**
 * Case- and diacritic-insensitive form of a string, for both haystacks and needles.
 *
 * NFD splits "é" into "e" + a combining acute, which the strip then removes, so `cafe`
 * finds "Café" and `café` finds "Cafe". This is deliberately not a full Unicode collation —
 * that would mean shipping a table for a search box. It handles the Latin-script accents
 * people actually type, and everything else falls back to a plain case-folded compare.
 */
export function foldText(value: string): string {
  return value.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
}

// ── The prefix registry ──────────────────────────────────────────────────────

export interface QueryFieldSpec {
  /** The canonical prefix, without the colon. */
  readonly prefix: string;
  /** Accepted alternatives. Folded into the same field, never a separate entry. */
  readonly aliases: readonly string[];
  /** For an autocomplete row. */
  readonly label: string;
  readonly hint: string;
  /**
   * True when the prefix can only answer "is there one", not "does it contain this" —
   * because the text it would search never crosses the bridge.
   */
  readonly presenceOnly: boolean;
}

/**
 * Every field-scoped prefix, once.
 *
 * Exported so an autocomplete menu renders from this and cannot drift out of step with what
 * the parser accepts (hard rule 8 — no second list). A prefix added here is understood by
 * the parser immediately; `filter.ts` maps it to haystack fields under a
 * `Record<QueryField, …>`, so forgetting to wire one up is a type error rather than a term
 * that silently matches nothing.
 */
export const QUERY_FIELDS = [
  {
    prefix: 'title',
    aliases: ['name'],
    label: 'title:',
    hint: 'Match the record title',
    presenceOnly: false,
  },
  {
    prefix: 'user',
    aliases: ['username'],
    label: 'user:',
    hint: 'Match the username',
    presenceOnly: false,
  },
  {
    prefix: 'email',
    aliases: [],
    label: 'email:',
    hint: 'Match the email address',
    presenceOnly: false,
  },
  {
    prefix: 'url',
    aliases: ['site'],
    label: 'url:',
    hint: 'Match any of the record’s URLs',
    presenceOnly: false,
  },
  { prefix: 'tag', aliases: [], label: 'tag:', hint: 'Match a tag name', presenceOnly: false },
  {
    prefix: 'folder',
    aliases: [],
    label: 'folder:',
    hint: 'Match the folder name',
    presenceOnly: false,
  },
  {
    prefix: 'field',
    aliases: [],
    label: 'field:',
    hint: 'Match a custom field’s label',
    presenceOnly: false,
  },
  {
    prefix: 'type',
    aliases: ['kind'],
    label: 'type:',
    hint: 'Match the kind of record — login, card, note, wifi, ssh-key…',
    presenceOnly: false,
  },
  {
    prefix: 'note',
    aliases: ['notes'],
    label: 'note:',
    hint: 'Records that have notes — note text is never searchable here',
    presenceOnly: true,
  },
] as const satisfies readonly QueryFieldSpec[];

export type QueryField = (typeof QUERY_FIELDS)[number]['prefix'];

/**
 * What `note:something` does, stated once so the UI and the tests quote the same decision.
 *
 * The choice was: reject the term outright, or degrade it. Rejecting it means a user who
 * types `note:recovery` gets an error and no results, having asked a perfectly reasonable
 * question. Silently dropping it is worse still — the query would widen to *everything*,
 * and every record on screen would look like a note match.
 *
 * So it degrades to `has:notes`: strictly narrower than dropping it, never wrong about a
 * record it shows, and paired with a diagnostic saying why. The full-text answer exists —
 * the main process can search note bodies over `kh:credentials:deep-search` — and a caller
 * that has that channel can route `ParsedQuery.raw` to it and feed the ids back in as
 * `deepMatchIds`. What must not happen is this module pretending it searched the text.
 */
export const NOTE_PREFIX_BEHAVIOUR = 'has-notes' as const;

// ── The flag registry ────────────────────────────────────────────────────────

export interface QueryFlagSpec {
  /** The whole token, namespace included: `is:favorite`. */
  readonly token: string;
  readonly aliases: readonly string[];
  readonly hint: string;
}

/**
 * Every boolean flag, once.
 *
 * The bar for entry is that a `CredentialProjection` alone can answer it, with no clock, no
 * vault settings and no health report. That rules out `is:weak` and `is:reused` (they need
 * the password), and `is:expired` / `is:expiring` (they need `now`, which a pure function
 * has no business reading — `HealthAnalysisOptions.now` exists for exactly that reason).
 * Those belong to the health dashboard, which already computes them properly.
 *
 * American and British spellings both parse; `favourite` is an alias rather than a second
 * entry so the two can never diverge.
 */
export const QUERY_FLAGS = [
  { token: 'is:favorite', aliases: ['is:favourite'], hint: 'Starred records' },
  { token: 'is:trashed', aliases: ['is:deleted'], hint: 'Records in the trash' },
  { token: 'is:untagged', aliases: [], hint: 'Records with no tags' },
  { token: 'is:unfiled', aliases: ['is:nofolder'], hint: 'Records in no folder' },
  { token: 'has:password', aliases: [], hint: 'Records with a password set' },
  { token: 'has:notes', aliases: ['has:note'], hint: 'Records with notes' },
  { token: 'has:attachment', aliases: ['has:attachments', 'has:file'], hint: 'Records with files' },
  { token: 'has:totp', aliases: ['has:otp'], hint: 'Records with a one-time-password secret' },
  { token: 'has:url', aliases: ['has:urls'], hint: 'Records with at least one URL' },
  { token: 'has:history', aliases: [], hint: 'Records with saved versions' },
] as const satisfies readonly QueryFlagSpec[];

export type QueryFlagToken = (typeof QUERY_FLAGS)[number]['token'];

/** The two flag namespaces. A prefix in this set is looked up as a flag, never as a field. */
const FLAG_NAMESPACES: readonly string[] = ['is', 'has'];

// ── Parsed shapes ────────────────────────────────────────────────────────────

export interface QueryTerm {
  /** `null` for a bare term, which may match any searchable field. */
  readonly field: QueryField | null;
  /** As typed, for echoing back in the UI. Never used for matching. */
  readonly text: string;
  /** `foldText(text)` — precomputed here so matching never folds a needle per record. */
  readonly folded: string;
  /** It was quoted. Only affects tokenising; a phrase may contain spaces, a word may not. */
  readonly phrase: boolean;
  readonly negated: boolean;
}

export interface QueryFlagTerm {
  readonly flag: QueryFlagToken;
  readonly negated: boolean;
}

export type QueryDiagnosticCode =
  | 'unterminated-quote'
  | 'dangling-negation'
  | 'empty-term'
  | 'unknown-flag'
  | 'note-body-not-searchable';

/**
 * Something the user should be told, without the query having failed.
 *
 * Every one of these is recoverable by construction: the parser has already decided what to
 * do about it, and the surrounding query still runs.
 */
export interface QueryDiagnostic {
  readonly code: QueryDiagnosticCode;
  /** The offending token, as typed. */
  readonly token: string;
  /** Plain, user-facing, and free of anything secret — it is only ever the query itself. */
  readonly message: string;
}

export interface ParsedQuery {
  readonly raw: string;
  readonly terms: readonly QueryTerm[];
  readonly flags: readonly QueryFlagTerm[];
  readonly diagnostics: readonly QueryDiagnostic[];
  /** Nothing to test — such a query matches every record rather than none. */
  readonly isEmpty: boolean;
}

/** The parse of an empty box. Shared so callers do not each allocate one per render. */
export const EMPTY_QUERY: ParsedQuery = {
  raw: '',
  terms: [],
  flags: [],
  diagnostics: [],
  isEmpty: true,
};

// ── Lookup tables ────────────────────────────────────────────────────────────

const FIELD_BY_PREFIX = new Map<string, QueryField>();
for (const spec of QUERY_FIELDS) {
  FIELD_BY_PREFIX.set(spec.prefix, spec.prefix);
  for (const alias of spec.aliases) {
    FIELD_BY_PREFIX.set(alias, spec.prefix);
  }
}

const FLAG_BY_TOKEN = new Map<string, QueryFlagToken>();
for (const spec of QUERY_FLAGS) {
  FLAG_BY_TOKEN.set(spec.token, spec.token);
  for (const alias of spec.aliases) {
    FLAG_BY_TOKEN.set(alias, spec.token);
  }
}

/** Presence-only prefixes, resolved once so the parser does not scan the registry per token. */
const PRESENCE_ONLY_FIELDS: ReadonlySet<string> = new Set(
  QUERY_FIELDS.filter((spec) => spec.presenceOnly).map((spec) => spec.prefix)
);

// ── The parser ───────────────────────────────────────────────────────────────

function isSpace(char: string): boolean {
  return char === '' || /\s/u.test(char);
}

/**
 * Parses a query string. Total: every input produces a `ParsedQuery`.
 *
 * The scanner is a hand-written single pass rather than a regex split, because quoting has
 * to survive being half-typed and a split cannot see that the closing quote is missing.
 */
export function parseQuery(input: string): ParsedQuery {
  const terms: QueryTerm[] = [];
  const flags: QueryFlagTerm[] = [];
  const diagnostics: QueryDiagnostic[] = [];

  const length = input.length;
  let i = 0;

  while (i < length) {
    if (isSpace(input.charAt(i))) {
      i += 1;
      continue;
    }

    const tokenStart = i;

    let negated = false;
    if (input.charAt(i) === '-') {
      negated = true;
      i += 1;
    }

    // A prefix is everything up to the first colon, stopping at whitespace or a quote so
    // that `"a: b"` and a bare `https://x` are not mistaken for one.
    let prefix: string | null = null;
    let scan = i;
    while (scan < length) {
      const char = input.charAt(scan);
      if (isSpace(char) || char === ':' || char === '"') break;
      scan += 1;
    }
    if (scan < length && input.charAt(scan) === ':') {
      prefix = input.slice(i, scan).toLowerCase();
      i = scan + 1;
    }

    let value: string;
    let phrase = false;
    if (input.charAt(i) === '"') {
      phrase = true;
      i += 1;
      const close = input.indexOf('"', i);
      if (close === -1) {
        // Unterminated: take the rest as the phrase so results update while it is being
        // typed, and say so. Discarding it would make the list jump on the opening quote.
        value = input.slice(i);
        i = length;
        diagnostics.push({
          code: 'unterminated-quote',
          token: input.slice(tokenStart),
          message: 'A quote was never closed — searching the rest of the line as a phrase.',
        });
      } else {
        value = input.slice(i, close);
        i = close + 1;
      }
    } else {
      let end = i;
      while (end < length && !isSpace(input.charAt(end))) end += 1;
      value = input.slice(i, end);
      i = end;
    }

    const token = input.slice(tokenStart, i);

    if (prefix !== null && FLAG_NAMESPACES.includes(prefix)) {
      if (value === '') {
        diagnostics.push(emptyTermDiagnostic(token));
        continue;
      }
      const flag = FLAG_BY_TOKEN.get(`${prefix}:${value.toLowerCase()}`);
      if (flag === undefined) {
        // Dropped rather than searched as text: a typo'd `is:favorit` should not quietly
        // become a text search for "is:favorit" that matches nothing at all.
        diagnostics.push({
          code: 'unknown-flag',
          token,
          message: `"${token}" is not a filter Keyhold knows. It was ignored.`,
        });
        continue;
      }
      flags.push({ flag, negated });
      continue;
    }

    const field = prefix === null ? null : (FIELD_BY_PREFIX.get(prefix) ?? null);

    // An unrecognised prefix is not an error — `https://example.com` and `9:30` are things
    // people paste into a search box. Put the colon back and search for the whole thing.
    const text = field === null && prefix !== null ? `${prefix}:${value}` : value;

    if (text === '') {
      diagnostics.push(negated ? danglingNegationDiagnostic(token) : emptyTermDiagnostic(token));
      continue;
    }

    if (field !== null && PRESENCE_ONLY_FIELDS.has(field)) {
      // See NOTE_PREFIX_BEHAVIOUR. Rewritten here, once, so `filter.ts` never has to know
      // that a searchable-looking prefix is not searchable.
      flags.push({ flag: 'has:notes', negated });
      diagnostics.push({
        code: 'note-body-not-searchable',
        token,
        message:
          'Note text never leaves the vault’s locked side, so it cannot be searched from here. Showing records that have notes instead.',
      });
      continue;
    }

    terms.push({ field, text, folded: foldText(text), phrase, negated });
  }

  return {
    raw: input,
    terms,
    flags,
    diagnostics,
    isEmpty: terms.length === 0 && flags.length === 0,
  };
}

function emptyTermDiagnostic(token: string): QueryDiagnostic {
  return {
    code: 'empty-term',
    token,
    // Mid-typing is the common case, so this is phrased as "still waiting", not "wrong".
    message: `"${token}" has nothing to search for yet, so it was ignored.`,
  };
}

function danglingNegationDiagnostic(token: string): QueryDiagnostic {
  return {
    code: 'dangling-negation',
    token,
    message: 'A "-" on its own excludes nothing, so it was ignored.',
  };
}
