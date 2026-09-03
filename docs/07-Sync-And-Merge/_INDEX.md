# 07 · Sync & merge

Reconciling two copies of one vault without losing an edit.

| Page                                         | Phase | What it covers                                                                                                                                                                                                         |
| -------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`00-Merge-Engine.md`](./00-Merge-Engine.md) | 12    | Why clocks decide nothing, absence-is-not-deletion and what it costs, why a duplicate id is refused rather than resolved, the tombstone matrix, how a conflict crosses the bridge as a length, and the caller sequence |

**The rule the rest follows from:** a deletion has a marker and absence does not. A record in
the ancestor and on one side only is **kept**; only a `trashedAt` tombstone removes anything.

**Its companion:** a document holding two entries under one id is refused outright, with a
named `DuplicateIdError` naming the side, the list and the ids, because the alternatives are
losing a record quietly or manufacturing more corruption to repair it. See §3 and decision D26.

**Nothing here is reachable by a user.** The engine is built and tested; there is no
`kh:sync:*` channel, no base-snapshot storage, no file watcher, no conflict-resolver UI, and
no caller taking the mandatory pre-merge backup.

**Still to come (Phase 12):** the header generation counter and content hash, the file
watcher and reload prompt, base-snapshot storage, the resolver UI, a saved merge report, and
cloud-folder detection.
