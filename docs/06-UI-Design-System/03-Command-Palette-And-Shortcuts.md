# The command palette and keyboard shortcuts

> One shortcut table, one key listener, one ranked list of commands and credentials — and
> deliberately no way to copy a password from any of it. Current reference. Implemented by
> `src/renderer/src/commands/`.
>
> **Status: built, tested and mounted.** `App.tsx` renders `<CommandsProvider />` outside the
> screen switch, so the key listener is global and survives a navigation. `palette.open` and
> `help.shortcuts` also arrive from the native menu through
> `src/renderer/src/shell/menu-bridge.ts`. Two commands still need handlers only their owning
> views can supply. See §8.

---

## 1. One registry, because the copies fail silently

There is one list of shortcuts in Keyhold — `SHORTCUTS` in `shortcut-registry.ts` — and four
things read it: the key handler that matches an event, the help sheet that draws it, the
palette that reads its own entry out of it for a hint, and the conflict guard that proves no
two entries claim the same combination.

Hard rule 8 exists for this exact shape. Three copies of "Ctrl+K opens the palette" is what
the file prevents, and the way the copies fail is invisible: the handler keeps working while
the help screen quietly tells the user about a shortcut that was renamed a year ago. Nothing
can fail when a label lies.

The same rule runs one level down and one level up:

- **A combination is data, not a string.** `KeyCombo` is `{ key, mod, shift, alt }`, and a
  combination written as a comparison in a `keydown` handler _and_ again as `"Ctrl+K"` in a
  help table is the same two-list problem.
- **A command does not restate its key.** `CommandDefinition` names a `shortcutId` and the
  label is read out of the shortcut table.
- **A section heading is derived from scope**, so the help sheet's grouping cannot disagree
  with when a shortcut actually fires — one field, two readers, rather than a `category`
  string alongside it.
- **`ShortcutId` is a spelled-out union**, not inferred from the table, so a command
  referring to an id that does not exist is a compile error at the reference rather than a
  runtime `undefined` when the help sheet tries to draw it.

### `mod`, not `ctrl` and `meta`

One abstract accelerator flag, resolved at match time from the platform the main process
reports: Command on macOS, Control everywhere else. Storing both would mean every table entry
appearing twice, once per platform.

The _other_ modifier is then required to be **absent**. On macOS, Control+Command+K must not
fire Command+K: a handler that ignores the modifiers it did not ask about fires on a superset
of what the user pressed, which is how a shortcut steals a combination belonging to the OS.

`normaliseKey` lower-cases single characters only, on length rather than a list of names, so
`Escape` does not become `escape` and stop matching while a key nobody thought of still
behaves. Shift is compared separately, which is why the character is folded rather than
trusted: Shift+A reports `key === 'A'`, and a table entry written as `a` with `shift: true`
must still match it.

---

## 2. The three booleans, and why each defaults to `false`

Each answers a distinct question about _when_ a shortcut may fire, and each defaults to the
safe answer so a new entry has to argue for its exception.

| Flag           | Fires while…                                    | Why the default is `false`                                                                                                             |
| -------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `whenLocked`   | the vault is locked                             | A locked vault is supposed to be locked. A shortcut reaching vault state through a closed door is a bug with a keyboard in front of it |
| `whileTyping`  | a text field has focus                          | Someone typing a password must not trigger "move to trash" because the password contained the bound letter                             |
| `whileOverlay` | a modal, confirm, palette or help sheet is open | An overlay owns the keyboard; a background shortcut firing underneath acts on a view the user cannot see                               |

`whileTyping` is the one with the worst failure mode, and `text-entry.ts` is its guard. Its
type list is a list of what is **not** text — `button`, `checkbox`, `color`, `file`, `hidden`,
`image`, `radio`, `range`, `reset`, `submit` — rather than an allow-list of text types.
Enumerating the text types would mean the predicate silently returning `false` for every input
type added to HTML after it was written, which is the wrong way round: an unknown input type
is far more likely to be a text field than a button, and being wrong in that direction only
costs a shortcut that did not fire.

`<select>` counts as text entry. It takes no free text, but it consumes single letters as
type-ahead, and a shortcut stealing a keystroke there is the same class of surprise.
`contentEditable` is read through `isContentEditable` where the DOM offers it and through the
attribute otherwise, because jsdom does not implement the property — and a guard that silently
degrades to "nothing is editable" under test is a guard whose tests prove nothing.

