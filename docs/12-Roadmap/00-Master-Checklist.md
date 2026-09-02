# Keyhold — Master Build Checklist

> **This file is the canonical TODO for the project.** Every task lives here. Nothing gets dropped
> into chat. Tick items as they land, in order, and add anything new to the right phase rather than
> to the void.
>
> - Design record (frozen): [`docs/superpowers/specs/2026-09-02-keyhold-product-spec.md`](../superpowers/specs/2026-09-02-keyhold-product-spec.md)
> - Deferred / future ideas: [`01-Feature-Backlog.md`](./01-Feature-Backlog.md)
> - Why things are the way they are: [`02-Decision-Log.md`](./02-Decision-Log.md)
> - Things only Anahat can do: [`../../MANUAL-BACKLOG.md`](../../MANUAL-BACKLOG.md)

**Definition of done for every phase:** the code is written, the phase's docs page exists and is
accurate, `npm run lint`, `npm run typecheck` and `npm test` all pass, and a commit is made.

**Status legend:** `[ ]` todo · `[x]` done · `[~]` in progress · `[!]` blocked (say why inline)

---

## Phase 0 — Project scaffold & tooling ✅

_Goal: `npm run dev` opens a hardened, empty Electron window on Windows and macOS._

- [x] Initialise `package.json` — name `keyhold`, GPL-3.0-or-later, author, repository
- [x] Scaffold with `electron-vite` (main / preload / renderer)
- [x] TypeScript strict everywhere (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and six more)
- [x] Path aliases (`@main`, `@preload`, `@renderer`, `@shared`) in **both** `electron.vite.config.ts` and every `tsconfig.*.json` — kept in sync by `tools/alias-parity.test.ts`
- [x] ESLint + Prettier + `.editorconfig`; scripts `lint`, `lint:fix`, `format`, `typecheck`, `verify`
- [x] Vitest configured for the `node` and `renderer` environments
- [x] Harden `BrowserWindow`: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, `webviewTag: false`, spellcheck off
- [x] Strict CSP — `default-src 'none'`, no `unsafe-inline` in `script-src`, no `unsafe-eval`, `connect-src 'none'`
- [x] Block `will-navigate` and `setWindowOpenHandler` for anything not in-app; external links go to the real browser
- [x] Deny every web permission (`setPermissionRequestHandler` / `setPermissionCheckHandler`)
- [x] Disable devtools in production builds
- [x] Single-instance lock
- [x] `LICENSE` (GPL-3.0), SPDX header lint rule (local, with fault-injected test), `.gitignore`, `.gitattributes`
- [x] `CHANGELOG.md` (Keep a Changelog), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `PRIVACY.md`
- [x] `docs/11-Development/` — setup & scripts, testing policy
- [x] **Extra:** launch smoke test (`npm run test:smoke`) that starts the real app and verifies the preload bridge — added after discovering that a sandboxed ESM preload fails silently at runtime (decision D20)
- [x] **Extra:** renderer lint zone that makes importing `electron`, `node:*`, `fs`, `crypto`, `os` or `@main/*` a hard error
- [x] **Extra:** `Math.random()` banned project-wide by lint
- [x] Git: initial commits on `main`

**Verified:** `npm run verify` green (20 tests) · `npm run build` clean · `npm run test:smoke`
reports `SMOKE-PASS window created, renderer loaded, preload bridge present`.
All three guards fault-injected and confirmed to fail on the defect they claim to catch.

**Blocked:** the GitHub remote does not exist yet — GitHub CLI is not installed. See
`MANUAL-BACKLOG.md` M1. Commits are landing locally; the push happens the moment the remote exists.

## Phase 1 — Crypto core & the KEEP container ✅

_Goal: a library that turns a password plus records into a `.keep` file and back, with no UI at all._

