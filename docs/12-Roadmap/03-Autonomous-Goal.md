# The autonomous goal string

The standing instruction for an unattended Claude Code run on Keyhold. Set it as the session goal
and the session will work the roadmap to completion without intervention.

**It is a contract, not a task list.** It deliberately contains no counts, no hashes and no "as of
today" state — it points at the queue files instead, so it stays true on the fiftieth loop.

---

## The string

```
Work unattended on Keyhold until interrupted. Decide and record the assumption rather than asking. Do not stop, do not wait for review, do not shrink scope.

WORK QUEUE, in order:
1. docs/12-Roadmap/00-Master-Checklist.md — phases 0→19 in order. Finish a phase fully before starting the next; tick items as they land.
2. After v1.0.0 is tagged: docs/12-Roadmap/01-Feature-Backlog.md — ⭐⭐⭐ first, then ⭐⭐.
3. Blocked on Anahat (a Mac, a purchase, a login, a GUI step) → build everything around it, degrade gracefully, log exact steps in MANUAL-BACKLOG.md, keep going. Never buy anything, never execute a gated step.
Keep the checklist, backlog, decision log and MANUAL-BACKLOG.md current as you go, so the next run resumes correctly. New ideas go into those files, never only into chat.

SCOPE: C:\Dev\Credentials-App only.

HARD RULES — read CLAUDE.md "Hard rules" and "Watch out for" before editing:
- The renderer never holds the master key or secret material. Adding a secret to the safe projection is a vulnerability, not a shortcut.
- CSPRNG only; never Math.random for a salt, nonce, id or password. Never invent cryptography.
- Zero network in the app except the opt-in, off-by-default HIBP check.
- Never commit a .keep/.keepx/.kdbx/.csv outside tests/**/fixtures.
- Never spend money — no certificates, no paid APIs, no hosting.
- Every subagent brief forbids `git` outright, including `status`.

PER SLICE: npm run lint && npm run typecheck && npm test all green → commit by explicit path → push only if a remote exists (it may not yet; see MANUAL-BACKLOG M1). Never git add -A. One coherent change per commit, message says why.

GUARDS: ship each system with its guard in the same pass, then fault-inject the guard with the exact bug it claims to catch before trusting it. Core systems only per CLAUDE.md — no ceremonial tests, no coverage chasing.

SUBAGENTS: fan out only for independent research and read-only audits, several at once. Each brief: anchored file:line output, and no git. Write the code yourself.

DOCS: update the matching docs/ page in the same pass as the code. docs/superpowers/specs/ is history — never edit it to match new code.

NEVER IDLE: when the roadmap and the ⭐⭐⭐ backlog are done, do not stop. Audit Keyhold against KeePassXC, Bitwarden, Proton Pass and Padloc for feature gaps, and sweep for UX and quality-of-life wins, missing user options, accessibility, performance, tests, guards and docs. Rank by value × buildability, obey the hard rules and the non-goals in docs/00-Overview/00-What-Is-Keyhold.md, then build. Keep shipping until interrupted.

REPORT once at the end, not throughout: what shipped, what is verified with the command output, and what you deliberately left and why.
```

---

## What each clause defends against

| Clause                                            | The failure it prevents                                                                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _Decide rather than asking; do not stop_          | The session halting overnight on a question nobody is awake to answer                                                                                                                 |
| **Work queue points at files, not a list**        | The goal going stale after the first slice. The session re-reads live state every loop                                                                                                |
| _Keep the files current as you go_                | The next run redoing work the last one finished                                                                                                                                       |
| _Blocked → build around it, log it, keep going_   | One macOS-only item stalling nineteen phases of buildable work                                                                                                                        |
| **Renderer never holds secrets**                  | The single most likely architectural regression — it is easier to ship a feature by putting the password in the renderer, and that quietly destroys the project's main security claim |
| **CSPRNG only / never invent crypto**             | The two ways password managers actually get broken                                                                                                                                    |
| **Never commit a `.keep`**                        | A real vault reaching a public repo when it is flipped public                                                                                                                         |
| **Never spend money**                             | Decision D11 being violated at 3am by "just buy the certificate"                                                                                                                      |
| **Subagents forbidden `git`**                     | Agents tidy. A tidying agent runs `git clean` and deletes uncommitted work                                                                                                            |
| **Gate command before every commit**              | One enormous unverified diff at the end instead of continuous verified progress                                                                                                       |
| _Commit by explicit path, never `git add -A`_     | Scratch files and subagent output being swept into commits                                                                                                                            |
| **Fault-inject the guard**                        | A test that has never been seen to fail being trusted as coverage                                                                                                                     |
| _`docs/superpowers/specs/` is history_            | The frozen design record being "corrected" into a duplicate of the current docs                                                                                                       |
| **Never idle, with a ranking rule and a ceiling** | Either stopping early, or picking something enormous and half-finishing it                                                                                                            |
| _Report once at the end_                          | Six progress pings instead of one useful summary                                                                                                                                      |

---

## Editing it later

Safe to change: the competitor list in NEVER IDLE, the backlog priority threshold (`⭐⭐⭐`), and the
scope line if the project gains a second directory.

Do not remove: the four hard security rules, the no-`git`-for-subagents rule, the gate command, or
the explicit-path staging rule. Those are the clauses that make an unattended run safe rather than
merely productive.

Do not add: counts, commit hashes, phase numbers "currently" in progress, or anything else that
will be false next week. That is what the queue files are for.
