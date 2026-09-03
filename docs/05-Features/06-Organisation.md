# Folders and tags

> A folder tree that cannot form a cycle or orphan a record, a tag system where a rename
> rewrites every record that carries it, and a sidebar whose every drag has a keyboard
> equivalent. Current reference. Implemented by `src/main/organisation/` and
> `src/renderer/src/organisation/`.
>
> **Status: the operations engine and the sidebar are both built and tested — 96 tests in
> the main process, 18 for the renderer's tree model. Neither half is connected to the
> other.** There are no `kh:organisation:*` entries in `CHANNELS`, `VaultService` composes
> none of these operations, and `OrganisationSidebar` is not mounted in `App.tsx`. The
> sidebar's read-only surfaces would work today; every mutation reports that the vault cannot
> answer. See §9, which also records **two places where the two halves currently disagree.**

---

## 1. Deleting a folder: the caller must choose, because both answers are reasonable

`deleteFolder(document, folderId, policy)` has **no default policy**, and that is the point.
Picking one silently is how records end up orphaned in a way that reads as a UI glitch rather
than as data loss.

| Policy       | The folder | Its subfolders                   | Its records                                   |
| ------------ | ---------- | -------------------------------- | --------------------------------------------- |
| `'reparent'` | Removed    | Rise to where it was             | Rise to where it was                          |
| `'unfile'`   | Removed    | **The whole subtree is removed** | Every record anywhere beneath becomes unfiled |

Neither policy deletes a record. A record is only ever removed by `credential-ops`, through
the Trash, with a tombstone — folder deletion is not a route around that. The records under
`'unfile'` survive, unfiled, still in the vault, still in search, still in `is:unfiled`.

The failure this guards against is the one that looks like nothing happened: a folder removed
while its records keep pointing at its id, leaving them filed nowhere, absent from every
folder view, and reachable only by search. That is data loss wearing a UI glitch's clothes,
and it is why the policy is a required argument.

---

## 2. The cycle guards, and why every walk has one

Folder parentage arrives from a file that may have been merged from two devices, imported,
restored from a partial backup, or hand-edited. A cycle in it is a **real state**, not a
hypothetical — the merge engine's own `folder-cycle-broken` note exists because two devices
reparenting each other's folders produces one. A walk without a `seen` set spins forever with
the UI thread inside it, and the symptom is a window that stops responding while the user's
data is perfectly fine. A malformed vault must render badly, never hang.

There are three separate guards, each doing a different job:

**`moveFolder` refuses to create one.** A folder moved into its own descendant detaches that
whole subtree: still in the array, still holding records, unreachable from any root — so it
vanishes from the sidebar and its records vanish with it, while the file says nothing is
wrong. The refusal is explicit and typed rather than a silent no-op, because a drag that
appears to do nothing is a bug report nobody can write. Self-parenting is the degenerate case
of the same check: `collectDescendantFolderIds` includes the root it was asked about, so
`move(x, x)` is caught by the same line.

**`walkAncestors` survives one.** It returns how the walk ended — `'root'`, `'missing-parent'`
or `'cycle'` — as part of the answer rather than as an exception, because both failure modes
are states a real vault can be in and every caller wants to handle them differently: the depth
check treats what it got as a lower bound (the conservative direction), `folderPath` refuses
outright rather than returning a partial path that is a confident lie about where a folder
lives, and `checkOrganisation` names the folders involved.

**`buildFolderTree` renders one anyway.** In the renderer, a broken folder is still drawn —
promoted to the top level and flagged with a `FolderAttachment` of `'missing-parent'` or
`'cycle'` — and every problem is reported for the UI to surface. Nothing is repaired. Render
what you can, say what is wrong, never hang. `MAX_RENDER_DEPTH` (64) is a stack guard rather
than a product limit: recursion thousands deep would throw a `RangeError` mid-render and blank
the sidebar.

The depth check in `moveFolder` measures the **subtree being carried**, not just the folder
being dragged. Dropping a three-level branch one level below the limit is the case a naive
check waves through and only a user with a broken sidebar ever discovers.

---

## 3. `findOrCreateFolderPath` is what the import commit stage needs

A parser emits `import-folder:Work/Clients` placeholders, and this is the one function that
turns them into real ids. Three properties matter, and each is a bug someone has shipped
before:

1. **Reuse, do not duplicate.** `Work/Clients` and `Work/Suppliers` in one import must produce
   one `Work`, and an import run twice must not double the tree.
