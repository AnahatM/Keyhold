# Building & releasing

> How Keyhold turns into files a person can download, what those files are, why they are
> unsigned, and what a maintainer has to do by hand. Current reference — update it in the
> same pass as `electron-builder.yml` or `.github/workflows/`.

**Status.** The configuration in this folder is written but **not yet exercised**. No
packaged build has been produced, no workflow run has happened, and there is no macOS
machine in the project (`MANUAL-BACKLOG.md` M2). Everything below that describes a
_decision_ is reliable; everything that describes a _result_ is a prediction until the
first release proves it. The [Unverified](#what-is-unverified) section at the end lists
exactly which is which.

---

## Three repository fixes that had to happen first — all done

Kept as a record rather than a task list: each was invisible from inside
`electron-builder.yml`, each would have failed the first CI run, and each is the kind of
thing that is obvious only in hindsight.

1. **`.gitignore` ignored `build/`.** `directories.buildResources: build` is where icons,
   installer artwork and the entitlements plist live, and the ignore line had been written
   for an output folder this project does not have — electron-vite writes `out/` and
   electron-builder writes `release/`, both ignored separately. The effect was that no CI
   checkout had an icon and every automated build would have come out unbranded. The line is
   gone and a comment stands where it was so nobody re-adds it. The icons come from
   `npm run icons`; do not edit them by hand, because `tools/icons.test.ts` regenerates them
   and compares bytes. See [`build/README.md`](../../build/README.md).
2. **`package:dir` did not exist.** It produces the unpacked application directory without an
   installer or a DMG — seconds rather than minutes, and the fastest way to check the two
   things that exist only in a packaged build: that the asar contains what it should, and
   that the Argon2 worker loads from `app.asar.unpacked` (see
   [The Argon2 worker](#the-argon2-worker-and-asar)).
3. **The repository was not Prettier-clean.** `verify.yml` runs `format:check`, which
   `npm run verify` did not at the time, so the first CI run would have failed on formatting
   rather than on anything real. `npm run format` once fixed it; `format:check` now sits
   inside `verify:full`, which is what stops the drift coming back.

**No `devDependencies` change was ever required.** `electron-builder` is pinned at
`26.15.3` and `electron` at `44.1.1`; the packaging toolchain was installed at scaffold time.

---

## Building locally

### Windows

```bash
npm run verify:full        # never package something you have not gated
npm run package:win        # NSIS installer + portable exe, x64 and arm64
```

Output lands in `release/`. First run downloads the NSIS toolchain and the Electron
binaries for both architectures — expect several minutes and a few hundred megabytes of
cache. Subsequent runs are much faster.

### macOS

```bash
npm run verify:full
npm run package:mac        # universal DMG + universal zip
```

Must run **on macOS**. Codesigning — even the ad-hoc signature Keyhold uses — and DMG
creation both shell out to Apple tooling that exists nowhere else. There is no
cross-compilation story here and there is not going to be one.

### Neither platform builds the other

Windows cannot produce a DMG and macOS cannot produce a signed NSIS installer that behaves
correctly. This is why the release workflow uses a two-runner matrix rather than one job.

---

## The artifacts

| File                                  | Platform | What it is                                                       |
| ------------------------------------- | -------- | ---------------------------------------------------------------- |
| `Keyhold-<version>-win-setup.exe`     | Windows  | NSIS installer. Registers file associations, Start-menu shortcut |
| `Keyhold-<version>-win-portable.exe`  | Windows  | Single executable. Installs nothing, registers nothing           |
| `Keyhold-<version>-mac-universal.dmg` | macOS    | Disk image, arm64 + x64 in one binary                            |
| `Keyhold-<version>-mac-universal.zip` | macOS    | The same `.app`, zipped — for people who dislike mounting images |
| `SHA256SUMS-windows.txt`              | —        | Checksums for the Windows files                                  |
| `SHA256SUMS-macos.txt`                | —        | Checksums for the macOS files                                    |

Names come from `artifactName` in `electron-builder.yml`. They are deliberately
lowercase-and-hyphens with no spaces, because a filename with a space in it is a filename
that breaks somebody's verification command.

`-${arch}` is removed automatically by electron-builder when a target produces one
artifact covering several architectures, which is why the macOS names read `universal` and
the Windows names have no arch segment at all when NSIS emits a single combined installer.

### The portable build is a real feature, not a fallback

Keyhold's audience includes people who would rather not have a password manager write to
the registry, create shortcuts, or claim file types. The portable executable does none of
those things: it unpacks to a temporary directory, runs, and leaves. It also registers no
file associations, which is a consequence of the same choice rather than an oversight.

---

## What is inside the package

`files` in `electron-builder.yml` is an **allow-list**: `out/**/*` and `package.json`, and
nothing else. `src/`, `tests/`, `tests/fixtures/`, `tools/`, `docs/`, every `tsconfig`,
and the ESLint and Prettier configuration are excluded because they were never included,
not because somebody remembered to exclude them. That is the difference between a rule and
a habit.

Source maps are excluded explicitly on top of that. Production builds do not emit them
today, but a `.map` shipped beside a password manager is a free map of its internals, and
the exclusion means turning `build.sourcemap` on for an afternoon's debugging cannot leak
one into a release.

Production dependencies are collected separately by electron-builder and are unaffected by
the `files` list. They are needed: `electron.vite.config.ts` sets `externalizeDeps: true`
for the main bundle, so `hash-wasm` and `@zxcvbn-ts/*` are resolved from `node_modules` at
runtime rather than inlined.

> **Known slack.** `react`, `react-dom` and `zustand` are declared in `dependencies` but
> are bundled into the renderer by Vite, so the copies in `node_modules` ship without ever
> being loaded. It is on the order of a megabyte. Excluding them is possible but is the
> kind of optimisation that turns into a blank window six months later, so it has not been
> done. Revisit only with a packaged smoke test in place to catch the mistake.

### The Argon2 worker and asar

This is the most fragile thing in the packaged app, and it is worth understanding before
changing anything near it.

`src/main/crypto/kdf-runner.ts` starts the key-derivation worker with
`new Worker(join(import.meta.dirname, 'kdf-worker.js'))` — a **path**, resolved at
runtime, not an import the bundler can see. Inside an asar archive that path points at a
virtual file, and loading it depends on Electron's `fs` shim reaching into the archive
from a worker thread.

If that fails, the failure mode is horrible: the app builds cleanly, launches cleanly,
shows its unlock screen, and then cannot derive a key — so it cannot open any vault at
all. Nothing in `npm run build`, `npm test` or `npm run test:smoke` would notice, because
none of them run against an asar archive.

So `electron-builder.yml` unpacks it:

```yaml
asarUnpack:
  - out/main/kdf-worker.js
```

The file then exists on disk under `app.asar.unpacked/`, and Electron's path translation
for unpacked files is the same well-trodden mechanism that native `.node` modules have
used for a decade.

**This still has to be confirmed once, by hand, by unlocking a real vault in a packaged
build.** It is on the release checklist for that reason.

---

## Opening a file from the shell

`electron-builder.yml` registers `.keep`, `.keepx` and `.keeptheme` with the OS. That is
only half the feature: registration makes the OS hand Keyhold a path, and the main process
currently ignores it. The work below belongs in `src/main/index.ts` and is not yet done.

`.keepbak` is deliberately **not** registered. A rolling backup that opens on double-click
invites someone to work inside a file the app is about to overwrite.

### What has to change

**One place decides what an acceptable path is.** Everything else routes through it.

```ts
const OPENABLE_EXTENSIONS = new Set(['.keep', '.keepx', '.keeptheme']);

/** The first argv entry that looks like a file we handle. */
function openableFileFrom(argv: readonly string[]): string | undefined {
  return argv
    .slice(1) // argv[0] is the executable
    .find((arg) => !arg.startsWith('-') && OPENABLE_EXTENSIONS.has(extname(arg).toLowerCase()));
}
```

**Windows and Linux — first launch.** The path arrives in `process.argv`. Note that in
development `electron-vite` passes `.` as an argument, which the extension check above
already rejects.

**Windows — subsequent launches.** The single-instance lock in `src/main/index.ts` already
catches these, but its handler currently discards the arguments:

```ts
// today
app.on('second-instance', () => {
  focusMainWindow();
});

// needed
app.on('second-instance', (_event, argv) => {
  focusMainWindow();
  handleOpenRequest(openableFileFrom(argv));
});
```

Without that, double-clicking a `.keep` while Keyhold is already running focuses the
window and does nothing else, which reads as a bug.

**macOS.** The path never arrives in `argv`. It comes as an event:

```ts
app.on('open-file', (event, path) => {
  event.preventDefault(); // or macOS assumes we declined and handles it itself
  handleOpenRequest(path);
});
```

This listener **must be registered at module scope, before `app.whenReady()`**. On macOS
the event can fire before the app is ready — that is exactly what happens when a
double-clicked file is what launched the app — so `handleOpenRequest` needs to buffer the
path and replay it once the window exists.

### Rules for handling it

1. **Never auto-unlock.** A path from the shell selects a vault on the unlock screen. It
   does not prompt for a master password in a modal, and it does not touch any stored
   credential. Anything that opens a vault as a side effect of a double-click is a
   different threat model to the one in `docs/00-Overview/03-Threat-Model.md`.
2. **The file is untrusted input.** A `.keep` handed over by the shell goes through the
   same container parser, with the same size and structure limits, as one chosen from the
   in-app file picker. There is no shortcut path.
3. **A `.keeptheme` goes through theme import validation**, unchanged. It is a JSON token
   map from an unknown source; the fact that the OS passed it along says nothing about it.
4. **The path is not a secret, but it is not nothing either.** `C:\Users\anahat\work\
employer-vault.keep` in a log line or a crash report tells a reader things. Treat it as
   the metadata it is.

### No custom URL scheme

`protocols:` is absent from `electron-builder.yml` on purpose. A `keyhold://` handler is a
remotely triggerable entry point into a password manager — any web page could invoke it —
and no feature needs one. If one ever does, it is a decision-log entry before it is a
config change.

---

## Unsigned builds: what a user actually sees

Keyhold ships **unsigned**. This is decision D16 and `MANUAL-BACKLOG.md` M4, and it
follows directly from decision D11: the project costs its author nothing to run.

Being straight about this matters more than usual. Keyhold's pitch is that you should not
have to trust a company with your passwords — so it would be dishonest to then paper over
the fact that your operating system cannot verify who built the binary you are about to
install. It genuinely cannot. Here is what that looks like and what to do about it.

### Windows — SmartScreen

Downloading and running the installer produces a blue dialog: **"Windows protected your
PC"**, with body text saying Microsoft Defender SmartScreen prevented an unrecognised app
from starting. There is no visible way forward on that dialog until you click **More
info**, which reveals a **Run anyway** button.

If the file itself was blocked on download, Windows applies a mark-of-the-web and the
dialog may not even appear — instead nothing happens. Right-click the file →
**Properties** → tick **Unblock** at the bottom → **OK**, then run it.

The installer's UAC prompt will show **Publisher: Unknown**. That is accurate.

**SmartScreen reputation does not accrue for unsigned software.** A signed application
earns trust as download counts rise; an unsigned one shows the same warning on the ten
thousandth download as on the first. There is no free path around this, only the honest
one: explain it, and publish a checksum so the warning is the only thing standing between
the user and a file they can independently verify.

### macOS — Gatekeeper

The app is **ad-hoc signed**, not truly unsigned. That distinction is worth stating
because it changes what the user sees: on Apple Silicon a genuinely unsigned binary will
not launch at all — macOS reports it as damaged and offers only "Move to Bin". An ad-hoc
signature costs nothing, requires no Apple Developer account, and gets the app to the
ordinary unidentified-developer prompt instead, which has a way through.

That way through, on current macOS: launch the app, get refused, then open **System
Settings** → **Privacy & Security**, scroll to the bottom, and click **Open Anyway** next
to the message about Keyhold. Confirm with a password or Touch ID.

The old right-click → **Open** shortcut was removed in recent macOS versions. Any
instructions that still recommend it — including plenty on the internet — are out of date.

> The exact dialog wording is **not verified**. There is no Mac in this project
> (`MANUAL-BACKLOG.md` M2), and the wording has changed between macOS releases. Confirm it
> on a real machine before it goes into the README.

### What signing would cost, for the record

- **Windows**, an OV or EV code-signing certificate: roughly **$200–400 per year**. EV
  additionally grants immediate SmartScreen reputation; OV does not.
- **macOS**, Apple Developer Program membership: **$99 per year**. This is what enables
  Developer ID signing and notarisation, which together remove the Gatekeeper prompt
  entirely.
- **Azure Trusted Signing**: around **$10 per month**, cheaper but still recurring, and
  still requires an organisation identity check.

All three are money, and money is the thing this project has decided not to spend. They
are recorded here so the option is visible, not because any of them is a recommendation.

`build/entitlements.mac.plist` exists and is inert precisely so that if that ever changes,
turning signing on is a three-line edit rather than an afternoon of research.

---

## The checksum story

For a signed binary, the signature is the integrity story and a checksum is a nicety. For
an unsigned one the checksum is the **entire** integrity story, so it is worth doing
properly rather than as a gesture.

Every release publishes `SHA256SUMS-windows.txt` and `SHA256SUMS-macos.txt` in the exact
format both `sha256sum -c` and `shasum -a 256 -c` accept:

```
9f2c...a1  Keyhold-1.0.0-win-setup.exe
```

They are generated on the runner that produced the artifacts, from those artifacts,
immediately after packaging.

**And they are published twice.** The release workflow also writes them into the build
job's step summary. This is the part that actually matters: a release page can be edited
at any time by anyone with write access to the repository, and an edited release page
would show a hash matching a swapped binary. A completed Actions run's summary cannot be
edited. Two records that must agree is a meaningfully stronger claim than one record, and
it costs three lines of YAML.

A user's verification, in full:

```bash
# macOS
shasum -a 256 -c SHA256SUMS-macos.txt
```

```powershell
# Windows PowerShell
Get-FileHash -Algorithm SHA256 .\Keyhold-1.0.0-win-setup.exe
```

Then compare against the release page **and** the Actions run summary. If they disagree,
do not install the file, and open a security report (`SECURITY.md`).

### Free ways to add a third record, later

Neither costs anything, and both amount to a checksum held by somebody who is not us:

- **winget** manifests carry a required `InstallerSha256`, stored in Microsoft's
  repository.
- **Homebrew Cask** formulae carry a required `sha256`, stored in Homebrew's.

Both are worth doing once there is a v1 to submit. Backlog material, noted here because
the reasoning belongs with the rest of the checksum argument.

---

## Continuous integration

Three workflows, all in `.github/workflows/`.

| Workflow      | Trigger                  | Runner           | What it does                                  |
| ------------- | ------------------------ | ---------------- | --------------------------------------------- |
| `verify.yml`  | push to `main`, every PR | `windows-latest` | Formatting, then `npm run verify:full`        |
| `release.yml` | tag `v*`                 | Windows + macOS  | Test, package, checksum, upload to a draft    |
| `audit.yml`   | weekly, manual           | `ubuntu-latest`  | `npm audit` on runtime and build dependencies |

### Actions are pinned to commit SHAs

Every `uses:` names a 40-character commit SHA with the version in a trailing comment:

```yaml
uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
```

A tag is a mutable pointer. The owner of an action repository can move `v7` to any commit
at any time, and every workflow tracking `@v7` runs it on the next trigger. For most
projects that is a theoretical risk. For the CI that builds the binaries of a password
manager it is the whole ballgame — a moved tag is arbitrary code execution inside the job
that produces the artifacts users download.

Dependabot understands this format: it bumps the SHA and rewrites the comment, so pinning
does not mean going stale.

### Why the gate is Windows-only

On a **private** repository GitHub meters Actions minutes with a platform multiplier:
Linux 1×, Windows 2×, macOS **10×**. The free allowance divided by ten is not many macOS
runs. Keyhold's owner pays for nothing (decision D11), so macOS is not in the pull-request
gate.

This is a real gap and it is worth naming rather than burying: **a macOS-only regression
can reach a release tag.** Two things partially cover it — the release workflow runs the
launch smoke test on `macos-latest` before uploading anything, and `MANUAL-BACKLOG.md` M2
is the manual pass on real hardware.

The moment the repository goes public (`MANUAL-BACKLOG.md` M5) standard runners are free,
and `verify.yml` should become a matrix over `windows-latest` and `macos-latest`. It is a
four-line change, flagged in a comment in the file itself.

Linux is absent for a different reason: it is not built or shipped at all (backlog F1).

### The launch smoke test in CI — what is actually true

`npm run test:smoke` spawns a real Electron process and drives a real window. Whether that
works depends entirely on whether the runner has a display.

| Runner           | Display              | Smoke test                                  |
| ---------------- | -------------------- | ------------------------------------------- |
| `windows-latest` | Interactive desktop  | **Runs**, in `verify.yml` and `release.yml` |
| `macos-latest`   | WindowServer session | **Runs**, in `release.yml`                  |
| `ubuntu-latest`  | **None**             | Would need `xvfb-run --auto-servernum`      |

Windows and macOS runners both have a window server, and Chromium falls back to software
rendering when no GPU is present, so no virtual display is needed on either. Linux runners
have no display server at all; a smoke test there would need `xvfb-run`. Since Linux is
not a shipped platform, no Linux job exists and the question is academic — but the answer
is written into `verify.yml` next to the step, so the next person does not have to
re-derive it.

**Nothing is conditionally skipped and nothing is `continue-on-error`.** A smoke test that
CI skips is a smoke test that does not exist. If it turns out to be flaky on a runner, the
fix is to make it work or to say plainly that it does not run there — not to add an `if:`
that quietly makes the job green.

**What the smoke test does not cover:** the packaged artifact. It runs against `out/`, so
it says nothing about the asar archive, the ad-hoc signature, the unpacked Argon2 worker,
or the installer. Those are checklist items below, and a packaged smoke test would be a
genuinely valuable addition to `tools/`.

### The audit job

Runtime dependencies (`npm audit --omit=dev --audit-level=moderate`) **fail** the job —
those packages end up inside the shipped app, where a vulnerability in one is a
vulnerability in Keyhold. Build-time dependencies are reported but do not fail, because
the ESLint/Vite/electron-builder tree produces advisories often enough that failing on
them would train everyone to ignore the workflow entirely.

`actions/dependency-review-action` would be the natural per-PR companion, but it needs
GitHub's dependency graph, which private repositories only get under Advanced Security.
Add it when the repository goes public.

> Scheduled workflows are automatically disabled after **60 days** of repository
> inactivity. If the audit stops appearing, that is why; re-enable it from the Actions tab.

### Dependabot

`.github/dependabot.yml` is committed and live. It was expected to need adding by hand — the
reasoning being that it "is not a workflow file" — but that restriction is about
`.github/workflows/`, which a token lacking the `workflow` scope cannot push. `dependabot.yml`
is not in that directory, and pushed like any other file. This is what is in it:

```yaml
# SPDX-License-Identifier: GPL-3.0-or-later
version: 2
updates:
  # Grouping the routine tooling churn into one pull request keeps the queue readable, so
  # that an ungrouped PR is a signal rather than noise. Electron, electron-builder and the
  # crypto dependencies are deliberately left ungrouped — each deserves reading.
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 5
    groups:
      dev-tooling:
        dependency-type: development
        update-types:
          - minor
          - patch

  # This is what makes SHA-pinned actions maintainable: Dependabot rewrites both the SHA
  # and the trailing version comment.
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

Issue and pull-request templates (`.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md`)
were the other half of that Phase 18 line and are committed for the same reason.

The bug template opens by asking people **not** to paste a password, a vault file or an
export, and points a security report at `SECURITY.md` rather than at a public issue —
`config.yml` puts that link above the "blank issue" option, where somebody in a hurry will
see it. The pull-request template's second checkbox is the one that matters: every guard has
to have been fault-injected, because a guard nobody has watched fail is not known to work.

---

## The release checklist

Work top to bottom. Steps marked **manual** cannot be automated and are the reason the
release is created as a draft rather than published.

**Before tagging**

1. `npm run verify:full` is green locally.
2. `CHANGELOG.md` has an entry for the version.
3. `MANUAL-BACKLOG.md` has nothing 🔴 outstanding.
4. `package.json` `version` is the version you are about to tag. The workflow refuses to
   proceed if the tag and the file disagree, but finding out locally is quicker.
5. `build/icon.ico` and `build/icon.icns` are committed and current — `npm test` covers
   this, because `tools/icons.test.ts` regenerates them and compares bytes.

**Tag**

```bash
git tag -a v1.0.0 -m "Keyhold 1.0.0"
git push origin v1.0.0
```

**CI does** — draft the release, build on both platforms, run the tests and the launch
smoke test, generate checksums, upload everything, and print the checksums into the job
summary.

**Then, by hand, before publishing** — every one of these is a thing CI structurally
cannot check:

6. **manual** Install from the Windows NSIS installer on a clean machine or VM. Confirm
   the SmartScreen steps in this document are still accurate.
7. **manual** **Create and unlock a vault in the installed build.** This is the check that
   catches the Argon2-worker-in-asar failure mode. Nothing automated covers it.
8. **manual** Double-click a `.keep` file. Confirm the association works and that it
   selects the vault without unlocking it.
9. **manual** Run the portable executable. Confirm it registers nothing and leaves nothing
   behind.
10. **manual** Uninstall. Confirm settings and window state survive
    (`deleteAppDataOnUninstall: false`) and that no vault file was touched.
11. **manual** On macOS: mount the DMG, drag to Applications, walk the Gatekeeper prompt,
    and repeat steps 7 and 8. This is `MANUAL-BACKLOG.md` M2.
12. **manual** Verify the published checksums against the Actions job summary, and against
    a hash you compute yourself from the downloaded file.
13. Publish the draft.

**After publishing**

14. Confirm the download links in the README point at the new version.
15. If the repository is public, consider the winget and Homebrew Cask submissions.

---

## Platforms: what is published, and what is built from source

**GitHub releases carry the Windows build only.** There is no Mac on this project, and
buying one to ship a build nobody has asked for yet is not a good trade. macOS and Linux
users build from source — `npm install && npm run package:mac` or `:linux`, one command,
no toolchain beyond Node, because there is no native code anywhere in Keyhold that would
need compiling per architecture.

That is an honest position for a GPL project and a better one than an unsigned Mac build
Gatekeeper refuses to open anyway. **It has to be said in the README's download section**
rather than left for a macOS visitor to discover by finding no asset, and it is.

**Nothing in Keyhold is Windows-only.** Quick unlock, the network-name probe and the
`mac` and `linux` blocks of `electron-builder.yml` all have their branches written. They
have simply never been _run_. The first person to build on a Mac is the first person to
find out, and publishing that plainly is better than implying coverage that does not exist.

---

## What is verified, and how

**The packaged Windows build runs, and the Argon2 worker loads from `app.asar.unpacked`.**
That was the one thing the asar arrangement could not prove about itself, and it is proven:
`vault.create` returned `ok` after ~3.1 s of Argon2 inside the packaged app, lock and unlock
both succeeded, and a wrong passphrase was refused with an error naming neither path nor
password. Three seconds of Argon2 _is_ the redirect working — had it failed, the worker
would never have loaded and no key would have been derived at all.

**How to repeat it, because the obvious route is closed by design.** `isSmokeRun()` is gated
on `!app.isPackaged` (`src/main/smoke.ts`), so `npm run test:smoke` cannot be pointed at a
packaged build: the environment variable is the request and the gate is the permission. The
route that works is to launch the executable with `--remote-debugging-port`, attach over the
Chrome DevTools Protocol, and call the preload bridge directly:

```bash
npm run package:dir
release/win-unpacked/Keyhold.exe --user-data-dir=<a throwaway profile> --remote-debugging-port=9444
# then, against http://127.0.0.1:9444/json/list, evaluate in the page:
#   await window.keyhold.vault.create('<a temp path>.keep', '<a passphrase>')
```

It needs no change to the app, and it is the technique to reach for any time a question can
only be answered by a build that is actually packaged.

---

## What is still unverified

Stated plainly, because the alternative is implying a level of confidence this work does
not have.

- **The NSIS installer has never been produced or run.** `package:dir` exercises the
  unpacked application and nothing about the installer, its shortcuts, its uninstaller or
  its file association.
- **There is no Mac.** The universal build, the ad-hoc signature, the DMG, the Gatekeeper
  wording and the `.keep` association on macOS are all unexercised.
- **The universal macOS build may need to become two per-architecture builds.** Keyhold
  contains no native code, which is the condition for `lipo` having nothing arch-specific
  to reconcile, so it should work. If it does not, the fallback is `arch: [x64, arm64]`
  under `mac.target` and two artifacts instead of one.
- **No Linux build has been produced**, though the AppImage, deb and rpm targets are
  configured and the `nmcli` network probe is written.
- **DMG creation is occasionally flaky on hosted macOS runners** (`hdiutil` reporting a
  busy resource). If it appears, re-running the job is the usual fix; if it recurs, it
  needs a retry step rather than a shrug.

---

## Related

- [`electron-builder.yml`](../../electron-builder.yml) — the configuration itself, commented
- [`build/README.md`](../../build/README.md) — icon specifications and installer artwork
- [`docs/11-Development/00-Setup-And-Scripts.md`](../11-Development/00-Setup-And-Scripts.md) — every npm script and the local gate
- [`docs/12-Roadmap/02-Decision-Log.md`](../12-Roadmap/02-Decision-Log.md) — D11 (costs nothing), D16 (unsigned), D14 (pure-WASM Argon2)
- [`docs/12-Roadmap/01-Feature-Backlog.md`](../12-Roadmap/01-Feature-Backlog.md) — F-series, platform and distribution