- [x] Argon2id via `hash-wasm`, AES-256-GCM via Node `crypto`
- [x] KDF calibration targeting ≈500 ms, **never returning weaker than the shipped default** (guard test — a fast machine must not buy a weaker vault)
- [x] KDF parameter bounds enforced in **both** directions: a floor so a downgraded header cannot weaken a vault, a ceiling so a hostile file cannot DoS the app
- [x] Envelope encryption: derive KEK → generate DEK → wrap/unwrap; password change rewraps 32 bytes and never touches the body
- [x] `SecretBytes` — redacts through `toString`, `toJSON` and `util.inspect`; zeroes on destroy; idempotent destroy; constant-time compare; `use(fn)` rather than a getter
- [x] `randomInt` with rejection sampling, not modulo — modulo bias measurably shrinks generated-password entropy
- [x] KEEP container writer and reader per the spec
- [x] Header as AAD, with **explicit fixed key ordering** so a refactor cannot silently break every existing vault
- [x] Header treated as hostile input: every field type-checked, base64 validated by round-trip
- [x] Attachment chunks, each bound to its own id as AAD so chunks cannot be relocated between records
- [x] `formatVersion` gate: refuse a newer version rather than guessing; preamble/header version cross-check
- [x] Forward-only migration framework with a contiguity guard
- [x] Atomic write: tmp → `fsync` → rotate backups → rename → `fsync` directory
- [x] Rolling backups with configurable retention; a **failed save consumes no backup slot**
- [x] Crash recovery: orphaned `.tmp` is surfaced and quarantined, **never silently deleted**
- [x] **Tests (96):** roundtrip · wrong password · flipped bit in ciphertext/tag/nonce/AAD · **truncation at every length** · **a flipped bit sampled across the whole body** · header tampering at identical length · chunk relocation · KDF bounds · calibration floor · redaction paths · statistical randomness bias · password change · multiple independent DEK wrappings · atomic-write failure paths
- [x] `docs/02-Security/` and `docs/04-Vault-Format/` written — the format spec is publishable

**Verified:** `npm run verify` green (122 tests). Two fault injections confirmed: removing
the body's AAD binding breaks the header-tampering test; rotating backups before the temp
write breaks four durability tests.

**Decision recorded:** crypto and format implementations live in `src/main/`, not
`src/shared/`. `@shared` must compile in the renderer, and putting crypto there would make
it importable from the renderer — exactly what decision D13 exists to prevent. `@shared`
holds types and constants only. See D22.

## Phase 2 — Vault service & the secure IPC bridge ✅

_Goal: the main process owns every secret; the renderer can only ask, never hold._

- [x] `VaultService` — create, inspect, unlock, lock, save, summary; holds the decrypted document
- [x] `lock()` destroys the DEK, drops the document and revokes every grant; idempotent; wired to window-close and will-quit
- [x] `lock()` deliberately does **not** save — an unattended auto-lock must never commit a half-finished edit
- [x] **Safe projection** builder, constructed field by field rather than by spreading (a spread is additive, so a new field would silently start crossing)
- [x] The secret classification is declared **once**, in `@shared/model/credential.ts`, with a compile-time check that every core field is classified
- [x] Typed IPC contract in `@shared/ipc/api.ts` — channel names and the `window.keyhold` shape from one source
- [x] Runtime validation on both sides: string caps, id allow-list pattern, NUL-byte rejection, `SecretRef` rebuilt field by field so smuggled properties cannot ride along
- [x] Allow-listed `contextBridge` surface — every member enumerated by hand, `ipcRenderer` never exposed
- [x] On-demand secret fetch through a broker: one at a time, TTL-scoped, rate-limited, all revoked on lock
- [x] Deep-search delegate — searches notes, answers and hidden custom values, returns **ids only**
- [x] Structured `IpcResult` errors; handlers never throw across the bridge; `INTERNAL` reports that a bug happened, deliberately not what
- [x] **Tests (79):** the safe-projection property test · lifecycle and locking · reveals of each secret kind · deep search returning no text · grant expiry to the millisecond · rate limiting · every validator, including nine hostile `SecretRef` shapes
- [x] **Smoke test extended** to make a real IPC round-trip in the launched app — the only check that catches an unregistered handler or a drifted channel name
- [x] `docs/01-Architecture/` written

