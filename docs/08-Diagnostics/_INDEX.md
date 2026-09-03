# 08 · Diagnostics

What to tell someone whose vault will not open, and what is still wrong once it does.

| Page                                                                 | What it covers                                                                                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`00-Recovery-And-Diagnostics.md`](./00-Recovery-And-Diagnostics.md) | Why nothing here repairs anything, how far a `.keep` parses without a password, ranking the copies beside it, the document checks, and the report that carries no user content |

**The two rules everything follows from:**

1. **Report, never repair.** A repair is one line, and that is the trap — it destroys the
   evidence of which cause produced the state. There is no code anywhere that executes a
   `RepairPlan`.
2. **Ids, counts, byte offsets and timestamps only.** A report is written to be pasted into a
   bug report, so it carries no password, note, title, folder name, tag name, or filename
   beyond a basename. A property test plants a marker in every one of those and sweeps the
   serialised result.

**Nothing here is reachable by a user.** Every analysis is built and tested; there is no
`kh:recovery:*` channel, no diagnostics screen, and no caller that gathers the bytes, the
directory listing and the chunk list to feed them.
