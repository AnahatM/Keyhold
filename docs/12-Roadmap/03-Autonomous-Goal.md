# The autonomous goal string

The standing instruction for an unattended Claude Code run. Set it as the session goal and the
session works the queue to completion without intervention.

**It is a contract, not a task list.** It deliberately contains no counts, no hashes and no "as of
today" state — it points at the queue files instead, so it stays true on the fiftieth loop.

---

## The release goal

**This is the one in force.** It replaced the build-phase goal (kept below) when every roadmap
phase was ticked and what remained was release work rather than construction. Four things changed,
and each was a deliberate answer rather than a default:

- **The landing page comes first**, in its own directory, because it is the only remaining piece of
  the release that has not been started at all.
- **Harden only.** No new subsystems. A pre-release repo does not want a session inventing features
  overnight — but an idea that occurs mid-run still has to land somewhere, so the ceiling is paired
  with an obligation to write it into the feature backlog rather than drop it.
- **No never-idle clause.** The build-phase goal ended with "keep shipping until interrupted",
  which is right while there is a roadmap and wrong when the queue is a finite debt ledger. This
  one stops and reports.
- **Push each slice.** The remote exists now (`MANUAL-BACKLOG.md` M1) and it is private, so work
  never sits stranded on one machine.

```
Work unattended until the queue below is empty, then stop and report. Decide and record the assumption rather than asking. Do not wait for review, do not shrink scope.

WORK QUEUE, in order:
1. C:\Dev\KeyholdLandingPage — build it first. One-page marketing site for Keyhold: React + Vite + TypeScript strict, hand-written CSS over custom-property tokens, no Tailwind, no CSS-in-JS. Brief and content sources: C:\Dev\Credentials-App\HANDOFF.md §5 and §2. Invent no capability — the honest list is the persuasive one. Screenshots come from docs/images/. Do NOT `git init` there and do NOT deploy; record both in MANUAL-BACKLOG.md.
2. docs/12-Roadmap/03-Deferred-Quality.md — the debt ledger, top to bottom: owed guards, then tests, then docs. Entries leave it by being done.
3. HANDOFF.md §3 — the README: screenshots directly under the badges and pitch, plus the download section. Use the anahat-readme skill; regenerate shots with `node tools/smoke.mjs --shots docs/images` rather than editing by hand.
4. MANUAL-BACKLOG.md — build everything around a gated step, degrade gracefully, log exact steps and values.
Keep all four current as you go so the next run resumes correctly.

BLOCKED ON ANAHAT, do not attempt: launching the packaged build, opening a Keyhold .kdbx in real KeePassXC, flipping the repo public, any purchase, login, GUI step, Mac, system-tool install, or running a packaged binary.

CEILING: harden only. Tests, guards, docs, bug fixes, UX polish inside screens that already exist. No new subsystems, no new features. Anything larger you think of goes into docs/12-Roadmap/01-Feature-Backlog.md in enough detail to build later — never silently dropped, never silently implemented.

SCOPE: those two directories. docs/superpowers/ is frozen history — never edit it to match new code.

HARD RULES (CLAUDE.md binds; these are the ones expensive to get wrong at 3am):
- The renderer never holds the master key or secret material. A secret in a projection is a vulnerability, not a shortcut.
- CSPRNG only — never Math.random for a salt, nonce, id or password. Never invent cryptography.
- Zero network except the opt-in, off-by-default HIBP check behind NetworkPolicy.
- Never commit a .keep/.keepx/.kdbx or a plaintext export outside tests/**/fixtures.
- No second list; the merge engine, KEEP container and atomic writes are additive-only.
- Read CLAUDE.md's "Watch out for" before editing.

PER SLICE: npm run lint && npm run typecheck && npm test green; anything touching main or preload also needs npm run build && npm run test:smoke. Run npm run format before committing, not prettier on the files you touched — CI runs format:check repo-wide. Then commit by explicit path with a message saying WHY, and push. Never git add -A. One coherent change per commit.

GUARDS: ship a system and its guard together, and fault-inject the guard with the exact bug it claims to catch BEFORE trusting it. An injection that fails nothing is a finding — say so and strengthen the test. A guard that fails you is right until proved otherwise: fix the code, not the guard.

MOUNT WHAT YOU BUILD: this repo's characteristic failure is finishing a subsystem and wiring it nowhere while every test passes — no test of a component can see that nothing renders it. Add a SMOKE-CHECK that drives the caller, and for any UI slice run `node tools/smoke.mjs --shots <dir>` and actually look at the PNGs.

SUBAGENTS: fan out over disjoint file sets for independent research and audits. Every brief: an exact file allowlist; "NEVER run git, including status"; no new dependencies; "another agent is editing this repo — name errors in files that are not yours rather than fixing them". Do the integration, the IPC and the writing yourself.

DOCS: update the matching docs/ page and its _INDEX.md in the same pass as the code. Never state a count you have not guarded.

REPORT at the end, not throughout: what shipped, what is verified, what you deliberately left and why.
```

