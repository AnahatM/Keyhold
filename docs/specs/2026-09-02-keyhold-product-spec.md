# Keyhold — Product & Architecture Spec

- **Date:** 2026-09-02
- **Status:** Approved — the design this project was built from
- **Author:** Anahat Mudgal

> **This is the spec archive copy.** It records what was decided and why, on the date above.
> It is history, not current reference. When the code changes, update `docs/`, **never this file.**
> The living reference tree is `docs/00-Overview/` onward.

---

## 1. What Keyhold is

**Keyhold** is a free, open-source, fully offline credential manager for Windows and macOS,
built with Electron. Everything lives on the user's device inside a single encrypted file.
There is no account, no server, no telemetry, no subscription, and nothing to host or pay for —
for the user _or_ the maintainer.

**One-line pitch:** _Your passwords, in a file you own, encrypted with a key only you have._

### Goals

| #   | Goal                                         | How it is measured                                                                                                         |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| G1  | Never lose a credential                      | Atomic writes, rolling backups, tombstones, pre-merge snapshots, trash with restore, undo on every destructive action      |
| G2  | Never leak a credential                      | Renderer never holds the master key; strict CSP; zero network by default; clipboard hygiene                                |
| G3  | Never lock the user in                       | KDBX 4 export opens in KeePassXC; 18+ import formats; full-fidelity JSON export; the `.keep` format is publicly documented |
| G4  | Be genuinely pleasant to use                 | The thing KeePassXC is most criticised for. Modern three-pane UI, full theme engine, command palette, keyboard-first       |
| G5  | Answer "what changed, when, and from where?" | Per-credential, per-field version history with a device + network audit trail — the headline differentiator                |
| G6  | Cost nothing, forever                        | No server, no hosting, no paid tier, no certificate spend required to function                                             |
| G7  | Let the user decide their own trade-offs     | Every security behaviour, every metadata capture, every automation is individually configurable                            |

### Non-goals (v1)

| Not doing                    | Why                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------- |
| Hosted sync / accounts       | The entire point is no server. Sync happens through files the user controls. |
| Browser extension / autofill | Large separate surface with its own threat model. Backlog, not dropped.      |
| Mobile apps                  | Out of scope. The `.keep` format is documented so others could build one.    |
| Team / shared vaults         | Single-user tool. Sharing happens via `.keepx` transfer bundles.             |
| Telemetry or crash reporting | Zero network by default. Non-negotiable.                                     |
| Paid tiers of any kind       | GPL-3.0, free forever.                                                       |

### Principles

1. **Offline by default; network never without an explicit toggle.** The only network feature in
   scope is the opt-in HIBP breach check — off by default, k-anonymity only.
2. **The user owns the file.** No proprietary lock-in. Export to KDBX and open it in KeePassXC.
3. **Everything is configurable.** Security-level presets _plus_ individual overrides.
4. **The renderer never holds the master key.** See §5.2.
5. **Never lose data.** See G1.
6. **Honest security claims.** A published threat model stating what Keyhold does _not_ protect
   against. A password manager that overstates its guarantees is worse than one that is candid.

---

## 2. Naming — every name, and what it means

### The app: **Keyhold**

A _keyhold_ is a coined compound reading two ways at once: the thing that _holds your keys_, and a
_hold_ in the fortification sense — a defensible place you put valuables. It is short, one
memorable word, unclaimed in the password-manager space, and gives an obvious wordmark (a keyhole
or a lock glyph). Chosen over **Coffer** (strong but old-world), **Cipherfold** (technical, longer
to type), and keeping the literal folder name **Credentials-App** (descriptive, but weak as an
open-source project people star and share).

### The file format: **KEEP** — _Keyhold Encrypted Entry Package_

Extension: **`.keep`**. A _keep_ is the fortified inner stronghold at the centre of a castle —
precisely what a _keyhold_ holds. It is simultaneously the plain English verb: _this is where you
keep things_. Chosen over `.hold` (on-brand but abstract as a noun), `.ward` (distinctive, more
fantasy-flavoured), and `.trove` (warm, but abandons the castle metaphor).

