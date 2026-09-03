# The merge engine

> Two decrypted vault documents in, one merged document and a report out — with no clock, no
> key and no file anywhere in it. Current reference. Implemented by `src/main/sync/` and
> `src/shared/model/sync.ts`.
>
> **Status: the engine is built and tested, including five whole-engine properties. Nothing a
> user can reach exists.** There is no `kh:sync:*` channel in
> `CHANNELS`, no file watcher, no base-snapshot storage, no conflict-resolver UI, and no
> caller taking the mandatory pre-merge backup. `mergeDocuments` is currently called only by
> its own tests. See §11.

---

## 1. Clocks decide nothing, and that is the whole design

Last-write-wins is the obvious way to merge two records and it is a trap. Two machines'
clocks disagree — often by minutes, occasionally by years — and nothing in either file says
which is right. A device with a fast clock does not win once. It wins **every** conflict, on
**every** field, forever, silently. What the user sees is a vault that keeps reverting, and
no error anywhere.

So no function in `merge-values.ts` looks at a timestamp, and no timestamp anywhere in the
engine decides a value. Timestamps are still carried _through_ a merge — `createdAt`,
`updatedAt`, `passwordUpdatedAt`, `lastUsedAt` — but only by `min` and `max`, which are
commutative and cannot be gamed by a skewed clock into overwriting content, and only **after**
the content decision has already been made.

What replaces the clock is the ancestor. Where one side changed a field and the other did
not, the ancestor says so and there is nothing to decide. Where both changed it, the answer
is a conflict the user is shown. There is no third option in which the engine guesses.

---

## 2. Three-way where possible, two-way where not, and never a pretence about which

`mergeDocuments(base, ours, theirs, options)` takes the last state both devices agreed on as
`base`. With it, "one side changed this and the other did not" is answerable, and most of a
real merge answers itself. Without it, the only knowable fact is that two values differ.

|                                    | Three-way                       | Two-way           |
| ---------------------------------- | ------------------------------- | ----------------- |
| Can tell an edit from a stale copy | Yes                             | **No**            |
| A field that differs               | Resolved if only one side moved | Always a conflict |
| A record on one side only          | Kept, and reported              | Kept              |
| A version missing on one side      | Deleted there — honoured        | Kept (union)      |
| `MergeConflict.base`               | The ancestor's projected value  | Always `null`     |

A two-way merge is therefore noisier by design. `MergeReport.mode` surfaces which one ran,
because the two give genuinely different guarantees and the user is entitled to know which
they got.

Step 6 of the caller sequence — storing the merged document as the next base snapshot — is
what turns the _next_ merge from two-way into three-way. That is the difference between a
merge that mostly answers itself and one that asks about every field that differs.

---

## 3. Absence is not deletion, and the cost is written down

A record present in the ancestor and on one side only has two possible explanations: the
other device purged it, or the other device's copy is incomplete. The engine **keeps it**,
and emits a `record-kept-unmatched` note.

The trade is deliberate and it is not free.

- **What it costs.** A genuine purge — only reachable after a record has sat in the Trash
  past its retention window — can come back once, and the user has to purge it again.
- **What it buys.** No truncated file, no half-synced cloud folder and no
  restored-from-an-old-backup device can ever cause a credential to vanish.

Set against goal G1, _never lose a credential_, that is not a close call. A record is dropped
in exactly one situation: it is in the ancestor and gone from **both** sides, which is both
devices agreeing it was purged. That produces a `record-purged` note.

Deletion has a marker for precisely this reason.

### A duplicate id is refused, not resolved

The rule above is about a record that is present on one side. This one is about a document
that has gone wrong in a way the model cannot represent at all, and it fires **before**
anything is read.

`assertUniqueIds` walks records, folders and tags on all three inputs and throws a named
`DuplicateIdError` — carrying the side, the entity and every offending id, sorted — the moment
one list holds two entries under one id. That guard is what makes `indexRecords` safe: `new Map`
keeps the last entry for a repeated key, so without it the merge quietly discarded one of the
two before it had looked at either, and could take a second, unrelated record with it. That was
the behaviour until this landed (subsystem audit finding N3).

Two entries under one id is corruption, because identity is what every part of this engine
merges _by_. There are three honest responses and two of them cost the user something this one
does not.