2. **Match case-insensitively, but never rewrite the existing name.** A vault with `Work` and
   an export with `work` mean the same folder, and the vault's spelling wins — silently
   recasing a folder the user named is an edit they did not ask for.
3. **Ancestors first, in order.** `A/B/C` creates `A`, then `A/B`, then `A/B/C`, so the tree is
   well-formed at every step and sibling ordering follows the path rather than whatever the
   parser emitted first.

A path that names nothing returns `folder: null` and the document untouched, which is the
correct answer for a source row with an empty group column: the caller files the record at the
root rather than inventing a folder called nothing.

`findOrCreateFolderPaths` does a whole import in one pass and sorts the paths before creating
them, so sibling order is the source's alphabetical order rather than row order — which is what
makes two imports of the same data produce the same tree, and therefore what makes an import
diffable and a dry-run meaningful. It returns every path it touched **including the ancestors
created along the way**, because a parser emits a placeholder for `Work` as readily as for
`Work/Clients`, and the commit stage rewriting record ids needs both to resolve.

Where duplicate siblings already exist, the lowest `(order, id)` wins, so an import run twice
against a vault that already has duplicates keeps resolving to the same folder.

### The separator ban is load-bearing

A folder name may not contain `/` or `\`. `folderPath` and `findFolderByPath` are inverses of
each other and stay inverses only while that holds: a folder called `Work/Clients` would
produce a path indistinguishable from two nested folders, and the import commit stage would
then file records under a folder that does not exist. Control characters are banned for the
reason they are banned everywhere in this codebase — a NUL in a name is never a name, it is
someone probing a parser.

Normalisation is **trimming and nothing else**. No case folding, no whitespace collapsing, no
character substitution: the name is the user's, and an operation that quietly rewrites it is
editing their data. Trimming is the exception because a trailing space is invisible and would
make two identical-looking folders resolve differently by path.

---

## 4. A record stores a tag's _name_, so a rename has to rewrite records

`Credential.tags` is typed `readonly string[]` and says nothing either way, so it is worth
stating plainly. Three parts of the codebase already assume names: `normaliseTags` trims and
case-folds them (an id needs neither), every import parser feeds raw label text straight into
`NewCredentialInput.tags`, and the exporter's tag scoping matches `record.tags` against
`tag.name.toLowerCase()`.

The consequence is why `tag-ops.ts` exists: **renaming a tag must rewrite every record that
carries it.** A rename that only edits the `Tag` entry leaves every record pointing at a name
nothing answers to — the tag vanishes from the sidebar count, from `tag:` searches and from
the export, while still sitting in the records. That is the classic version of this bug.

The `Tag` entry still has an id. It identifies the _entry_ — the thing that owns a colour and
a sidebar row — so a rename preserves the colour and the id, and only the strings on records
move.

Comparison is on `tagKey`: trimmed and lower-cased, exactly what `normaliseTags` does inline
when it deduplicates. `Work` and `work` typed a week apart are one tag to everybody except a
string comparison, and two chips that look identical and filter differently is the worst of
both. `tag-ops.test.ts` asserts the two agree on every case it can think of rather than
trusting that they do.

### Duplicate sibling folder names are allowed

That is a decision, not an oversight. A folder's identity is its id; the name is a label, and
paths are a convenience derived from it. Enforcing uniqueness would make three things that
must never fail start failing: a merge bringing in a same-named folder from another device, a
restore from a backup written before a rename, and an import whose source tree happens to
collide. The alternative — inventing `Work (2)` — puts a name in the user's vault that they
never chose and cannot easily find again.

So the conflict is surfaced instead of prevented: `siblingNameConflict` lets a UI warn before
it commits, `checkOrganisation` reports existing duplicates, and `findFolderByPath` resolves
them deterministically.

### The limits

| Limit                          | Value  | Why there                                                                                                                                    |
| ------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_FOLDER_NAME_LENGTH`       | 200    | Already far past readable in a tree; stops a pasted paragraph breaking every derived path                                                    |
| `MAX_FOLDER_DEPTH`             | 16     | Real exports essentially never pass five; depth makes tree walks super-linear and indentation unusable. Past this the honest answer is a tag |
| `MAX_FOLDERS`                  | 2,000  | The whole tree renders in the sidebar and every operation is at least linear in it                                                           |
| `MAX_TAG_NAME_LENGTH`          | 100    | A tag is a chip                                                                                                                              |
| `MAX_TAGS`                     | 500    | The sidebar renders every tag; `credential-ops` already caps one record at 64                                                                |
| `MAX_RENDER_DEPTH` (renderer)  | 64     | A stack guard, not a product limit                                                                                                           |
| `MAX_PERSISTED_IDS` (renderer) | 10,000 | So a pathological tree cannot grow the `localStorage` entry into quota errors                                                                |

