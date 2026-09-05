# Handoff — what is left before the open-source release

> The single entry point for the next session. Read this first, then
> [`docs/12-Roadmap/00-Master-Checklist.md`](./docs/12-Roadmap/00-Master-Checklist.md).
>
> **Every roadmap phase is ticked.** What remains is release work, deferred quality, and a
> backlog that has no end — so this file exists to say which of those actually blocks a
> release and which does not.

---

## 0. Before you start: set the goal

**The release goal is written.** It is in
[`docs/12-Roadmap/03-Autonomous-Goal.md`](./docs/12-Roadmap/03-Autonomous-Goal.md) under _The
release goal_ — copy that block and set it with `/goal`. Do not write a new one from scratch;
edit that file if it needs to change, so the reasoning stays beside the string.

Four things in it were decided rather than defaulted, and are worth knowing before overriding
any of them:

- **The landing page comes first** (§5), because it is the only part of the release not started.
- **Harden only** in this repo — no new subsystems. Larger ideas go into
  [`docs/12-Roadmap/01-Feature-Backlog.md`](./docs/12-Roadmap/01-Feature-Backlog.md) rather
  than being built or dropped.
- **No never-idle clause.** The queue here is a finite debt ledger, not a roadmap, so the run
  stops and reports when it empties.
- **Push each slice.** The remote exists and is private.

The build-phase goal that preceded it traded testing depth and long-form documentation for
throughput, deliberately. What was skipped under it is listed in §4 and in
[`docs/12-Roadmap/03-Deferred-Quality.md`](./docs/12-Roadmap/03-Deferred-Quality.md), and the
release goal's queue is that ledger.

---

## 1. Blocking the release

Three things, in order. The first is now **done**; only the second is still gated on Anahat.

### 1.1 Launch the packaged build 🟢 — done, and it works

**`MANUAL-BACKLOG.md` → M-PKG**, which now carries the evidence table. On 2026-09-05 the
Windows build was rebuilt on a second machine and driven through the real preload bridge from
inside the asar: `vault.create` returned `ok: true` **after 3,152 ms of Argon2**, lock and
unlock both succeeded (unlock 1,138 ms), and a wrong password was refused with an error naming
no path and no password. Three seconds of Argon2 _is_ the `asarUnpack` redirect working — had
it failed, the worker would never have loaded and no key would have been derived at all.

`tools/smoke.mjs` cannot be pointed at a packaged build, deliberately: `isSmokeRun()` is gated
on `!app.isPackaged`. The route that works is launching the exe with `--remote-debugging-port`
and calling the bridge over CDP, and it needs no change to the app. That is how any future
check of a packaged build should be done.

**What is left is not a blocker**: somebody looking at the unlock progress bar to confirm it is
determinate and moving rather than parked at 0% for three seconds, and the NSIS installer path,
which `--dir` does not exercise.

### 1.2 Open a Keyhold-written `.kdbx` in real KeePassXC 🟡

**`MANUAL-BACKLOG.md` → M-KDBX-INTEROP.** KDBX 4 import and export are built, and a vault
survives export → import through Keyhold's own KeePass reader. What no offline test can prove
is that KeePassXC agrees: a round trip passes for any self-consistent implementation,
including a wrong one. Four specific things to look at are listed in the backlog entry.

### 1.3 Flip the repository public 🟢

**`MANUAL-BACKLOG.md` → M5.** Read that entry's checklist first. Two CI steps are gated behind
it (`macos-latest` in the matrix, `dependency-review-action`) and are four lines each
afterwards.

---

## 2. Release shape — decided, and it needs saying out loud

**GitHub releases carry the Windows build only.** There is no Mac available and buying one is
not a good trade for a build nobody has asked for yet. macOS and Linux users build from
source: one command, no toolchain beyond Node, and no native code anywhere in Keyhold to
compile per-architecture.

