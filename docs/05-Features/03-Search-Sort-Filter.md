# Search, sort and filter

> The query language, how results are ranked, and why the ordering is total.
> Current reference. Implemented by `src/shared/search/`.
>
> **Status: the engine is built, tested, and wired into the credential list. The query-bar
> UI — prefix autocomplete, the diagnostics line, saved searches — is not.** See §7.

---

## 1. Where it runs, and why

In `src/shared/`, and called from the renderer. Search runs on the **safe projection**,
against data the renderer already holds, because a round trip per keystroke would make
search feel broken.

That is also its one real limitation: the projection has no note bodies, no security
answers and no hidden custom values, so the renderer cannot match inside them. That search
runs in the main process (`kh:credentials:deep-search`), which returns **ids only**, and
those are merged in through `deepMatchIds`. The renderer already has the projections to
render; it never needs the text that matched.

A deep match can never satisfy a _negated_ term. The main process reports what it found,
never what is absent, and inferring absence from a list of hits would be wrong.

---

## 2. The query language

One box. Everything below composes, and a leading `-` negates any of it.

| Form                | Matches                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `bare term`         | Title, username, email, urls, tags, security-question prompts, and non-secret custom labels and values |
| `"quoted phrase"`   | The phrase, contiguously                                                                               |
| `title:` `name:`    | Title only                                                                                             |
| `user:` `username:` | Username                                                                                               |
| `email:`            | Email                                                                                                  |
| `url:` `site:`      | URLs                                                                                                   |
| `tag:`              | Tags                                                                                                   |
| `folder:`           | The record's own folder name                                                                           |
| `field:`            | Custom-field **labels**                                                                                |
| `is:`               | `favorite`, `trashed`, `untagged`, `unfiled`                                                           |
| `has:`              | `password`, `notes`, `attachment`, `totp`, `url`, `history`                                            |

**The parser never throws.** An unterminated quote, a trailing `-`, a bare `:` and an empty
string all parse to something sensible. A search box that throws on a half-typed query is a
bug, and every query is half-typed at some point.

The prefixes and flags are exported as registries, so autocomplete renders _from_ them
rather than restating them — the "no second list" rule that this module exists to enforce.

### `note:` cannot work, and degrades rather than lying

The projection carries `hasNotes` and `notesLength`, never the note body, so `note:foo`
has nothing to search. Three options were available, and only one is honest:

- **Reject the query** — punishes a reasonable question.
- **Drop the term** — _widens_ the result to everything, so every row on screen would look
  like a note match.
- **Degrade to `has:notes`, and say so** — strictly narrower than dropping it, never wrong
  about a row it shows, and the UI gets a sentence to display.

The rewrite happens once, in the parser, so nothing downstream ever sees a term claiming to
search note text. The real answer lives behind the deep search.

### Flags that deliberately do not exist

No `is:weak`, `is:reused`, `is:expired` or `is:expiring`. Weakness needs the password and
expiry needs a clock — neither is derivable from a projection, and both already live in the
health report (`docs/05-Features/01-Health-Rules.md`). A test asserts their absence, so
"just add it" runs into the reason rather than into a bug.

An **unknown prefix** (`https://x`, `9:30`) is searched literally, because it is almost
always someone pasting a URL or a time. An **unknown flag** (`is:favorit`) is dropped with a
diagnostic, because a typo silently becoming a text search that matches nothing is worse
than being told.

---

## 3. Trashed records, and the flag that lifts the rule

Trashed records are excluded by default and only appear when asked for. Getting that
backwards would show deleted records during ordinary browsing, which reads as data that
would not stay deleted.

`is:trashed` **lifts** the default exclusion, because typing the flag and getting nothing
back reads as broken. `-is:trashed` does not lift it — a negation should never widen.

---

## 4. Ranking

A field weight and a match-kind weight, combined as `field * 10 + kind` — **added, not
multiplied**. Multiplying lets a URL exact match outrank a title substring, so searching
"github" would put `api.github.com` above the record actually called GitHub. Field
dominates kind, always.

Each result carries `FieldMatch` entries — which field, which kind, which term, and the
matched text — so the UI can show _why_ a record matched and highlight it without
re-running the match.

Matching is case- and diacritic-insensitive in both directions: `cafe` finds `Café` and
`Café` finds `cafe`. NFD normalisation with combining marks stripped, no library.

---

## 5. Sorting is total, stable, and honest about nulls

Keys: title, username, `createdAt`, `updatedAt`, `passwordUpdatedAt`, `lastUsedAt`,
`useCount`, and relevance.

**Every sort breaks ties on `id`**, so the list cannot reshuffle between renders. The
tiebreak stays ascending even in a descending sort, so toggling direction does not
rearrange tied groups. Removing it fails five tests, including a property that sorts the
same set from several starting orders and expects one answer.