Rejected during brainstorming, recorded so we do not re-tread the ground: `.bastion`, `.redoubt`,
`.coffer`, `.chest`, `.reliquary`, `.stash`, `.crypt`, `.cipher`, `.sealed`, `.enigma`, `.codex`,
`.grimoire`, `.ledger`, `.sanctum`.

### The full extension family

| Extension    | Name                                           | Contents                                                                                                                              | Encrypted?                        |
| ------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `.keep`      | **KEEP** — Keyhold Encrypted Entry Package     | The vault itself: all records, history and attachments                                                                                | Yes — Argon2id + AES-256-GCM      |
| `.keepx`     | **KEEPX** — Keyhold Encrypted Exchange Package | A transfer bundle: a _subset_ of records under its own separate passphrase, for moving to another device or handing to another person | Yes — independent passphrase      |
| `.keeptheme` | Keyhold Theme                                  | An exported custom theme — a small JSON token map                                                                                     | No — contains no secrets          |
| `.keepbak`   | Keyhold Backup                                 | A rolling automatic backup of a `.keep`                                                                                               | Yes — identical format to `.keep` |
| `.keep.tmp`  | _(transient)_                                  | The atomic-write staging file, renamed over the target on `fsync`                                                                     | Yes                               |

The `x` in `.keepx` reads as **exchange** — the file you hand over. The distinction from `.keep`
matters: a `.keep` is _your vault_; a `.keepx` is _a parcel_, with its own passphrase, so sharing
one never means sharing your master password.

### Glossary of internal terms

| Term                          | Meaning                                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vault**                     | One `.keep` file and everything in it. A user may have several.                                                                                                             |
| **Record** / **Credential**   | One stored entry.                                                                                                                                                           |
| **KEK** — Key Encryption Key  | 32 bytes derived from the master password by Argon2id. Never stored.                                                                                                        |
| **DEK** — Data Encryption Key | 32 random bytes that actually encrypt the vault body. Stored only in wrapped (encrypted) form, wrapped by the KEK.                                                          |
| **Wrapping**                  | Encrypting one key with another. Lets us add unlock methods without re-encrypting the vault.                                                                                |
| **Safe projection**           | The subset of record data the renderer is allowed to hold: titles, usernames, emails, URLs, tags, folders, dates, metadata, history summaries, health flags. Never secrets. |
| **Origin**                    | The device/network/app metadata attached to each history version — the audit trail.                                                                                         |
| **Tombstone**                 | A soft-deleted record retained as a deletion marker so sync cannot resurrect it.                                                                                            |
| **Generation**                | A monotonic counter in the vault header, incremented on every save. Used to detect external changes.                                                                        |
| **Base snapshot**             | The last-synced state, stored so a three-way merge is possible.                                                                                                             |
| **Smart view**                | A saved, rule-based filter (e.g. "weak AND untagged").                                                                                                                      |

---

## 3. Decisions made in this session

Every question asked and answered, with the alternatives that were rejected. The living version of
this table is `docs/12-Roadmap/02-Decision-Log.md`.

