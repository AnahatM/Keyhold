# Changelog

All notable changes to Keyhold are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The in-app Changelog view (Phase 16) renders this file directly — there is deliberately
no second, hand-maintained copy. Which is also why this file must stay true: a stale
line here is not a stale line in a repo, it is a stale line in the app.

## [Unreleased]

Nothing has been released yet. Everything below is on `main` and unversioned.

### The vault

- **The KEEP container format** — magic, version, a plaintext JSON header used as the
  AEAD's additional authenticated data, a sealed body, and length-prefixed attachment
  chunks each bound to its own id. Specified in full at `docs/04-Vault-Format/` so anyone
  can write a reader.
- **Argon2id → KEK → a random DEK → AES-256-GCM over the body.** Envelope encryption, so
  changing the master password rewraps a key rather than re-encrypting the vault. Argon2
  runs on a worker thread, because it blocks whatever thread it is on for the full
  derivation and that must never be the one drawing the window.
- **Atomic writes** — tmp, fsync, rotate backups, rename, fsync the directory. An
  interrupted write is quarantined and never deleted.
- Saves are **serialised**, and a save never writes back a snapshot taken before it started.

### Records

- Full CRUD over titles, usernames, emails, passwords, multiple URLs, security questions,
  notes and **unlimited custom fields**, typed from `CUSTOM_FIELD_TYPES`, reorderable and
  individually hidden.
- **Soft delete with a Trash**, undo on every destructive action, and tombstones rather
  than deletions, so a future sync cannot resurrect something you removed.
- A virtualised list that stays responsive at 10,000+ records.

### History and the audit trail

- **Version history recording what changed, when, and from which device and network** — the
  feature no other free, local password manager has. Per-credential, with a global default.
- Four audit privacy levels — `none`, `device` (the default), `network`, `full` — enforced
  at the moment of capture rather than at display, so a field you chose not to record was
  never written to the file at all.
- A timeline with a per-entry diff, whole-version restore, per-field restore, and a clear
  action. A restore is itself recorded, so it can be taken back.
- Old secrets are fetched one at a time through the same broker, rate limit and clipboard
  rules as live ones.

### Getting data in and out

- **Import from every format in the `PARSERS` registry**: Bitwarden (CSV and JSON), LastPass,
  Chrome/Edge/Brave, Firefox, Safari, 1Password (CSV and `.1pux`), Dashlane (CSV and JSON),
  NordPass, KeePass (CSV and XML), Keeper, RoboForm, Proton Pass, Enpass, Keyhold's own JSON,
  and a generic CSV mapper. Nothing is dropped silently.
- **KeePass `.kdbx` (version 4), both directions**, with no dependency added: the format is
  composed from Node's own crypto and Keyhold's existing Argon2. An encrypted KeePass database
  imports without a plaintext intermediate file, and exporting one is the door out that every
  other password manager can read. Version 3 is refused by name — its values use Salsa20,
  which the platform does not provide — with the instruction to re-save it as a 4.
- **A `.keep` or `.keepx` is itself an import source**, decrypted and read back through the
  parser that already existed.
- **An import that can be undone.** A dry run over the real parse, duplicate detection against
  the vault on title + login identity + host, a merge that fills empty fields and never removes
  a URL or moves a record out of the folder you filed it in, and an undo guarded so it refuses
  rather than swallowing an edit you made afterwards.
- **Export in six**: lossless Keyhold JSON, a flat CSV, Bitwarden's exact column set,
  Bitwarden's JSON, a KeePass `.kdbx`, and an encrypted `.keepx` parcel. Spreadsheet formula
  injection is neutralised, and the cost of doing so is reported rather than hidden.
- The JSON export **re-imports**, closing the round trip. So does the `.kdbx`.
- **Formats nobody has opened in the app they target are labelled "Not verified yet"** in the
  export dialog, with the specific gap named and the advice to keep your vault until the
  import has worked. Three of the six carry it.

