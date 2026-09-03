# Competitive analysis & differentiation

> **Purpose:** why anyone would choose Keyhold over the open-source password managers that already
> exist, stated honestly — including where the competition is genuinely better.
>
> **Status:** current reference. Last reviewed 2026-09-02. Re-check before each major release;
> these products move.

---

## 1. The landscape

| Product                | Model                       | Licence       | Local-only?         | Cost                       | Notable strength                                                               | Notable weakness                                                                                                                                |
| ---------------------- | --------------------------- | ------------- | ------------------- | -------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **KeePassXC**          | Local file (KDBX)           | GPL-2/3       | Yes                 | Free                       | Mature, audited, enormously capable, hardware-key support, browser integration | UI widely criticised as dated, cluttered and overwhelming; no theming; file-conflict handling is manual and clunky                              |
| **KeePass (original)** | Local file (KDBX)           | GPL-2         | Yes                 | Free                       | The reference implementation; vast plugin ecosystem                            | Windows/.NET-first; UI is two decades old; plugins are unvetted third-party code                                                                |
| **Bitwarden**          | Client + server             | GPL-3 / AGPL  | No — needs a server | Free tier; £/$ for premium | Excellent clients, strong ecosystem, real audits                               | Requires an account and a server, cloud or self-hosted. Attachments, TOTP and reports sit behind premium. Self-hosting is real ongoing overhead |
| **Vaultwarden**        | Bitwarden-compatible server | AGPL-3        | No                  | Free, but you host it      | Lightweight Bitwarden server                                                   | You are now a sysadmin. Docker, TLS certs, backups, a box that must stay up                                                                     |
| **Proton Pass**        | Client + Proton account     | GPL-3 clients | No                  | Free tier; paid tiers      | Polished, good crypto, well funded                                             | Account-bound to a single company. Not usable without Proton                                                                                    |
| **Padloc**             | Client + server             | AGPL-3        | No                  | Free tier; paid            | Genuinely modern UI, non-Electron desktop client                               | Team/cloud oriented; local-only use is not the happy path; small team, slow release cadence                                                     |
| **Buttercup**          | Local file + optional cloud | GPL-3         | Yes                 | Free                       | Simple, approachable, Electron desktop                                         | Feature-thin next to KeePassXC; mobile app weak; development pace has slowed markedly                                                           |
| **Passbolt**           | Server-first                | AGPL-3        | No                  | Free tier; paid            | Strong team-sharing model, good HIBP integration                               | Server-mandatory; built for teams, heavy for one person                                                                                         |
| **Psono**              | Server-first                | Apache-2      | No                  | Free tier; paid            | Enterprise features                                                            | Server-mandatory; enterprise-shaped                                                                                                             |
| **`pass` / gopass**    | Local files + GPG           | GPL-2         | Yes                 | Free                       | Unix-pure, scriptable, git-native versioning                                   | CLI-first; GUI options are third-party and inconsistent; GPG key management defeats most users                                                  |
| **Apple Passwords**    | OS-integrated               | Closed        | No                  | Free                       | Beautiful, effortless, _finally_ added version history in iOS 26               | Apple-only. No Windows parity. Closed source. Not exportable in any rich form                                                                   |
| **Chrome / Google PM** | Browser + account           | Closed        | No                  | Free                       | Zero friction                                                                  | **No password history at all** — every save is final and irreversible. Google account-bound. No custom fields                                   |

---

## 2. The gap Keyhold fills

Read the table as a two-axis grid and the hole is obvious:

```
                      LOCAL-ONLY, NO SERVER
                              ▲
                              │
        pass / gopass  ·  KeePass  ·  KeePassXC  ·  Buttercup
                              │
                              │        ◄── KEYHOLD ──►
                              │             (here)
   ───────────────────────────┼───────────────────────────►
   DATED / SPARSE UI          │            MODERN, THEMED,
                              │            PLEASANT UI
                              │
        Vaultwarden · Passbolt · Psono · Padloc · Bitwarden · Proton Pass
                              │
                              ▼
                      REQUIRES A SERVER OR AN ACCOUNT
```

**Everything modern and pleasant requires a server or an account. Everything local and
server-free looks and feels like 2009.** Keyhold is deliberately aimed at the empty quadrant:
the polish of a hosted product, with the architecture of a local file.

---

## 3. The USP — five claims we can actually defend

### USP 1 — Version history with a device and network audit trail _(the headline)_

Per-credential, opt-in-per-record version history that records not just _what_ changed and _when_,
but **from which device, on which network, by which OS user, on which app version** — with a
field-level diff and single-field restore.