| #   | Decision                | Chosen                                                                                                                    | Rejected, and why                                                                                                                                                                                                                                                                                                            |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Native vault format     | Custom `.keep` + a full interop layer                                                                                     | **KDBX-as-native** — cannot carry per-field version history, device/network audit trail, or structured custom metadata without cramming them into string fields that read as noise elsewhere. **SQLCipher** — native binary dependency complicates cross-platform packaging, and the vault stops being "one thing you copy". |
| D2  | Device transfer model   | All three tiers: portable file **+** `.keepx` bundle **+** watched-folder merge sync                                      | **Manual copy only** — last-writer-wins loses edits. **LAN pairing** — deferred to backlog; adds a network surface to an otherwise offline app.                                                                                                                                                                              |
| D3  | Big features in v1      | Password health dashboard (incl. opt-in HIBP) **+** encrypted attachments                                                 | TOTP generator and extra item types were _not_ selected for v1 but are explicitly **recorded in the backlog, not dropped**, at the user's instruction.                                                                                                                                                                       |
| D4  | Unlock / lockdown in v1 | Biometric quick-unlock **+** auto-lock and clipboard hygiene                                                              | Key-file second factor and emergency recovery kit were _not_ selected for v1 but are explicitly **recorded in the backlog, not dropped**, at the user's instruction.                                                                                                                                                         |
| D5  | App name                | **Keyhold**                                                                                                               | Coffer, Cipherfold, Credentials-App                                                                                                                                                                                                                                                                                          |
| D6  | Licence                 | **GPL-3.0-or-later**                                                                                                      | MIT and Apache-2.0 (permissive — a closed fork of a password manager cannot be audited, which undermines the trust argument). AGPL-3.0 (the network clause buys nothing for an app that never runs as a service, and deters contributors).                                                                                   |
| D7  | Window layout           | Three-pane, both side panes collapsible                                                                                   | Two-pane (filtering one click deeper). Card grid (fewer items per screen, scales poorly past a few hundred entries).                                                                                                                                                                                                         |
| D8  | Theming                 | Full theme engine: tokens, ~8 themes, accent picker, density, font scale, custom theme editor, `.keeptheme` import/export | Named themes without an editor; light/dark only.                                                                                                                                                                                                                                                                             |
| D9  | Format name             | **KEEP**, extension `.keep`                                                                                               | `.hold`, `.ward`, `.trove`, plus the fourteen rejected names in §2.                                                                                                                                                                                                                                                          |
| D10 | Configurability         | Everything user-configurable via security presets **plus** per-setting overrides                                          | Fixed opinionated defaults with no escape hatch.                                                                                                                                                                                                                                                                             |
| D11 | Hosting & cost          | Nothing to host, nothing to pay — for the user _or_ the maintainer                                                        | Any hosted component.                                                                                                                                                                                                                                                                                                        |
| D12 | Repository              | `AnahatM/Keyhold`, **private for now**, public at v1                                                                      | Public from day one.                                                                                                                                                                                                                                                                                                         |
| D13 | Renderer secret access  | Renderer holds the **safe projection** only; secrets fetched per-reveal over IPC with a TTL                               | Full decrypted vault in renderer memory (what most Electron password managers do — see §5.2).                                                                                                                                                                                                                                |
| D14 | Argon2 implementation   | `hash-wasm` (pure WASM)                                                                                                   | `@node-rs/argon2` / `argon2` native bindings — adds a per-platform native binary to the build matrix for no user-visible gain.                                                                                                                                                                                               |
| D15 | Attachment storage      | Separate encrypted chunks appended inside the same `.keep` file                                                           | Base64 inside the record payload (33% bloat, slows every unlock). Sidecar folder (breaks the single-portable-file promise).                                                                                                                                                                                                  |
| D16 | Code signing            | Unsigned in v1; checksums published; SmartScreen/Gatekeeper steps documented                                              | Paying for an EV certificate and an Apple Developer account — violates D11. In backlog if funding ever appears.                                                                                                                                                                                                              |

---

## 4. Feasibility: encryption _and_ portability

The user asked whether data can be copied and transferred between devices via files while still
being encrypted. **Yes — and it is the standard design, not a compromise.**

The `.keep` file is **self-contained ciphertext**. The key is derived from the master password
alone via Argon2id, so **no device-specific input ever enters the key**. Consequences:

- Copy it to a USB stick, Dropbox, iCloud Drive, OneDrive, Syncthing, email, a NAS — it opens
  anywhere Keyhold runs, given the master password.
- Anyone who intercepts the file gets an authenticated ciphertext blob. Wrong password → the DEK
  unwrap fails. Tampered file → the GCM authentication tag fails. Both are hard, loud failures,
  never a partial or silently-wrong read.
- The device/network audit metadata lives **inside** the encrypted payload, so it travels with the
  record and is never exposed by the file itself.