### Security posture

- **The renderer never holds secret material.** It receives a projection carrying titles,
  usernames and lengths, and asks for one secret at a time through a rate-limited,
  TTL-scoped broker that is emptied on lock.
- Hardened renderer: `contextIsolation`, `sandbox`, no Node integration in any frame or
  worker, `<webview>` disabled, every web permission denied, and a strict CSP with no
  `unsafe-eval`, no `unsafe-inline` in `script-src`, and `connect-src 'none'`.
- **Zero network requests.** Not for icons, not for updates, not for fonts, not for
  telemetry. A repo-wide guard parses every source file and fails the build if any file but the
  one designated transport can originate a request.
- **A global network kill-switch**, machine-scoped and off by default, that fails closed on a
  corrupt preferences file. It is ANDed with the breach check's own setting and wins.
- **A path from outside the app must name local storage**, checked against an allow-list rather
  than a deny-list — so a `.lnk` naming a UNC share cannot make Windows open an SMB connection
  and hand over an NTLM handshake before the window even exists.
- Navigation lockdown: only `http:` and `https:` are ever handed to the browser, `file:`
  navigation is confined to the app's own renderer directory, and devtools are gated on
  packaging.
- Single-instance lock, so two processes cannot race writes to one vault.
- Unlock throttling, configurable auto-lock, and clipboard clearing on a timer.

### Interface

- Eight themes with a **contrast guard in the test suite** — every colour is a token, and a
  test fails the build if any theme drops a pair below its WCAG 2.2 AA minimum.
- Toasts, a native `<dialog>` modal, tooltips that open on focus, honest progress for a slow
  unlock, and written empty states.
- A command palette, a shortcut registry, and a folder and tag sidebar.
- **A fourth region of the shell for the tools that are not about one record** — vault health,
  the generator, settings and the whole offline help library each take over the main area while
  the sidebar stays put.

### Now reachable, having been built and wired to nothing

- This section used to list six subsystems that were finished, tested and callable from no
  part of the running app — the failure this project actually has. They are wired now.
- **One-time codes.** An `otp-secret` field shows six digits, an issuer, and a ring counting
  down to the moment it changes; it refreshes itself when the window closes. The seed never
  leaves the main process, and copying goes through the same auto-clearing clipboard as every
  other secret — under its own rate-limit key, so copying codes cannot exhaust the budget that
  would let you reveal the seed.
- **Diagnose a vault.** Reads a vault file **without its password**, surveys and ranks the
  files beside it, and produces a report saying what was checked, what was found, what to do
  in order, and what nothing can undo. Available while locked, which is the situation it
  exists for. The report contains no password, no record title, no folder name and no path
  beyond a basename, so it is safe to attach to a bug report.
- **The opt-in breach check.** Off by default and behind two separate switches — a machine
  kill-switch and a per-vault opt-in — with a dialog explaining exactly what leaves the
  machine before either can be turned on. It never runs on its own: a request happens when you
  press a button and at no other time, and the screen reports how many were made. A run that
  could not reach the service is never rendered as a clean result.
- **Attachments, the import and export dialogs, three-way merge, the activity log, the
  `.keeptheme` dialogs and the first-run tour** — all mounted.

### Still not reachable

- Nothing. Every subsystem in the codebase has a caller. What remains is on the roadmap as
  unbuilt work rather than as unwired work.

### Notes

- **Keyhold has not been audited**, and no release has been published. A Windows build has
  been produced and not yet launched. The first internal audit pass is at `docs/14-Audits/`.
- **An application icon**, drawn from geometry in `tools/make-icons.mjs` rather than kept as
  an asset: one set of numbers produces the SVG, the Windows `.ico`, the macOS `.icns` and
  every PNG, and a test regenerates them and compares bytes.
- The roadmap and what remains: [`docs/12-Roadmap/00-Master-Checklist.md`](./docs/12-Roadmap/00-Master-Checklist.md).