**Verified:** `npm run verify` green (201 tests) · `npm run test:smoke` reports
`IPC round-trip OK`. Four fault injections confirmed: spreading the record, including
`version.snapshot`, ignoring the user's hidden flag, and removing a handler registration.

**Deferred to Phase 5 (CRUD):** the multi-vault registry and recent-vaults list. It needs
app-level preference storage, which arrives with settings; `replaceDocument` covers the
service's needs until then. Recorded here rather than dropped.

## Phase 3 — App shell, design system & theme engine

_Goal: the three-pane shell renders, and every theme is contrast-safe._

- [ ] CSS token layer — colour, space, radius, shadow, motion, type. **Zero hardcoded colours.**
- [ ] Theme engine: 8 themes — Dawn, Midnight, Slate, Nord, Solarized Light, Solarized Dark, Rose, High-Contrast
- [ ] Independent accent-colour picker
- [ ] Density control (compact / comfortable / spacious)
- [ ] Font-size scale + font-family choice, including a monospace face for secrets
- [ ] Follow-OS theme toggle; `prefers-reduced-motion` respected throughout
- [ ] Custom theme editor with live preview; `.keeptheme` export and import
- [ ] Three-pane shell with both side panes collapsible and persisted; responsive down to one pane
- [ ] Base components: Button, Input, Select, Checkbox, Switch, Radio, Tabs, Badge, Chip, Tooltip, Menu, Card, Skeleton, EmptyState, ErrorState
- [ ] Native menu bar (Windows + macOS variants) and system tray with quick actions
- [ ] Window state persistence (size, position, maximised, pane widths)
- [ ] **Guard test:** every token resolves to a non-empty value in every theme
- [ ] **Guard test:** every foreground/background token pair passes WCAG AA contrast in every theme
- [ ] `docs/06-UI-Design-System/` written

## Phase 4 — Unlock, lock & session security

_Goal: you can create a vault, unlock it, and trust that it locks itself._

- [ ] Welcome screen — create vault / open vault / recent vaults
- [ ] Create-vault flow: choose location, master password with live strength meter, explicit "there is no recovery" acknowledgement
- [ ] Unlock screen with a progress indicator during Argon2 (it takes real time — never a frozen window)
- [ ] Run Argon2 off the UI thread (utility process or worker) so the window stays responsive
- [ ] Failed-attempt throttling with exponential backoff
- [ ] Optional wipe-after-N-failures — off by default, loud type-to-confirm
- [ ] Auto-lock: idle timeout · system sleep · OS screen lock · minimise (optional) · app close
- [ ] Manual lock `Ctrl/Cmd+L`
- [ ] Biometric quick-unlock — Windows Hello / Touch ID, DEK wrapped into `safeStorage`
- [ ] Enrol / revoke biometric independently of the master password
- [ ] Clipboard service: auto-clear countdown · exclude from Windows clipboard history and cloud clipboard · `org.nspasteboard.ConcealedType` on macOS · clear on lock · clear on exit
- [ ] Change master password (rewrap DEK) · rotate DEK · change KDF parameters
- [ ] **Tests:** lock zeroes every secret · biometric wrapping roundtrip · throttle timing · clipboard clear timer
- [ ] `docs/02-Security/` updated with the session model

## Phase 5 — Credential CRUD & the field system

_Goal: full create/read/update/delete over every field discussed._

