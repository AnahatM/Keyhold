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

## Phase 3 — App shell, design system & theme engine ✅

_Goal: the three-pane shell renders, and every theme is contrast-safe._

- [x] CSS token layer — colour, space, radius, shadow, motion, type. **Zero hardcoded colours**
- [x] Themes defined as **typed data, not CSS**, so one source feeds the runtime, the contrast guard and the theme editor — no second list
- [x] Eight themes: Dawn, Midnight, Slate, Nord, Solarized Light, Solarized Dark, Rose, High-Contrast
- [x] Independent accent picker with **runtime contrast derivation** — the picker is the one place a user can create a combination the build-time guard never saw
- [x] Density control (compact / comfortable / spacious), with comfortable and above at or over the 44px WCAG target size
- [x] Font-size scale and font-family choice; **secrets always monospace** regardless
- [x] Follow-OS toggle; `prefers-reduced-motion` OR-ed with the app setting, never overridden
- [x] `.keeptheme` export and import, with validation that names the missing tokens
- [x] Three-pane shell, both panes collapsible, widths persisted, dividers keyboard-operable
- [x] Degrades three-pane → two → one rather than squeezing
- [x] Base components: Button, Input/Field, Badge, EmptyState, ErrorState, LoadingState, Skeleton
- [x] Native menu bar with correct macOS and Windows conventions; vault items disabled while locked
- [x] Window state persistence, including the **off-screen-restore guard**
- [x] **Guard test:** every token resolves in every theme, no unknown keys, every colour parseable
- [x] **Guard test:** every foreground/background pair passes WCAG AA in **every** theme (252 assertions)
- [x] **Guard test:** every theme × every accent preset × 10 hostile colours stays readable (~970 assertions)
- [x] **Extra:** screenshot capture in the smoke harness (`npm run test:smoke -- --shot <path>`), for verifying the UI actually renders and for reproducible README screenshots in Phase 19
- [x] `docs/06-UI-Design-System/` written

**Verified:** `npm run verify` green (1252 tests) · `npm run test:smoke` passes · the running
app captured and visually checked. Fault injection confirmed the window-state guard (3 tests
fail without the display check); the theme guard caught two genuine contrast failures during
authoring (Dawn `border-strong` at 2.99:1, Nord `danger-text` at 4.23:1), and the accent
guard caught a real quantisation bug where a value accepted at 4.50:1 shipped at 4.48:1.

**Deferred, with reasons — see `docs/06-UI-Design-System/01-Layout-And-Components.md` §4:**
Select/Switch/Radio (Phase 14, settings), Tabs/Card/Chip (Phase 5, the detail view),
Tooltip/Menu/Modal/Toast (Phase 15, where the chrome systems live), the theme **editor UI**
(Phase 14 — the model, contrast maths, validation and import/export are already built and
tested; only the editing surface is outstanding), and the system tray (Phase 15, alongside
the commands it would contain). A component with no caller is designed against a guess.

## Phase 4 — Unlock, lock & session security ✅

_Goal: you can create a vault, unlock it, and trust that it locks itself._

- [x] **Argon2 on a worker thread** so the window never freezes. The renderer being a separate process does not solve this — it stays responsive but cannot paint anything main has not sent it
- [x] Worker built as its own entry, tested against the **built** file; the gate now builds before testing so those tests cannot silently skip
- [x] `KdfProvider` interface with a deliberate **no silent fallback** — a missing worker in a packaged app is a real bug, not something to paper over
- [x] Welcome screen with recent vaults, native file dialogs opened by **main** (a renderer-supplied path would be attacker-controlled; an OS dialog is genuine consent)
- [x] Create-vault flow: live strength meter, and an explicit **"there is no recovery" checkbox** rather than fine print
- [x] Master-password strength via zxcvbn in main only, with app-specific terms as `userInputs` and a 12-character floor on top of the score
- [x] Unlock screen with a working state that **explains why it is slow**, a ticking lockout countdown, and a note naming the reason for a lock the user did not ask for
- [x] Unlock throttling: free attempts for typos, exponential backoff, capped
- [x] Auto-lock on OS-wide idle, sleep, screen-lock; minimise and blur available but off
- [x] Clipboard: one atomic write carrying the no-retain markers, auto-clear countdown, clear-only-if-still-ours, cleared on every lock path
- [x] Quick unlock with **honest capability reporting** — Touch ID is a biometric gate, Windows DPAPI is not, and the UI copy comes from main rather than being hardcoded
- [x] Optional wipe-after-N-failures: off by default, refused below 3, and it removes the backups too
- [x] Absolute deadlines cross IPC, so countdowns are derived rather than mirrored and decremented
- [x] **Tests (75):** the full create → lock → unlock cycle · lock clearing the clipboard · throttle timing with an injected clock · quick-unlock enrolment, revocation and re-key invalidation · the wipe threshold firing at exactly N · strength verdicts including app-specific terms · worker output matching in-process byte for byte · the calling thread staying free
- [x] **Smoke test extended** to drive create → lock → wrong-password-rejected → unlock → list in the real app against a real file
- [x] `docs/02-Security/02-Session-Model.md` written