**This must be said in the README's download section**, not left for a macOS user to discover
by finding no asset. Something like: _"Windows builds are published here. macOS and Linux:
build from source — `npm install && npm run package:mac` (or `:linux`)."_ It is an honest
position for a GPL project, and better than an unsigned Mac build that Gatekeeper refuses to
open anyway.

Worth knowing while writing that: the macOS and Linux branches of quick unlock, the
network-name probe and the packaging config are all written and have **never been run**. The
first person to build on a Mac is the first person to find out.

---

## 3. README work — done

**Done.** The screenshots sit directly under the badges and the warning, led by the version
history with the device each change came from. The download section exists and states the
platform split from §2. Three facts that had gone stale in the _underselling_ direction were
corrected — the import-format count, "KDBX export is designed but not built", and "the one
exception planned (a breach check)" — and all three counts now have guards in
`tools/doc-counts.test.ts` that read the README and compare them against their registries.

Worth knowing if the images are regenerated: `captureNamedShot` now asserts each capture's
subject is on screen at the instant it is taken. That check found four screenshots that had
drifted onto the wrong screen, one of which was in this README under a caption describing
something else entirely.

---

## 4. Deferred quality — nearly cleared

**The ledger is at
[`docs/12-Roadmap/03-Deferred-Quality.md`](./docs/12-Roadmap/03-Deferred-Quality.md).** Its
documentation section is **empty**, and its owed-tests section is down to one entry that is a
description of a manual check rather than a missing fixture.

What was closed, and what each thing turned out to protect:

| Was owed                     | Now                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `mirror-backup.ts` — no test | 22, four failures driven for real, each asserting the message carries no path                         |
| `requireBreachCheckPatch`    | Renderer-supplied request pacing refused four ways, including when the value sent is the default      |
| `VaultService.totpCode`      | A wrong-type and a missing field return the _same_ `null` — telling them apart is a field-type oracle |
| `blockScreenCapture`         | The behaviour, plus a parser-based check that both call sites still apply it                          |
| The cancelled sweep          | `cancelled`, zero requests, and `safeCount` still zero — end to end through the real client           |
| `kh:recovery:save-report`    | Refuses before opening a dialog; the held report is dropped on lock                                   |
| `diagnose.ts`                | The folder walk, the directory filter, a vault path naming nothing                                    |
| The breach consent dialog    | Writes nothing until confirmed; states the cost as well as the protection; off takes no dialog        |
| `TotpField`                  | Self-refresh, the expiring state, and copying through the broker                                      |
| `kdbx/header.ts`             | Nineteen refusals a round trip cannot see, including the two that exist to be _legible_               |
| The record-type picker       | Appends without eating a custom field the user already added                                          |
| `DiagnosticsView`            | A dismissed dialog leaves the report alone; a real choice replaces it                                 |

**Two guards were added**, and the first is the one that matters:
`tools/bridge-is-used.test.ts` generalises "built and unreachable" — every member of
`KeyholdApi` must be used somewhere under `src/renderer/`. It found three defects on its first
run. And `captureNamedShot` in the smoke run now asserts every screenshot shows its subject,
which found four files that had drifted onto the wrong screen — one of them in the README under
a caption describing something else.

### What is still open, honestly

- **The second half of the reachability rule.** A call site that _exists_ inside a component
  nothing renders is invisible to the static guard; only the smoke run reaches it, and only
  where somebody wrote the check. This is the highest-value item left on that page.
- **`diagnose.ts`'s 256 MB size cap**, deliberately: writing a 256 MB file per test run costs
  more than the branch is worth.
- **The KDBX attachment-marker append path**, which needs a real KeePassXC database and is part
  of §1.2 rather than a missing fixture.

Also open, from the backlog rather than that file: **G3 · publish the KEEP format spec as a
standalone implementable document.** Three stars, and central to the no-lock-in claim — "you
can leave" is only credible if somebody else can write a reader.

---