The genuinely hard part is not encryption — it is **two devices editing the same file**. That is
Phase 12, solved with per-record timestamps, content hashes, tombstones, a stored base snapshot,
three-way merge, and a field-level conflict resolver. Never an auto-merge without a pre-merge
backup, never a silent overwrite.

---

## 5. Architecture

### 5.1 Stack

| Layer               | Choice                                            | Note                                             |
| ------------------- | ------------------------------------------------- | ------------------------------------------------ |
| Shell               | Electron (latest stable at scaffold time, pinned) | Windows + macOS, x64 + arm64                     |
| Build               | electron-vite                                     | Fast HMR, clean main/preload/renderer split      |
| UI                  | React 19 + TypeScript (strict)                    |                                                  |
| Styling             | Hand-written CSS over custom-property tokens      | No Tailwind, no CSS-in-JS (per global CLAUDE.md) |
| State               | Zustand                                           | Small; easy to keep secrets out of               |
| Tests               | Vitest                                            | Core systems only — §10                          |
| Packaging           | electron-builder                                  | NSIS + portable (Windows), DMG + zip (macOS)     |
| Argon2id            | `hash-wasm` (pure WASM)                           | Deliberately no native binary — D14              |
| AES-256-GCM         | Node `crypto`, main process                       | Native, zero dependency                          |
| KDBX interop        | `kdbxweb` + our WASM Argon2                       | Read and write KDBX 3 and 4                      |
| Strength estimation | `@zxcvbn-ts/core`, lazily loaded in main          | Never shipped to the renderer                    |

### 5.2 Process model — the security spine

```
┌──────────────────────── MAIN PROCESS (Node) ─────────────────────────┐
│  KEK · DEK · the full decrypted vault                                │
│  All crypto · all file I/O · all secret material                     │
│  Zeroes every secret buffer on lock. Sends nothing unless asked.     │
└──────────────────────────────┬───────────────────────────────────────┘
                               │  contextBridge — typed, allow-listed IPC
┌──────────────────────────────┴───────────────────────────────────────┐
│  PRELOAD   contextIsolation: true · sandbox: true · nodeIntegration: false │
│  Exposes only window.keyhold.* — a fixed, enumerated API surface      │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
┌──────────────────────────────┴───────────────────────────────────────┐
│  RENDERER (React) — holds the SAFE PROJECTION only:                  │
│  titles · usernames · emails · urls · tags · folders · dates ·       │
│  metadata · history summaries · health flags.                        │
│  NEVER passwords, TOTP secrets, security-question answers,           │
│  note bodies, or attachment bytes. Those are requested on demand,    │
│  per reveal / per copy, and dropped after a short TTL.               │
└──────────────────────────────────────────────────────────────────────┘
```

**Why this matters.** Most Electron password managers decrypt the entire vault into renderer
memory, where any XSS, any compromised dependency, and any devtools access reaches every secret at
once. Keyhold's renderer _does not have them to leak_. Search, sort and filter all operate on the
safe projection; deep search inside notes and custom-field values is delegated to main over IPC.

**Hardening checklist:** `contextIsolation: true` · `sandbox: true` · `nodeIntegration: false` ·
`webSecurity: true` · strict CSP with no `unsafe-inline` and no `unsafe-eval` · `will-navigate`
and `setWindowOpenHandler` blocked for external URLs · no remote content ever loaded · devtools
disabled in production builds · every IPC channel allow-listed and schema-validated in **both**
directions.

### 5.3 Cryptography

```
master password ──Argon2id(salt, m, t, p)──►  KEK (32 B)
                                                │
                                    AES-256-GCM unwrap
                                                ▼
        random DEK (32 B) ──AES-256-GCM(nonce, gzip(payload))──► vault body
```

**Envelope encryption is deliberate.** It means:

- Changing the master password rewraps 32 bytes instead of re-encrypting the whole vault.
- Biometric quick-unlock stores an _independently wrapped_ copy of the DEK in the OS keychain
  (Electron `safeStorage` → DPAPI on Windows, Keychain on macOS), revocable on its own without
  touching the password path.
- Future key-file and hardware-key factors slot in as additional wrappings of the same DEK.

