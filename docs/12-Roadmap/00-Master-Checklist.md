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

**Unblocked 2026-09-03:** the remote exists — `AnahatM/Keyhold`, private, `main` tracking
`origin/main`. `gh` had been installed all along and was simply not on either shell's PATH; two
earlier passes read that as "not installed". See `MANUAL-BACKLOG.md` M1.

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
- [x] Restoring a single field from a timeline row — `DiffRows.tsx` calls it through the store
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
- [x] Folder tree and tag sidebar, drag-to-file, favourites — `organisation/FolderTree.tsx`,
      `TagFilterList.tsx`, the drag handlers in the sidebar, and Favourites as a smart view in
      `smart-views.ts` rather than a second code path (its count comes from the same place
      every other count does)
- [ ] Query-bar UI: prefix autocomplete from `QUERY_FIELDS`, the diagnostics line, saved searches
      — the parser and `QUERY_FIELDS` are done and unit-tested; no `.tsx` imports either, so
      none of the three is built
- [ ] A user-facing sort control
- [x] **Tests (79)** and nine fault injections, two of which exposed guards weaker than they
      looked
- [x] `docs/05-Features/03-Search-Sort-Filter.md` written

## Phase 8 — Password generator & strength ~ MOUNTED

_The engine, the three `kh:generator:*` channels and the UI are all built. The generator is a
tool view, reachable from the sidebar, and folds into the credential form as a disclosure._
_Full notes: `docs/05-Features/00-Password-Generator.md`._

- [x] Random mode: length, character classes, exclude-ambiguous, require-one-of-each, custom exclude set
- [x] Passphrase mode with the **real EFF large wordlist** (7 776 words, hash pinned, prefix-freedom asserted — including the four hyphenated entries a naive guard would have rejected)
- [x] Pronounceable mode and PIN mode
- [x] Entropy that reflects the alphabet **after** exclusions, and that **charges for** `requireEachClass` rather than overstating it
- [x] An over-restrictive config throws rather than silently producing something weaker
- [x] **Tests (14)**, including a statistical anti-bias guard over ~2 000 samples. Six fault injections; one found a real gap — applying exclusions to the output rather than the alphabet is caught only by the length assertion, which is now documented as that defect's sole guard
- [x] IPC channels (`kh:generator:generate`, `:estimate`, `:limits`) and the generator UI — a tool view plus `InlineGenerator`, which generates nothing until it is opened
- [x] Session generation history — `generation-history.ts` and `SecretHistoryList`, discarded when the panel collapses
- [ ] Per-site rule memory, and generate-and-replace that auto-versions the old password
- [x] `docs/05-Features/00-Password-Generator.md` written

## Phase 9 — Encrypted attachments ~ MOUNTED, MINUS DRAG-AND-DROP

_Engine, channels, panel and preview are all in: both dialogs open in the main process, the
bytes never cross the bridge, and the preview judges by sniffed type. What is left is
drag-and-drop and a lightbox. Full notes: `docs/05-Features/04-Attachments.md`._

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
- [x] Reading a file from disk, IPC channels, export to disk with its warning — both dialogs
      open in the main process, the bytes never cross the bridge, and there is deliberately
      no `read` channel
- [ ] Drag-and-drop onto the attachments panel — the only part of that line not built
- [x] In-app preview: images, PDF, plain text — `AttachmentViewer.tsx`, judged on the
      **sniffed** type rather than the claimed one
- [ ] A lightbox for the preview (also Phase 15)
- [x] `VaultSettings` carrying the caps, so they travel with the vault
- [x] **Tests (80)** and nine fault injections, all caught
- [x] `docs/05-Features/04-Attachments.md` written

## Phase 10 — Import ~ MOUNTED, MORE FORMATS TO COME

_The parser registry, the import service with its six `kh:import:*` channels, and the wizard
itself — reachable from the File menu and the palette. What is left is more source formats
and the activity-log entry. Full notes: `docs/09-Import-Export/00-Import-Formats.md` and
`02-Import-Service.md`._

- [x] Bitwarden CSV and unencrypted JSON (encrypted exports refused with a reason)
- [x] LastPass, Chromium (Chrome/Edge/Brave), Firefox, Safari/Apple, 1Password 8, Dashlane,
      NordPass, KeePassXC and the older KeePass CSV
