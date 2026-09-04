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

## 🟢 M6 — Decide whether a project website is wanted

Backlog G2. GitHub Pages is free and would host screenshots, the comparison table and downloads.
Only worth doing once there is something to show.

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

## 🟡 M-PKG · Launch the packaged build and unlock a vault

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

**What is left, and it is only yours because it means running a binary.**

1. Launch `release\win-unpacked\Keyhold.exe`.
2. Create a vault, set a master password, and **watch the unlock progress bar move**. That is
   Argon2 running in the worker inside the packaged app, and it is the one thing none of the
   above proves. If it hangs at 0% or the app reports it cannot derive a key, the redirect
   failed and I want to know immediately.
3. Add a credential, lock, unlock again with the same password.
4. Then the installer path: `npm run package:win`, install it, and unlock a vault from the
   installed copy. SmartScreen will warn — the build is unsigned by decision D16 (M4).
5. macOS needs a Mac (M2).

Tell me what you saw. A failure here is a packaging fix, not a code fix, and the shape of what
you describe will say which.

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
   imported** — that path counts attachments out of the inner header and is the one branch no
   test in this repo can reach, because Keyhold's own writer never emits one.
5. Tell me what you saw. If anything is wrong the fix is in `src/main/export/kdbx.ts` (the
   schema) or `src/main/kdbx/` (the framing), and the failure you describe will say which.

**One thing worth knowing.** If KeePassXC refuses the file outright rather than opening it
wrongly, that is the better failure — it means the framing or the key chain is off, which is
the half with the most test coverage and the easiest to bisect.

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
