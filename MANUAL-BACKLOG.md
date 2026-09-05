# Manual backlog — tasks for Anahat

Things Claude cannot or should not do. Each entry has enough detail to be done without re-reading
the conversation.

**Legend:** 🔴 blocks further building · 🟡 needed before release · 🟢 whenever convenient

Last updated: 2026-09-05

---

## ~~M1~~ — Create the private GitHub repository and push — **DONE**

**Done 2026-09-03.** `AnahatM/Keyhold`, private, `main` tracking `origin/main`.

The blocker was wrong rather than real: `gh` **was** installed — at
`C:\Program Files\GitHub CLI\gh.exe`, already authenticated as `AnahatM` with `repo` scope —
and simply not on the PATH of either shell. Two earlier passes checked `gh --version` and
`which gh`, got nothing, and concluded it was absent. Invoking the executable by its full path
worked immediately.

**Worth carrying forward:** on Windows, "not on PATH" and "not installed" are different facts,
and only one of them blocks anything. Check the usual install locations —
`C:\Program Files\<tool>\`, `%LOCALAPPDATA%\Programs\`,
`%LOCALAPPDATA%\Microsoft\WinGet\Links\`, `C:\ProgramData\chocolatey\bin\`,
`~\scoop\shims\` — before recording a tool as missing.

**Checked before pushing**, since a push is outward-facing and hard to take back:

- no `.keep`, `.keepx` or `.kdbx` anywhere in the history, not only in the working tree;
- no `.csv` or `.env` tracked, and no credential-shaped strings (`gh*_`, `sk-`, `AKIA`, PEM
  private-key headers) in tracked content;
- 737 files, 3.16 MiB packed, nothing over 1 MB;
- the working tree clean, on `main`.

Nothing further is needed here. **M5** (flip it public at v1) is the next step for this repo, and
it stays green.

---

## 🟢 M2 — macOS is a compile-it-yourself platform

**Decided.** There is no Mac available, and buying one to ship a build nobody has asked for
yet is not a good trade. So:

- **Releases on GitHub carry the Windows build only.**
- macOS users build from source. `npm install && npm run package:mac` on any Mac produces a
  DMG and a zip; `electron-builder.yml` already has the `mac` block, and there is no native
  code anywhere in Keyhold, so nothing needs compiling per-architecture.
- Linux users can do the same with `npm run package:linux` — AppImage, deb and rpm.

**What this means for the README and the release notes:** say it plainly, in the download
section, rather than leaving macOS users to discover there is no asset. "Windows builds are
published here. macOS and Linux: build from source — one command, no toolchain beyond Node."
That is an honest position for a GPL project and a better one than an unsigned Mac build
Gatekeeper refuses to open anyway.

**Still true and worth knowing:** nothing in Keyhold is Windows-only. Quick unlock, the
network-name probe and the packaging targets all have their macOS and Linux branches written;
they have simply never been _run_. The first person to build on a Mac is the first person to
find out, and that is the honest state to publish.

---

## ~~M3~~ — Install project dependencies — **done, and no longer a live item**

`npm install` succeeded during Phase 0 and `node_modules/` has been present ever since; every
gate run in this repo depends on it. Kept as a heading rather than deleted so the numbering
stays stable — M4, M5 and M6 are referenced from the docs by number.

**Nothing is outstanding.** This once said `kdbxweb` still was; that item is withdrawn (D32),
and Keyhold's dependency list is closed at `@zxcvbn-ts/core`, `@zxcvbn-ts/language-common`,
`hash-wasm`, `react`, `react-dom` and `zustand`.

---

## 🟢 M4 — Code signing certificates (deferred by decision D16)

Both cost money annually, which conflicts with decision D11 (_"I won't have to pay for anything"_).
**Deliberately not being done.** Recorded so the option is visible if that ever changes.

- **Windows:** an OV/EV code-signing certificate (~$200–400/yr) removes SmartScreen warnings
- **macOS:** an Apple Developer Program membership ($99/yr) enables Developer ID signing and notarisation

Until then: builds ship unsigned, SHA-256 checksums are published with every release, and the README
documents the exact SmartScreen and Gatekeeper steps. Backlog item D8.

---

## 🟢 M5 — Flip the repository public at v1

Decision D12 made it private for now; backlog G1 flips it. Before flipping:

1. Confirm no secrets, no personal vault files, and no `.keep`/`.keepx` files were ever committed
   (`git log --all --diff-filter=A --name-only | sort -u` and read it)
2. Confirm `SECURITY.md` has a working private disclosure route
3. Confirm the README's comparison table is still accurate — competitors move

---

## 🟡 M6 — The landing page: one decision left, and it is the domain

Backlog G2. **The site exists and is its own repository** — `AnahatM/Keyhold-Landing-Page`,
cloned here at `C:\Dev\Keyhold-Landing-Page`, pushed. One page: hero, the audit trail,
features, architecture, screenshots, the honest trade-offs table, the download split and an
FAQ. React + Vite + TypeScript strict, hand-written CSS over Keyhold's own Midnight and Dawn
palettes, no Tailwind, and no third-party request of any kind. `npm install && npm run verify`
is the whole gate and it is green.

### What was fixed on 2026-09-05, so it is not re-found

Reviewed by rendering it and driving a real browser over CDP — both themes, and every width
from 320px to 1920px:

- **`og:image` was a relative path.** Open Graph resolves nothing relative, so every link to
  the page would have shown a card with no image, silently. Absolute now, with `og:url`, and
  `check:assets` fails the build if the three origins in `index.html` disagree.
- **`.gitattributes` was missing `eol=lf`**, so a fresh clone on Windows failed
  `npm run format:check` — the first step of `verify` — on all thirty files.
- **The screenshots were unreadable on a phone**, and now pan inside their own frame.
- **Every `auto-fit` grid used a fixed `minmax` floor**, pushing the page sideways at 320px.
- **KDBX no longer "opens in KeePassXC"** there either, matching the app and the README.
- Added `vercel.json` (CSP, `nosniff`, `no-referrer`, `Permissions-Policy`, cache lifetimes),
  `robots.txt` and `sitemap.xml`.

### What is left, and it is yours

**Deploy it, and decide the domain.** Vercel or Cloudflare Pages, both fine and both free;
`vercel.json` already names the build command (`npm run build`) and output directory (`dist`),
so importing the repository should need no configuration.

**Then change the origin in five places if it is not `keyhold.app`:** three in `index.html`
(`<link rel="canonical">`, `og:url`, `og:image`), and one each in `public/robots.txt` and
`public/sitemap.xml`. `npm run check:assets` will catch a mismatch among the three in
`index.html`, but it cannot know which domain is right — a canonical pointing at a domain
that does not serve the page is worse than no canonical at all.

**One thing to change after M5:** the download card links to
`github.com/AnahatM/Keyhold/releases`, which 404s for anyone who is not you while the
repository is private.

---

## 🟡 M-TIDY · The last two files to delete, once you are finished

**This file is one of them.** The repository has been stripped of the scaffolding that
described how the work was organised rather than what the software does — `HANDOFF.md` and
`docs/12-Roadmap/03-Autonomous-Goal.md` are deleted, `docs/superpowers/specs/` is now
`docs/specs/`, and no commit message in the history carries a co-authorship or session
trailer any more (rewritten and force-pushed 2026-09-05; the pre-rewrite history is on the
local branch `backup/pre-trailer-rewrite`, which was deliberately **not** pushed).

**The deferred-quality ledger is gone**, on the first of the two conditions written into it:
every entry in it was closed. Its owed documentation had been empty for a while; its two owed
guards and its two owed tests were finished on 2026-09-05. Each closed entry's reasoning was
written into the file it was about rather than kept in the ledger, so nothing was lost with it
— and the two documents that still pointed at it for coverage that had since landed were
corrected rather than left to mislead.

**One file is deliberately still here: this one.** Delete it when every 🔴 and 🟡 entry above
is done. Anything left that is a real limitation rather than a task belongs in
`docs/12-Roadmap/01-Feature-Backlog.md` first; a gap does not stop being real because the file
recording it was tidied away.

It is internal process bookkeeping and is not referenced from the README, `CONTRIBUTING.md` or
any published doc, so deleting it breaks no link — but run `npx vitest run
tools/doc-paths.test.ts` afterwards, which is the guard that would tell you if it did.

**`CLAUDE.md` stays.** It reads as contributor documentation — the stack, the commands, the
hard rules, the "watch out for" list — and is more useful to a newcomer than anything else in
the repository.

---

## Done

_(nothing yet)_

---

## ~~M-ICON~~ — An application icon — **withdrawn; it is drawn, and it is code**

This asked for a hand-drawn `icon.png` with an `.ico` and `.icns` derived from it, on the
assumption that artwork is a manual step. It is not, for a mark this simple.

`tools/make-icons.mjs` draws it: a keyhole on a rounded plate in the default theme's accent,
defined as **one set of geometry constants** and rendered by arithmetic — a circle test, a
trapezoid test and a rounded-rectangle test, supersampled 4×4 for anti-aliasing. Everything
downstream is derived from those numbers: `build/icon.svg` for documents, `build/icon.png` at
1024, `build/icon.ico` with the seven sizes Windows asks for, `build/icon.icns` with the ten
OSTypes macOS reads including every retina variant, and `build/icons/*.png` for Linux. PNG,
ICO and ICNS are all written by hand — PNG is a zlib stream and four CRC-tagged chunks, and
the other two are containers that hold PNGs — so nothing was installed.

`npm run icons` regenerates. `tools/icons.test.ts` regenerates and **compares bytes**, so an
icon edited by hand and committed without its source fails the build; it also parses both
containers back, because a wrong ICO offset produces a file every tool accepts and Windows
declines to draw, and nothing else in this repo would ever open one.

**A keyhole rather than a padlock**, and the reason is the 16-pixel rendering: every password
manager is a padlock, and at that size they are indistinguishable from each other and from a
browser's own address-bar icon. It was checked by eye at 16, 32 and 256.

**If you want a different mark**, the numbers are at the top of `tools/make-icons.mjs` under
"The geometry" — change them, run `npm run icons`, and every file follows. That is the one
thing left here and it is a preference, not a blocker.

## 🟢 M-PKG · The packaged build runs; the installer and one look are left

**Unblocks:** the first release. **Smaller than it was** — the build itself has now been
produced, and the specific risk this entry was written to contain has been checked as far as
it can be without launching.

**What has been done.** `npm run package:dir` ran to completion on Windows and wrote
`release/win-unpacked/`. Three things were then verified from the artefacts:

1. **`out/main/kdf-worker.js` is marked `"unpacked": true` in the asar's own header**, and the
   file is present at `release/win-unpacked/resources/app.asar.unpacked/out/main/kdf-worker.js`.
   That flag is what makes Electron's loader redirect the runtime path
   `…/app.asar/out/main/kdf-worker.js` to the unpacked copy — which is the exact mechanism the
   Argon2 worker depends on, and the exact thing this entry was written to worry about.
2. **The icon is genuinely embedded.** The bytes of `build/icons/256x256.png` appear inside
   `Keyhold.exe` and do not appear inside the stock `node_modules/electron/dist/electron.exe`.
3. **`tools/asar-unpack.test.ts` now guards the arrangement** — that the worker is in
   `asarUnpack`, and that the filename `kdf-runner.ts` builds at runtime is the one the config
   covers. Both halves, because a config-only check would miss a rename in the code.

**The risk this entry existed for is now closed, with evidence.** 2026-09-05, on the second
machine, `npm run package:dir` was rebuilt from a clean clone and
`release\win-unpacked\Keyhold.exe` was launched and driven through the real preload bridge:

| Step                                     | Result                                                      |
| ---------------------------------------- | ----------------------------------------------------------- |
| Window and renderer from inside the asar | Loaded — `…/app.asar/out/renderer/index.html`, root mounted |
| Preload bridge                           | All 20 groups present on `window.keyhold`                   |
| `vault.create` → Argon2 in the worker    | **`ok: true` after 3,152 ms**                               |
| `session.status`                         | `unlocked`                                                  |
| `vault.lock`                             | `ok: true`, status `locked`                                 |
| `vault.unlock` with the real password    | **`ok: true` after 1,138 ms**, status `unlocked`            |
| `vault.unlock` with a wrong password     | Refused, and the logged error names no path and no password |

Three seconds of Argon2 is the redirect working: had it failed, the worker would not have
loaded and no key would have been derived at all. The `asarUnpack` arrangement is therefore
confirmed end to end, not only from the header.

**How, and why it is worth writing down.** `KEYHOLD_SMOKE` is deliberately gated on
`!app.isPackaged` (`src/main/smoke.ts` — the environment variable is the request, the gate is
the permission), so `tools/smoke.mjs` **cannot** be pointed at a packaged build, correctly.
The packaged app was driven instead by launching it with `--remote-debugging-port` and calling
the bridge over CDP. That is the route for any future check of a packaged build, and it needs
no change to the app.

**What is genuinely left, and it is yours because it is a human judgement or an installer.**

1. **Watch the unlock progress bar with your own eyes.** The engine underneath it is now
   proven; what is not proven is that the bar is _determinate and moving_ rather than sitting
   at 0% for three seconds and jumping. That is a look, not a test.
2. **The installer path:** `npm run package:win`, install it, and unlock a vault from the
   installed copy. SmartScreen will warn — the build is unsigned by decision D16 (M4). Nothing
   above touches NSIS; only `--dir` was exercised.
3. **macOS needs a Mac** (M2).

---

## 🟢 M-CI · One packaging step left, and it is gated on going public

1. ~~`npm run format` once~~ — **done.** The whole repository is Prettier-clean and
   `format:check` is inside `verify:full`, which is the command CI runs, so a file that is
   not clean now fails the gate rather than being discovered later.
2. ~~Create `.github/dependabot.yml`~~ — **done.** It was listed here as manual because it "is
   not a workflow file and has to be created separately", but that reasoning was about
   `.github/workflows/`, which a token without the `workflow` scope cannot push.
   `dependabot.yml` is not in that directory and pushed normally. The issue templates,
   `config.yml` and the pull-request template landed with it, which were the other half of
   the Phase 18 line.
3. **Still yours, and genuinely gated:** once the repo is public, add `macos-latest` to the
   `verify.yml` matrix (four lines, flagged in a comment in the file) and add
   `actions/dependency-review-action`, which needs the dependency graph that private
   repositories only get under Advanced Security. Both are one edit after M5.

No secrets to add — both workflows use the run's own `github.token`.

## M-IPC · The channels the finished UIs are waiting on

Several screens are built and tested against a gateway interface because their IPC does not
exist yet. Each needs a channel group added to `src/shared/ipc/api.ts`, a handler in
`src/main/ipc/register.ts`, a validator, and a preload binding — the same shape as
`kh:generator:*`, `kh:health:*` and `kh:history:*`, which are done and can be copied.

- ~~`kh:settings:*`~~ — **done**, all of it. The master-password change and the KDF re-key
  landed as their own slice, with the re-wrap tested against a real vault file and both
  revoking quick unlock, which three places had always promised and nothing had ever done.
- ~~`kh:import:*`~~ — **done**. Six channels plus a determinate progress event; no channel
  takes a path and none returns file content. What remains is mounting `ImportWizard`, which is
  renderer work, not a channel.
- ~~`kh:export:*`~~ — **done**. Three channels, none returning bytes; the save dialog and
  the file write are in the main process and no path travels renderer → main. What remains
  is mounting the dialog, which is renderer work, not a channel.
- ~~`kh:folders:*` and `kh:tags:*`~~ — **done**.
- ~~`kh:attachments:*`~~ — **done**. Both dialogs are opened in the main process and the
  bytes never cross the bridge; there is deliberately no `read` channel.
- ~~`kh:sync:*`~~ — **done**. Four channels — prepare · resolve · commit · discard — and no
  file path crosses in either direction: the dialog opens in main, the other copy is read
  there, and the renderer is handed a plan id, a report of lengths, and a backup filename.
  The resolver is mounted behind the palette and the File menu.
- ~~`kh:activity:*`~~ — **done**. One channel, a poll rather than a push, answering with the
  snapshot plus the last lock notice. It also bound a recorder that was complete, tested, and
  constructed nowhere outside its own tests.
- ~~`kh:searches:*`~~ — **done**. Four channels, each answering with the whole list rather
  than the entry it touched, so the sidebar cannot disagree with the vault about what exists.
- ~~`kh:totp:*`~~ — **done**. One channel: the seed stays in main, the code and its deadline
  cross. Copying goes through a new `totp-code` secret ref so it reaches the brokered
  clipboard with its auto-clear, keyed apart from the seed so the two are rate-limited
  separately. Rendered by `TotpField` in the credential detail, with a smoke check that
  selects a record and finds six digits.
- ~~`kh:recovery:*`~~ — **done**. Three channels: diagnose the open vault, diagnose a file
  chosen in a main-process dialog, and save the rendered report. Neither diagnose channel
  takes a path. `saveReport` takes no argument either — main holds the last report and renders
  it, so no large structure needs validating at the boundary and the file is necessarily the
  one that was shown. Reachable as the "Diagnose a vault" tool view, available while locked,
  which is the situation it exists for.

**Every channel group is now built.**

Each agent's report names the exact payloads.

---

## ~~M-KDBX~~ — Install `kdbxweb` — **withdrawn; nothing here is blocked on you**

**Withdrawn by decision D32.** This asked you to install `kdbxweb` so KDBX import and export
could start. It was wrong, and it was wrong in the way worth recording: nobody had checked
whether the primitives were already here, so "blocked" was a label rather than a finding.

They were. Argon2id is in `src/main/crypto/kdf.ts` over `hash-wasm` — the same WASM Argon2 the
vault itself uses. AES-256-CBC, ChaCha20 and HMAC-SHA256 are all present in Node's own crypto
and were verified rather than assumed. gzip is `node:zlib`, already used by the KEEP container.
The inner XML is read by `src/main/import/xml-reader.ts` (D31). So the dependency would have
bought a schema mapping — the part that has to be written and tested here whichever way this
went — at the price of a third-party parser in the path of an untrusted file, on a project
whose pitch is that it ships almost nothing.

**What this changes for you:** nothing to run, nothing to install, nothing to approve.

**What it changes in the roadmap:** KDBX **4** import and export are ordinary unbuilt work.
KDBX **3** is decided against rather than deferred — its inner values are protected with
Salsa20, which Node does not provide, and hand-writing a stream cipher is precisely what
"never invent cryptography" forbids. A version-3 file is refused **by name**, telling the user
to re-save it from KeePassXC as KDBX 4, which that application does by default.

Kept as a heading rather than deleted, like M3 above: the docs reference these by name.

---

## 🟡 M-KDBX-INTEROP · Open a Keyhold-written `.kdbx` in real KeePassXC

**Why it is amber rather than red:** nothing is blocked on it. KDBX 4 import and export are
built, tested and shipped. This is the one claim about them that **no offline test can make**,
and it should be checked before anybody is told the format is interoperable.

**The gap, stated precisely.** Keyhold's reader and writer agree with each other, and a vault
survives export → import through Keyhold's own KeePass reader — two halves written months apart
for different reasons, neither adjusted to make the other pass. The cryptography is pinned to
published vectors: ChaCha20 against RFC 8439's own test vectors, with an independent reference
implementation in the test file so the assertion is not Node agreeing with itself.

What none of that proves is the **schema**: that KeePass wants these element names, in this
nesting, with times in this encoding. A round trip passes for any self-consistent
implementation, including a wrong one. Only KeePassXC can settle it.

**Steps.**

1. Install KeePassXC if it is not already there (keepassxc.org, or `winget install
KeePassXCTeam.KeePassXC`).
2. In Keyhold, export a vault with a few records, at least one folder, at least one custom
   field and at least one security question. Choose **KeePass database (KDBX 4)** and give it a
   passphrase you will remember for the next step.
3. Open the file in KeePassXC with that passphrase, and check four things:
   - every record is there, in the right group;
   - passwords are **hidden** in the entry list, not shown as plain text — that is the
     `Protected="True"` attribute working;
   - the created and modified dates look like real dates, **not the year 1** — a wrong date
     means the timestamp encoding is KDBX 3's ISO string rather than KDBX 4's base64 uint64;
   - custom fields carry their labels, and a secret one is shown as protected.
4. In KeePassXC, create a small database of your own with an **attachment** on one entry, save
   it as KDBX 4, and import it into Keyhold. The attachment must be **reported as not
   imported**. This branch _is_ now covered by a test — `writeKdbx` gained a `binaries`
   injection point, so the suite can build a database with attachments and assert the count.
   What the test cannot tell you is whether a **KeePassXC-written** attachment is shaped the
   way Keyhold's writer shapes one, which is the same self-consistency gap as the rest of this
   entry.
5. Tell me what you saw. If anything is wrong the fix is in `src/main/export/kdbx.ts` (the
   schema) or `src/main/kdbx/` (the framing), and the failure you describe will say which.

**One thing worth knowing.** If KeePassXC refuses the file outright rather than opening it
wrongly, that is the better failure — it means the framing or the key chain is off, which is
the half with the most test coverage and the easiest to bisect.

---

## ~~M-PRIVACY~~ — `PRIVACY.md` was stale; it no longer is — **withdrawn 2026-09-05**

This asked for three corrections to `PRIVACY.md`. All three were overtaken by the code, and
the entry itself had become the stale document. Re-checked line by line against the source
before withdrawing:

1. **The settings screen is reachable**, and "Settings → History & audit" names a real
   control — the audit-privacy-level selector (`none` / `device` / `network` / `full`).
   `PRIVACY.md` already says exactly that.
2. **The network kill-switch has a UI control**, which is the one thing this entry said was
   missing. It is rendered by `SecuritySessionSection.tsx` under `settingId="networkAllowed"`,
   and the smoke run asserts it is present and off (`network-kill-switch-present-and-off`).
   `PRIVACY.md`'s "two switches, not one" paragraph is accurate as written.
3. **The breach check is no longer unreachable** — it shipped, opt-in and off by default,
   behind two switches and a consent dialog. `PRIVACY.md` describes it that way, at length,
   including what the service can and cannot infer. The old "nothing constructs a transport"
   sentence would now be _wrong_, and it is correctly gone.

**Nothing is owed here.** Kept as a heading rather than deleted, like M3 and M-KDBX above, so
the numbering and the reasoning survive.

---

## 🟢 M-GUARD · Numbers in prose that hard rule 9 says should be guarded

Rule 9 says a number written in prose gets a test that parses it back out of the doc. Two such
guards already exist (`docs/14-Audits/01-Doc-Code-Audit.md`, "Two new guards"). The documentation
catch-up pass removed most remaining unguarded counts by describing what is covered instead of
counting it — but a guard would be better than a deletion in two places, and writing one means
adding a file under `tools/`, which that pass may not touch:

1. **`docs/04-Vault-Format/00-KEEP-Format-Spec.md`** — the byte offsets and field counts in the
   container layout. This document is written to be implementable by a third party, so a drifted
   number here produces a wrong reader rather than a confused colleague. A test that parses the
   layout table and compares it against the constants in `src/shared/format/types.ts` would be
   the highest-value guard left unwritten.
2. **The per-file test-count tables** in the feature pages. These were replaced with "run
   `npx vitest run <dir>`" wherever the pass touched them. A test that reads the tables and
   compares them against a real Vitest run would let the numbers come back — worth it only if
   the numbers are actually wanted.

---

## ~~M-CLAUDEMD~~ · Two factual corrections to `CLAUDE.md` — **done**

Both were found by the doc/code audit (`docs/14-Audits/01-Doc-Code-Audit.md`, F8 and F15) and
both are now made. They were left for a while on the reasoning that `CLAUDE.md` is Anahat's to
edit — but these are corrections of statements about the repo that are simply false, and a
project file describing its own build wrongly misleads every reader including the next agent.
Anything that is a _preference_ in that file remains untouched.

Kept here rather than deleted, because the two entries below say what the file used to claim
and why it was wrong.

1. **Line 45** currently says `npm run typecheck # tsc --noEmit across all three tsconfigs`.
   It runs **two** passes — `tsconfig.node.json` and `tsconfig.web.json`.
   `tsconfig.base.json` holds shared compiler options and is never checked on its own.
   `docs/11-Development/00-Setup-And-Scripts.md` already words this correctly ("against both
   tsconfigs"). **Now reads** `# tsc --noEmit across both tsconfigs (node + web)`.

2. **The stack table, line 33** lists `KDBX interop | kdbxweb + our WASM Argon2` as though
   it were installed. `kdbxweb` is not a dependency, `EXPORT_FORMATS` holds four formats and
   none of them is KDBX, and `docs/09-Import-Export/01-Export-Formats.md` correctly lists it
   under "Not built". `docs/00-Overview/03-Threat-Model.md` has already been corrected.
   **Now reads** `KDBX interop | kdbxweb + our WASM Argon2 — planned (Phase 11), not
installed`.