| Parameter   | Default                      | Notes                                                                                                                   |
| ----------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| KDF         | Argon2id                     | m = 64 MiB, t = 3, p = 4 — calibrated on first run against the machine, written into the header, adjustable in Settings |
| Cipher      | AES-256-GCM                  | 96-bit random nonce per encryption, never reused                                                                        |
| Header      | Plaintext, passed as **AAD** | So header tampering breaks the authentication tag                                                                       |
| RNG         | `crypto.randomBytes`         | CSPRNG only. Never `Math.random`, anywhere, for anything                                                                |
| Compression | gzip **before** encrypt      | Never after — compressing ciphertext is pointless and compressing after leaks nothing but wastes work                   |

### 5.4 The KEEP container format

```
offset  content
0       MAGIC  "KEYHOLD\0"                          8 bytes
8       formatVersion                               uint16 LE
10      headerLength                                uint32 LE
14      HEADER  (UTF-8 JSON, plaintext, used as AAD)
          { formatVersion, vaultId, deviceId,
            kdf: { alg, m, t, p, salt },
            cipher: "AES-256-GCM",
            wrappedDek: { nonce, ct, tag },
            createdAt, modifiedAt, generation,
            recordCount, attachmentCount }
…       bodyLength uint32 · bodyNonce 12 B · bodyCiphertext+tag      ← all records
…       chunkCount uint32
          repeated:  chunkId 16 B · chunkLength uint32
                     · nonce 12 B · ciphertext+tag                   ← one per attachment
EOF
```

Attachments are **separate encrypted chunks**, not base64 inside the record payload. This keeps the
records body small and fast to decrypt on unlock, avoids 33% base64 bloat, and lets a large
attachment be read only when actually opened — while the vault stays a single portable file.

**Write safety:** serialise → write `vault.keep.tmp` → `fsync` → atomic `rename` over the target →
roll `vault.keep.bak.1..N`. A crash mid-write can never leave a truncated vault.

**Versioning:** `formatVersion` is checked on open. A newer version than the app understands
refuses to open rather than guessing. Migrations run forward-only, on a copy, with the original
retained as a `.keepbak`.

### 5.5 The record model

```ts
Credential {
  id: string              // UUID v7 — time-sortable, so creation order is free
  type: 'login'           // v1 only; the field-template system is built for more (backlog)
  title: string
  favorite: boolean
  folderId: string | null
  tags: string[]
  icon: { kind: 'auto' | 'letter' | 'emoji' | 'custom', value?: string }

  fields: {
    username: string
    email: string
    password: string                                  // secret
    urls: string[]                                    // multiple; first is primary
    securityQuestions: { id, question, answer }[]     // answers are secret
    notes: string                                     // secret
    custom: CustomField[]
  }

  attachments: { id, name, mime, size, sha256, addedAt }[]

  meta: {
    createdAt, updatedAt
    passwordUpdatedAt          // drives the "old password" health rule
    lastUsedAt, useCount       // drives sort-by-frequency and "recently used"
    expiresAt | rotationIntervalDays | null
  }

  history: {
    enabled: boolean           // the per-credential checkbox; global default, per-record override
    maxVersions: number | null
    versions: Version[]
  }

  trashedAt: number | null     // soft delete; doubles as the sync tombstone
}

CustomField {
  id, label, order, hidden: boolean
  type: 'text' | 'password' | 'email' | 'url' | 'number' | 'date' | 'datetime'
      | 'boolean' | 'multiline' | 'phone' | 'pin' | 'otp-secret' | 'address'
  value: string
}

Version {
  versionNumber, savedAt
  changedFields: string[]
  snapshot: Partial<fields>    // only what changed — keeps history cheap
  origin: {
    action: 'create' | 'update' | 'restore' | 'import' | 'merge'
    deviceName        // os.hostname()
    osUser            // os.userInfo().username
    platform, osRelease, appVersion
    networkName       // WiFi SSID, best effort; falls back to active interface name
    localIp           // optional, off by default
  }
}
```

