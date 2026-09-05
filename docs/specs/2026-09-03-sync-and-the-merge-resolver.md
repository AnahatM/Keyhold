# Sync, and the screen that settles a merge

**Written 2026-09-03.** A point-in-time design record, not a reference page. When this drifts
from the code, the code is right — fix `docs/07-Sync-And-Merge/`, not this file.

---

## 1. What this is for

Keyhold's sync promise is one sentence: **two devices, one cloud folder, and never a lost
edit.** There is no Keyhold server, so "sync" means the user puts their `.keep` in Dropbox,
iCloud Drive, OneDrive or a syncing NAS folder, and two machines write to the same file.

That arrangement has exactly one hard problem, and it is not encryption. It is that the file
is a single opaque blob to the sync client, so when two devices both edit, the client cannot
merge — it picks one, or it writes `vault (conflicted copy).keep` beside it. Both outcomes
lose an edit. The whole of this design exists to make Keyhold notice that first and do the
merge itself, field by field.

## 2. What was already built, and what this spec adds

The order was deliberate: the engine is where correctness lives, so it went first and has
been finished and tested for some time. By the time this spec was written the pieces were:

| Piece                                                      | State     |
| ---------------------------------------------------------- | --------- |
| Three-way merge engine, per record, per field, pure        | Built     |
| Absence is not deletion; tombstones; duplicate ids refused | Built     |
| Conflict report that carries lengths, never values         | Built     |
| Generation counter **and content hash** in the header      | Built     |
| Base-snapshot store — the ancestor a three-way merge reads | Built     |
| File watcher on the open vault                             | Built     |
| Mandatory pre-merge backup, enforced by construction       | Built     |
| **`kh:sync:*` channels**                                   | This spec |
| **The conflict resolver screen**                           | This spec |
| **A merge report the user can keep**                       | This spec |

Everything above the line is reachable from nothing. `mergeDocuments` is called only by its
own tests. That is the gap this closes.

## 3. The sequence, end to end

1. The watcher notices the file's header no longer matches what we hold. It reports; it never
   acts. It has already suppressed our own writes and ignored a touched mtime.
2. The user is told, and chooses. **Nothing happens automatically** — see §6.
3. `PreMergeBackup.runMerge` takes a verified copy. If it cannot, the merge does not run.
4. The engine merges: our document, their document, and the stored base snapshot.
5. If `requiresResolution`, the resolver screen opens. The user settles each conflict; the
   merge is **re-run** in the main process with the choices folded in, not patched.
6. The merged document is written. Only then is the base snapshot replaced.
7. The report is offered for keeping.

Steps 3 and 6 are where data is lost if this is wrong, and both are already enforced rather
than requested: the backup mints a receipt every later step requires, and
`snapshotIsSafeToStore` refuses to record an ancestor for a merge that did not finish.

## 4. Why the resolver never sees a value

This is the design decision the whole screen turns on, and it is decision D13 applied to a
new surface rather than a new rule.

A conflict is _which side wins_, not _what the value is_. So a `ConflictSide` carries a kind
and, for a secret, a **length** — the same discriminated union the history diff already uses,
built by running values through the _existing_ projector rather than a second one written for
sync. A property test plants a marker in every secret in both documents and asserts the
serialised report does not contain it.

The user picks a side by name. The choice returns as a `ConflictChoice`, and the merge re-runs
in main. Nothing about that flow needs the value in the renderer, which is why it is not
there.

**Re-running rather than patching** matters for a second reason: a merge is a pure function
of its inputs, so re-running it with a choice added produces a document that is _consistent_
— whereas patching one field of a previously-merged document produces a state the engine
never sanctioned and cannot reason about.

## 5. Two-way is a different situation, and the screen must say so

Three-way can tell an edit from a stale copy: if one side matches the ancestor, it did not
change, and the other side wins silently. Two-way cannot, so **every difference is a
conflict**.

A user with a base snapshot sees four conflicts. The same user on a new machine, with no
snapshot yet, sees four hundred — for the same two files. If the screen does not explain
that before they start clicking, the honest conclusion they will draw is that the app is
broken.

The mode is in the report for exactly this reason, and the resolver leads with it.

## 6. Nothing happens automatically, and that is not timidity

The obvious product instinct is to merge in the background and tell the user afterwards. It
is wrong here, for three reasons:

- A merge that runs unattended still has to resolve conflicts, and the only way to do that
  without asking is to pick a side — which is last-writer-wins with more steps.
- A merge writes the whole vault. Doing that to a file the user is not looking at, from an
  input that arrived over a network they do not control, is a large action taken quietly.
- The pre-merge backup is only reassuring if the user knows it was taken.

So the watcher reports, and a person decides. The setting that would let this run
automatically is deliberately not offered.

## 7. Four hundred conflicts

The two-way case makes bulk resolution necessary, and bulk resolution is also the thing most
likely to make the engine pointless. The line drawn here:

- **Grouping and filtering are free.** By record, by kind, by which side is currently applied.
  Seeing the shape of a disagreement is not deciding it.
- **"Take mine for the rest" exists, and is never the default, never pre-selected, and always
  says how many it covers.** It is the honest tool for the case where somebody knows one
  device is stale. It is not the fast path.
- **There is no "resolve all automatically".** That is the button that turns this into
  last-writer-wins.

## 8. What is deliberately not in this design

- **No conflict resolution for attachments' contents.** The report names which chunks need
  importing; the bytes are copied wholesale. A half-merged file is not a thing.
- **No automatic conflict-copy cleanup.** If a sync client already wrote
  `vault (conflicted copy).keep`, Keyhold's recovery survey lists it. Deleting somebody's
  file because we think we merged it is not a risk worth taking.
- **No merge across vault ids.** Two different vaults at one path is a "something replaced
  your file" warning, and the only safe response is to stop.
- **No three-way merge of the base snapshot itself.** If it is missing or unreadable, the
  merge degrades to two-way and says so. That is worse and correct; guessing is neither.

## 9. What would make this wrong

Written down so a later reader can check rather than re-derive:

- If a `ConflictSide` ever carries a value, the property test fails and the guarantee in §4 is
  gone.
- If the resolver patches the merged document instead of re-running the merge, §4's second
  argument no longer holds and the result is a document the engine never produced.
- If the base snapshot is stored before the merged vault is safely written, the _next_ merge
  treats real edits as changes away from a state that never existed.
- If a merge can run without a `PreMergeBackup`, hard rule 6 is broken by the one operation
  most able to break it.
