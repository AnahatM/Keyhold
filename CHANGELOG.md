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
  Chrome/Edge/Brave, Firefox, Safari, 1Password 8, Dashlane, NordPass, KeePass, Keyhold's own
  JSON, and a generic CSV mapper. Nothing is dropped silently.
- **An import that can be undone.** A dry run over the real parse, duplicate detection against
  the vault on title + login identity + host, a merge that fills empty fields and never removes
  a URL or moves a record out of the folder you filed it in, and an undo guarded so it refuses
  rather than swallowing an edit you made afterwards.
- **Export in four**: lossless Keyhold JSON, a flat CSV, Bitwarden's exact column set for
  leaving, and an encrypted `.keepx` parcel. Spreadsheet formula injection is neutralised,
  and the cost of doing so is reported rather than hidden.
- The JSON export **re-imports**, closing the round trip.

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

### Groundwork, not yet reachable from the UI

- **Attachments** — storage, reference counting and the IPC channels are all in place; nothing
  in the interface attaches, opens or previews a file yet.
- **Import and export dialogs** — both are written, tested and bound to real channels, and
  nothing mounts either.
- **Three-way merge** — the engine is built and refuses rather than guessing; there is no file
  watcher, no base snapshot and no resolver screen.
- **TOTP, vault diagnostics, the `.keeptheme` file dialogs, the activity log, and the first-run
  tour** — each built and tested with nothing calling it.
- **The opt-in breach check** — off by default in the strongest sense: nothing constructs a
  transport, so no code path in the running app makes a request.

### Notes

- **Keyhold has not been audited**, and no release has been packaged. The first internal
  audit pass is at `docs/14-Audits/`.
- The roadmap and what remains: [`docs/12-Roadmap/00-Master-Checklist.md`](./docs/12-Roadmap/00-Master-Checklist.md).
