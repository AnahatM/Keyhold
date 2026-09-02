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
  notes and **unlimited custom fields** in 13 types, reorderable and individually hidden.
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

- **Import from eleven formats**: Bitwarden (CSV and JSON), LastPass, Chrome/Edge/Brave,
  Firefox, Safari, 1Password 8, Dashlane, NordPass, KeePass, and a generic CSV mapper.
  Nothing is dropped silently.
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
  telemetry.
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
- A command palette, a shortcut registry, a folder and tag sidebar, a settings screen, a
  health dashboard, a generator panel, an in-app help library, and a first-run flow.

### Groundwork, not yet reachable from the UI

- Attachment storage, three-way merge, TOTP, vault diagnostics, a `.keeptheme` format, an
  activity log, and an opt-in breach check that is **off by default and not yet wired to
  anything**.

### Notes

- **Keyhold has not been audited**, and no release has been packaged. The first internal
  audit pass is at `docs/14-Audits/`.
- The roadmap and what remains: [`docs/12-Roadmap/00-Master-Checklist.md`](./docs/12-Roadmap/00-Master-Checklist.md).
