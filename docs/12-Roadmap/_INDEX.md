# 12 · Roadmap

The project's memory. Everything that is planned, everything that is deferred, and every decision
that has been made.

| Page                                                 | What it is                                                                                                                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`00-Master-Checklist.md`](./00-Master-Checklist.md) | **The canonical TODO.** 20 phases, each independently completable and verifiable. Tick items as they land; add new work here rather than to chat.                                                                              |
| [`01-Feature-Backlog.md`](./01-Feature-Backlog.md)   | Everything deferred, nothing rejected — including the four features offered during planning but not selected for v1, recorded at Anahat's explicit instruction. Also the short list of ideas genuinely rejected, with reasons. |
| [`02-Decision-Log.md`](./02-Decision-Log.md)         | ADR-style record of all 17 founding decisions and the alternatives rejected, plus the five decisions deliberately deferred to implementation.                                                                                  |
| [`03-Autonomous-Goal.md`](./03-Autonomous-Goal.md)   | The goal string for an unattended run, plus what each clause defends against and which parts must never be removed.                                                                                                            |

---

## How these fit together

```
   Anahat has an idea mid-build
              │
              ▼
   ┌──────────────────────────┐
   │ Is it scheduled work?    │──── yes ──►  00-Master-Checklist.md (a phase)
   └──────────┬───────────────┘
              │ no
              ▼
   ┌──────────────────────────┐
   │ Is it a "later, maybe"?  │──── yes ──►  01-Feature-Backlog.md
   └──────────┬───────────────┘
              │ no
              ▼
   ┌──────────────────────────┐
   │ Is it a choice between   │──── yes ──►  02-Decision-Log.md
   │ options, now settled?    │
   └──────────┬───────────────┘
              │ no
              ▼
   Something only Anahat can do  ──────────►  ../../MANUAL-BACKLOG.md
```

**Nothing goes only into chat.** That is the entire point of this folder.