| Response                   | What it costs                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep one, report the other | A lost credential with a note attached — and a note is not a password. Hard rule 6 has no "but we said so" clause                                                                                                                                                                                                                   |
| Keep both under fresh ids  | Minting an id needs a CSPRNG, so the engine stops being pure and its output stops being reproducible between the resolver loop's two passes; the new id is a _new record_ to the other device, so the duplicate propagates rather than resolving; and it severs the record from its ancestor, its history and its attachment chunks |
| **Refuse**                 | Nothing. The engine is pure and writes no file, so a refusal leaves both vaults exactly as they were, on disk, with every record still in them                                                                                                                                                                                      |

The user also has a repair path already: `document-diagnosis.ts` emits `duplicate-record-id`
for precisely this state, which means the codebase's answer to "what do I do about it" predates
this guard and is not merging. The error is **named** rather than bare so a dialog can say which
file, which list and which ids, and point at the diagnosis — asking a UI to pattern-match prose
is how a dialog ends up saying "merge failed". Nothing in it is secret material: an id is
already what `MergeNote.targetId` and the `duplicate-record-id` diagnostic carry.

The sides are checked ours, theirs, then base — the order the user can act on. A duplicate in
their own file is something they can repair now; one in the stored base snapshot is the least
alarming of the three and should not be the message they see when their own vault is the one
that needs work.

Custom fields, security questions and attachments are deliberately **not** checked here.
`assertValidCredential` already refuses a record with duplicate ids in those lists, and a
second copy of that rule would be the duplicate list hard rule 8 forbids.

This sits beside `assertSameDocumentVersion`, which refuses for the same shape of reason: a
merge is the one operation that reads two meanings of a thing at once and writes a single
answer, so doing it when the thing has two meanings on one side — or means two different things
across a schema version — is how a vault loses a password. Full rationale in decision D26.

---

## 4. The tombstone rules

`trashedAt` is the tombstone and it is the only thing in the model that can say "this was
deliberately removed". It is not merged as an ordinary field, because treating it as one
would put a deletion up for a vote it can lose.

| Ancestor       | Ours          | Theirs            | Result                                                   | Note                  |
| -------------- | ------------- | ----------------- | -------------------------------------------------------- | --------------------- |
| any            | `null`        | `null`            | live                                                     | —                     |
| any            | T             | T                 | trashed at T                                             | —                     |
| any            | T₁            | T₂ (both set)     | trashed at **max(T₁, T₂)**                               | —                     |
| live           | trashed       | live, edited      | **trashed**, carrying the merged fields, conflict raised | `tombstone-preserved` |
| live           | trashed       | live, untouched   | **trashed**, no conflict                                 | —                     |
| trashed at T   | T (untouched) | `null` (restored) | **live**, no conflict                                    | `record-restored`     |
| trashed at T   | T′ ≠ T        | `null`            | **trashed at T′**, conflict raised                       | `tombstone-preserved` |
| none (two-way) | trashed       | live              | **trashed**, conflict iff the content differs            | `tombstone-preserved` |

Three things this table encodes:

**A tombstone wins over a record that is merely present.** This is the one asymmetry in
`merge-record.ts` and it is deliberate: undoing an unwanted deletion is one click in the
Trash, while a record that quietly returns from the dead on every sync is a bug the user
cannot fix and, in a password manager, may not even notice.

**A tombstone does not discard the other side's edits.** Delete-versus-edit produces a record
that is trashed _and_ carries the merged fields, plus a `record-delete-vs-edit` conflict.
Restoring it from the Trash therefore recovers the newer content, not the state it was
deleted in.

**Two tombstones keep the later timestamp.** Trash retention measures from `trashedAt`, so
the later of the two gives the user the longer window to change their mind — and `Math.max`
is commutative, so no clock wins anything.

---

## 5. Per field, and three merge shapes

Merging is per **field**, never per record. A phone updating the password while a laptop
fixes the title is the ordinary case, and a whole-record resolution would make the user throw
one of those away to keep the other.

`FIELD_STRATEGY` in `merge-record.ts` is a `Record` over `VersionedField` — all fourteen —
rather than a `switch` with a default, so adding a field to `VersionedValues` stops the file
compiling until someone classifies it. A default branch would silently treat a new keyed list
as an opaque value, and the user would be asked to choose between two custom-field lists that
could have been merged.

The three shapes, all in `merge-values.ts`:

**`resolveValue` — a scalar.** Sides agree → done. Ours matches the ancestor → take theirs.
Theirs matches the ancestor → take ours. Both moved differently → **conflict**, and the
provisional value is ours. No ancestor → agree, else conflict.

