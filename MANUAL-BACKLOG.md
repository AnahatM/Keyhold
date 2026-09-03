# Manual backlog — tasks for Anahat

Things Claude cannot or should not do. Each entry has enough detail to be done without re-reading
the conversation.

**Legend:** 🔴 blocks further building · 🟡 needed before release · 🟢 whenever convenient

Last updated: 2026-09-03

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

## 🟡 M2 — Test on a real macOS machine

**Blocks:** the macOS half of Phase 18, and honest cross-platform claims in the README.

Windows is the development machine. These need a Mac to verify, and cannot be simulated:

1. `npm run package` produces a working DMG on both Intel and Apple Silicon
2. **Touch ID** quick-unlock enrols, unlocks, and revokes correctly (Electron `safeStorage` → Keychain)
3. **Gatekeeper** behaviour on an unsigned build — confirm the exact right-click → Open steps, and the wording of the dialog, for the README
4. **SSID detection** via `system_profiler SPAirPortDataType` returns what we expect, and fails gracefully with WiFi off
5. Clipboard `org.nspasteboard.ConcealedType` genuinely keeps secrets out of clipboard-history apps
6. The native menu bar reads correctly (macOS conventions differ from Windows)
7. `.keep` file association works on double-click

---

## ~~M3~~ — Install project dependencies — **done, and no longer a live item**

`npm install` succeeded during Phase 0 and `node_modules/` has been present ever since; every
gate run in this repo depends on it. Kept as a heading rather than deleted so the numbering
stays stable — M4, M5 and M6 are referenced from the docs by number.

**The one dependency that is still outstanding is `kdbxweb`** — that is M-KDBX below, and it
is a separate decision rather than a rerun of this.

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

## 🟢 M6 — Decide whether a project website is wanted

Backlog G2. GitHub Pages is free and would host screenshots, the comparison table and downloads.
Only worth doing once there is something to show.

---

## Done

_(nothing yet)_

---

## M-ICON · An application icon

`build/icon.png` (512×512 or larger, with an `.ico` and `.icns` derived from it) does not
exist. `electron-builder.yml` and the README's header both want one. Until then the README
uses an emoji and the packaged app gets Electron's default icon.

## M-PKG · Confirm a packaged build actually unlocks a vault

**Unblocks:** the first release. Nothing else can be verified until this is done once.

`electron-builder.yml` is written and schema-valid, but **no packaged build has ever been
produced**. The specific risk it was written to contain: `src/main/crypto/kdf-runner.ts`
starts the Argon2 worker from a **runtime path**, not an import. Inside an asar that depends
on Electron's fs shim reaching into the archive from a worker thread. If it fails, the app
builds, launches, shows the unlock screen — and can never derive a key. Nothing in `build`,
`test` or `test:smoke` would notice, because none of them run against an asar.

`asarUnpack` should prevent it. Confirming it costs one run:

```bash
npm run package:dir
# then launch the unpacked build and unlock a vault
```

Then the full path: `npm run package:win`, install it, unlock a vault.
macOS needs a Mac (see M2).

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
- `kh:totp:*`, `kh:recovery:*` — once those engines are finished.

Each agent's report names the exact payloads.

---

## 🔴 M-KDBX · Install `kdbxweb`, which the stack claims is already here

**Blocks:** KDBX import (roadmap Phase 8) and KDBX 4 export (Phase 10). Both are the last
unbuilt formats, and neither can start without this.

**Where it stands.** `CLAUDE.md`'s stack table already says this honestly — "`kdbxweb` + our
WASM Argon2 — planned (Phase 11), not installed" — so nothing there needs correcting.
`package.json`'s `dependencies` are `@zxcvbn-ts/core`, `@zxcvbn-ts/language-common`,
`hash-wasm`, `react`, `react-dom` and `zustand`, and no source file imports `kdbxweb`. The
roadmap's two KDBX lines are simply waiting on this install, and this entry is the step that
unblocks them.

**Why I have not done it.** Installing a package is yours by rule (§7): it writes
`package-lock.json`, it pulls a dependency tree I cannot review the provenance of on your
behalf, and this one will end up parsing untrusted files that users hand it.

**Steps.**

1. From `C:\Dev\Credentials-App`:
   ```
   npm install kdbxweb@2.1.1 --save-exact
   ```
   Pinned exactly, like `hash-wasm@4.12.0` beside it — this library reads attacker-supplied
   files, so the version that was reviewed is the version that should ship.
2. Confirm it landed in `dependencies` and **not** `devDependencies`. It ships in the app,
   so a `devDependencies` entry would work in `npm run dev` and be missing from the packaged
   build — the failure only users see.
3. Run `npm run verify:full` and tell me it is green.
4. Tell me it is installed and I will build the importer and the exporter.

**Two things worth knowing before you run it.**

- `kdbxweb` does **not** bundle Argon2; it expects the host to supply one. That is exactly
  why the stack table pairs it with our WASM Argon2, and it is good news: the KDF stays the
  audited `hash-wasm` path already used for `.keep` files, and no native binding enters the
  tree.
- Check what the install adds. If it pulls a native module, stop and tell me — hard rule
  "`hash-wasm` (pure WASM — **never** a native binding)" exists because a native binding
  breaks the cross-platform build, and the same reasoning applies to anything arriving
  underneath this.

**If you would rather not add it at all**, say so and I will mark KDBX import and export as
declined in the roadmap rather than leaving two lines open forever. Keyhold can already
import KeePass **CSV**, which is the path most KeePass users take; `.kdbx` is the better one
because it is lossless and needs no plaintext intermediate file, but it is not the only door.

---

## 🟡 M-PRIVACY · `PRIVACY.md` has gone stale in the under-claiming direction

**Why it is amber rather than green:** `PRIVACY.md` is a published promise about behaviour, and
a promise that is wrong — in either direction — is the one kind of documentation defect that
costs trust rather than time. It is outside the paths the documentation pass may edit.

It was corrected once (doc-audit finding F7) to say that the settings screen, the consent screen
and the global network kill-switch did not exist. Two of those three have since landed:

1. **The settings screen is reachable.** `SettingsScreen` is the `settings` tool view, mounted by
   `src/renderer/src/vault/VaultScreen.tsx` and openable from the sidebar's tool rows or the
   native **Settings** menu item. "Settings → Privacy" no longer names a route that does not
   exist — and the audit-privacy-level control (`none` / `device` / `network` / `full`) really is
   in the history-and-audit section of that screen, so that sentence is now simply true.
2. **The global network kill-switch exists** — `src/main/network-policy.ts` plus the
   machine-scoped `Preferences.networkAllowed`, off by default and fail-closed (decision D23).
   What does **not** exist is a UI control for it: it is writable over
   `kh:settings:update-machine` and nothing renders a toggle, so today it is reachable only by
   editing `preferences.json` in the user-data directory. Say that plainly rather than implying
   a switch in Settings.
3. **Still true, and worth keeping as the strongest sentence on the page:** the breach check is
   unreachable. Nothing constructs a transport, so no code path in the running app makes a
   request — a guarantee stronger than a setting.

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