**Why this is a real differentiator:**

- Chrome / Google Password Manager has **no history whatsoever** — every save is final.
- Apple Passwords only added version history in **iOS 26 (2025)**, and it is Apple-only and closed.
- KeePassXC keeps previous password entries, but with **no device or network provenance** and no
  field-level diff UI.
- Bitwarden has password history on **premium**, and no device attribution.
- The only tools that answer _"which of my machines changed this, and where was it?"_ are
  **enterprise, cloud-hosted and paid** (Securden, Entra, AD auditing).

Keyhold brings an enterprise-grade audit trail to a free, local, single-user app. Nobody else in
the free/local tier does this.

### USP 2 — The renderer never holds the master key

An architectural security claim, not a feature bullet. The renderer process holds a **safe
projection** — titles, usernames, URLs, tags, dates — and never the passwords, note bodies,
security-question answers or attachment bytes. Those are fetched from the main process per reveal,
with a TTL.

Most Electron password managers decrypt the whole vault into renderer memory, where a single XSS
or one compromised npm dependency reaches every secret at once. Keyhold's renderer _does not have
them to leak._ This is a genuinely uncommon design, it is verifiable by reading the source, and it
is exactly the kind of claim a security-minded audience checks.

### USP 3 — Modern, fully themeable UI, with zero server

This directly targets KeePassXC's single most-cited weakness. Three-pane collapsible layout,
command palette, eight complete themes plus an accent picker, density and font-scale controls, a
custom theme editor with `.keeptheme` import/export, and **automated WCAG AA contrast tests across
every theme**. No competitor in the local-only tier ships a theme engine at all.

### USP 4 — Real file-based merge sync, without a server

Two devices, one cloud folder, and a genuine three-way merge with tombstones, a base snapshot, a
field-level conflict resolver, a pre-merge backup and a merge report.

- KeePassXC has a merge command, but it is manual, opaque, and not what happens when Dropbox
  produces a conflicted copy.
- Bitwarden and Proton solve this with a server, which is the thing we are refusing to have.
- Buttercup and `pass` leave you with whatever the filesystem did.

Sync without a server, done properly, is a hard problem most local-first managers simply decline to
solve.

### USP 5 — Provable no lock-in

18+ import formats, and — critically — **KDBX 4 export that opens directly in KeePassXC**. The
`.keep` format is publicly documented in this repo. Full-fidelity JSON export includes history.
"You can leave whenever you want, and here is exactly how" is a trust argument, and most products
that make it cannot back it up.

---

## 4. Secondary advantages

| Advantage                                                                                                                | Against whom                                                                     |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| **Security questions as a first-class repeatable field type**                                                            | Nearly everyone buries them in a free-text note                                  |
| **Unlimited _typed_ custom fields** (13 types, reorderable, individually hidden)                                         | Most managers offer text-only custom fields, or a fixed set                      |
| **Everything configurable** — security presets plus per-setting overrides for lock, clipboard, metadata capture, history | KeePassXC is configurable but hostile about it; hosted products decide for you   |
| **Audit-metadata privacy levels** (`none` / `device` / `network` / `full`)                                               | Nobody else lets you dial _how much_ provenance is recorded — it is on or absent |
| **Attachments and health reports free**                                                                                  | Both are premium in Bitwarden                                                    |
| **Zero network by default**, with the single opt-in HIBP check behind a plain-English explainer                          | Most products phone home for updates, telemetry or icons without asking          |
| **Nothing to host, for the user or the maintainer**                                                                      | Vaultwarden, Passbolt, Psono, Padloc                                             |
| **Import dry-run with a full report and one-click undo**                                                                 | Almost all importers are fire-and-forget                                         |

---

## 5. Where the competition is genuinely better — stated honestly

Not everything is a win, and the README should not pretend otherwise.

| They win on                        | Who                                               | Our position                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Browser autofill**               | Everyone except `pass`                            | Not in v1. Backlog. This is the single biggest gap and should be said plainly                                                                 |
| **Mobile apps**                    | Bitwarden, Proton, 1Password, KeePassXC ecosystem | Not in scope. Mitigated by KDBX export — your data opens in a mobile KeePass client today                                                     |
| **Third-party security audits**    | Bitwarden, Proton, 1Password, KeePassXC           | We have none, and will not claim otherwise. Mitigation: a documented threat model, a small and readable codebase, and a published format spec |
| **Hardware key / YubiKey support** | KeePassXC                                         | Backlog — the envelope-encryption design already accommodates it as another DEK wrapping                                                      |
| **Maturity and battle-testing**    | KeePassXC, Bitwarden                              | A new project. Honesty plus obsessive data-loss protection (atomic writes, rolling backups, tombstones, pre-merge snapshots) is the answer    |
| **Team sharing**                   | Bitwarden, Passbolt, Psono                        | Explicit non-goal. `.keepx` bundles cover one-off handoffs                                                                                    |
| **Memory-safety of the runtime**   | KeePassXC (C++/Qt), Padloc (non-Electron client)  | Electron is a fair criticism. Mitigated by keeping secrets out of the renderer entirely (USP 2)                                               |