**`Intl.Collator` with `{ numeric: true, sensitivity: 'base' }`, built once at module
scope.** Numeric so "Item 10" sorts after "Item 9"; base sensitivity so case does not
create arbitrary groups; once, because constructing a collator per comparison is a genuine
performance bug on a 10,000-record list. The locale is the host's — this list is read by one
person, in their language — so the order is total and stable on any machine, but not
byte-identical across locales.

**`lastUsedAt` is nullable, and nulls sort last in _both_ directions.** Treating null as `0`
puts never-used records at the _top_ of a descending "recently used" view, which reads as a
bug. The null decision is made before the direction is applied. Both directions are
guarded, and by different faults — the `?? 0` injection failed only the ascending test, so
a second injection pinning nulls first was needed to prove the descending one guards
anything.

---

## 6. Folder trees, and the cycle guard

Folder filtering can include descendants. A malformed folder tree with a cycle would hang
the UI, so descendant collection tracks what it has seen.

That guard's fault injection is the one that produces no assertion output: removing it makes
the test run **never terminate**, which is exactly the failure it prevents. The evidence is
a timeout — `exit code 124`, worker killed — rather than a diff, because Vitest cannot
interrupt a synchronous infinite loop.

---

## 6a. The query bar, and the sort control

Both existed in the engine long before either was reachable, which is the same story twice.

### What the parser understood, and never said

`parseQuery` has always produced user-facing diagnostics — an unterminated quote, a dangling
negation, an unknown flag, and the `note:` degradation explaining itself. Nothing rendered them.
So a typo produced an empty list, and **an empty list on a password manager reads as "you do not
have it" rather than "I did not understand that"**. `QueryHelp` shows them, in a warning tone
rather than a danger one, because the query still ran.

### What it accepts, and never offered

Six field prefixes and ten flags, discoverable only by reading the source. `QUERY_FIELDS` says
in its own comment that it is exported so a menu can render from it; `query-suggestions.ts` is
that menu, generated from the parser's own tables so a prefix added there appears without
anyone remembering to.

The property its tests hold is the **round trip**: everything offered, applied to what was
typed, must parse back cleanly. A suggestion the parser rejects is worse than no suggestions —
the user did not type it, the app did, and then complained about it. That test found `note:`
produces a diagnostic, which is correct rather than a defect: the parser degrades it to
`has:notes` because note bodies never cross the bridge, and the renderer supplements it with a
real deep search, so in this app `note:recovery` does find the note.

Completions are computed for the **last token, not the caret** — a deliberate simplification for
a one-line box, stated rather than left to be discovered.

### The sort control

Eight keys and a sensible default direction per key had been in the engine since it was written,
and `visibleCredentials` had taken a `SortOptions` the whole time with nothing passing one.

`SortControl` is a key picker plus a direction toggle, not one menu of every combination — two
decisions however many keys exist. **The direction button says what it will do in that key's own
words**, because "ascending" is accurate and useless: for a date it means oldest, for a count it
means fewest, and a control that says "newest first" while doing the opposite is worse than no
control. That mapping lives in `sort-labels.ts` and is tested.

Choosing a key adopts _that key's_ default direction rather than carrying the previous one over.
Going from "Name A–Z" to "Last used" and landing on longest-ago-first is the literal reading and
never the intended one.

The automatic order — title on an empty box, relevance once there is a query — remains the
default, and choosing pins it against that switch. That switch is the reason the control matters:
a list that silently reorders itself as you type is one you cannot keep your place in.

---

## 7. Not built yet

- **Saved searches.** The remaining third of the query-bar line. It needs somewhere to live, and
  that is a decision rather than a leftover: vault settings travel inside the `.keep` file, and
  machine preferences do not — a saved search naming a folder that only exists on one device is
  the case that decides it.
- ~~**Folder and tag sidebars** wired to `folderId` / `tagIds`~~ — built and mounted; see
  [`06-Organisation.md`](./06-Organisation.md).
- ~~**The query-bar UI** and **a sort control**~~ — both built; see §6a.
- **Fuzzy matching and highlight offsets.** `FieldMatch` already carries what a highlighter
  needs to compute ranges.
- **Memoised haystacks.** Folding is already limited to the fields a given query can reach.
  If a 10,000-record vault ever measures slow, this is the place to look — deliberately not
  done pre-emptively, because it would put mutable state in a module whose value is being
  pure.

---

## 8. One list, not two

`visibleCredentials` in the renderer used to be a second, weaker implementation of all of
this: `toLowerCase().includes()` over five fields, no diacritic folding, no ranking, a
collator built per comparison, and no tiebreak — so "Item 10" sorted before "Item 9" and
equal titles reshuffled between renders.

It now calls this engine. Two implementations of "what does this search find" would have
disagreed within a month, and the one the user actually sees would have been the weaker of
the two.