- [x] Generic CSV with inferred mapping, and an explicit mapping for the wizard to supply
- [x] Hand-written RFC 4180 reader: BOM, quoted newlines, mixed line endings, ragged rows
- [x] Strict detection — an unfamiliar variant falls through to the generic mapper rather than
      being parsed by the wrong parser
- [x] Nothing dropped silently; **no warning may quote a value**
- [x] Fixtures in `tests/fixtures/import/`, never beside the parsers
- [x] **IPC** — six `kh:import:*` channels plus a determinate `kh:event:import-progress`; no
      channel takes a path and none returns file content
- [x] **The mapping wizard**, as a state machine over a gateway interface, with an in-memory fake
- [x] **Dedupe against the existing vault** on title + login identity + host, the smallest key
      that catches a re-import without collapsing five accounts on one site
- [x] **Dry run** — the preview parses once, holds the parse, and the commit re-uses it, so the
      two cannot disagree
- [x] **Undo**, guarded on the expected generation, the batch's own generation **and** no unsaved
      changes — the third is what a generation-only check would miss
- [ ] The activity-log entry (`ACTIVITY_KINDS` already declares an `import` kind)
- [x] Mount `ImportWizard` — `menu-bridge.ts` routes `vault.import`, the palette offers the
      row, and `smoke.ts` asserts it is there. The line's stated reason went stale before the
      line did
- [ ] KDBX 3/4, KeePass XML, 1PUX, Proton Pass, Enpass, Keeper, RoboForm, Dashlane JSON, and
      Keyhold's own `.keep`/`.keepx`
- [x] **Tests** across the parsers, the service and the wizard, and six fault injections, two of
      which found real holes
- [x] `docs/09-Import-Export/00-Import-Formats.md` and `02-Import-Service.md` written

## Phase 11 — Export & the transfer parcel ~ MOUNTED, TWO FORMATS TO COME

_The serialisers, the preview and the three `kh:export:*` channels are built and tested,
Keyhold's own JSON export re-imports, and the dialog is mounted with its shred reminder. What
is left is KDBX 4 and Bitwarden JSON export. Full notes:
`docs/09-Import-Export/01-Export-Formats.md`._

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
- [x] **IPC channel** — three channels, none of which returns bytes: the save dialog opens in
      main, the file is written in main, and the renderer learns only where it landed
- [x] **Type-to-confirm checked in the main process**, against the raw text the user typed, by
      the one matcher — never a boolean the renderer computed
- [x] A plan whose `kind` disagrees with what the registry says about its format is **refused**,
      not guessed at; `includeTrashed` must be present, never defaulted at this boundary
- [x] **Restrictive file permissions** (`0o600`) on every readable format, and the plaintext
      buffer zeroed after the write
- [x] **The preview runs the real exporter** and discards the bytes, so the loss list the
      dialog shows is the list the file would carry — guarded, for all four formats
- [x] Mount the export dialog, with the shred reminder (`PLAINTEXT_AFTERMATH_REMINDER`) —
      `menu-bridge.ts` routes `vault.export` and the palette offers the row
- [ ] KDBX 4 export; Bitwarden JSON export
- [x] **Tests** and sixteen engine fault injections (one of which found a guard that was not
      the one doing the work), plus six on the preview and six on the IPC boundary
- [x] `docs/09-Import-Export/01-Export-Formats.md` written

## Phase 12 — Sync & merge ~ COMPLETE

_Goal: two devices, one cloud folder, and never a lost edit. Every line below is done. A user
can merge from the palette or the File menu, is offered the conflicted copies their sync client
left rather than having to find them, is told when the vault file changed underneath them and
offered only what does not destroy something, and gets a per-record account of every merge in
the vault's own encrypted history. Full notes:
`docs/07-Sync-And-Merge/00-Merge-Engine.md` and `01-The-Merge-Flow.md`._

- [x] Generation counter **and content hash** in the header — the counter answers "was this
      written again", the hash answers "is this content different from mine", and sync needs the
      second. Optional in the header, because it is the AAD and every older vault must still open
- [x] **File watcher on the open vault** — the hard part is not noticing but not crying wolf:
      one save is a dozen directory mutations, and a watcher that reported each would teach
      people to dismiss the prompt that matters. Decides from the plaintext header, never from
      an event, so it needs no key and no unlocked vault