**`mergeKeyedList` — custom fields, security questions, attachments.** Entry-level, so one
device adding "recovery code" and the other adding "account number" produces a record holding
both with no conflict at all. An entry on one side only: not in the ancestor → it was added,
keep it; in the ancestor and unchanged where it survives → the other side deleted it, honour
the delete; in the ancestor and _changed_ where it survives → delete-versus-edit, keep the
edit and flag a conflict, because deleting a custom field is a click while retyping a
recovery code is not; no ancestor at all → keep it.

**`mergeTagSet` — a record's tags.** The one field where a real three-way merge is possible
with no conflict at all, and worth the special case: tagging is what two devices diverge on
most. A tag survives if both sides have it, or if the side that has it _added_ it since the
ancestor. A tag in the ancestor that one side dropped is a removal, and removals are
honoured — which is what makes this a set merge rather than a union. A union would make
"remove this tag" impossible to sync, because the other device would put it straight back.
There is no conflict case: "one side added T while the other removed T" cannot happen, since
if we added it, it was not in the ancestor for them to remove.

### Equality is structural, not `JSON.stringify`

`stable-value.ts` sorts object keys before comparing. `versioning.ts` can use
`JSON.stringify` because it compares two values out of the _same_ record; a merge compares
values out of **two different files**, written by two different builds, possibly
round-tripped through an import parser that built its objects in a different order.
`{a:1,b:2}` and `{b:2,a:1}` are the same custom field, and reporting a conflict on a field
nobody touched — asking the user to choose between two identical values — is the bug that
avoids.

`canonical()` is called on passwords, notes, answers and custom values, so **its output
contains secrets**. It is used for equality, de-duplication and tie-breaking, all of which
stay inside the merge, and nothing in `@shared/model/sync.ts` has a field that could hold
one.

---

## 6. A conflict carries lengths, not values, and does not build its own projector

A merge conflict is by construction _two of the thing that differs_ — and for `password`,
`notes`, `securityQuestions` and `custom`, the thing that differs **is** secret material. A
conflict report that carried its values would put two passwords into a structure whose whole
purpose is to be rendered in a list and sent over IPC.

So `ConflictSide` is `DiffSide` — the history diff's own union, reused rather than
redeclared — plus `{ kind: 'absent' }`, which a merge needs and a history diff does not: "the
title was empty" and "there was no record" are different facts a UI must not render the same
way.

`conflict-projection.ts` **deliberately implements nothing**. The rule for "how does a
versioned value cross the bridge safely" already exists in `../history/diff-projection.ts`,
already tested and already fault-injected. A second implementation here would be a second
list under hard rule 8, and the way that fails is not a crash — it is one of the two copies
quietly gaining a case the other never got. So a conflict side is produced by handing the
value to `toDiffProjection` as a degenerate one-element diff and taking the `before` end of
it. Odd to read; impossible to get wrong. A new secret field classified in `credential.ts` is
inherited here for free.

`plainSide` is the separate door for values that cannot be credential material — a folder
name, a tag colour, a setting. It decides nothing; the caller asserts by choosing it, and the
no-secrets property test checks the assertion.

### Resolution never sends a value back

The resolver sends a **side**, not a value: `MergeOptions.resolutions` is a map from conflict
id to `'ours' | 'theirs'`, and the merge is simply re-run with the choice folded in. One
merge implementation, no second "apply resolutions" path to diverge from it, and no need for
a conflict's actual values ever to have crossed to the renderer. The values themselves are
revealed one at a time through the secret broker, exactly like a historic password.

`settle` only consults the map when the field is _still_ in conflict. A resolution map
outlives the merge it was collected for — the user resolves, an edit lands, the merge re-runs
— and applying a stale answer to a field that now has one obvious value would overwrite an
edit nobody was asked about.

### Conflict ids are independent of argument order

`record:<id>:field:password`, `record:<id>:trash`, `record:<id>:history:<property>`,
`folder:<id>:<property>`, `tag:<id>:<property>`, `setting:<key>`. Three things depend on
that: a resolver keeping the user's selections across a re-merge, `resolutions` being keyed
by them, and the commutativity test comparing two merges by conflict-id set. An id embedding
"ours" or a positional index would break all three silently — the resolver would simply stop
remembering.

---

## 7. Three resolution states, and what `'policy'` may and may not settle

`MergeResolution` is `'unresolved'` · `'user'` · `'policy'`. Flattening them would let an
unresolved conflict be saved as though it had been settled.

