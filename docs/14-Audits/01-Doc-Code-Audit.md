# Documentation audit — 2026-09-02

> Every page under `docs/`, plus the root markdown files, checked against the code it
> claims to describe. `docs/superpowers/specs/` is excluded by rule: it is frozen history
> and a drifted spec there is a record, not a defect.
> Point-in-time snapshot, not current reference.
>
> **Scope note.** `src/` was being actively written while this ran, and nine main-process
> subsystems — `activity`, `attachments`, `breach`, `organisation`, `recovery`, `shell`,
> `sync`, `theme`, `totp` — appeared after the sweep. They have no documentation yet, so
> they generate no findings here, but they will invalidate several "not built yet" sections
> the moment they are wired up. F2 and F7 are the ones already moving.

---

## Summary

**The guarded numbers held; the unguarded ones did not.** Every figure this project bothered
to pin — the Argon2 floors and ceilings, the 12- and 16-byte cryptographic sizes, the 256 MiB
decompression bound, the broker's 30-second TTL and 60-per-minute limit, the throttle's
doubling table, the eight themes, "77 tests", "19 covering durability", "62 tests", "40
checks" — was verified against the code and every one of them is correct. That is the
"ship the guard with the system" rule visibly paying off, and it is worth saying before the
findings, because the findings are all in the places where that rule was not applied.

What has rotted is of three kinds, in descending order of danger. **Absence claims**, which
fail silently by definition: three "not built yet" sections describe features that are now
built, and one "never crosses" row in the architecture doc describes a boundary that has
since moved. **Counted lists** written in prose and never re-counted: fourteen custom-field
types that are thirteen, eight health rules that are nine, eleven parsers that are twelve,
eighteen import formats that are twelve, seventeen decisions that are twenty-two.
**Present-tense descriptions of unbuilt things** in user-facing documents — `PRIVACY.md`
describes a Settings screen and a network kill-switch that do not exist, and the threat model
lists KDBX export as a mitigation the user has today.

Two structural items sit above all of those. `CHANGELOG.md` still says "Nothing is stored
yet", sixteen phases after that stopped being true. And there is no `README.md`, while four
separate documents refer to it as though there is.

**20 findings: 4 high, 8 medium, 8 low.** Two of them — F5 and F20 — are security claims
that are false, and both have matching entries in the security audit.

---

## Findings, by impact

### F1 — HIGH · `CHANGELOG.md` describes Phase 0 and says nothing is stored yet

`CHANGELOG.md:11-29` against `docs/12-Roadmap/00-Master-Checklist.md:460-483`

The entire `[Unreleased]` section lists scaffold, hardening, navigation lockdown, the
single-instance lock, the SPDX rule and the smoke test — Phase 0 and nothing else. Line 28
then states:

> Nothing is stored yet. The vault format and cryptography arrive in Phase 1

Phases 1 through 5 are marked **Done** in the roadmap's own progress table, and phases 6, 7,
8, 10, 11, 13 and 15 are marked partially done. The KEEP container, envelope encryption,
Argon2 on a worker thread, the vault service, CRUD, history and the audit trail, search, the
generator, twelve import parsers, four export formats, the health engine and the whole app
chrome all exist. This file is the single most misleading document in the repository, and
line 8 says it is the source the in-app Changelog view will render directly — so the error is
scheduled to become user-facing.

**Fix.** Rewrite `[Unreleased]` from the roadmap's progress table, one Added bullet per
landed phase, and delete the Notes block.

---

### F2 — HIGH · Three "not built yet" sections describe features that are built

Absence claims are the most dangerous kind of documentation because nothing fails when they
go stale. All three of these were verified in both directions.