---

## 5. Integrity is reported and never repaired

`checkOrganisation` finds seven kinds, all of which are what a vault actually looks like after
a merge, a partial restore, or an import that committed records before its folders:

| Kind                        | What it means                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `record-missing-folder`     | The record is filed nowhere and shows nowhere                                          |
| `folder-missing-parent`     | The subtree is unreachable from any root                                               |
| `folder-cycle`              | Unreachable from any root, and it hangs any walk without a guard                       |
| `record-missing-tag`        | A tag name with no `Tag` entry: no colour, no sidebar row                              |
| `duplicate-folder-name`     | Allowed, but the paths are ambiguous                                                   |
| `duplicate-tag-name`        | Two rows, two colours, one set of records                                              |
| `import-placeholder-folder` | An `import-folder:` placeholder reached the vault — a commit stage that did not finish |

Nothing is fixed, for the same reason `src/main/recovery/` fixes nothing: reparenting an
orphan or clearing a dangling `folderId` takes one line and destroys the only evidence of
which of three causes produced it. The three want three different responses, and after a
silent repair they are indistinguishable. `integrity.test.ts` asserts both halves — the issue
fires, and the document comes back untouched.

**Messages carry ids and counts only**, like `ImportWarning`. Names are the finding itself for
the two duplicate checks, so they travel in a dedicated `name` field the caller can choose to
render, never interpolated into the message text — which is exactly what lets
`src/main/recovery/document-diagnosis.ts` carry these findings into a shareable report by
dropping one field.

---

## 6. Every drag has a keyboard equivalent, and the menu is the primary path

Drag-and-drop is a mouse gesture with no keyboard equivalent, and a folder tree whose only way
to refile a record is to drag it is unusable for anyone navigating by keyboard. WCAG 2.2 says
so twice: **2.1.1** (everything reachable by keyboard) and **2.5.7 Dragging Movements** (any
drag action needs a single-pointer alternative).

So `MoveToDialog` is not a convenience bolted on later — it is the primary path and the drag
is the shortcut. It is also the only way to see every destination at once, the only way to
move something into a folder scrolled off screen, and the only way that works on a trackpad
without a steady hand. A radio group rather than a `<select>`, because the options carry a
hierarchy that indentation has to show and a native select can neither render that nor say
"you are here" beside the current parent.

`move-targets.ts` builds both destination lists from the **same tree the sidebar renders**, so
the menu can never offer a destination the tree does not show, and it excludes a folder's own
descendants using the same `collectDescendantFolderIds` the main-process cycle check uses.

`tree-keyboard.ts` implements the full WAI-ARIA tree pattern as a pure function over the flat
list of visible rows, because getting it half right is worse than not claiming `role="tree"`
at all — a screen reader announces "tree item, level 2, expanded" and the user then presses
Left expecting to collapse:

| Key           | Action                                                                 |
| ------------- | ---------------------------------------------------------------------- |
| Down / Up     | The next / previous **visible** row; collapsed children are skipped    |
| Right         | Expand a collapsed parent; on an expanded one, move to its first child |
| Left          | Collapse an expanded parent; otherwise move to the parent row          |
| Home / End    | First / last visible row                                               |
| Enter / Space | Select                                                                 |
| `*`           | Expand every sibling of the focused row                                |

Keys outside that set are left alone, so Tab, typing into a rename field and the app's own
shortcuts still work. Focus is roving — exactly one row carries `tabIndex=0` — so Tab moves
past the whole tree in one press rather than through every folder.

### The drag kind is in the MIME type, not in the data

During `dragover` — the event that decides whether a drop is allowed at all — the browser
refuses to hand over the dragged data; only `dataTransfer.types` is readable, in "protected
mode", so a page cannot read a file's contents just because a cursor passed over it. A drop
target that calls `getData()` in `dragover` gets an empty string and either rejects every drop
or accepts every drop, **including a file dragged in from the desktop**.