- [x] Reload prompt when the on-disk vault changed — and, more to the point, **not** a reload
      prompt in the three cases where reloading destroys something: a replaced vault, an older
      file on disk, and unsaved edits in this window. The decision is a table tested over every
      combination of the flags, and `reloadFromDisk` refuses independently of it
- [x] **Base-snapshot storage** — the last-synced state, machine-scoped and never travelling
      with the vault: a snapshot arriving from another device is not this device's last-agreed
      state, which is the one input a three-way merge cannot survive being wrong about
- [x] Three-way merge engine — per record, per field, pure, and with no timestamp deciding a value
- [x] **Absence is not deletion** — a record in the ancestor and on one side only is kept and reported
- [x] **A duplicate id is refused, not resolved** — a named `DuplicateIdError`, thrown before
      anything is read (D26)
- [x] Tombstones so a deletion never resurrects
- [x] Conflict detection matrix (both changed · one changed · one deleted · both deleted · both created)
- [x] Field-level conflict resolver UI: mine / theirs, with a diff — and **mounted**, which
      was the gap that mattered: it was finished, tested and rendered by nothing at all
- [x] **The `kh:sync:*` channels** — prepare · resolve · commit · discard, with no file path
      crossing in either direction and an unrecognised side refused rather than defaulted
- [x] **The step in front of the resolver** — `prepare` is one call so a file can never be
      picked without the backup being taken, which means the window waits for a KDF; the wait
      is indeterminate and says so
- [x] **A KDF progress channel, shared with unlock** — `kh:event:kdf-progress`, one channel and
      three callers. Determinate by prediction rather than measurement, because Argon2 reports
      nothing and cannot be chunked: the rate is learned from this machine's own derivations and
      corrected after every one. Never reaches 100% before the work ends, and says when it has
      overrun. See `docs/02-Security/00-Cryptography.md` §3
- [x] **Mandatory pre-merge backup** — enforced rather than requested: a private-constructor
      receipt only the backup path can mint, minted after the copy is verified on disk, and
      required by every step that follows. Named, dated and retained, because the rolling
      `.bak.N` slots are rotated out by the very next save
- [x] The merge report itself — a conflict carries lengths, never values, and a resolution never
      sends a value back
- [x] Saving a merge report, and a view for it — as the vault's **own history** rather than a
      file: a version with `action: 'merge'` and full provenance on each record the merge
      changed, encrypted, travelling with the vault, and already visible in the timeline. A
      report written beside the vault would have been a plaintext index of record titles next
      to the ciphertext. `historyRecordsMerges` turns it off; off wins a disagreement
- [x] Cloud-folder detection with guidance — ten providers, recognised from the path alone and
      shown where the vault is described rather than as an alert. Whole-segment matching, because
      a false positive costs more than a miss: the merge engine recovers a miss, and telling
      somebody with a `Megabytes` folder that they are inside MEGA does not
- [x] Handle provider "conflicted copy" files — found beside the vault, described from their
      plaintext headers before any key is used, and offered as merge candidates by opaque id.
      No path crosses the bridge in either direction, which is what makes a channel that starts
      a merge from a named file safe to have at all
- [x] **Tests:** the full conflict matrix · five whole-engine properties, including that no merge loses a record · tombstone correctness · idempotent re-merge
- [x] Documentation written — at `docs/07-Sync-And-Merge/`, not the `docs/10-Sync-And-Transfer/` this line used to name; `07-` was free when it landed and `10-` was not

## Phase 13 — Health dashboard ~ MOUNTED, MINUS HIBP

_The offline rules in `HEALTH_RULE_IDS`, the `kh:health:analyse` channel, the dashboard and the per-rule
settings are all built, and the dashboard is a tool view. The opt-in HIBP check is not wired.
Full notes: `docs/05-Features/01-Health-Rules.md` and `07-Breach-Check.md`._

