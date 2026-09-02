# Manual backlog — tasks for Anahat

Things Claude cannot or should not do. Each entry has enough detail to be done without re-reading
the conversation.

**Legend:** 🔴 blocks further building · 🟡 needed before release · 🟢 whenever convenient

Last updated: 2026-09-02

---

## 🔴 M1 — Create the private GitHub repository and push

**Blocks:** the explicit request _"setup a git repo in this codebase and push it online to GitHub
privately for now"_ (decision D12). Local git is already initialised and committed — only the remote
is missing.

**Status:** GitHub CLI is **not installed** on this machine (checked 2026-09-02: `gh` is not on
PATH, not in `%ProgramFiles%\GitHub CLI`, not in `%LOCALAPPDATA%\GitHubCLI`). Git itself is fine
(2.55.0) and the identity is already set to `Anahat <61635745+AnahatM@users.noreply.github.com>`.

### Option A — install the GitHub CLI (recommended; then Claude can do the rest)

```powershell
winget install --id GitHub.cli -e
```

Close and reopen the terminal, then:

```powershell
gh auth login
# → GitHub.com → HTTPS → authenticate with a browser
```

Tell Claude once that is done and it will run the repo creation and push itself.

### Option B — create it in the browser (works fine from a phone)

1. Go to <https://github.com/new>
2. **Repository name:** `Keyhold`
3. **Visibility:** **Private**
4. **Do not** initialise with a README, `.gitignore`, or a licence — the local repo already has them
5. Create, then tell Claude. It will run:

```bash
git remote add origin https://github.com/AnahatM/Keyhold.git
git branch -M main
git push -u origin main
```

_(If a credential prompt appears on the push, Git Credential Manager will open a browser window.)_

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

## 🟡 M3 — Install project dependencies if Claude's `npm install` is blocked

Claude will attempt `npm install` during Phase 0. If it fails for permissions or network reasons,
run it manually in `C:\Dev\Credentials-App` and say so.

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

## M-README · Regenerate the README screenshots

**Unblocks:** the README's Screenshots section, which currently explains how they are made
rather than showing them.

The capture is automated — it just needs a tree that builds. Run:

```bash
npm run build
node tools/smoke.mjs --shots docs/images
```

That writes `docs/images/Keyhold-Screenshot-0{1..4}.png`: the populated list and detail pane,
the history timeline, the timeline with a diff expanded, and the same view in the light
theme. Then replace the note in the README's Screenshots section with the 2×2 image table
(the markup is in this file's history, or follow `docs/06-UI-Design-System/`).

**Why it is not done:** the capture refuses to run against a stale build, and the build was
failing on another in-flight change at the time. Not a defect — the guard doing its job.

## M-ICON · An application icon

`build/icon.png` (512×512 or larger, with an `.ico` and `.icns` derived from it) does not
exist. `electron-builder.yml` and the README's header both want one. Until then the README
uses an emoji and the packaged app gets Electron's default icon.