- [ ] Credential list — virtualised, handles 10 000+ entries
- [ ] Detail view; edit view; create flow
- [ ] Core fields: title, username, email, password, **multiple URLs**, notes
- [ ] Security questions — repeatable, first-class `{question, answer}` pairs, answers treated as secrets
- [ ] Custom fields — unlimited, drag-to-reorder, individually hidden, 14 types: `text`, `password`, `email`, `url`, `number`, `date`, `datetime`, `boolean`, `multiline`, `phone`, `pin`, `otp-secret`, `address`
- [ ] Per-field reveal / copy / hide with an `aria-live` announcement
- [ ] Icons: auto (favicon-free, derived from the title), letter, emoji, custom
- [ ] Duplicate a credential
- [ ] Bulk edit: move to folder, add/remove tag, set favourite, delete
- [ ] Soft delete → Trash, with restore and configurable auto-purge
- [ ] Undo on every destructive action (toast with an Undo button)
- [ ] Unsaved-changes guard on navigation and on quit
- [ ] **Tests:** the record model's invariants · custom-field type validation · trash and restore round-trip
- [ ] `docs/03-Data-Model/` and `docs/05-Features/` written

## Phase 6 — History, versioning & the audit trail _(headline feature)_

_Goal: "what changed, when, and from which device and network?" is always answerable._

- [ ] Version model — changed-field list plus a partial snapshot (never a full copy)
- [ ] **Per-credential "keep past versions" checkbox**, with a global default and per-record override
- [ ] Configurable retention cap, with oldest-first pruning
- [ ] Origin capture in the main process: device name, OS user, platform, OS release, app version
- [ ] Network name — `netsh wlan show interfaces` (Windows) / `system_profiler SPAirPortDataType` (macOS), falling back to the active interface name; **must never block a save**
- [ ] Optional local IP capture
- [ ] **Privacy levels:** `none` / `device` (default) / `network` / `full`
- [ ] History timeline UI on the detail pane
- [ ] Field-level diff between any two versions
- [ ] Restore an entire version, or a single field from one
- [ ] Reveal an old password under the same clipboard rules
- [ ] Export a single credential's history
- [ ] **Tests:** versioning on change only · retention pruning · restore correctness · diff correctness · privacy levels capture exactly what they claim and nothing more
- [ ] `docs/05-Features/history-and-audit.md` written

## Phase 7 — Organisation, search, sort & filter

_Goal: finding one credential among thousands takes under two seconds._

- [ ] Nested folders — tree, create/rename/move/delete, drag-and-drop
- [ ] Tags — flat, multi-assign, colour-coded, rename cascades
- [ ] Favourites
- [ ] Saved smart views (rule-based, e.g. "weak AND untagged")
- [ ] Fuzzy search over the safe projection, debounced
- [ ] Deep search via the main-process delegate (notes, custom values)
- [ ] Search operators: `tag:`, `folder:`, `url:`, `has:`, `is:`, `created:`, `updated:`
- [ ] Sort by title, created, updated, password age, use count, strength, folder
- [ ] Filter chips with a visible active-filter state and a clear-all
- [ ] Empty / loading / no-results states for every list
- [ ] Decide indexed vs linear deep search by measuring against a 10 000-record synthetic vault; record the result in `docs/13-Appendix/`
- [ ] **Tests:** search operator parser · filter composition · sort stability
- [ ] `docs/05-Features/organisation-and-search.md` written

## Phase 8 — Password generator & strength

- [ ] Random mode: length, character classes, exclude-ambiguous, require-one-of-each, custom exclude set
- [ ] Passphrase mode: bundled EFF large wordlist, word count, separator, capitalisation, number injection
- [ ] Pronounceable mode; PIN mode
- [ ] Entropy calculation plus a crack-time estimate (`@zxcvbn-ts/core`, lazily loaded in main only)
- [ ] Session generation history
- [ ] Per-site rule memory for sites that reject symbols
- [ ] Generate-and-replace inside a credential — auto-versions the previous password
- [ ] Standalone generator view and a command-palette action
- [ ] **Tests:** every requested class is present · excluded characters never appear · entropy maths · passphrase wordlist integrity
- [ ] `docs/05-Features/password-generator.md` written

## Phase 9 — Encrypted attachments