### What the release-specific clauses defend against

| Clause                                                   | The failure it prevents                                                                                                                             |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Landing page first, and do not `git init` there**      | A second repository being created and committed to without Anahat having decided it should exist                                                    |
| **Invent no capability**                                 | A marketing page claiming a feature Keyhold deliberately does not have — the fastest way to lose a security tool's credibility                      |
| **Blocked on Anahat, named explicitly**                  | "Blocked" quietly widening to mean "hard". The list is closed: five gated kinds of action and three named release steps                             |
| **Harden only, paired with "write it into the backlog"** | Both halves of one failure — a session inventing a subsystem overnight, and a session losing a good idea because it was not allowed to build it     |
| **Stop and report when the queue empties**               | Self-directed work continuing past the point where a person should look at it                                                                       |
| **`npm run format` before committing**                   | The exact CI failure this repo has already had: formatting per-file, then `format:check` failing repo-wide on a file nobody in that session touched |

---

## The build-phase goal, kept for reference

In force while `00-Master-Checklist.md` still had unticked phases. **Two of its clauses were added
after the first long unattended run**, learned rather than reasoned in advance, and both survive
into the release goal in a different form:

- **"NOT DONE while any unattended code work remains."** Without it, a run treats a phase boundary
  as a finish line. The definition of blocked was spelled out — a purchase, a login, a GUI step, a
  Mac, a system-tool install, or running a packaged binary — so that "blocked" could not quietly
  widen to mean "hard".
- **"A built-but-unmounted thing beats new construction."** Keyhold was built engine-first on
  purpose, and the cost of that order is features that are complete, tested, and reachable from
  nowhere. They look finished in every count. Several whole flows sat in that state for weeks,
  which is why the release goal still carries **MOUNT WHAT YOU BUILD**.

The **guards** clause is worded the way it is for the same reason: over one run, fault injection
found several guards that could not fail at all — including two written in that very run. "An
injection that fails nothing is a finding" is the sentence that turns that from an embarrassment
into a result.

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

Common to both goals.

| Clause                                          | The failure it prevents                                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| _Decide rather than asking; do not stop_        | The session halting overnight on a question nobody is awake to answer                                                                                                          |
| **Work queue points at files, not a list**      | The goal going stale after the first slice. The session re-reads live state every loop                                                                                         |
| _Keep the files current as you go_              | The next run redoing work the last one finished                                                                                                                                |
| _Blocked → build around it, log it, keep going_ | One macOS-only item stalling every other buildable thing                                                                                                                       |
| **Renderer never holds secrets**                | The most likely architectural regression — it is easier to ship a feature by putting the password in the renderer, and that quietly destroys the project's main security claim |
| **CSPRNG only / never invent crypto**           | The two ways password managers actually get broken                                                                                                                             |
| **Never commit a `.keep`**                      | A real vault reaching a public repo when it is flipped public                                                                                                                  |
| **Never spend money**                           | Decision D11 being violated at 3am by "just buy the certificate"                                                                                                               |
| **Subagents forbidden `git`**                   | Agents tidy. A tidying agent runs `git clean` and deletes uncommitted work                                                                                                     |
| **Gate command before every commit**            | One enormous unverified diff at the end instead of continuous verified progress                                                                                                |
| _Commit by explicit path, never `git add -A`_   | Scratch files and subagent output being swept into commits                                                                                                                     |
| **Fault-inject the guard**                      | A test that has never been seen to fail being trusted as coverage                                                                                                              |
| _`docs/superpowers/specs/` is history_          | The frozen design record being "corrected" into a duplicate of the current docs                                                                                                |
| _Report once at the end_                        | Six progress pings instead of one useful summary                                                                                                                               |

---

## Editing it later

Safe to change: the queue order, the ceiling, and the scope line as directories come and go.

Do not remove: the four hard security rules, the no-`git`-for-subagents rule, the gate command, the
`npm run format` clause, or the explicit-path staging rule. Those are the clauses that make an
unattended run safe rather than merely productive.

Do not add: counts, commit hashes, phase numbers "currently" in progress, or anything else that
will be false next week. That is what the queue files are for.