**Verified:** `npm run verify` green (1318 tests) · `npm run test:smoke -- --vault <path>` drives
the whole cycle and passes · the written file confirmed to be a real KEEP vault (correct magic
bytes, plaintext header, high-entropy body, and the passphrase absent from the file) · welcome
screen captured and visually checked, which caught a layout bug where `flex-direction: column`
leaked from a sibling class and centred the action buttons.

**Deferred to Phase 14 (settings), where their UI belongs:** change master password, rotate
DEK, and change KDF parameters. The service methods exist and are tested; only the settings
surface to drive them is outstanding.

## Phase 5 — Credential CRUD & the field system ✅

_Goal: full create/read/update/delete over every field discussed._

- [x] Credential list — **virtualised**, handles 10 000+ entries; row height read from the density token so it stays correct when density changes
- [x] Detail view, edit view, create flow
- [x] Core fields: title, username, email, password, **multiple URLs**, notes
- [x] Security questions as repeatable first-class `{question, answer}` pairs — the prompt is not secret, the answer is treated as a password
- [x] Custom fields — unlimited, 13 types, reorderable, individually hidden
- [x] Per-field reveal / copy / hide, with `aria-live` announcements (a copy's visible feedback is invisible to a screen reader)
- [x] Icons: letter and emoji. **No favicon fetching** — it would tell a server which accounts exist
- [x] Duplicate a credential, regenerating **every** id, without history or attachments
- [x] Soft delete → Trash, with restore and retention enforced **on save, not on a timer**
- [x] Undo on every destructive action; permanent deletion is the one exception and asks first instead
- [x] Unsaved-changes guard
- [x] **Tests (29 unit + 14 end-to-end):** defaults · the change-detection matrix for every tracked field · the no-op case · `passwordUpdatedAt` separation · duplicate-id rejection · trash/restore idempotence · retention boundaries
- [x] **The smoke run now asserts the live IPC surface never returns a password or a note in a projection** — fault-injected and confirmed
- [x] `docs/03-Data-Model/` written

**Verified:** 21 end-to-end checks pass in the running app; the populated UI captured and
visually checked (which caught a leftover duplicate the CRUD cycle was not cleaning up).

**Deferred:** bulk edit and drag-to-reorder for custom fields — both want the selection and
drag machinery that arrives with Phase 7's organisation work, and building them twice would
be worse than building them once.

## Phase 6 — History, versioning & the audit trail _(headline feature)_ ~ ENGINE DONE

_The engine, the provenance capture and the service methods are built and tested. The
timeline UI and its IPC channels are not. Full notes: `docs/05-Features/02-History-And-Audit.md`._

- [x] Version model — changed-field list plus a partial snapshot, with **backward deltas**, so
      that pruning the oldest versions leaves every surviving entry restorable
- [x] **Per-credential "keep past versions" checkbox**, with a global default and per-record override
- [x] Configurable retention cap, with oldest-first pruning and no renumbering
- [x] Origin capture in the main process: device name, OS user, platform, OS release, app version
- [x] Network name — `netsh wlan show interfaces` / `system_profiler SPAirPortDataType`, falling
      back to the active interface name; **cached and asynchronous, so it can never block a save**
- [x] Optional local IP capture
- [x] **Privacy levels:** `none` / `device` (default) / `network` / `full`, enforced at capture
- [x] `meta.createdOrigin` — creation has no previous state, so it lives on the record
- [x] Restore an entire version, or a single field from one; a restore is itself versioned
- [x] Field-level diff between any two points in the timeline
- [x] Reveal an old password — four `historic-*` secret refs, the version number in the broker key
- [x] `clearHistory`, because an audit trail is the one feature that can hold something a user
      wants gone
- [x] History timeline UI on the detail pane, and its IPC channels — entries newest first,
      an expandable diff per entry, restore, and a clear-history action that asks twice
- [x] Old secrets revealed through the broker under the same rules as live ones
- [ ] Comparing two arbitrary points (`history.compare` exists end to end; nothing calls it)
- [ ] Restoring a single field from a timeline row (`restoreField` exists end to end)
- [ ] Export a single credential's history
- [x] **Tests (70):** versioning on change only · retention pruning and its direction ·
      reconstruction across a prune · diff correctness · restore and un-restore · the privacy
      sweep asserting each level captures exactly what it declares · capture under a hung probe
- [x] `docs/05-Features/02-History-And-Audit.md` written

**Seven fault injections, all now caught.** The seventh found a genuine gap rather than
confirming a guard: no broker test covered historic refs, so dropping the version number from
the key — which would let a renderer walk a record's whole password history for one grant —
passed silently. Two tests added; the re-injection then failed.

## Phase 7 — Organisation, search, sort & filter ~ SEARCH DONE

_The query, ranking and sort engine is built, tested, and wired into the list. Folders, tags
and the query-bar UI are not. Full notes: `docs/05-Features/03-Search-Sort-Filter.md`._

- [x] Query language: field prefixes, quoted phrases, `is:`/`has:` flags, negation
- [x] Case- and diacritic-insensitive matching, with ranked results and per-field match info
- [x] Deep matches from the main process merged in by id — the renderer never receives the
      note text, security answer or hidden value that matched
- [x] Sort by title, username, created, updated, password age, last used, use count, relevance —
      **total and stable**, with `Intl.Collator({ numeric: true })` built once
- [x] Trashed records excluded by default; `is:trashed` lifts it, `-is:trashed` does not
- [x] Folder-descendant filtering with a cycle guard
- [x] **The renderer's second, weaker implementation folded into this one**
- [ ] Folder tree and tag sidebar, drag-to-file, favourites
- [ ] Query-bar UI: prefix autocomplete from `QUERY_FIELDS`, the diagnostics line, saved searches
- [ ] A user-facing sort control
- [x] **Tests (79)** and nine fault injections, two of which exposed guards weaker than they
      looked
- [x] `docs/05-Features/03-Search-Sort-Filter.md` written

## Phase 8 — Password generator & strength ~ ENGINE DONE

_The generation engine is built and tested; the IPC channel and the UI are not._
_Full notes: `docs/05-Features/00-Password-Generator.md`._

- [x] Random mode: length, character classes, exclude-ambiguous, require-one-of-each, custom exclude set
- [x] Passphrase mode with the **real EFF large wordlist** (7 776 words, hash pinned, prefix-freedom asserted — including the four hyphenated entries a naive guard would have rejected)
- [x] Pronounceable mode and PIN mode
- [x] Entropy that reflects the alphabet **after** exclusions, and that **charges for** `requireEachClass` rather than overstating it
- [x] An over-restrictive config throws rather than silently producing something weaker
- [x] **Tests (14)**, including a statistical anti-bias guard over ~2 000 samples. Six fault injections; one found a real gap — applying exclusions to the output rather than the alphabet is caught only by the length assertion, which is now documented as that defect's sole guard
- [ ] IPC channel and generator UI
- [ ] Session generation history, per-site rule memory, generate-and-replace (auto-versioning the old password)
- [x] `docs/05-Features/00-Password-Generator.md` written

## Phase 9 — Encrypted attachments ~ ENGINE DONE

_The engine is built and tested; reading files, IPC, previews and drag-and-drop are not.
Full notes: `docs/05-Features/04-Attachments.md`._

- [x] Attach a file → its own encrypted chunk, **content-addressed and shared** between
      records that attach the same file
- [x] **The chunk id stays random rather than becoming the digest** — ids are plaintext in the
      container, so a content-derived id would fingerprint every attachment to anyone holding
      the locked file
- [x] Reference counting, with trashed records still counting as referrers
- [x] SHA-256 integrity verification, and orphan detection in both directions — reported, never
      silently repaired
- [x] Size limits derived from how the container is actually read (peak resident is ~3× the
      total), validated against the container's own ceiling
- [x] MIME sniffed rather than trusted; the **detected** type is stored, because it picks the
      viewer; filenames sanitised, `evil.pdf.exe` flagged rather than renamed
- [x] **Fixed a latent data loss in `purgeCredential`** — it deleted every chunk the record
      listed, which with shared chunks deletes files other records still display
- [ ] Reading a file from disk, IPC channels, drag-and-drop, export to disk with its warning
- [ ] In-app preview: images, PDF, plain text; a lightbox
- [ ] `VaultSettings` carrying the caps, so they travel with the vault
- [x] **Tests (80)** and nine fault injections, all caught
- [x] `docs/05-Features/04-Attachments.md` written

## Phase 10 — Import ~ PARSERS DONE

_Eleven parsers are built and tested. The commit half — IPC, the wizard, dedupe, dry-run,
undo — is not. Full notes: `docs/09-Import-Export/00-Import-Formats.md`._

- [x] Bitwarden CSV and unencrypted JSON (encrypted exports refused with a reason)
- [x] LastPass, Chromium (Chrome/Edge/Brave), Firefox, Safari/Apple, 1Password 8, Dashlane,
      NordPass, KeePassXC and the older KeePass CSV
- [x] Generic CSV with inferred mapping, and an explicit mapping for the wizard to supply
- [x] Hand-written RFC 4180 reader: BOM, quoted newlines, mixed line endings, ragged rows
- [x] Strict detection — an unfamiliar variant falls through to the generic mapper rather than
      being parsed by the wrong parser
- [x] Nothing dropped silently; **no warning may quote a value**
- [x] Fixtures in `tests/fixtures/import/`, never beside the parsers
- [ ] IPC, the mapping wizard, dedupe against the existing vault, dry-run, undo, activity log
- [ ] KDBX 3/4, KeePass XML, 1PUX, Proton Pass, Enpass, Keeper, RoboForm, Dashlane JSON, and
      Keyhold's own `.keep`/`.keepx`
- [x] **Tests (264)** and six fault injections, two of which found real holes
- [x] `docs/09-Import-Export/00-Import-Formats.md` written

## Phase 11 — Export & the transfer parcel ~ ENGINE DONE

_The serialisers are built and tested, and Keyhold's own JSON export re-imports. The IPC
channel and the export dialog are not. Full notes: `docs/09-Import-Export/01-Export-Formats.md`._

- [x] Lossless Keyhold JSON — every field, folders, tags, settings, **and history with its
      origins**; deterministic, field-by-field, never `JSON.stringify(record)`
- [x] Flat Keyhold CSV, and a **compatible CSV in Bitwarden's exact eleven columns**, proven
      by running Keyhold's own Bitwarden parser over the output
- [x] Encrypted `.keepx` parcel, composing the existing envelope/container/header — no second
      AEAD, and deliberately non-deterministic bytes, because determinism here means nonce reuse
- [x] **CSV injection neutralised**, with the cost reported: a neutralised value is no longer
      byte-identical to the vault, so every rewritten cell is counted per column and named
- [x] A UTF-8 BOM by default, so Excel does not open the file as the ANSI code page
- [x] Every plaintext result carries a mandatory warning, in the type, and the engine writes
      no files at all
- [x] Trashed records excluded unless explicitly asked for, in all four formats, with the
      exclusion itself reported
- [x] Subset exports prune folders and tags to what the selection references
- [x] **The round trip closes** — `keyhold-json` is a registered importer, and the one strict
      parser
- [ ] IPC channel, export dialog, type-to-confirm, restrictive file permissions, shred reminder
- [ ] KDBX 4 export; Bitwarden JSON export
- [x] **Tests (89 + 13)** and sixteen fault injections, one of which found a guard that was
      not the one doing the work
- [x] `docs/09-Import-Export/01-Export-Formats.md` written

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

## Phase 13 — Health dashboard ~ RULES DONE

_The eight offline rules are built and tested; the dashboard, the IPC channel and the
opt-in HIBP check are not. Full notes: `docs/05-Features/01-Health-Rules.md`._

- [x] Offline rules: weak · reused (with the cluster) · old · expiring/expired · insecure `http://` URL · incomplete · likely-duplicate · empty title
- [x] Trashed records excluded from every rule
- [x] An overall score with **explicit, arguable weights** rather than an opaque formula, reproducible from the report itself so it can be audited
- [x] Disabling a rule can only raise the score or leave it — renormalising would change the score of a vault that never broke the rule you just switched off
- [x] **The report can never carry a password**: cluster ids are synthetic counters not hashes, and `insecureUrl` reports the host rather than the URL (which can carry credentials in its userinfo)
- [x] **Tests (44)**, including every rule's boundary conditions and a no-secrets property test. Four fault injections
- [ ] Dashboard view, IPC channel, per-rule settings
- [ ] **HIBP Pwned Passwords, opt-in and off by default** — deliberately absent for now: no network code, no stub, no fetching import
- [ ] `missing-2FA` — needs a model decision, since there is no 2FA field to key it off
- [x] `docs/05-Features/01-Health-Rules.md` written

## Phase 14 — Settings & configurability ~ UI DONE

_The screen is built and tested against a gateway interface; the IPC channel for changing
`VaultSettings` does not exist yet._

- [x] Appearance (mounting the existing panel), security and session, history and audit,
      health rules, vault, danger zone
- [x] **Machine settings and vault settings are visibly different** — one follows the file to
      another device, the other does not
- [x] The four audit privacy levels rendered from `AUDIT_LEVEL_FIELDS`, and health rules from
      `HEALTH_RULE_IDS` — never a hand-written list
- [x] Every default is the safe one, and reset restores exactly that
- [ ] The `kh:settings:*` IPC channels, and the master-password change flow
- [x] **Tests (32)**

## Phase 15 — Chrome & quality of life ~ CHROME DONE

_The notification, dialog, tooltip, progress and empty-state layer is built and mounted. The
shortcut table, the command palette and the lightbox are not.
Full notes: `docs/06-UI-Design-System/02-App-Chrome.md`._

- [x] Toasts, with a queue that coalesces then caps then bounds, and **undo and error toasts
      that never dismiss themselves**
- [x] Two live regions, so an error interrupts and "Copied" does not
- [x] Pause on hover **and focus**, resuming with the remaining time (WCAG 2.2)
- [x] Toasts cleared on lock, because one can name a record
- [x] Modal and confirm dialog on the native `<dialog>` — real inertness, not a Tab-only trap
- [x] Tooltips: 500 ms on hover, **0 on focus**, never closing on a timer
- [x] Progress that is honest about a slow unlock, with a reduced-motion fallback that is a
      steady fill rather than a frozen sweep
- [x] Empty states with real copy, rendered through the existing primitive
- [ ] Global shortcut table and the command palette (Ctrl/Cmd+K)
- [ ] Image lightbox — wants attachments (Phase 9) first
- [x] **Tests (62)** and six fault injections, all caught
- [x] `docs/06-UI-Design-System/02-App-Chrome.md` written

## Phase 16 — In-app content pages

- [ ] Help & FAQ — fully offline, bundled
- [ ] Changelog view, rendered from `CHANGELOG.md` at build time (never a hand-maintained second copy)
- [ ] About — version, credits, links, and an **auto-generated** third-party licence list
- [ ] **Security & Threat Model** page, in plain English, including what Keyhold does _not_ protect against
- [ ] Keyboard shortcut reference
- [ ] First-run onboarding tour, skippable and re-runnable
- [ ] **Guard test:** the licence list is generated from `package.json`, not hand-written

## Phase 17 — Accessibility, performance & quality audits ~ FIRST PASS DONE

_Two written audits plus an adversarially-verified review workflow.
Reports: `docs/14-Audits/`._

- [x] Security audit: 15 findings (2 high, 3 medium, 6 low, 4 informational), no critical.
      **The secret boundary swept end to end and clean** — projection, diff projection, every
      IPC handler, the preload, the renderer's persistence. `npm audit --omit=dev`: 0
      vulnerabilities
- [x] Docs-vs-code audit: 20 findings. Every _guarded_ number verified correct; it was the
      unguarded prose counts that had rotted
- [x] An eight-dimension review workflow with three-vote adversarial verification per finding
- [x] **Five findings fixed**, each with a fault-injected guard: the `save()` read-modify-write
      that lost data silently, two independent `shell.openExternal` paths taking any URI scheme,
      `file:` URLs all counting as "us", `ELECTRON_RENDERER_URL` honoured when packaged, and a
      vault path validator that permitted any path
- [ ] Fix the remaining audit findings, notably the CHANGELOG and the stale "not built yet"
      sections
- [ ] Audit the nine subsystems that landed _after_ the sweep — `activity`, `attachments`,
      `breach`, `organisation`, `recovery`, `shell`, `sync`, `theme`, `totp`. **`breach/` is the
      project's first network code and needs its own pass before it ships**
- [x] `docs/14-Audits/` written

## Phase 18 — Packaging, CI & release ~ CONFIGURED, NEVER RUN

_Config and workflows are written and schema-valid. **No packaged build has ever been
produced and no workflow has ever run** — there is no remote yet. Full notes:
`docs/13-Packaging/00-Building-And-Releasing.md`._

- [x] `electron-builder.yml`: NSIS + portable (Windows), universal DMG + zip (macOS), asar on,
      an allow-list `files` block so no source, test, fixture or source map ships
- [x] `.keep` / `.keepx` / `.keeptheme` file associations
- [x] **Unsigned, and honest about it** — what SmartScreen and Gatekeeper actually show, and
      the way through, written down rather than glossed. macOS is **ad-hoc** signed, because a
      genuinely unsigned binary will not launch at all on Apple Silicon
- [x] Verify workflow on push/PR; release workflow on a tag with **SHA-256 checksums**, which
      for an unsigned binary is the only integrity story there is
- [x] Action versions pinned by SHA — a floating tag on a password manager's release pipeline
      is a supply-chain surface
- [x] `asarUnpack` for the Argon2 worker: it is started from a runtime path, so inside an asar
      it would build, launch, show the unlock screen and never derive a key — and nothing in
      build, test or test:smoke would notice
- [ ] Produce a real build on each platform and confirm a vault unlocks in it (MANUAL-BACKLOG)
- [ ] App icons (MANUAL-BACKLOG M-ICON)
- [x] `docs/13-Packaging/` written

## Phase 19 — Documentation & README

- [ ] Complete the numbered `docs/` tree using the **`comprehensive-documentation`** skill
- [ ] `_INDEX.md` in every folder plus the top-level `docs/_INDEX.md`
- [x] Doc/code mismatches and deliberate oddities — now `docs/14-Audits/01-Doc-Code-Audit.md`,
      because `13-` was taken by packaging by the time it was written
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

> **A note on "not mounted" and "needs IPC".** A large amount of this project is now
> _built and tested but not reachable by a user._ Several screens are complete against a
> gateway interface with an in-memory fake, because their IPC channels do not exist yet;
> others are finished components that nothing renders. That is a deliberate consequence of
> building engines before wiring — the engine is where correctness lives and the wiring is
> mechanical — but it means the honest reading of this table is that the **remaining work is
> mostly integration, not construction.** `MANUAL-BACKLOG.md` §M-IPC lists every channel
> group still owed.

| Phase                            | Status         |
| -------------------------------- | -------------- |
| 0 · Scaffold                     | ✅ **Done**    |
| 1 · Crypto & KEEP format         | ✅ **Done**    |
| 2 · Vault service & IPC          | ✅ **Done**    |
| 3 · Shell, design system, themes | ✅ **Done**    |
| 4 · Unlock, lock, session        | ✅ **Done**    |
| 5 · CRUD & fields                | ✅ **Done**    |
| 6 · History & audit trail        | ~ Nearly done  |
| 7 · Organisation & search        | ~ IPC done     |
| 8 · Password generator           | ~ Not mounted  |
| 9 · Attachments                  | ~ IPC done     |
| 10 · Import                      | ~ Needs IPC    |
| 11 · Export & transfer bundle    | ~ Needs IPC    |
| 12 · Sync & merge                | ~ Engine done  |
| 13 · Health dashboard            | ~ Not mounted  |
| 14 · Settings                    | ~ IPC done     |
| 15 · Chrome & QoL                | ~ Palette live |
| 16 · In-app content              | ~ Not mounted  |
| 17 · Audits                      | ~ First pass   |
| 18 · Packaging & CI              | ~ Configured   |
| 19 · Docs & README               | Not started    |