- [ ] Attach a file → its own encrypted chunk in the same `.keep`
- [ ] SHA-256 integrity verification on read
- [ ] In-app preview: images, PDF, plain text; a lightbox for images
- [ ] Export to disk with a plaintext warning
- [ ] Warn above 5 MB; configurable hard cap, default 25 MB per file
- [ ] Attachment totals in vault stats; orphan-chunk cleanup on save
- [ ] Drag-and-drop to attach
- [ ] **Tests:** chunk roundtrip · integrity failure detected · orphan cleanup · size-cap enforcement
- [ ] `docs/05-Features/attachments.md` written

## Phase 10 — Import engine

_Goal: nobody has to retype anything, from any manager._

- [ ] Parser interface + shared normalisation pipeline
- [ ] **Generic CSV with a column-mapping UI** — the catch-all that makes everything else possible
- [ ] KeePass KDBX 3 and 4 (`kdbxweb` + our WASM Argon2)
- [ ] KeePass XML
- [ ] Bitwarden JSON (encrypted and plain) and CSV
- [ ] 1Password 1PUX and CSV
- [ ] LastPass CSV
- [ ] Chrome / Edge / Brave CSV
- [ ] Firefox CSV
- [ ] Safari / Apple Passwords CSV
- [ ] Dashlane CSV and JSON
- [ ] Proton Pass JSON and CSV
- [ ] Enpass JSON
- [ ] NordPass CSV
- [ ] Keeper CSV and JSON
- [ ] RoboForm CSV
- [ ] Native `.keep` and `.keepx`
- [ ] Import wizard: parse → preview table → map columns → target folder/tags → dedupe strategy (skip / overwrite / keep both / merge fields) → **dry-run report** → commit
- [ ] One-click undo of an entire import
- [ ] Preserve source history where the source has it (KDBX, Bitwarden)
- [ ] Import report saved into the vault's activity log
- [ ] **Tests:** one fixture file per format → expected normalised records; malformed-input handling for each
- [ ] `docs/09-Import-Export/` written, with a per-format field-mapping table

## Phase 11 — Export engine & the transfer bundle

- [ ] `.keep` export (encrypted, native)
- [ ] **`.keepx` transfer bundle** — selective record choice, its own passphrase, optional advisory expiry
- [ ] **KDBX 4 export** — the anti-lock-in guarantee; verified to open in KeePassXC
- [ ] Bitwarden JSON export
- [ ] Full-fidelity JSON export including history
- [ ] Encrypted JSON export
- [ ] CSV export
- [ ] Type-to-confirm dialog on any unencrypted export, restrictive file permissions, shred reminder
- [ ] **Tests:** roundtrip through every own-format · KDBX export re-imports losslessly · unencrypted export is gated
- [ ] `docs/09-Import-Export/` updated

## Phase 12 — Sync & merge

_Goal: two devices, one cloud folder, and never a lost edit._

- [ ] Generation counter and content hash in the header
- [ ] File watcher on the open vault; detect external modification
- [ ] Reload prompt when the on-disk vault changed and there are no local edits
- [ ] Base-snapshot storage — the last-synced state, for three-way merge
- [ ] Three-way merge engine — per record, per field
- [ ] Tombstones so a deletion never resurrects
- [ ] Conflict detection matrix (both changed · one changed · one deleted · both deleted · both created)
- [ ] Field-level conflict resolver UI: mine / theirs / merge, with a diff
- [ ] **Mandatory pre-merge backup** — no merge ever runs without one
- [ ] Merge report, saved and viewable
- [ ] Cloud-folder detection with guidance (Dropbox / OneDrive / iCloud / Google Drive / Syncthing)
- [ ] Handle provider "conflicted copy" files — offer to merge them in
- [ ] **Tests:** the full conflict matrix · a property test asserting no merge ever loses a record · tombstone correctness · idempotent re-merge
- [ ] `docs/10-Sync-And-Transfer/` written

## Phase 13 — Health dashboard