So the kind lives in the MIME type (`application/x-keyhold-credential-id`,
`application/x-keyhold-folder-id`), where `dragover` can see it, and the id lives in the data,
read once in `drop`. The types are namespaced to Keyhold so a drag from another application
can never be mistaken for a record. A folder wins if both are somehow present, because a
folder move restructures the tree and an ambiguous drag should not silently refile a record.

**Only an id is ever put on a drag** — already in the safe projection. A drag payload is
readable by any drop target in the window and is the sort of channel that quietly becomes a
leak.

---

## 7. Smart views are data, and colour is never the information

The six saved views at the top of the sidebar — `all`, `favourites`, `recent`, `untagged`,
`unfiled`, `trash` — are one array of `FilterOptions` + query text + sort, not a `switch`
inside a component. Written as branches, "Favourites" and "Trash" would be two paths that
drift, counts would be computed a third way, and adding "Expiring soon" would mean editing
three files.

Two fields are deliberately not `FilterOptions`: `queryText`, because `is:untagged` has no
structured equivalent and inventing a second "has no tags" predicate would be a second
matcher; and `usedOnly`, because "Recently used" is a sort plus "has ever been used" and
`FilterOptions` has no predicate over `meta.lastUsedAt`. Adding one belongs in
`@shared/search`, which this module does not own.

"Recently used" shows 25 and carries **no count**, because it is a capped ordered window
rather than a set: a number beside it would either be the cap (meaningless) or the whole vault
(misleading).

Rows differ by icon and by text, **never by colour** (WCAG 1.4.1), and a tag's colour swatch
is `aria-hidden` decoration — the tag's _name_ is what identifies it, everywhere, for
everyone.

---

## 8. State: the tree is derived, expansion is per vault, and mutations re-read

**The tree is never stored.** `folders` is the flat list the vault gave us and `tree` is
`buildFolderTree(folders)`, recomputed whenever that list changes. Storing both and updating
them separately is how a tree ends up describing folders that are no longer there — and this
tree in particular has to survive cycles, so it must never be a stale copy.

**Every mutation returns the whole snapshot**, not a patch and not a boolean, and the store
adopts it wholesale. The main process is the source of truth for folder order and parentage —
it renormalises sibling `order` on every write — so a renderer predicting the result locally
would render an order the file does not have, and the difference would only show up after a
reload.

**Expansion is remembered per vault**, keyed on `VaultSummary.vaultId`. Two vaults on one
machine have entirely different trees, so a shared expansion set would mean opening the second
vault expands ids that mean nothing in it — and would leak a little structure between vaults.
`localStorage` is treated as hostile throughout: it can be absent, throw on read, or contain
anything at all, and a corrupt or missing value must mean **collapsed**, never a crash. Nothing
secret is stored; folder ids are already in the safe projection.

**The renderer never validates on the vault's behalf.** Blank names, cycles and depth limits
are checked in `ipc-gateway.ts` only for immediate feedback. The main process must check them
again and is the only authority — a renderer is a semi-trusted zone (decision D13) and a
UI-side check is a courtesy, never a guarantee.

---

## 9. Not built yet — and two disagreements to settle first

### Not connected

- **The IPC channels.** There are no `kh:organisation:*` entries in `CHANNELS`.
  `ipc-gateway.ts` names the nine it expects: `list`, `create-folder`, `rename-folder`,
  `move-folder`, `delete-folder`, `create-tag`, `rename-tag`, `set-tag-colour`, `delete-tag`.
  Filing a record needs no new channel — `kh:credentials:update` already accepts `folderId`.
- **`VaultService` composes none of these operations.** The main-process functions are pure
  over a document and nothing calls them on the open vault.
- **`OrganisationSidebar` is not mounted.** `App.tsx` renders `ClearToastsOnLock` and the
  screen switch, and nothing else. The sidebar was written against the `OrganisationGateway`
  interface precisely so it would not block on the bridge: `fake-gateway.ts` binds it to an
  in-memory vault for the tests, `ipc-gateway.ts` probes for the real bridge at call time, and
  it lights up on its own the moment the channels land.
- **Favourites, and the query-bar UI** (roadmap Phase 7).

### Two places where the two halves currently disagree

Both are real mismatches in the code, recorded here rather than fixed, because the fix belongs
with whoever writes the IPC layer.

