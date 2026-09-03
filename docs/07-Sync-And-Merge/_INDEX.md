# 07 · Sync & merge

Reconciling two copies of one vault without losing an edit.

| Page                                             | Phase | What it covers                                                                                                                                                                                                                          |
| ------------------------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`00-Merge-Engine.md`](./00-Merge-Engine.md)     | 12    | Why clocks decide nothing, absence-is-not-deletion and what it costs, why a duplicate id is refused rather than resolved, the tombstone matrix, how a conflict crosses the bridge as a length, and the caller sequence                  |
| [`01-The-Merge-Flow.md`](./01-The-Merge-Flow.md) | 12    | The four `kh:sync:*` channels and why no path crosses them, why `prepare` is one call, who owns a decrypted copy of another vault at each moment, when the base snapshot is written, the wait in front of the resolver, and the ways in |

**The rule the rest follows from:** a deletion has a marker and absence does not. A record in
the ancestor and on one side only is **kept**; only a `trashedAt` tombstone removes anything.

**Its companion:** a document holding two entries under one id is refused outright, with a
named `DuplicateIdError` naming the side, the list and the ids, because the alternatives are
losing a record quietly or manufacturing more corruption to repair it. See §3 and decision D26.

**It is reachable now.** The four `kh:sync:*` channels are registered, the resolver is mounted
behind the command palette's `Merge another copy of this vault` and the File menu's
`Merge Another Copy…`, and the mandatory pre-merge backup is taken inside `prepare` before a
single conflict is on screen. The generation counter and content hash, the file watcher and
base-snapshot storage are all in.

**Still to come (Phase 12):** the reload prompt, a saved merge report and a view for it,
cloud-folder detection, provider "conflicted copy" handling, and a KDF progress channel —
which unlock needs just as much, so it belongs to both rather than only here.
