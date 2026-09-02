# What Keyhold is

> Start here. This page defines the product: what it does, what it deliberately does not do, and
> the principles that settle arguments later.

---

## The one-liner

> **Your passwords, in a file you own, encrypted with a key only you have.**

**Keyhold** is a free, open-source, fully offline credential manager for Windows and macOS, built
with Electron. Everything lives on the user's device inside a single encrypted file. There is no
account, no server, no telemetry, no subscription, and nothing to host or pay for — for the user
_or_ the maintainer.

---

## The three-line pitch

1. **A password manager that is actually offline** — one encrypted file, no account, no server, no
   telemetry, no subscription.
2. **That remembers everything** — per-credential version history with a full device and network
   audit trail, so you always know what changed, when, and where it changed from.
3. **And that you can leave at any time** — imports from 18+ managers, exports to KDBX 4, and the
   file format is publicly documented.

---

## Goals

| #      | Goal                                           | How it is measured                                                                                                    |
| ------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **G1** | Never lose a credential                        | Atomic writes, rolling backups, tombstones, pre-merge snapshots, trash with restore, undo on every destructive action |
| **G2** | Never leak a credential                        | The renderer never holds the master key; strict CSP; zero network by default; clipboard hygiene                       |
| **G3** | Never lock the user in                         | KDBX 4 export opens in KeePassXC; 18+ import formats; full-fidelity JSON export; a published format spec              |
| **G4** | Be genuinely pleasant to use                   | Modern three-pane UI, full theme engine, command palette, keyboard-first — the thing KeePassXC is most criticised for |
| **G5** | Answer _"what changed, when, and from where?"_ | Per-credential, per-field version history with a device and network audit trail                                       |
| **G6** | Cost nothing, forever                          | No server, no hosting, no paid tier, no certificate spend required to function                                        |
| **G7** | Let the user decide their own trade-offs       | Every security behaviour, metadata capture and automation is individually configurable                                |

---

## Non-goals

Saying no clearly is what keeps the project finishable. These are deliberate, and revisiting one
requires a new decision-log entry.

| Not doing                                    | Why                                                                                                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosted sync or accounts                      | The entire point is that there is no server. Sync happens through files the user controls.                                                                     |
| Browser extension / autofill                 | A large separate surface with its own threat model. Deferred to backlog B1 — and the README says so plainly, because it is the biggest gap versus competitors. |
| Mobile apps                                  | Out of scope. Mitigated: KDBX export opens in existing mobile KeePass clients today.                                                                           |
| Team or shared vaults                        | Single-user tool. One-off handoffs use `.keepx` transfer bundles.                                                                                              |
| Telemetry or crash reporting, even anonymous | Zero network by default. Non-negotiable.                                                                                                                       |
| Paid tiers, licence keys, donation nags      | GPL-3.0, free forever.                                                                                                                                         |
| Custom cryptography                          | Standard primitives only: Argon2id, AES-256-GCM, envelope encryption. Never invent a cipher.                                                                   |

---

## Principles

These settle design arguments. When two options look equally good, the one that better serves a
principle wins.

### 1. Offline by default; network never without an explicit toggle

The only network feature in scope is the opt-in HIBP breach check — off by default, k-anonymity
only, behind a plain-English explainer of exactly what is sent, and killable by a global network
switch in Settings.

### 2. The user owns the file

No proprietary lock-in. Export to KDBX 4 and open it in KeePassXC. The KEEP format is documented
well enough that someone else could implement it.

### 3. Everything is configurable

Named security presets (Relaxed / Balanced / Strict / Paranoid) **plus** an independent override for
every individual setting. The user, not us, decides their security/convenience trade-off. Every
feature must expose its behaviour as a setting from the moment it is written — not bolted on later.

### 4. The renderer never holds the master key

The main process owns the keys and the decrypted vault. The renderer holds a **safe projection** —
titles, usernames, URLs, tags, dates — and fetches individual secrets on demand with a TTL. Most
Electron password managers decrypt everything into renderer memory, where one XSS or one bad
dependency reaches every secret at once. Ours does not have them to leak.

### 5. Never lose data

Atomic writes. Rolling backups. Tombstones rather than deletions. A mandatory backup before every
merge. Trash with restore. Undo on every destructive action. A dry-run before every import. If a
design choice risks data loss, it is the wrong choice regardless of how elegant it is.

### 6. Honest security claims

A published threat model that states what Keyhold does **not** protect against. A password manager
that overstates its guarantees is worse than one that is candid about its limits — because users
calibrate their behaviour to what they believe is true.

### 7. Interconnected, not isolated

A health finding links to the credential that caused it. A credential links to its history. A
history version links to the device that wrote it. Related things should be able to reach each
other rather than living in separate screens.

---

## Who it is for

The person who wants **KeePassXC's independence with 1Password's polish**, and is not willing to
run a server to get it.

Concretely: developers and technical users who already distrust cloud password managers; people who
want their vault on a USB stick; anyone who has bounced off KeePassXC's interface; people who want
to know _which machine_ changed a password and _when_; and anyone unwilling to pay a subscription
for something that is fundamentally a local file with a text editor on top.

---

## Where to go next

| You want                                               | Read                                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Why every name means what it means                     | [`01-Naming-And-Glossary.md`](./01-Naming-And-Glossary.md)                                                           |
| Why anyone would pick this over KeePassXC or Bitwarden | [`02-Competitive-Analysis.md`](./02-Competitive-Analysis.md)                                                         |
| What Keyhold protects against, and what it does not    | [`03-Threat-Model.md`](./03-Threat-Model.md)                                                                         |
| The full frozen design record from planning            | [`../superpowers/specs/2026-09-02-keyhold-product-spec.md`](../superpowers/specs/2026-09-02-keyhold-product-spec.md) |
| What is being built, in order                          | [`../12-Roadmap/00-Master-Checklist.md`](../12-Roadmap/00-Master-Checklist.md)                                       |
| Ideas deferred to later                                | [`../12-Roadmap/01-Feature-Backlog.md`](../12-Roadmap/01-Feature-Backlog.md)                                         |
| Why a decision was made                                | [`../12-Roadmap/02-Decision-Log.md`](../12-Roadmap/02-Decision-Log.md)                                               |