### The gate is a pure function

`canFire(shortcut, env)` is split out of the `keydown` hook deliberately: everything deciding
whether a _destructive_ shortcut runs lives in code with no DOM, no React and no store, so the
whole truth table is asserted directly rather than driven through a synthetic key event and
inferred from whether a spy was called.

The order — locked, then overlay, then typing, then scope — is deliberate, and reads as _a
locked vault beats everything else_, which is the sentence the security posture actually
claims. Every gate is a plain `&&` of a flag the table states explicitly, so a reviewer
reading a table row can tell exactly when that row fires without reading the gate at all. That
is what makes the table trustworthy.

### Three scopes

`global` is always live. `list` needs a record selected; `editor` needs the editor open, and
`activeScopes` puts **at most one of those two** in play: while the editor is open, the list's
destructive shortcuts are aimed at a record the user is in the middle of changing.

---

## 3. There is deliberately no "copy password" command

The shortcut table has a `credential.copyPassword` binding. The **command registry does
not**, and that asymmetry is the single most important decision in this directory.

A shortcut is aimed at a record the user has already selected and is looking at. The palette
is a **search surface** over titles and usernames, where the highlighted row changes as you
type. Putting a secret-copying action behind a fuzzy text match — where the wrong row can be
highlighted at the moment Enter is pressed — is how a password ends up on the clipboard for a
record the user never meant.

**The palette navigates and triggers; it does not read.** There is no reveal path in
`palette-search.ts`, and there must never be one. A credential item carries the
`CredentialProjection` the renderer already holds — title, username, email — and the palette
renders exactly those.

The recents store follows from the same posture:

**It is in memory, and it is cleared on lock.** A persisted "recently used" list is a
plaintext record of somebody's accounts sitting outside the encrypted file. Nothing about the
vault's crypto helps if `localStorage` holds `credential:…` keys for the bank, the employer
and the dating site — an attacker with the disk gets the shape of a life without ever touching
the KEEP. So the store never writes anywhere: no `localStorage`, no disk, no IPC. It is a
variable, and a variable dies with the window. Locking clears it for the same reason
`ClearToastsOnLock` exists: a palette still listing "Go to Chase Bank" over an unlock screen
has broken the promise a lock makes.

The clear is driven by a **subscription** to the session store rather than an effect comparing
render to render, because an effect body that calls `setState` cascades a render on every
session tick.

Entries are the opaque `command:…` / `credential:…` keys, never the objects, so a remembered
command whose handler has since unmounted, or a record that has been trashed, resolves to
nothing and silently drops out — instead of being a row that throws when someone presses
Enter on it. `MAX_RECENTS` is 6, small on purpose: recents sit above the full command list in
an empty palette, and a dozen of them would push every command below the fold and make the
palette worse at the thing it is named after.

---

## 4. Commands are data, and behaviour arrives at mount

A `CommandDefinition` carries no `run`, no closure and no store reference. The list is
therefore importable from a test, renderable without an app around it, and diffable when
someone adds a command. `resolveCommands` supplies behaviour separately, at mount, from
whoever actually owns the state a command touches.

Eleven commands across four sections — `Vault`, `Navigate`, `Record`, `Help`. Two fields
worth naming:

- **`keywords`** — words a user might reach for that are not in the title: "close" for lock,
  "delete" for trash, "clone" for duplicate. These are the difference between a palette that
  feels like it read your mind and one that only works if you already know what the command is
  called.
- **`destructive`** — marked so the palette can **label** it rather than colour it. WCAG 1.4.1:
  never colour alone, and the row is a text row, so a red tint would be the only signal.

`requiresSelection` hides a command that cannot act, because a command that cannot act is
noise.

`CommandsProvider` derives most handlers straight from the two stores — the stores are the
public API for those actions, and reaching around them would be a second way to trash a
record. Two are not derivable: focusing the search box and collapsing the sidebar are owned by
the views that render them, so they arrive as optional props. **A handler that is not supplied
is not bound, the shortcut is not listed on the help sheet, and the key is left alone for the
browser.** Nothing is ever advertised and dead.