## 5. The landing page — built, and waiting on two decisions

**It exists**, at `C:\Dev\KeyholdLandingPage`. One page: hero, the audit trail, features,
architecture, screenshots, the honest trade-offs table, the download split and an FAQ. React +
Vite + TypeScript strict, hand-written CSS over Keyhold's own Midnight and Dawn palettes, no
Tailwind, and **no third-party request of any kind** — every icon is inline SVG and the type is
the system stack, because a page about a program that makes no network requests should not make
eight to draw its own ticks.

`npm run verify` there runs format, lint, an asset guard and the build, and is green. The page
has been rendered and looked at in both themes and at a phone width; the reviewing found and
fixed three real defects (a hero screenshot too small to read, a spotlight layout with a
screen-sized hole in it, and a regex that set half a paragraph in monospace).

**Two things are deliberately not done, and both are Anahat's call** — full instructions in
`MANUAL-BACKLOG.md` → **M6**:

1. **It is not a git repository.** No `git init`, nothing committed. Creating a second
   public-facing repository is a decision, not a chore.
2. **It is not deployed.** Vercel or Cloudflare Pages, both fine, both free. No account was
   touched.

One thing to change once **M5** lands: the download card links to the releases page, which 404s
for anyone but Anahat while the repository is private.

**The rule that governs its content, if it is edited:** nothing on the page may claim a
capability Keyhold does not have. `src/lib/site.ts` holds every fact in one place, and each
count is annotated with the guarded registry in this repository it was copied from.

---

## 6. What shipped in the last session, so nothing is re-done

Every item below is on `main` and pushed.

| Shipped                              | Notes                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **KeePass XML import**               | 19th format, with a hardened XML reader written here rather than a dependency (D31)            |
| **KDBX 4 read and write**            | No dependency (D32). KDBX 3 refused by name — Salsa20 is not available to compose              |
| **Application icon**                 | Drawn from geometry in `tools/make-icons.mjs`; SVG, ICO, ICNS and PNGs all derived             |
| **"Not verified yet" export labels** | Three of six export formats have never been opened in the app they target, and now say so      |
| **Breach check made reachable**      | Engine existed for months with no IPC channel; two switches, a consent dialog, never automatic |
| **One-time codes on screen**         | TOTP engine existed since Phase 8 and rendered nowhere                                         |
| **Diagnose a vault**                 | Recovery engine existed and was callable from nothing; reads a vault without its password      |
| **Ten record types**                 | Cards, notes, identities, Wi-Fi, SSH keys… each a field template, not a storage shape          |
| **`type:` search**                   | The record types were invisible to search without it                                           |
| **Linux target**                     | AppImage, deb, rpm, plus an `nmcli` network probe                                              |
| **Screen-capture blocking**          | `setContentProtection`, on by default                                                          |
| **Copy to a second folder**          | After every save, to a folder the user picks. Fire-and-forget                                  |
| **First packaged build**             | Windows, verified as far as is possible without launching it                                   |

Three flaky or wrong guards were also fixed rather than worked around: a smoke check that was
failing because the harness never focused the window, an IPC test whose hook timed out under
load, and a folder-integrity performance budget that cried wolf.

---

## 7. Standing rules the next session should not have to rediscover

- **`CLAUDE.md` binds.** Read its "Watch out for" section before editing anything.
- **A guard that fails you is right until you have proved otherwise.** Three separate guards
  blocked work in the last session and all three were correct — a network-policy rule, a
  file-length ceiling, and a gateway-coverage check. Fix the code, not the guard.
- **`npm run format` before committing**, not `prettier --write` on the files you touched. CI
  runs `format:check` over the whole repo and it has already failed once for exactly that.
- **Per slice:** `npm run lint && npm run typecheck && npm test`; anything touching main or
  preload also needs `npm run build && npm run test:smoke`. Commit by explicit path, push.
- **Mount what you build**, and prove it with a smoke check. See §4.