**Audit-trail privacy levels** (Settings → Privacy). This metadata travels inside the vault, so the
user controls exactly how much is captured:

| Level                | Captures                                     |
| -------------------- | -------------------------------------------- |
| `none`               | Timestamps only                              |
| `device` _(default)_ | + device name, app version, platform         |
| `network`            | + OS user, WiFi SSID / active interface name |
| `full`               | + local IP, OS release string                |

SSID capture is best-effort: `netsh wlan show interfaces` on Windows,
`system_profiler SPAirPortDataType` on macOS, silently falling back to the active interface name
from `os.networkInterfaces()`. It runs asynchronously and must never block or slow a save.

---

## 6. Feature set — v1 scope

### 6.1 Vault lifecycle

Create vault (choose location + master password with a live strength meter and an explicit
"there is no recovery" acknowledgement) · Open existing · Recent vaults list · Multiple vaults,
switchable · Change master password · Re-key (rotate the DEK) · Change KDF parameters · Integrity
check · Manual and scheduled backups with configurable retention · Restore from backup.

### 6.2 Locking & unlocking

Lock now (`Ctrl/Cmd+L`) · Auto-lock on idle (configurable) · on system sleep/lock · on minimise
(optional) · on app close · Master-password unlock · Biometric quick-unlock (Windows Hello /
Touch ID) via a keychain-wrapped DEK · Failed-attempt throttling with exponential backoff ·
Optional wipe-after-N-failures (off by default, loud confirmation) · Full memory zeroing on lock.

### 6.3 Clipboard hygiene

Auto-clear after N seconds (default 30) with a visible countdown · Excluded from Windows clipboard
history and cloud clipboard · Excluded from the macOS pasteboard's persistent store via
`org.nspasteboard.ConcealedType` · Cleared on lock · Cleared on exit · A "reveal and type manually"
fallback for users who prefer the clipboard never touch a secret at all.

### 6.4 CRUD

Full create / read / update / delete over every field in §5.5 · Unlimited user-defined custom
fields with a type picker and drag-to-reorder · Per-field reveal / copy / hide · Multi-URL ·
Security questions as repeatable first-class pairs (not free text buried in notes) · Notes with a
monospace toggle · Duplicate a credential · Bulk edit (move to folder, add/remove tag, set
favourite, delete) · Soft delete to Trash with restore and configurable auto-purge · Undo on every
destructive action.

### 6.5 History & audit — the headline feature

Per-credential **"keep past versions" checkbox**, plus a global default · Configurable retention
cap · Timeline view per credential · Field-level diff between any two versions · Restore a whole
version, or a single field from one · Reveal an old password under the same clipboard rules ·
Origin metadata on every version per §5.5 · Export a single credential's history.

### 6.6 Organisation & finding things

Nested folders (tree, drag-and-drop) · Flat multi-tags with colours · Favourites · Trash · Saved
smart views · Fuzzy search over the safe projection · Deep search delegated to main for notes and
custom values · Search operators (`tag:`, `folder:`, `url:`, `has:totp`, `is:weak`,
`created:>2025-01-01`) · Sort by title, created, updated, password age, use count, strength,
folder · Filter chips · Virtualised list (10 000+ entries) · Command palette (`Ctrl/Cmd+K`).

### 6.7 Password generator

Random mode (length, character classes, exclude-ambiguous, require-one-of-each, custom exclude
set) · Passphrase mode (bundled EFF large wordlist, word count, separator, capitalisation, number
injection) · Pronounceable mode · PIN mode · Live entropy and crack-time estimate · Session
generation history · Per-site rule memory for sites that ban symbols · Generate-and-replace from
inside a credential, which auto-versions the old password.

### 6.8 Attachments

Attach any file to a credential · Stored as a separate encrypted chunk in the same `.keep` ·
SHA-256 integrity check on read · In-app preview for images, PDFs and text · Export to disk with a
warning · Warn above 5 MB, configurable hard cap defaulting to 25 MB per file · Attachment totals
in vault stats.

### 6.9 Health dashboard