- [ ] Offline rules: weak · reused (with the cluster listed) · old · expiring/expired · insecure `http://` URL · missing-2FA flag · incomplete · likely-duplicate
- [ ] Overall health score, tracked over time inside the vault
- [ ] Dashboard view with drill-down and one-click jump-to-fix
- [ ] Per-rule enable/disable and threshold configuration
- [ ] **HIBP Pwned Passwords, opt-in, off by default** — k-anonymity (SHA-1 prefix of 5 chars only)
- [ ] A plain-English explainer of exactly what leaves the device, shown before it is ever enabled
- [ ] Result caching, rate limiting, offline-graceful failure, a visible "last checked" timestamp
- [ ] A global network kill-switch in Settings that disables even this
- [ ] **Tests:** each rule's boundary conditions · k-anonymity request builder sends only the 5-char prefix · cache behaviour
- [ ] `docs/05-Features/health-dashboard.md` written

## Phase 14 — Settings & configurability

_Goal: the user, not us, decides their security/convenience trade-off._

- [ ] Settings shell: Vault · Security · Privacy · Appearance · Behaviour · Import/Export · Sync · Advanced · About
- [ ] **Security presets** — Relaxed / Balanced / Strict / Paranoid — each a named bundle of the individual settings
- [ ] Every individual setting independently overridable, with a visible "modified from preset" marker
- [ ] Settings search
- [ ] Reset-to-default per setting and per section
- [ ] Settings export/import (never includes secrets)
- [ ] Advanced: KDF parameters, retention counts, cache sizes, the network kill-switch, a debug-log toggle (off by default)
- [ ] **Tests:** every preset resolves to a complete, valid settings object · migration of a settings file from an older shape
- [ ] `docs/05-Features/settings.md` written

## Phase 15 — App chrome & quality-of-life systems

- [ ] **Route/view table** — one source of truth every other system reads from (build this first; the palette, menus and shortcuts all consume it)
- [ ] Command palette `Ctrl/Cmd+K` — jump to credential, run actions, switch theme, lock, generate
- [ ] Toast system, with Undo affordances
- [ ] Modal/dialog system — focus-trapped, ESC to close, `aria-modal`, restores focus on close
- [ ] Tooltip system
- [ ] Determinate progress bar for Argon2, import, export and merge
- [ ] Attachment/image lightbox
- [ ] Deliberate empty, loading and error states on every single view
- [ ] Full keyboard operation; shortcut cheat-sheet `Ctrl/Cmd+/`; remappable bindings
- [ ] `.keep` file association — double-clicking a vault opens Keyhold
- [ ] Optional launch-at-login; start-minimised-to-tray option
- [ ] Opt-in update check against GitHub Releases, **off by default**
- [ ] **Guard test:** every view in the route table is reachable from the command palette

## Phase 16 — In-app content pages

- [ ] Help & FAQ — fully offline, bundled
- [ ] Changelog view, rendered from `CHANGELOG.md` at build time (never a hand-maintained second copy)
- [ ] About — version, credits, links, and an **auto-generated** third-party licence list
- [ ] **Security & Threat Model** page, in plain English, including what Keyhold does _not_ protect against
- [ ] Keyboard shortcut reference
- [ ] First-run onboarding tour, skippable and re-runnable
- [ ] **Guard test:** the licence list is generated from `package.json`, not hand-written

## Phase 17 — Accessibility, performance & quality audits

- [ ] **Accessibility sweep (WCAG 2.2 AA):** contrast in every theme · full keyboard route with no traps · visible focus everywhere · labels on every input · ARIA only where native will not do · `prefers-reduced-motion` · minimum 44×44 px targets · `lang` attribute · screen-reader pass on the primary flows
- [ ] **Performance sweep:** startup time budget · unlock time (Argon2, off-thread) · list render with 10 000 records · search latency · memory after unlock · lazy-load `kdbxweb`, `zxcvbn` and the PDF preview
- [ ] **Responsive sweep:** every view at the minimum window size and at five widths; nothing overflows outside a designated scroll container
- [ ] **Refactoring sweep:** oversized files split, duplicates folded, dead code removed
- [ ] **Stale-docs sweep:** every number, path and claim in `docs/` verified against the code
- [ ] Dependency audit — `npm audit`, licence compatibility with GPL-3.0
- [ ] Write each audit's findings to `docs/13-Appendix/`, including an explicit "checked and fine" list