- [x] Offline rules: weak · reused (with the cluster) · old · expiring/expired · insecure `http://` URL · incomplete · likely-duplicate · empty title
- [x] Trashed records excluded from every rule
- [x] An overall score with **explicit, arguable weights** rather than an opaque formula, reproducible from the report itself so it can be audited
- [x] Disabling a rule can only raise the score or leave it — renormalising would change the score of a vault that never broke the rule you just switched off
- [x] **The report can never carry a password**: cluster ids are synthetic counters not hashes, and `insecureUrl` reports the host rather than the URL (which can carry credentials in its userinfo)
- [x] **Tests (44)**, including every rule's boundary conditions and a no-secrets property test. Four fault injections
- [x] Dashboard view (a tool view), the `kh:health:analyse` channel, and per-rule settings in `HealthRulesSection`
- [~] **HIBP Pwned Passwords, opt-in and off by default.** The k-anonymity client, the isolated
  HTTPS transport, the projection and the four-way no-network guard are built and tested, and
  the **global network kill-switch now exists** (D23). Still absent: the `kh:breach:*` channel,
  the consent screen, a UI control for `networkAllowed`, and the composition root that would
  construct a transport — so no code path in the running app makes a request
- [ ] `missing-2FA` — needs a model decision, since there is no 2FA field to key it off
- [x] `docs/05-Features/01-Health-Rules.md` written

## Phase 14 — Settings & configurability ~ MOUNTED, TWO CHANNELS SHORT

_The screen is built, wired to real IPC and mounted as the `settings` tool view. Four of the six
channels it needs exist; the two that do not are envelope-crypto operations rather than settings
writes. Full notes: `docs/06-UI-Design-System/01-Layout-And-Components.md` §1._

- [x] Appearance (mounting the existing panel), security and session, history and audit,
      health rules, vault, danger zone
- [x] **Machine settings and vault settings are visibly different** — one follows the file to
      another device, the other does not
- [x] The four audit privacy levels rendered from `AUDIT_LEVEL_FIELDS`, and health rules from
      `HEALTH_RULE_IDS` — never a hand-written list
- [x] Every default is the safe one, and reset restores exactly that
- [x] `kh:settings:read`, `:update-machine`, `:update-vault` and `:clear-all-history`, plus the
      quick-unlock toggle routed through the session channels — which **re-reads** after enrolling
      rather than reporting a failure it did not have (audit finding N4)
- [x] The screen is reachable — `settings` is one of the four tool views, opened from the sidebar
      or from the native Settings item through `menu-bridge.ts`
- [ ] `kh:settings:change-master-password` and `kh:settings:rekey`. Both re-wrap the DEK and both
      must be atomic against a real vault file, so they are a slice of their own;
      `REQUIRED_CHANNELS` in `settings-gateway.ts` names them, and a test fails if an entry there
      names a channel the contract already has
- [x] A UI control for `networkAllowed`, the global network kill-switch (D23) —
      `settings/SecuritySessionSection.tsx`, with the weakened-trade-off marker. The preference is
      persisted and writable over `kh:settings:update-machine`; nothing renders a toggle
- [x] **Tests** over the settings plan, the copy, the gateway and the channel inventory

## Phase 15 — Chrome & quality of life ~ DONE BAR THE LIGHTBOX

_The notification, dialog, tooltip, progress and empty-state layer is built and mounted, and so
are the shortcut table and the command palette. The lightbox is not. Full notes:
`docs/06-UI-Design-System/02-App-Chrome.md` and `03-Command-Palette-And-Shortcuts.md`._

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
- [x] Global shortcut table and the command palette (Ctrl/Cmd+K) — `CommandsProvider` is mounted
      in `App.tsx` outside the screen switch, so the listener survives a navigation
- [ ] `focusSearch` and `toggleSidebar`, the two handlers only the vault screen can supply, and a
      setting that can turn the palette off
- [ ] Image lightbox — wants attachments (Phase 9) first
- [x] **Tests** over the queue, the timing, the focus rules and the shortcut gate, and six fault injections, all caught
- [x] `docs/06-UI-Design-System/02-App-Chrome.md` written

## Phase 16 — In-app content pages ~ HELP MOUNTED

_The help viewer is one of the four tool views and ships its articles inside the app. The
generated pages — changelog, about, the licence list — are not built._

- [x] Help & FAQ — fully offline, bundled, and reachable: `ContentViewer` is the `help` tool
      view, over the articles in `src/renderer/src/content/articles/`