It is one component, mounted once, high enough in the tree to survive a screen change — the
same reason `ClearToastsOnLock` is a component. Screens unmount as the session moves between
welcome, unlock and vault, and a `keydown` listener that unmounts with them is a shortcut that
works only on some screens for reasons nobody can see.

---

## 5. One ranked list, on the vault's own search engine

The palette searches commands and credentials **at once**, because that is the question a user
is actually asking: "github" is either the record or nothing, "lock" is either the command or
nothing, and making them choose a mode first is making them do the disambiguation the computer
is better at. Two side-by-side lists would need an invented interleave rule; one list needs a
shared score.

So `command-match.ts` scores commands on `@shared/search`'s own scale. It is an **adapter, not
a second matcher**: the query language (`parseQuery`), the text normalisation (`foldText`) and
the scoring weights all come from there. What is here is only the mapping:

| Command surface | Engine field | Why                                             |
| --------------- | ------------ | ----------------------------------------------- |
| `title`         | `title`      | The name of the thing, same as a record's title |
| `keywords`      | `tag`        | Alternative names the user might reach for      |
| `section`       | `folder`     | Where it lives. Weakest, same as a record's     |

The alternative — giving every command a synthetic `CredentialProjection` and running
`matchCredential` unchanged — was considered and rejected. It reuses more code and produces
wrong answers: the engine's flag predicates would be asked whether a command `has:password` or
`is:untagged`, and the honest answer for a menu item is neither true nor false — `is:untagged`
would have returned every command in the app. Fabricating twenty fields of a security-boundary
type to get three of them is also exactly the sort of thing that later reads as "commands are
credentials".

Because the scale is shared, a command hit and a credential hit are directly comparable.
Credentials are capped at `MAX_CREDENTIAL_RESULTS` (25) — the palette is a "jump to the thing
I am thinking of" surface, not a browser, and past a couple of dozen rows a user reaches for
the real list while rendering the rest costs a frame on every keystroke. Commands are never
capped.

### Two shapes of result list

**Nothing typed** — the question is "what can I do?", the list is short, and the structure is
the answer: Recent, then Vault, Navigate, Record, Help, as headed groups. Recents keep the
order the search put them in — most recent first — rather than being re-sorted, because
re-sorting would make "recent" mean nothing.

**Something typed** — the question is "where is this?", so one flat ranked list. Grouping here
would fight the ranking: the best match would sit under whichever heading it belongs to rather
than at the top, and the user would have to scan every group to find it. The heading says how
many, which is the only thing they still need to know.

`list-navigation.ts` handles the highlight, and **the list wraps**: Down from the last row
returns to the first. In a palette that is right — the list is short and the user is holding a
key, and stopping dead at the bottom reads as the palette having frozen. (A long document list
is the opposite case and should clamp, which is why this is a named function rather than a
rule assumed everywhere.) `current` is clamped rather than trusted, because it is derived from
a search that has just re-run and can point past the end of a list that shrank on the last
keystroke — an out-of-range index highlights nothing and makes Enter do nothing, with no
visible cause.

---

## 6. The listener: one, on `window`, in the bubble phase, reading a ref

**One `keydown` listener**, reading `SHORTCUTS` and nothing else. There is no second place in
the app where a key is compared against a string.

**Removed on unmount**, and worth stating because getting it wrong is invisible: a `keydown`
on `window` that outlives its component keeps firing forever against a closure holding a store
and a handler from a tree that no longer exists. It survives every navigation, accumulates one
copy per mount, and the symptom is a shortcut that runs twice, then three times.

**The environment lives in a ref.** The listener is registered once, not once per render.
Handlers are inline closures over component state and change identity every render, so
depending on them would add and remove a `window` listener on every keystroke typed into the
search box.

**Bubble phase, not capture.** An overlay that has already handled a key stops the event —
`Modal.tsx` does exactly this for Escape, so Escape closes the topmost dialog and nothing
else. A capture-phase listener on `window` would see the key _first_ and run the app-level
shortcut before the dialog got the chance to say it had handled it.

`ShortcutHandler` is declared in `use-shortcuts.ts` rather than imported from the command
registry, even though it is identical to `CommandHandler` on purpose — one action is bound to
both a palette row and a key and the two must be the same function. The shortcut system does
not otherwise depend on the palette and should not start: the key listener works in an app
with no palette in it.