Always-offline rules: weak · reused (showing the cluster) · old (configurable age) · expiring or
expired · insecure `http://` URL · missing-2FA flag · incomplete record · likely-duplicate record.
An overall health score tracked over time. One-click jump to fix.

**Opt-in only:** HIBP Pwned Passwords via **k-anonymity** — only the first 5 characters of the
SHA-1 hash leave the device; never the password, never the full hash. Off by default, behind a
plain-English explainer of exactly what is sent, with results cached and rate-limited.

### 6.10 Import

Native `.keep` / `.keepx` · KeePass KDBX 3 and 4 · KeePass XML · Bitwarden JSON (encrypted and
plain) and CSV · 1Password 1PUX and CSV · LastPass CSV · Chrome / Edge / Brave CSV · Firefox CSV ·
Safari and Apple Passwords CSV · Dashlane CSV and JSON · Proton Pass JSON and CSV · Enpass JSON ·
NordPass CSV · Keeper CSV and JSON · RoboForm CSV · **generic CSV with a column-mapping UI**.

Every import runs the same pipeline: parse → preview table → map columns → choose target folder and
tags → pick a dedupe strategy (skip / overwrite / keep both / merge fields) → **dry-run report** →
commit, with one-click undo of the entire import.

### 6.11 Export

`.keep` (encrypted, native) · `.keepx` transfer bundle (own passphrase, selective, optional
advisory expiry) · **KDBX 4** (encrypted, opens in KeePassXC — the anti-lock-in guarantee) ·
Bitwarden JSON · full-fidelity JSON including history · encrypted JSON · CSV.

Any unencrypted export requires a type-to-confirm dialog, is written with restrictive file
permissions, and offers a shred reminder.

### 6.12 Sync & transfer

**Tier 1 — portable file.** Copy the `.keep` anywhere. A file watcher detects external changes
while unlocked and compares generation counter and content hash before offering to reload.

**Tier 2 — transfer bundle.** `.keepx` with its own passphrase, for handing a subset of records to
another device or person. Import previews and reports conflicts before writing anything.

**Tier 3 — merge sync.** Point two devices at the same cloud folder. Per-record `updatedAt` plus
content hash plus a stored base snapshot enable a real three-way merge. Deletions are tombstones,
so a delete never resurrects. Genuine conflicts open a field-level resolver: mine / theirs / merge.
Every merge takes a pre-merge backup first and writes a merge report. Never silent, never lossy.

### 6.13 Themes & appearance

Zero hardcoded colours — every colour is a token. Roughly 8 complete themes (Dawn, Midnight,
Slate, Nord, Solarized Light, Solarized Dark, Rose, High-Contrast) · Independent accent picker ·
Density (compact / comfortable / spacious) · Font-size scale · Font family choice including a
monospace option for secrets · Custom theme editor with live preview · `.keeptheme` export and
import · Follow-OS toggle · `prefers-reduced-motion` respected · **Every theme contrast-checked to
WCAG AA by an automated test** — the guard ships with the system.

### 6.14 App chrome & quality of life

Command palette · Toast system with Undo · Focus-trapped accessible modals · Tooltips ·
Determinate progress for long operations (Argon2, import, merge) · Attachment lightbox ·
Deliberate empty, loading and error states on every view · Full keyboard operation with a
shortcut cheat-sheet (`Ctrl/Cmd+/`) and remappable bindings · Window state persistence · System
tray with quick actions and lock · Single-instance lock · Native menu bar · `.keep` file
association so double-clicking a vault opens it · Optional launch-at-login · Opt-in update check
against GitHub Releases, off by default.

### 6.15 In-app content

Settings (Vault · Security · Privacy · Appearance · Behaviour · Import/Export · Sync · Advanced ·
About) · Offline Help & FAQ · Changelog rendered from `CHANGELOG.md` · About with credits and an
auto-generated third-party licence list · **Security & Threat Model** page in plain English,
including what Keyhold does _not_ protect against.

---

## 7. UI design

Three-pane, both side panes collapsible, degrading to two-pane and then one-pane as the window
narrows.