**The folder-delete policy.** `src/main/organisation/folder-ops.ts` declares
`FOLDER_DELETE_POLICIES = ['reparent', 'unfile']`, where `'unfile'` deletes the **whole
subtree** and unfiles every record beneath it.
`src/renderer/src/organisation/gateway.ts` declares
`FOLDER_DELETION_POLICIES = ['reparent', 'unfile-records']` and states that "in **both**
policies, subfolders are reparented rather than deleted". The value names differ and the
semantics differ. A `delete-folder` channel wired today would either reject the renderer's
string or delete a subtree the dialog promised to keep.

**The tag colour vocabulary.** Two constants share the name `TAG_COLOUR_TOKENS` and do not
share their members:

|         | `src/main/organisation/tag-colours.ts`                         | `src/renderer/src/organisation/tag-colours.ts`              |
| ------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| Values  | `text-muted`, `text-subtle`, `border-strong`, `info`, `accent` | `neutral`, `accent`, `info`, `success`, `warning`, `danger` |
| Default | `text-muted`                                                   | `neutral`                                                   |

The main-process file argues explicitly _against_ the status tokens the renderer offers:
`success`, `warning` and `danger` carry meaning — they are the health dashboard's signal for
weak, expiring and breached — and a vault where tags are also red and green is a vault where
the real warnings stop reading as warnings. `isTagColour` in the main process would reject
four of the renderer's six, and `neutral` is not a `ColourToken` at all. Both files
independently record that the right long-term answer is a dedicated `--kh-color-tag-*` family
in `tokens.ts`, each with its own contrast requirement, so the existing guard would cover them
for free.

### Duplication that is deliberate, and one that is not

`compareSiblings` in `src/main/organisation/folder-tree.ts` and `compareFolderSiblings` in the
renderer's `folder-tree-model.ts` are the same two-line ordering rule (`order`, then id — the
id tie-break is what makes it total, so two siblings sharing an `order` after a merge do not
appear to jump around on their own). That duplication is currently unavoidable: the renderer
is forbidden from importing `@main/*` by an ESLint `no-restricted-imports` rule, because that
is where the keys live. The right fix is to move the rule into a renderer-safe shared module.

`collectDescendantFolderIds` is **not** duplicated — it lives in `@shared/search/filter.ts`
and both halves import it. `folder-tree-model.test.ts` asserts the ordered layout it builds and
that set agree on every well-formed tree, so they cannot drift apart.

---

## 10. Tests

96 in `src/main/organisation/`, plus 18 for the renderer's tree model.

| File                                   | Tests | Covers                                                                                                                                                                           |
| -------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `folder-ops.test.ts`                   | 47    | Name validation and the separator ban · depth and count limits · the cycle refusal including self-parenting · both delete policies · `findOrCreateFolderPath`'s three properties |
| `tag-ops.test.ts`                      | 29    | That a rename rewrites records · `tagKey` agreeing with `normaliseTags` · merge, colour and limits                                                                               |
| `integrity.test.ts`                    | 14    | Each of the seven kinds, that a healthy document reports nothing, and that the document comes back untouched                                                                     |
| `tag-colours.test.ts`                  | 6     | That the palette is a subset of `ColourToken` and that `isTagColour` is the only door in                                                                                         |
| `folder-tree-model.test.ts` (renderer) | 18    | Broken folders still rendered and flagged · agreement with `collectDescendantFolderIds` · the visible/collapsed projection                                                       |

---

## 11. Related

- [`03-Search-Sort-Filter.md`](./03-Search-Sort-Filter.md) — `collectDescendantFolderIds`, `is:unfiled`, `is:untagged`, and the ranked matcher the smart views compose with
- [`../07-Sync-And-Merge/00-Merge-Engine.md`](../07-Sync-And-Merge/00-Merge-Engine.md) — how folders and tags merge, and `repairFolderTree`, which is where most of these broken states come from
- [`../08-Diagnostics/00-Recovery-And-Diagnostics.md`](../08-Diagnostics/00-Recovery-And-Diagnostics.md) — how `checkOrganisation`'s findings reach a shareable report
- [`../09-Import-Export/00-Import-Formats.md`](../09-Import-Export/00-Import-Formats.md) — the `import-folder:` placeholders `findOrCreateFolderPaths` resolves
- [`../06-UI-Design-System/00-Tokens-And-Themes.md`](../06-UI-Design-System/00-Tokens-And-Themes.md) — the token vocabulary a tag colour must come from