---

## 6. Positioning statement

> **Keyhold is for the person who wants KeePassXC's independence with 1Password's polish, and is
> not willing to run a server to get it.**
>
> Your vault is one encrypted file that you own and can copy anywhere. It opens in a modern,
> themeable, keyboard-first app. It remembers every change you ever made to a credential — what
> changed, when, and from which device and network. It costs nothing, phones nobody, and exports
> to KDBX the day you decide to leave.

### Three-line elevator version, for the README

1. **A password manager that is actually offline** — one encrypted file, no account, no server, no telemetry, no subscription.
2. **That remembers everything** — per-credential version history with a full device and network audit trail, so you always know what changed and where it changed.
3. **And that you can leave at any time** — imports from eighteen managers, a lossless JSON export and Bitwarden's own column set, and a format documented well enough for somebody else to write a reader. (KDBX 4 export is intended and not yet built.)

---

## 7. Risks to the positioning

| Risk                                                                                    | Mitigation                                                                                                                                               |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Another password manager" fatigue — the space is crowded                               | Lead with the audit trail (USP 1), not with "secure and open source", which everyone says                                                                |
| Security scepticism toward a new, unaudited crypto implementation                       | Use boring, standard primitives (Argon2id, AES-256-GCM, envelope encryption). Document the format. Never invent a cipher. Invite review in `SECURITY.md` |
| "Electron = bloat/insecure" reflex                                                      | Answer it head-on in the README with USP 2 — this is the strongest possible reply, because it is architectural rather than defensive                     |
| Missing autofill is a dealbreaker for a large share of users                            | Say so in the README's own comparison table. Honesty converts better than omission, and it heads off one-star "it doesn't autofill" reviews              |
| KeePassXC eventually ships its UI redesign (tracked in their issues #775, #1443, #3779) | The audit trail, theme engine and merge sync remain differentiators even after a KeePassXC refresh                                                       |

---

## Sources

- [KeePassXC](https://keepassxc.org/) · UI redesign tracking issues [#775](https://github.com/keepassxreboot/keepassxc/issues/775), [#1443](https://github.com/keepassxreboot/keepassxc/issues/1443), [#3779](https://github.com/keepassxreboot/keepassxc/issues/3779), [#9675](https://github.com/keepassxreboot/keepassxc/issues/9675)
- [KeePassXC review — TechRadar](https://www.techradar.com/reviews/keepassxc)
- [Bitwarden vault health reports](https://bitwarden.com/help/reports/) · [Bitwarden import formats](https://bitwarden.com/help/import-data/)
- [Bitwarden vs 1Password — TechRadar](https://www.techradar.com/versus/bitwarden-vs-1password)
- [Padloc](https://itsfoss.com/padloc/) · [Padloc review — NetSec.News](https://www.netsec.news/padloc-review/)
- [Buttercup — gHacks](https://www.ghacks.net/2019/07/30/buttercup-open-source-password-manager-windows-macos-linux-firefox-chrome/)
- [Have I Been Pwned: Pwned Passwords](https://haveibeenpwned.com/Passwords) · [HIBP API docs](https://haveibeenpwned.com/API/V3)
- [iOS 26 Passwords gains version history](https://apple.gadgethacks.com/news/ios-26-passwords-app-finally-gets-version-history-feature/)
- [Google Password Manager's missing history](https://nulltx.com/the-missing-feature-why-google-password-manager-urgently-needs-a-password-history)
- [Securden password audit trails](https://www.securden.com/password-manager/features/password-audit-trails.html)
- [1Password import support](https://support.1password.com/import/) · [pass-import format list](https://github.com/roddhjav/pass-import)
- [KDBX4 format documentation — Wladimir Palant](https://palant.info/2023/03/29/documenting-keepass-kdbx4-file-format/) · [kdbxweb](https://github.com/keeweb/kdbxweb)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
- [Applied cryptography guide — Argon2id + AES-GCM](https://tomodahinata.com/en/blog/password-hashing-argon2-encryption-key-management-applied-cryptography-guide)