- **`'unresolved'`** — the merged document holds a **provisional** value (ours, so the
  document is complete and renderable while the user decides). `requiresResolution` is true
  whenever any conflict is in this state, and the caller must not write the vault.
- **`'user'`** — a choice was supplied in `resolutions`.
- **`'policy'`** — settled automatically, and only where one answer is strictly safer.

Policy never settles a credential field. A password is never chosen for the user. Where it
does apply, every rule points the same way — toward the answer that keeps more data or
reveals less:

| Setting (`SETTING_POLICY`) | Direction                                                          |
| -------------------------- | ------------------------------------------------------------------ |
| `historyEnabledByDefault`  | Off wins — recording history is a privacy decision                 |
| `historyMaxVersions`       | Larger cap wins; `null` is unlimited and largest                   |
| `auditPrivacyLevel`        | Less revealing wins — capture is irreversible and the file travels |
| `passwordAgeWarningDays`   | Earlier warning wins — being told sooner is a nag, later is a gap  |
| `trashRetentionDays`       | Longer retention wins; `null` is never-purge                       |

A test walks that table and asserts the implementation actually moves in the direction it
names, because a table nothing reads is a comment that lies.

The same reasoning governs the two per-record history settings, with one subtlety worth
recording: `history.enabled` is a **boolean**, so with an ancestor it can never conflict — if
ours differs from the base, theirs either matches the base (an ordinary edit) or matches ours
(both moved the same way). "Off wins" is therefore reachable only in two-way mode or on a
record created independently on both devices. `history.maxVersions` has an unbounded range,
so its larger-cap policy is reachable either way.

One conflict is marked `'policy'` for a different reason. Two records claiming the same
attachment chunk id with different metadata is effectively impossible — chunk ids are random
— but it is reported rather than swallowed, with our metadata kept. It is deliberately not
wired into `settle`, so marking it unresolved would block a merge that could never be made to
converge by answering it.

---

## 8. Merging two timelines without corrupting either

This is where a naive merge quietly ruins a record, because a version is a **backward
delta**: it stores what the record held _before_ a change, and a state is reconstructed by
walking back from the live record. A version is therefore only meaningful relative to the
lineage it belongs to. Two devices that both edited a record have two chains, each anchored
at its own present; interleaving them and walking back produces a state that existed on
neither device.

What `merge-history.ts` does about that:

**The common case is exact.** Two devices sharing an ancestor share its whole timeline.
De-duplicating by content collapses that shared prefix perfectly, and if only one side edited
the record, the merged chain is _identical to that side's_ — not approximate. That is the
overwhelming majority of real merges.

**The lossy case is exactly the case the user is already being told about.** When both sides
edited the record, the field merge raises a conflict anyway, and intermediate reconstructions
from before the merge point become approximate. Approximate history for a record whose
conflict you are actively resolving is a far smaller cost than throwing away one device's
audit trail — in an app whose headline feature is the audit trail.

**A version's identity deliberately excludes `versionNumber`.** The same edit can carry
different numbers on two devices, because an earlier merge renumbers. Identifying by number
would fail to de-duplicate the shared prefix and would double every entry on every sync. The
identity is the canonical encoding of `savedAt`, `changedFields`, `snapshot` and `origin` —
which **contains secret material**, and is a map key inside that module and nothing else.

**The ancestor is used for exactly one thing, and it is not ordering:** a version present in
the ancestor and absent from a side was _deleted_ there. That covers "Clear history", which
is a real user action with a privacy motive — a union would put every old password the user
just deleted straight back — and ordinary retention pruning, which is the same operation with
a different trigger. With no ancestor, the result is the union.

**Numbers are left alone unless two timelines were genuinely interleaved.** If the combined
sequence is exactly one side's array, that array is returned untouched, gaps and all.
Renumbering a timeline nobody interleaved would break `merge(x, x) === x` and would invalidate
every version number a user has written down. `history-renumbered` and `history-truncated`
notes say when it did happen and how many entries the retention cap then dropped.

Entries are never rewritten — only reordered, renumbered and pruned — so a snapshot cannot
acquire a key it did not have, which is the one violation that would let a restore write a
value the timeline never showed. `assertValidHistory` runs on every merged record.

---

## 9. Folders, tags and settings have no tombstone