```
┌─────────┬──────────────┬──────────────────┐
│ ⌕ Ctrl+K│ ⌕ filter     │  GitHub      ☆ ⋯ │
│         │              │                  │
│ All 128 │ ▸ Amazon     │  user  anahat    │
│ ★ Favs 9│ ▸ Cloudflare │  mail  a@…    ⧉  │
│ ⚠ Weak 4│ █ GitHub     │  pass  ••••••  ⧉ │
│ 🗑 Trash │ ▸ Google     │  url   github…   │
│         │ ▸ Namecheap  │                  │
│ FOLDERS │ ▸ Steam      │  ── History ───  │
│  Work   │ ▸ Vercel     │  v3 · 2d · Laptop│
│  Personal              │  v2 · 1mo · Mac  │
│ TAGS    │              │                  │
│  #dev   │              │  Notes…          │
└─────────┴──────────────┴──────────────────┘
```

Design-system rules: tokens for colour, space, radius, shadow, motion and type · one component per
file · every interactive element keyboard-reachable with a visible focus ring · minimum 44×44 px
targets · secrets rendered in a monospace face with an optional per-character-class colouring ·
`aria-live` announcements for copy, clear and lock events.

---

## 8. Repository & distribution

- **Repo:** `AnahatM/Keyhold` — **private for now**, flipped public when v1 ships.
- **Licence:** GPL-3.0-or-later, with an SPDX header in every source file.
- **CI:** GitHub Actions — lint, typecheck and test on push; a tagged release builds Windows and
  macOS artefacts and drafts a GitHub Release. Free tier only.
- **Signing:** unsigned in v1 (certificates cost money; see D11/D16). SmartScreen and Gatekeeper
  steps documented in the README, SHA-256 checksums published with every release.
- **Community files:** `README.md` (via the `anahat-readme` skill), `CONTRIBUTING.md`,
  `SECURITY.md` with a disclosure policy, `CODE_OF_CONDUCT.md`, `CHANGELOG.md` (Keep a Changelog),
  `PRIVACY.md` stating plainly that nothing is collected, issue and PR templates, Dependabot config.

---

## 9. Threat model — published and honest

**Protects against:** theft of the vault file · theft of the whole device while locked · a cloud or
sync provider reading the vault · tampering with the vault file (detected, not silently accepted) ·
another local user account reading the vault · shoulder-surfing (masked fields, auto-lock) ·
clipboard scraping after the clear window · lock-in by any vendor, including Keyhold itself.

**Does not protect against:** a compromised operating system · a kernel or user-space keylogger ·
malware reading Keyhold's process memory while unlocked · a screen recorder while secrets are
revealed · an attacker who knows the master password · physical access while the vault is open ·
a malicious dependency introduced into a build the user compiles themselves.

These are stated explicitly in-app and in the README. A password manager that overstates its
guarantees is worse than one that is candid about its limits.

---

## 10. Testing policy

**Tested**, because a silent regression would be expensive: crypto (roundtrip, wrong-password
failure, tamper detection, KDF parameter handling, key rotation) · container serialise / parse /
migrate / corrupt-file handling · atomic write and crash recovery · the merge engine's full
conflict matrix plus a no-data-loss property test · every import parser against a fixture · export
roundtrips · password-generator charset guarantees and entropy maths · every health rule's
boundary conditions · history versioning, retention and restore · theme token completeness and
WCAG AA contrast.

**Deliberately not tested:** React components in general, thin IPC wrappers, config objects, or
anything whose test could never fail. No coverage target is chased.

---

## 11. Open questions carried into implementation

1. Exact Electron and React majors — pinned at scaffold time against what is then current.
2. Argon2 default parameters — calibrated on the dev machine targeting roughly 500 ms unlock, then
   written into the header so every vault carries its own settings.
3. Whether deep search should build a per-unlock inverted index in main or scan linearly. Decide by
   measuring against a 10 000-record synthetic vault.
4. Whether `.keepx` expiry should exist at all, given it can only ever be advisory (enforced by the
   importing client, not cryptographically).