- [ ] Changelog view, rendered from `CHANGELOG.md` at build time (never a hand-maintained second copy)
- [ ] About — version, credits, links, and an **auto-generated** third-party licence list
- [x] **Security & Threat Model** in plain English — `how-your-data-is-protected.ts`, including what Keyhold does _not_ protect against
- [x] Keyboard shortcut reference — `keyboard-shortcuts.ts`, built from `shortcuts-source.ts` rather than hand-listed
- [ ] First-run onboarding tour, skippable and re-runnable
- [ ] **Guard test:** the licence list is generated from `package.json`, not hand-written

## Phase 17 — Accessibility, performance & quality audits ✅

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
- [~] Fix the remaining audit findings. The stale "not built yet" sections were swept in the
  documentation catch-up pass; `PRIVACY.md` and the CHANGELOG still need a hand
- [x] Audit the nine subsystems that landed _after_ the sweep — `docs/14-Audits/02-Subsystem-Audit.md`,
      N1–N39, with `breach/` given a pass of its own and a plain verdict on wiring it up
- [x] Work the findings. **Every finding in `docs/14-Audits/` is now closed** — no file in that
      directory carries a `STATUS: OPEN` line. This line used to name which findings were fixed
      and which were not, which is a snapshot: it was wrong within days and stayed wrong for
      weeks. It is not restated here, deliberately — grep the audit directory, which is the only
      place that can answer it truthfully
- [x] `docs/14-Audits/` written

## Phase 18 — Packaging, CI & release ~ CONFIGURED, NEVER RUN

_Config and workflows are written and schema-valid. **No packaged build has ever been produced.**
The remote now exists, so a workflow can run for the first time — but nothing has, and packaging
needs a machine to run on and a Mac for the macOS half (`MANUAL-BACKLOG.md` M-PKG, M-CI, M2).
Full notes: `docs/13-Packaging/00-Building-And-Releasing.md`._

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
- [x] `_INDEX.md` in every folder plus the top-level `docs/_INDEX.md`
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

> **A note on "not mounted" and "needs IPC".** A large amount of this project was built and
> tested before it was reachable, and a large amount of the wiring has since landed — the
> tool-view region, the menu bridge, the settings channels, the import and export channels, the
> command palette, and the import wizard and export dialog themselves. That was a deliberate
> order (the engine is where correctness lives; the wiring is mechanical), and the honest reading
> of this table is still that the **remaining work is mostly integration, not construction.**
>
> **A built thing nothing renders is worth less than an unbuilt one**, because it looks finished
> in every test and in every count while a user cannot reach it. Anything in the phases above
> marked as built-and-unmounted should be finished before new construction starts. What is left
> in that state: the renderer half of attachments, the onboarding flow, the theme-import
> channels, and the composition root for the breach check. The sync layer around the merge
> engine is the one genuinely unbuilt piece. `MANUAL-BACKLOG.md` §M-IPC lists the channel
> groups still owed.
>
> **This table is a summary of the phases above and rots faster than they do.** Where the two
> disagree, the phase section wins — and then fix this.

| Phase                            | Status                        |
| -------------------------------- | ----------------------------- |
| 0 · Scaffold                     | ✅ **Done**                   |
| 1 · Crypto & KEEP format         | ✅ **Done**                   |
| 2 · Vault service & IPC          | ✅ **Done**                   |
| 3 · Shell, design system, themes | ✅ **Done**                   |
| 4 · Unlock, lock, session        | ✅ **Done**                   |
| 5 · CRUD & fields                | ✅ **Done**                   |
| 6 · History & audit trail        | ~ Nearly done                 |
| 7 · Organisation & search        | ~ Sidebar UI outstanding      |
| 8 · Password generator           | ~ Mounted                     |
| 9 · Attachments                  | ~ IPC done, no previews       |
| 10 · Import                      | ~ Mounted, wizard polish left |
| 11 · Export & transfer bundle    | ~ Mounted, KDBX left          |
| 12 · Sync & merge                | ~ Engine done                 |
| 13 · Health dashboard            | ~ Mounted, minus HIBP         |
| 14 · Settings                    | ~ Mounted, 2 channels short   |
| 15 · Chrome & QoL                | ~ Done bar the lightbox       |
| 16 · In-app content              | ~ Help mounted                |
| 17 · Audits                      | ~ Three passes, fixes ongoing |
| 18 · Packaging & CI              | ~ Configured, never run       |
| 19 · Docs & README               | ~ Tree written, README not    |