## Phase 18 — Packaging, CI & release

- [ ] `electron-builder` config — NSIS installer + portable (Windows), DMG + zip (macOS, x64 + arm64)
- [ ] App icons and installer artwork for both platforms
- [ ] GitHub Actions: lint + typecheck + test on push and PR
- [ ] GitHub Actions: tagged release → build matrix → draft Release with artefacts and SHA-256 checksums
- [ ] Reproducible-ish build notes so a third party can verify a binary
- [ ] Document the **unsigned-build** experience: exact SmartScreen and Gatekeeper steps for users
- [ ] Dependabot config; issue and PR templates
- [ ] Verify a clean install on Windows; **[!] a real macOS machine is needed — see MANUAL-BACKLOG**
- [ ] Tag `v1.0.0`

## Phase 19 — Documentation & README

- [ ] Complete the numbered `docs/` tree using the **`comprehensive-documentation`** skill
- [ ] `_INDEX.md` in every folder plus the top-level `docs/_INDEX.md`
- [ ] `docs/13-Appendix/03-Doc-Audit-Findings.md` — known code/doc mismatches and deliberate oddities
- [ ] Publish the KEEP format spec as a standalone, implementable document
- [ ] **`README.md` using the `anahat-readme` skill** — never freehanded
- [ ] README must include: the three-line pitch, the honest comparison table (including where competitors win), screenshots, the threat model summary, install instructions with the unsigned-build steps, and the "how to leave" export story
- [ ] Project `CLAUDE.md` finalised — stack, commands, architecture, conventions, guardrails, docs map, watch-outs
- [ ] Final check of `MANUAL-BACKLOG.md` — nothing left undone that was assumed done

---

## Cross-cutting rules — apply in every phase

- [ ] **No hardcoded values.** Colours are tokens; tunables live in one config module; magic numbers get names.
- [ ] **No `Math.random()` anywhere near a secret.** CSPRNG only.
- [ ] **No secret in a log, an error message, a URL, or a crash report.** Ever.
- [ ] **No second list.** If a system wants its own copy of "the views" or "the formats", fold it into the existing source of truth.
- [ ] **Ship the guard with the system** — a theme gets a contrast test, a registry gets a uniqueness test, a number written in prose gets a test that parses it back out.
- [ ] **Update the system's doc in the same pass as its code.** A stale doc is worse than no doc.
- [ ] **Commit per completed slice**, staged by explicit path — never `git add -A`.
- [ ] **Files stay short and single-purpose.** Split by concern before a file becomes unpleasant.

---

## Progress

| Phase                            | Status      |
| -------------------------------- | ----------- |
| 0 · Scaffold                     | ✅ **Done** |
| 1 · Crypto & KEEP format         | ✅ **Done** |
| 2 · Vault service & IPC          | ✅ **Done** |
| 3 · Shell, design system, themes | Not started |
| 4 · Unlock, lock, session        | Not started |
| 5 · CRUD & fields                | Not started |
| 6 · History & audit trail        | Not started |
| 7 · Organisation & search        | Not started |
| 8 · Password generator           | Not started |
| 9 · Attachments                  | Not started |
| 10 · Import                      | Not started |
| 11 · Export & transfer bundle    | Not started |
| 12 · Sync & merge                | Not started |
| 13 · Health dashboard            | Not started |
| 14 · Settings                    | Not started |
| 15 · Chrome & QoL                | Not started |
| 16 · In-app content              | Not started |
| 17 · Audits                      | Not started |
| 18 · Packaging & CI              | Not started |
| 19 · Docs & README               | Not started |
