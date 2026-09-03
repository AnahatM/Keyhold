# The autonomous goal string

The standing instruction for an unattended Claude Code run on Keyhold. Set it as the session goal
and the session will work the roadmap to completion without intervention.

**It is a contract, not a task list.** It deliberately contains no counts, no hashes and no "as of
today" state — it points at the queue files instead, so it stays true on the fiftieth loop.

**Two clauses were added after the first long unattended run**, because both were learned the hard
way rather than reasoned in advance:

- **"NOT DONE while any unattended code work remains."** Without it, a run treats a phase boundary
  as a finish line. The definition of blocked is spelled out — a purchase, a login, a GUI step, a
  Mac, a system-tool install, or running a packaged binary — so that "blocked" cannot quietly widen
  to mean "hard".
- **"A built-but-unmounted thing beats new construction."** Keyhold was built engine-first on
  purpose, and the cost of that order is features that are complete, tested, and reachable from
  nowhere. They look finished in every count. Two whole flows sat in that state for weeks.

The **guards** clause is worded the way it is for the same reason: over one run, fault injection
found several guards that could not fail at all — including two written in that very run. "An
injection that fails nothing is a finding" is the sentence that turns that from an embarrassment
into a result.

---

## The string

```
Work unattended on Keyhold (C:\Dev\Credentials-App) until interrupted. Decide and record the assumption rather than asking. Do not stop, do not wait for review, do not shrink scope.

NOT DONE while any unattended code work remains. "Blocked on Anahat" is true only for a purchase, a login, a GUI step, a Mac, installing a system tool, or running a packaged binary. Everything else is yours, however large.

WORK QUEUE, in order:
1. docs/12-Roadmap/00-Master-Checklist.md — phases in order. WITHIN a phase, a built-but-unmounted thing beats new construction: it looks finished in every test and count while a user cannot reach it. Engine before IPC before UI.
2. docs/14-Audits/ — open findings. Fix them; do not re-audit.
3. docs/12-Roadmap/01-Feature-Backlog.md — 3-star first, then 2-star.
4. MANUAL-BACKLOG.md — build everything around a gated step, degrade gracefully, log exact steps and values. Never execute it, never buy anything, never install anything.
Keep all four current as you go so the next run resumes correctly. New ideas go in those files, never only into chat.

SCOPE: the whole repo. Off-limits: docs/superpowers/ is frozen history — never edit it to match new code.

HARD RULES (CLAUDE.md is binding; these are the ones expensive to get wrong at 3am):
- The renderer never holds the master key or secret material. Adding a secret to a projection is a vulnerability, not a shortcut.
- CSPRNG only. Never Math.random for a salt, nonce, id or password. Never invent cryptography — compose src/main/crypto/ and src/main/format/.
- Zero network except the opt-in, off-by-default HIBP check behind NetworkPolicy.
- Never commit a .keep/.keepx/.kdbx/.csv/.json export outside tests/**/fixtures.
- No second list. A value with a home is referenced, never restated; fold a duplicate the moment you find one.
- The merge engine, the KEEP container and atomic writes are additive-only.
- Read CLAUDE.md's "Watch out for" before editing.

PER SLICE: npm run lint && npm run typecheck && npm test green; anything touching main or preload also needs npm run build && npm run test:smoke. Then commit by explicit path with a message saying WHY. Never git add -A. One coherent change per commit. Push only once a remote exists (MANUAL-BACKLOG M1).

GUARDS: ship a system and its guard together, and fault-inject the guard with the exact bug it claims to catch BEFORE trusting it. An injection that fails nothing is a finding: say so, strengthen the test, do not quietly move on. This keeps catching vacuous guards — expect more.

SUBAGENTS: fan out 4-8 at once over disjoint file sets. Every brief: an exact file allowlist; "NEVER run git, including status"; no new dependencies; fault injection with pasted output; "another agent is editing this repo — name errors in files that are not yours rather than fixing them". Do the integration, the IPC and the docs yourself.

VERIFY VISUALLY: for any UI slice run `node tools/smoke.mjs --shots <dir>` and actually look at the PNGs. It has caught layout bugs every test passed through. Add a SMOKE-CHECK for whatever a screenshot reveals.

DOCS: update the matching docs/ page and its _INDEX.md in the same pass as the code. Never state a count you have not guarded.

NEVER IDLE: when the queue empties, do not stop or wait. Sweep the codebase and the competitive space (Bitwarden, 1Password, KeePassXC, Proton Pass, Apple Passwords) for feature gaps, UX and quality-of-life wins, missing settings, extras worth giving users, content, tests, guards, docs, performance and accessibility. Rank by value x buildability under the rules above, then build properly — a spec in docs/superpowers/specs/ for anything large, then phases appended to the checklist. Build features freely; finish each before starting the next. Keep shipping until interrupted.

REPORT at the end, not throughout: what shipped, what is verified, what you deliberately left and why.
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