| Doc says not built                                                   | Code                                                                                                                                                                                                                            |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/05-Features/00-Password-Generator.md:106` "The IPC channel and the generator UI" | `src/main/ipc/register.ts:330,340,350` register `generatorGenerate`, `generatorEstimate`, `generatorLimits`; `src/preload/index.ts:151-160` exposes all three; `src/renderer/src/generator/` holds a full panel, form, slider, entropy readout and secret-history list |
| `docs/05-Features/00-Password-Generator.md:108-111` "`GENERATOR_LIMITS` … when the UI lands it must read them across the IPC contract" | That channel exists and `register.ts:344-353` documents it as the fix for exactly this problem. The instruction has been carried out; the paragraph still reads as future work                                                    |
| `docs/05-Features/01-Health-Rules.md:126` "The IPC channel, the dashboard view, and per-rule settings persistence" | `register.ts:357` registers `healthAnalyse`; `preload/index.ts:162-168` exposes it; `src/renderer/src/health/` holds `HealthDashboard.tsx`, `HealthScoreCard.tsx`, `HealthRuleSection.tsx`, `HealthRuleToggles.tsx` and a no-secrets guard test |

Per-rule settings persistence may genuinely still be absent — these renderer modules
appeared and grew during this audit and are in-flight work — but the IPC channels and the
dashboard view are unambiguously present, and a reader of either page would conclude
otherwise.

**Fix.** Rewrite both §-"Not built yet" sections against the current channel list, and add
the generator and health rows to `docs/01-Architecture/01-IPC-Surface.md`'s channel table
(which already lists both groups, so only the feature pages are wrong).

---

### F3 — HIGH · The architecture doc says version snapshots never cross the boundary

`docs/01-Architecture/00-Process-Model.md:70` against
`src/main/vault/projection.ts:72-108` and `src/shared/model/credential.ts:399-433`

The safe-projection table's last history row reads:

| Crosses | Never crosses |
| --- | --- |
| history: version number, timestamp, changed-field names, **origin** | version `snapshot` — those are previous passwords |

A projected snapshot **does** cross, and by design: `VersionProjection.snapshot` is a
`VersionedValuesProjection` carrying the previous title, username, email, urls, tags,
folderId, favorite, icon, expiry and rotation values verbatim, plus `passwordLength` and
`notesLength`, plus per-entry projections of old security questions and custom fields. The
model file documents this deliberately (`credential.ts:390-397`) — it is what lets a timeline
render `"Gmail" → "Google"` without a round trip.

The claim is not a security hole: the secret half is stripped by the same projectors that
strip the live record's, and the security audit verified that end to end. It is a stale
statement of a boundary that has since been drawn more precisely, and it is exactly the row a
reviewer would consult to answer "may I put this in a version projection?".

**Fix.** Replace the row with two: the raw `snapshot` never crosses; the projected snapshot
does, non-secret values verbatim and secret ones as lengths.

---

### F4 — HIGH · There is no `README.md`, and four documents assume there is

The repository root holds `CHANGELOG.md`, `CLAUDE.md`, `CODE_OF_CONDUCT.md`,
`CONTRIBUTING.md`, `MANUAL-BACKLOG.md`, `PRIVACY.md`, `SECURITY.md` — and no `README.md`.

References that assume otherwise:

- `docs/00-Overview/03-Threat-Model.md:3` — "**This page is published, in-app and in the
  README, deliberately.**" Present tense; it is published in neither.
- `MANUAL-BACKLOG.md:57` — "honest cross-platform claims in the README"
- `MANUAL-BACKLOG.md:63` — "the wording of the dialog, for the README"
- `MANUAL-BACKLOG.md:86` — "the README documents the exact SmartScreen and Gatekeeper steps"
- `MANUAL-BACKLOG.md:98` — "Confirm the README's comparison table is still accurate"

The README itself is Phase 19 work and correctly listed there, so its absence is on
schedule. The defect is the present-tense references, which make a reader (or a future agent)
go looking for a file that was never written.

**Fix.** Either write the README now with the `anahat-readme` skill, or make all five
references conditional ("will be published in the README, Phase 19").

---

### F5 — MEDIUM · "No hardcoded colours anywhere" is false, and the guards cannot catch it

`docs/06-UI-Design-System/_INDEX.md:10` and `CONTRIBUTING.md:47` and `CLAUDE.md:86`, against
`src/main/window.ts:29`

> **The hard rule:** every colour is a `--kh-color-*` token. There are no hardcoded colours
> anywhere, and two guard tests enforce it.

```ts
// window.ts:29
backgroundColor: '#12131a',
```

That is a literal hex colour outside the token file, and the two guard tests
(`themes.test.ts` — every token resolves in every theme; the contrast test — every
foreground/background pair passes WCAG AA) operate over the theme definitions, so neither
can see a colour in a `BrowserWindow` option. The claim "enforced by guard tests" is
therefore true of the theme layer and not of the codebase.

The window background is a real problem in its own right, not just a doc problem: it is the
colour flashed before the first paint, it is hard-coded to a dark value, and a user on a
light theme sees a dark flash on every launch.

Judgement call, recorded so it is not re-raised: the `rgb(0 0 0 / …)` values in
`src/renderer/src/styles/base.css:60-62` are *definitions* of `--kh-shadow-*` tokens, i.e.
the source of truth, and are not a violation.

**Fix.** Either derive the window background from the persisted appearance preference, or
narrow the claim to "every colour **in the UI** is a token" and say what the guards actually
cover.

---

### F6 — MEDIUM · Five counts in prose disagree with the code

Each was counted directly.

| Claim                                                                          | Code                                                                                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `docs/03-Data-Model/00-Credential-Model.md:82` "Fourteen types"                | `CUSTOM_FIELD_TYPES` (`credential.ts:27-41`) has **13** — and the doc's own list on the next line has 13                        |
| `docs/05-Features/_INDEX.md:8` "The eight offline rules"                       | `HEALTH_RULE_IDS` (`health.ts:40-50`) has **9**; the rules page's own table lists all nine                                      |
| `docs/09-Import-Export/_INDEX.md:7` and `00-Import-Formats.md:3` "eleven parsers" | `PARSERS` (`import/index.ts:32-55`) has **12**                                                                                 |
| `docs/11-Development/01-Testing-Policy.md:23` "Eighteen formats is eighteen chances" | **12** parsers exist; 18 appears to be a roadmap aspiration                                                                    |
| `docs/12-Roadmap/_INDEX.md:10` "all 17 founding decisions"                      | The log holds **D1–D22**. D18–D22 were added after the founding set, so "17 founding" is defensible — but the index reads as a description of the file's contents, and undercounts them by five |

`00-Import-Formats.md` has a second, worse form of the same defect: its §3 column-mapping
table has eleven rows and **omits `keyholdJsonParser` entirely** — the twelfth parser, and
the first entry in the registry. Someone using that table as the parser inventory would not
know Keyhold's own JSON export can be imported.

**Fix.** Correct all five, add the Keyhold JSON row, and — per hard rule 9 — add a test that
parses these numbers back out of the markdown. `docs/05-Features/01-Health-Rules.md:135`
already documents that pattern for a different number, so the technique is in the house.

---

### F7 — MEDIUM · `PRIVACY.md` describes a Settings screen that does not exist

`PRIVACY.md:28-29` and `PRIVACY.md:39`

> You are shown exactly this before it can be enabled, and a global network kill-switch in
> Settings disables it outright.

> …you choose how much of it is captured — `none`, `device`, `network`, or `full` — in
> Settings → Privacy.

There is no consent screen and no kill-switch. The HIBP feature itself began landing
*during* this audit — `src/main/breach/` now holds the k-anonymity client, the range parser
and an isolated HTTPS transport — but nothing outside that folder imports it, no
`kh:breach:*` channel is registered, and no setting exists to turn it on or off. So the
sentence describes a control the user cannot find, guarding a feature they cannot reach.

The settings half is in motion rather than absent: `src/renderer/src/settings/` grew from one
file to ten *during this audit* (an appearance panel plus vault, security/session,
history/audit and health-rule sections, a gateway and a `use-settings` hook), so the audit
privacy level is close to being user-changeable. But `src/renderer/src/App.tsx:4` still
imports only `AppearancePanel`, so no settings screen is reachable yet, and "Settings →
Privacy" names a route that does not exist.

This matters more than an ordinary staleness because `PRIVACY.md` is a published promise
about behaviour. A reader is being told a control exists that they cannot find, which reads
as either a lie or a broken build.

**Fix.** Mark both sentences as describing planned behaviour, or move them into a "Planned"
section until Phase 14 lands. The rest of the page — "Keyhold makes no network requests",
`connect-src 'none'`, no analytics, no CDN, no update ping — was verified and is accurate.

---

### F8 — MEDIUM · The threat model lists KDBX export as a present mitigation

`docs/00-Overview/03-Threat-Model.md:23`

> **The vendor turns hostile, raises prices, or shuts down** → There is no vendor. GPL-3.0,
> no server, KDBX 4 export, and a published format spec.

There is no KDBX export. `package.json` has no `kdbxweb` dependency, `EXPORT_FORMATS`
(`src/main/export/index.ts:25-54`) holds four formats — encrypted parcel, Keyhold JSON, CSV,
Bitwarden-compatible CSV — and `docs/09-Import-Export/01-Export-Formats.md:180` correctly
lists KDBX under "Not built".

The same phantom dependency appears in `CLAUDE.md`'s stack table, which lists
"KDBX interop | `kdbxweb` + our WASM Argon2" as though it were installed.

The other three items in that cell are true, and the anti-lock-in story stands on the
published format spec alone — which is the stronger claim anyway. But a table of mitigations
is read as a list of what protects the user today.

**Fix.** Move KDBX 4 export to a "planned" qualifier in both places until Phase 11 ships it.

---

### F9 — MEDIUM · Two documents point at `src/shared/crypto/`, which does not exist

`SECURITY.md:56` and `CONTRIBUTING.md:74`

> If a pull request touches `src/main/security.ts`, `src/shared/crypto/`,
> `src/shared/format/`, or the IPC contract…

Crypto lives in `src/main/crypto/`. It is in `src/main` deliberately and by recorded
decision — D22, "Crypto and format implementations live in `src/main`, not `src/shared`" —
and `docs/01-Architecture/00-Process-Model.md:50-55` explains why at length. So this is not
a typo about where a folder happens to be; it points a security reporter and a contributor at
the exact architectural arrangement the project decided against.

`src/shared/format/` is correct — that folder holds `types.ts`.

**Fix.** `src/main/crypto/` and `src/main/format/`, plus `src/shared/format/types.ts`.

---

### F10 — MEDIUM · The audit findings land in a folder no index knows about

`docs/12-Roadmap/00-Master-Checklist.md:420` and `docs/_INDEX.md:30`

Phase 17's final item is:

> Write each audit's findings to `docs/13-Appendix/`, including an explicit "checked and
> fine" list

and `docs/_INDEX.md:30` reserves `13-Appendix/` for "Audit findings, benchmarks, doc-audit
findings, deliberate oddities — _Planned — Phase 17_". Phase 19 additionally names
`docs/13-Appendix/03-Doc-Audit-Findings.md` explicitly (`00-Master-Checklist.md:438`).

These two files were written to **`docs/14-Audits/`** instead, on instruction. The result is
a documentation folder that the tree index does not list and that the roadmap does not point
to — the exact failure mode `docs/_INDEX.md` exists to prevent.

This audit is read-only over everything except its own folder, so it cannot correct either
file. Flagging it as the one finding here that **must** be actioned by hand, because until it
is, these reports are unreachable from the documentation entry point.

**Fix.** Add a `14-Audits/` row to `docs/_INDEX.md`, and point the Phase 17 and Phase 19
checklist items at it. Then decide whether `13-Appendix/` still has a purpose (benchmarks and
the "deliberate oddities" register) or whether it should be folded in.

---

### F11 — MEDIUM · The module map omits six of the main process's nine folders

`docs/01-Architecture/00-Process-Model.md:28-48`

The map lists `shared/`, `main/crypto/`, `main/format/`, `main/vault/`, `main/ipc/`,
`security.ts`, `window.ts`, `index.ts`, `smoke.ts`, `preload/`, `renderer/`. Absent:
`main/history/` (versioning, origin capture, the network probe, the diff projection —
including the codebase's *second* security boundary), `main/health/`, `main/generator/`,
`main/import/`, `main/export/`, `main/session/` (the whole session model: auto-lock,
clipboard, quick unlock, preferences, throttle, strength), plus `main/menu.ts` and
`main/window-state.ts`.

`01-IPC-Surface.md` and `02-Session-Model.md` document those areas well; the problem is that
the page presenting itself as *the* module map now shows less than half the tree, and
`diff-projection.ts` — which the same document elsewhere calls the second projection
boundary — does not appear on it at all.

**Fix.** Regenerate the map from the tree, and mark the two projection boundaries in it.

---

### F12 — LOW · "The three files" over a four-row table

`docs/01-Architecture/01-IPC-Surface.md:9-16`

The heading reads "## 1. The three files, and why it takes three"; the table has four rows —
`api.ts`, `*-validation.ts`, `register.ts`, `preload/index.ts`. Four is right.

---

### F13 — LOW · The channel-group table says history needs an open vault

`docs/01-Architecture/01-IPC-Surface.md:33` against `src/main/ipc/register.ts:405-408`

`kh:history:networkName` takes no vault: it calls `originCapture.refreshNetwork()`, which
probes the machine and is explicitly for the settings screen. Every other history channel
does need one. Small, but the table is the quick answer to "can this be called on the unlock
screen?".

---

### F14 — LOW · `npm run package` is documented as a script that works

`docs/11-Development/00-Setup-And-Scripts.md:29`

| `npm run package` / `package:win` / `package:mac` | electron-builder (Phase 18) |

The scripts exist in `package.json:39-41`, but there is **no electron-builder configuration
anywhere in the repository** — no `build` key in `package.json`, no `electron-builder.yml`,
no `electron-builder.json`. Running any of the three fails after the build step.

The "(Phase 18)" note is doing the work of a warning, and a reader in a hurry will not read
it that way. The config is correctly listed as the first item of Phase 18
(`00-Master-Checklist.md:426`).

**Fix.** Mark the row "Phase 18 — no config yet; this currently fails".

---

### F15 — LOW · `CLAUDE.md` says typecheck covers three tsconfigs

`CLAUDE.md:45` against `package.json:46-48` and
`docs/11-Development/00-Setup-And-Scripts.md:26`

`npm run typecheck` runs two `tsc --noEmit` passes, over `tsconfig.node.json` and
`tsconfig.web.json`. `tsconfig.base.json` holds shared compiler options and is never
type-checked on its own — which is what the development doc says ("against both tsconfigs"),
correctly. Only `CLAUDE.md` says three.

---

### F16 — LOW · `id: UUID v7 — time-sortable` is a v4

`docs/03-Data-Model/00-Credential-Model.md:13` against `src/main/crypto/random.ts:22-25`

```
├── id                 UUID v7 — time-sortable, so creation order is free
```

```ts
/** A v4 UUID from the platform CSPRNG. Used for vault and device identity. */
export function uuid(): string {
  return randomUUID();
}
```

`crypto.randomUUID()` produces a **v4** UUID. v4 is random, not time-ordered, so "creation
order is free" is not true — anything sorting by id gets an arbitrary order. Nothing appears
to depend on it today (sorting goes through `src/shared/search/sort.ts`, which sorts on real
timestamp fields), which is why this is low rather than a correctness bug. But it is a stated
property that would be relied on the first time someone needed a cheap stable order.

**Fix.** Either correct the doc to v4, or switch `uuid()` to a v7 implementation and keep the
property. Deciding which is a decision-log entry, not a doc edit — the ids go in the file
format.

---

### F17 — LOW · A code comment contradicts the constant directly beneath it

`src/shared/format/types.ts:66-84`

> OWASP's minimum recommendation is m=19 MiB, t=2, p=1. Keyhold's floor is well above that
> because this is a desktop app…

```ts
export const MIN_KDF_PARAMS = {
  memoryKib: 19_456, // 19 MiB — the OWASP floor
  iterations: 2,
  parallelism: 1,
} as const;
```

The floor **is** OWASP's, exactly. It is the *default* (64 MiB, t=3, p=4) that is well above
it, and the paragraph is describing the default while sitting above the minimum. The
published spec and the cryptography doc both get this right — `00-Cryptography.md:74-78`
explains the floor and the ceiling as serving different purposes, and the spec's table is
correct.

**Fix.** Move the comment to `DEFAULT_KDF_PARAMS` or reword it in place.

---

### F18 — LOW · The extension family lists two extensions nothing produces

`docs/04-Vault-Format/00-KEEP-Format-Spec.md:296-303`

`.keepbak` and `.keeptheme` appear in the table. Nothing in `src/` writes either:
`atomic-write.ts:45-47` produces `<vault>.keep.bak.N` (which the table also lists,
correctly), and there is no theme export at all — the appearance store persists to
`localStorage` (`src/renderer/src/theme/appearance-store.ts:41`).

Low, but this document is explicitly written to be implementable by a third party, and a
clean-room implementer reading it may conclude they should emit a `.keepbak`.

**Fix.** Mark both as reserved-not-yet-produced, or drop `.keepbak` (it is redundant with
`.keep.bak.N`) and move `.keeptheme` to the backlog.

---

### F19 — LOW · Three folder indexes have a broken second table

`docs/01-Architecture/_INDEX.md:7-9`, `docs/06-UI-Design-System/_INDEX.md:6-8`,
`docs/09-Import-Export/_INDEX.md:7-9`

In each, a blank line separates the last row from the ones above it, so the final entry
(`01-IPC-Surface.md`, `02-App-Chrome.md`, `01-Export-Formats.md`) renders as a *separate*
one-row table with the row itself promoted to a header. Purely presentational, and trivially
fixable by deleting the blank line.

---

### F20 — MEDIUM · The hardening doc describes a scheme check that does not run

_Numbered last because it was raised by the security audit after this list was drawn up; it
ranks with the medium findings above._

`docs/02-Security/01-Process-Hardening.md:108-110` against `src/main/window.ts:53-56` and
`src/main/security.ts:88-93`

> **`setWindowOpenHandler`** — always denies. … `http(s)` URLs are opened externally
> instead.

Two ways this is not what happens. `src/main/window.ts:53` installs a **second**
`setWindowOpenHandler` on the main window after `hardenWindow` has run; it replaces the
hardened one and has no scheme test, so any URI at all is passed to `shell.openExternal`.
And the `will-navigate` bullet three lines above ("anything outside the app's own pages is
cancelled and handed to the user's real browser") describes `security.ts:88-93` accurately —
which is itself the problem, because that path hands *every* scheme to the OS, not only
`http(s)`.

The rest of §4 is correct: `will-attach-webview` is prevented, both permission handlers deny
unconditionally, and the controls are applied from `web-contents-created` so they cover every
WebContents.

Filed here as well as in the security audit because this is the page a reviewer consults to
answer "is external-link handling safe?", and today it answers yes.

**Fix.** Fix the code (security audit S1 and S2), then leave this paragraph as written — it
describes the intended behaviour correctly.

---

## Checked, and found accurate

Recorded so nobody re-verifies these, and so nobody "corrects" one of them.

**Every guarded number checked out.**

| Claim                                                                  | Verified against                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Argon2: default 64 MiB / t=3 / p=4, floor 19 MiB / 2 / 1, ceiling 2 GiB / 32 / 16, 16-byte salt, 32-byte output | `src/shared/format/types.ts:72-95`, in both `00-Cryptography.md:67-72` and the spec's `§4` table |
| Nonce 12 bytes, tag 16, key 32, chunk id 16, magic `4B 45 59 48 4F 4C 44 00` | `types.ts:16-42`; byte layout in spec `§2` matches `container.ts` exactly |
| Decompression bounded at 256 MiB                                       | `MAX_BODY_BYTES` = 268 435 456, passed as `maxOutputLength`               |
| Grant TTL 30 s, 60 grants per 60 s window                              | `secret-broker.ts:27-38`; `00-Process-Model.md:121-124`                   |
| Throttle: 3 free attempts, 2 s base, doubling, 5-minute cap            | `unlock-throttle.ts:21-23`; `02-Session-Model.md:80-88`                   |
| Idle 10 min, sleep on, screen-lock on, minimise off, blur off          | `auto-lock.ts:31-37`; `02-Session-Model.md:94-100`                        |
| Eight built-in themes                                                  | `src/shared/theme/themes.ts` — dawn, midnight, slate, nord, solarized-light, solarized-dark, rose, high-contrast |
| "77 tests" across crypto and container                                 | 46 + 31 = 77                                                              |
| "adds 19 covering durability"                                          | `atomic-write.test.ts` — 19                                               |
| "62 tests" for app chrome                                              | seven chrome test files — 62                                              |
| "40 checks" in the launch smoke test                                   | `smoke.ts` — 40 `steps.push(...)`                                          |
| 20 phases in the master checklist                                      | Phase 0 through Phase 19                                                  |
| Clipboard markers, one atomic item, per platform                       | `clipboard.ts:43-53,78-87`; `02-Session-Model.md:119-126`                 |
| Quick-unlock platform table (Touch ID / DPAPI / keyring, and which prompts) | `quick-unlock.ts:52-94`; `02-Session-Model.md:144-154`                    |
| Symbol set excludes space, backslash, backtick and both quotes         | generator charsets                                                        |

**Absence claims that were verified and hold.**

- **"Keyhold makes no network requests"** (`PRIVACY.md:10`, `SECURITY.md:44`,
  `CLAUDE.md` hard rule 5, goal G2) — **true when swept, and still true at runtime, but the
  sweep result changed mid-audit.** At the time of the sweep there was no `fetch`, no
  `node:http`/`https`, no `net.request`, no `XMLHttpRequest` and no WebSocket anywhere in
  `src/`. `src/main/breach/` then landed, and there is now exactly one `fetch` call site in
  the repository (`https-transport.ts:119`). Nothing outside that folder imports it and no
  `kh:breach:*` channel is registered, so the running app still makes no request — but the
  claim has moved from "structurally impossible" to "true because the one exception is not
  wired up yet", and the documents asserting it should say so once it is. The only other
  outbound calls of any kind are two `shell.openExternal` links in the Help menu, which hand
  a URL to the user's browser rather than making a request.
- **"no network code, no stub, no fetching import anywhere in these files"**
  (`01-Health-Rules.md:127-128`) — true of `src/main/health/`.
- **"`Math.random()` is banned project-wide by lint"** (`00-Cryptography.md:139`,
  `00-Setup-And-Scripts.md:83`) — the rule is in the unscoped config block, disabled only for
  tests, and no call site exists anywhere in the repo.
- **"`console.log` banned"** in main/preload/shared (`00-Setup-And-Scripts.md:78`) —
  `no-console` with `warn`/`error` allowed, exactly as described.
- **"renderer imports of `electron`, `node:*`, `fs`, `path`, `crypto`, `os`,
  `child_process`, `@main/*` are a lint error"** — present, with the described message.
- **"the engine writes no files"** (`01-Export-Formats.md:37`) — `src/main/export/` contains
  no `writeFile`, no `open`. True, and export is not wired to IPC.
- **"no second `EmptyState` component"** (`02-App-Chrome.md:133`) — true.
- **"`@testing-library/react` is deliberately not a dependency"** (`02-App-Chrome.md:161`) —
  true.
- **"the parsing half is built… the commit half is not"** (`00-Import-Formats.md:6-7`) — no
  import channels exist in `CHANNELS`. Accurate.
- **"nothing writes a `merge` origin yet"** (`02-History-And-Audit.md:241`) — accurate.

**Prose that matches the implementation closely enough to be worth saying so.**

`docs/02-Security/01-Process-Hardening.md` §2 (every `webPreferences` value),
`docs/04-Vault-Format/00-KEEP-Format-Spec.md` §2/§3/§6/§8/§10 (byte layout, header field
list, key ordering, AAD bindings, the required read order, and the durability sequence — all
of which match `container.ts`, `header.ts` and `atomic-write.ts` step for step),
`docs/02-Security/00-Cryptography.md` §4 (`SecretBytes`' four properties, each verified),
`docs/05-Features/01-Health-Rules.md` §2 (the report carries ids, counts, severities, and a
host taken from `normaliseHost` — which does strip userinfo correctly), and
`docs/11-Development/00-Setup-And-Scripts.md`'s tsconfig and path-alias sections (aliases are
in all three places, and `tools/alias-parity.test.ts` does assert it).

---

## What this audit did not cover, and why

- **`docs/superpowers/specs/`** — excluded by rule. It is history; a drifted spec there is a
  record of an earlier decision, not a defect.
- **`docs/00-Overview/02-Competitive-Analysis.md`** was read for internal consistency only.
  Its claims are about KeePassXC, Bitwarden, Proton Pass and others; verifying them needs
  network access and current knowledge of those products, and this audit had neither. The
  same applies to the comparison-table freshness item in `MANUAL-BACKLOG.md:98`.
- **`docs/12-Roadmap/01-Feature-Backlog.md` and `03-Autonomous-Goal.md`** were skimmed for
  path and count claims, not audited line by line. They describe intent rather than
  implementation, so there is little for them to be wrong about.
- **`CODE_OF_CONDUCT.md`** was not audited — it makes no claims about the code.
- **UI-behaviour claims were not verified by running the app.** Statements like "nothing in
  the UI calls `history.compare` yet" (`02-History-And-Audit.md:236-237`) and the "not built"
  lists in `06-UI-Design-System/02-App-Chrome.md` §7 were checked by reading the renderer,
  not by using it.
- **The roadmap's progress table lags the code for phases 8 and 13** (both still marked
  "engine/rules done" while their IPC channels and renderer modules exist). That is not
  filed as a finding because those areas were being actively edited by other agents during
  this audit; the checklist is a working document and is expected to be ticked as those
  slices land. It is noted here so the next reader is not surprised by it.
- **No git command was run**, by instruction. `MANUAL-BACKLOG.md`'s 🔴 M1 ("create the
  remote and push") could therefore not be verified as done or outstanding, and no claim is
  made either way.
- **Other agents were writing `src/` throughout.** `src/renderer/src/commands/`,
  `src/renderer/src/generator/`, `src/renderer/src/health/` and most of
  `src/renderer/src/settings/` appeared or grew partway through — the settings folder went
  from one file to ten while this page was being written. They are the basis for F2 and part
  of F7; as Phases 8, 13 and 14 complete, F2 becomes more true and F7's settings half
  becomes less so. Re-check both before acting on them.

---

## Related

- [`00-Security-Audit.md`](./00-Security-Audit.md) — the security half of Phase 17. F20 here
  is the documentation face of S1 and S2 there; F5 here is the documentation face of the
  hardcoded window background; S6 there (the wipe leaves recoverable copies) contradicts
  `02-Session-Model.md:180`.
- [`../_INDEX.md`](../_INDEX.md) — which does not yet list this folder. See F10.