That single fact is what every rule in `merge-collections.ts` follows from. A folder that
vanished from one side might have been deleted or might never have arrived, and only the
ancestor can tell them apart. With an ancestor, "present in the ancestor, gone from one side,
untouched on the other" is a deletion and is honoured. Without one, the result is the union,
because the alternative is deleting a folder on the evidence of nothing.

A record's `tags` and the tag **palette** are deliberately merged by different rules: the
former is a set with no possible conflict, the latter a table of definitions where two devices
can genuinely give one tag two colours, and that is a disagreement only a person can settle.

Then `repairFolderTree` runs, because folders are _referenced_. Three things can be wrong at
that point, all produced by perfectly reasonable per-side decisions:

- **A record files into a folder that did not survive.** The folder is _resurrected_ from
  whichever side still remembers it (`folder-resurrected`). A deleted folder is one click to
  delete again; a vault whose records silently fall out of their folders is not.
- **A folder's parent did not survive.** It moves to the root (`folder-reparented`). Losing
  the nesting is recoverable; losing the folder is not.
- **The tree contains a cycle.** Two devices reparenting each other's folders produce
  `A → B → A`, which would hang any renderer that walks parents. One link is cut, at the
  canonically smallest id in the loop, so the same cut is made whichever direction the merge
  ran (`folder-cycle-broken`).

A record whose folder exists nowhere at all is unfiled and reported (`record-unfiled`). Every
repair is reported: a merge that silently rearranges someone's filing is exactly what makes
people stop trusting sync.

The resurrection pool is the ancestor's folders plus both sides', concatenated — so one id can
arrive three times with three different names. `canonicalIndexById` keeps the canonically
smaller definition rather than whichever copy came last, because "last" depends on the order
the caller concatenated the documents in, and therefore on which document was passed first.

---

## 10. The properties, and the two places commutativity deliberately does not hold

`properties.test.ts` runs fifteen scenarios through five properties, because a merge engine
tested case by case ships, and then the case nobody wrote runs on a real vault at two in the
morning.

1. **No record on either side is ever lost.** Goal G1. The one exception needs an ancestor to
   prove both sides agree it is gone.
2. **A tombstone is never overruled.** A 3 × 3 × 3 matrix over (ancestor, ours, theirs), run
   in both argument orders. The merged record may be live for exactly two reasons: nobody
   deleted it, or the ancestor was already trashed and one side restored it while the other
   left the tombstone as it found it.
3. **No secret reaches the report.** A marker is planted in every password, note, security
   answer, hidden custom value **and history snapshot** of both documents, and hunted for in
   the serialised report. The test is non-vacuous by construction: it also asserts the
   conflicts exist, that `"kind":"secret"` appears, that the markers _are_ in the merged
   document, and that a deliberately non-secret custom value still crosses so a resolver can
   render it.
4. **`merge(x, x) === x`.** A sync with a device that has nothing new must be a no-op — not a
   structurally-similar rebuild that renumbers history and marks a hundred records updated.
   The fixture version numbers start at 5 rather than 1 precisely so a merge that renumbers
   everything cannot pass by coincidence. It stays a no-op even when a `mergeOrigin` is
   supplied, so a timeline does not fill with "merged" entries every time a device syncs with
   one that had nothing to say.
5. **`merge(a, b)` agrees with `merge(b, a)`.** Same conflict ids, same
   `requiresResolution`, same symmetric notes, same counts, and — when nothing is left
   unresolved — the same document.

### The named exceptions

**Perspective notes.** `record-added`, `folder-added`, `tag-added` and `attachment-needed`
all mean "this arrived from the other side" or "this is a chunk we do not hold". Swapping the
arguments changes which of them are true, correctly. They are excluded from the symmetry
comparison by name, in `PERSPECTIVE_NOTES`, rather than quietly.

**The merge's own version entry.** The version recording the merge holds _this device's_
previous values, so two devices write different — and both correct — entries. Making it
symmetric would mean recording a "previous state" the device never had. There is an explicit
test named for this.

**A report with unresolved conflicts.** The provisional value is ours by construction, so the
two documents differ exactly in the fields the user has yet to decide. The conflict-id
assertion still binds.

---

## 11. The caller sequence, and what none of it has yet

`src/main/sync/index.ts` exports one function, `mergeDocuments`. Everything else is exported
only so the tests can aim at a single rule at a time — so a caller reaching past the barrel
shows up in review as an unusual import path.

The intended sequence, in the order the safety properties depend on:

1. Decrypt both vaults, and the stored base snapshot if there is one.
2. **Take the pre-merge backup. Mandatory.** It is not this engine's job — the engine cannot
   lose data it never writes, but the caller can.
3. `mergeDocuments(base, ours, theirs, { now })`.
4. If `report.requiresResolution`, show the conflicts, collect a side for each, and call
   `mergeDocuments` again with `resolutions`. Repeat until nothing is unresolved.
5. Copy every chunk in `report.attachmentsToImport` out of the other container.
6. Write the merged document, **and store it as the new base snapshot for next time**.

Two things the engine refuses rather than attempts:

- **Merging across document versions.** `assertSameDocumentVersion` throws. A migration
  exists because the meaning of a field changed, and a merge is the one operation that reads
  both meanings at once and writes a single answer. The caller migrates both sides first;
  `migrateBody` already does exactly that.
- **Merging containers.** This engine merges _documents_. Attachment bytes live in the KEEP
  container as separate encrypted chunks, and a merged record can reference a chunk only the
  other file holds. Those ids come back in `report.attachmentsToImport` — filtered against
  our whole container, not just the record that asked — and the caller must copy them across
  before writing. Dropping the reference instead would lose the attachment permanently.

---

## 12. Not built yet

None of this is reachable by a user. Specifically:

- **The IPC channel.** There is no `kh:sync:*` entry in `CHANNELS`
  (`src/shared/ipc/api.ts`), so the renderer cannot ask for a merge.
- **The conflict-resolver UI.** `@shared/model/sync.ts` exists in the renderer bundle and is
  shaped for it — ids to key rows, sides to show a diff, note kinds to explain what happened
  — but nothing renders it.
- **The pre-merge backup, as a caller.** Step 2 above is a rule with nobody to follow it yet.
  The rolling backups written by `atomic-write.ts` are a different mechanism on a different
  trigger.
- **Base-snapshot storage.** Nothing persists the last-synced document, so every merge would
  currently be two-way — the noisy mode.
- **The generation counter and content hash in the header, the file watcher, and the reload
  prompt** (roadmap Phase 12).
- **Cloud-folder detection and provider "conflicted copy" handling** (Phase 12).
- **`merge` origins in practice.** `HistoryAction` has carried `'merge'` since the model was
  written and `MergeOptions.mergeOrigin` threads it through, but nothing supplies one outside
  the tests. Omitting it writes no merge versions at all, which is the setting behind hard
  rule 7.
- **A saved, viewable merge report.** The report is returned, not stored.

---

## 13. Tests

In `src/main/sync/`. No total is written here on purpose: a count in prose is true the day it is
typed and silently false the next time a case lands, with nothing that fails when it drifts. Run
`npx vitest run src/main/sync` for the current number. What is worth stating is _what_ each file
covers, which changes only when someone decides it should.

| File                        | Covers                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `properties.test.ts`        | The five whole-engine properties over fifteen scenarios · the 27-cell tombstone matrix in both directions · the planted-marker no-secrets sweep                                       |
| `merge-record.test.ts`      | Per-field resolution · the tombstone rules with and without an ancestor · keyed lists and tag sets · history settings · metadata folding                                              |
| `merge-document.test.ts`    | Which records exist at all · absence-is-not-deletion and its companion tombstone case · counts · the document-version refusal · the duplicate-id refusal on each side and each entity |
| `merge-collections.test.ts` | Folders, the tag palette, the settings policy table, and `repairFolderTree`                                                                                                           |
| `merge-history.test.ts`     | De-duplication by identity · deletion via the ancestor · the invariants on every result · numbering left alone when nothing was interleaved                                           |

---

## 14. Related

- [`../05-Features/02-History-And-Audit.md`](../05-Features/02-History-And-Audit.md) — backward deltas, `VERSIONED_FIELDS`, and the diff projector this engine reuses
- [`../05-Features/06-Organisation.md`](../05-Features/06-Organisation.md) — folders and tags, and the integrity checker that reports what a merge can leave behind
- [`../08-Diagnostics/00-Recovery-And-Diagnostics.md`](../08-Diagnostics/00-Recovery-And-Diagnostics.md) — the checks that find a bad merge after the fact
- [`../09-Import-Export/01-Export-Formats.md`](../09-Import-Export/01-Export-Formats.md) — the `.keepx` parcel, and why re-importing an export is not a restore
- [`../12-Roadmap/02-Decision-Log.md`](../12-Roadmap/02-Decision-Log.md) — D13, the safe projection this report is bound by