### The platform is fetched once, ever

`getPlatform()` is a promise across IPC, and calling it per render — or per shortcut label —
would be a round trip to draw a `⌘`. It is fetched once into `palette-store.ts`, and
`loadPlatform` is idempotent so a second mount is free.

It starts `null`, and the UI renders **no shortcut label at all** until it resolves, rather
than defaulting to `win32` and showing a Mac user `Ctrl+K` for the frame before the answer
lands. A missing hint is a cosmetic gap; a wrong hint is a lie about a key that does not work,
and the user has no way to know which one they were shown.

Opening the help sheet closes the palette: two stacked native dialogs both take the top layer,
and the one underneath is inert but still painted, which reads as a rendering bug.

---

## 7. Accessibility notes

- **`role="group"` inside the listbox**, one `aria-labelledby` per heading. `palette-groups.ts`
  produces the shape; the DOM consequence is the component's business.
- **Destructive commands are labelled, not tinted** — see §4.
- **Every command in the palette is reachable by keyboard by construction**, since the palette
  is a keyboard surface. The shortcuts sheet is the discoverability path, and it is one of only
  two shortcuts that fire while the vault is locked, because a list of key names discloses
  nothing about the vault and is the one thing a confused user reaches for.

---

## 8. Not built yet

- **Two handlers have no owner yet.** `focusSearch` and `toggleSidebar` are optional props;
  `App.tsx` mounts `CommandsProvider` with neither, because both belong to the vault screen's
  own state and are wired when that screen owns them. Their shortcuts and commands stay
  unbound and unlisted until it does. `menu-bridge.ts` deliberately does not route them
  either — a global listener reaching across the app into a component's state is how every
  feature ends up having to register itself with it.
- **The setting.** `CommandsProvider` takes `enabled`, defaulting to on, so hard rule 7's
  preference has somewhere to land the moment something reads the settings snapshot for it.
  The mount in `App.tsx` passes no `enabled`, so the palette cannot currently be turned off.
- **User-rebindable shortcuts.** The table is fixed. `findShortcutConflicts` exists and is
  tested, which is most of what a rebinding UI would need, but nothing rebinds anything.
- **The image lightbox**, the other unbuilt item in Phase 15, which wants attachments first.

---

## 9. Tests

160 in `src/renderer/src/commands/`.

| File                        | Tests | Covers                                                                                                                        |
| --------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| `text-entry.test.ts`        | 28    | The whole "is the user typing?" truth table, including `select`, `contentEditable` under jsdom, and every non-text input type |
| `shortcut-registry.test.ts` | 21    | That no two entries claim one combination · scope/label agreement · every id in the union appearing exactly once              |
| `key-combo.test.ts`         | 19    | `mod` resolution per platform, the absent-other-modifier rule, key folding, and formatting                                    |
| `palette-search.test.ts`    | 18    | One merged ranked list, the credential cap, and that only projection fields are carried                                       |
| `command-match.test.ts`     | 17    | The three-surface mapping and that scores are comparable with credential scores                                               |
| `shortcut-gate.test.ts`     | 15    | `canFire` in every combination of locked, overlay, typing and scope · `activeScopes` never returning both `list` and `editor` |
| `use-shortcuts.test.tsx`    | 13    | Listener registration and removal, the ref, and bubble-phase behaviour                                                        |
| `list-navigation.test.ts`   | 12    | Wrapping, the empty and single-row lists, and clamping a stale index                                                          |
| `recent-commands.test.ts`   | 9     | Ordering, uniqueness, the cap, and that lock clears it                                                                        |
| `palette-groups.test.ts`    | 8     | Both list shapes, and that recents keep their order                                                                           |

---

## 10. Related

- [`02-App-Chrome.md`](./02-App-Chrome.md) — the `Modal` whose Escape handling the bubble-phase listener depends on, and `ClearToastsOnLock`
- [`01-Layout-And-Components.md`](./01-Layout-And-Components.md) — the shell the provider has to sit above
- [`../05-Features/03-Search-Sort-Filter.md`](../05-Features/03-Search-Sort-Filter.md) — the query language, the scoring scale and the field weights this borrows
- [`../12-Roadmap/02-Decision-Log.md`](../12-Roadmap/02-Decision-Log.md) — D13, why no palette row may read a secret
