# Keyhold — Decision Log

> Every decision made about this project, why it was made, and what was rejected. Append, never
> rewrite. If a decision is reversed, add a new entry that supersedes the old one and mark the old
> one — do not delete history.
>
> Format: ADR-style. The frozen narrative version of the founding decisions lives in
> [`docs/superpowers/specs/2026-09-02-keyhold-product-spec.md`](../superpowers/specs/2026-09-02-keyhold-product-spec.md).

---

## Session 1 — 2026-09-02 · Founding decisions

Context: a greenfield project. Anahat asked for a local, encrypted, cross-platform credentials
manager, free and open source, with no hosting and no cost. Four rounds of batched questions were
asked; every answer is recorded below.

---

### D1 — Native vault format: custom `.keep`

**Status:** Accepted
**Decision:** A custom container format (`.keep`) is the native format, with a comprehensive
import/export interop layer around it.

**Why:** The features Anahat asked for — per-field version history, a device and network audit
trail, unlimited typed custom fields, first-class security questions — have no natural
representation in any existing format. Owning the format means the data model can be exactly right.
The interop layer removes the usual cost of a proprietary format.

**Rejected:**

- **KDBX 4 as native.** Would give instant KeePassXC compatibility, but history, provenance and
  structured metadata would have to be crammed into string custom-fields that read as noise in
  other clients. The data model would be dictated by a format designed in 2004.
- **SQLCipher.** Good for very large vaults and partial reads, but adds a per-platform native
  binary to the build, and the vault stops being "one obvious thing you copy".

**Consequence:** we owe the ecosystem a published, implementable format spec (Phase 19), and KDBX 4
_export_ becomes a hard requirement, not a nice-to-have (D3 of the anti-lock-in promise).

---

### D2 — Transfer model: all three tiers

**Status:** Accepted
**Decision:** Portable single file **and** a `.keepx` transfer bundle **and** watched-folder
three-way merge sync.

**Why:** Anahat asked whether encrypted data can be copied between devices via files. It can, and
the interesting problem is concurrent edits, not encryption. Doing only tier 1 means a Dropbox
conflict silently loses edits — unacceptable against goal G1 (never lose a credential).

**Rejected:**

- **Manual copy only** — last-writer-wins loses data.
- **LAN device-to-device pairing** — deferred to backlog C1. It adds a listening network surface to
  an app whose main selling point is that it has none.

**Consequence:** the record model must carry per-record `updatedAt` and content hashes, deletions
must be tombstones rather than removals, and a base snapshot must be stored. All three are baked
into Phase 5/6 rather than retrofitted in Phase 12.

---

### D3 — v1 feature scope

**Status:** Accepted
**Decision:** Password health dashboard (including opt-in HIBP) and encrypted attachments are in
v1. Built-in TOTP and extra item types are **deferred, not dropped**.

**Anahat's exact instruction:** _"Even though I didn't check all the options ensure that they are
all written down in's docs for future implementation ideas at some later point."_

**Consequence:** backlog items A1 and A2. Groundwork is deliberately laid in v1 so both are additive
later — the record model carries a `type` discriminator, and `otp-secret` already exists as a
custom-field type.

---

### D4 — v1 unlock and lockdown scope

**Status:** Accepted
**Decision:** Biometric quick-unlock and auto-lock plus clipboard hygiene are in v1. Key-file second
factor and emergency recovery kit are **deferred, not dropped**.

**Anahat's exact instruction:** _"Again even if I didn't check these options write them down as
potential candidate features for the future."_

**Consequence:** backlog items A3 and A4. Envelope encryption (D14) is chosen specifically so both
are additional DEK wrappings rather than format changes.

---

### D5 — App name: **Keyhold**

**Status:** Accepted
**Why:** A coined compound that reads two ways — the thing that _holds your keys_, and a _hold_ in
the fortification sense. One word, memorable, unclaimed in this space, obvious wordmark.
**Rejected:** Coffer (strong but old-world), Cipherfold (technical, longer), Credentials-App
(descriptive but weak as an open-source project).

---

### D6 — Licence: **GPL-3.0-or-later**

**Status:** Accepted
**Why:** What KeePassXC, KeePass, Bitwarden's clients and Proton Pass all use. For a security tool
the copyleft guarantee _is_ the trust argument: any fork stays auditable.
**Rejected:** MIT and Apache-2.0 — a closed fork of a password manager cannot be inspected, which
undermines the entire premise. AGPL-3.0 — the network clause buys nothing for an app that never runs
as a service, and deters contributors.

---

### D7 — Layout: three-pane, collapsible

**Status:** Accepted
**Why:** The pattern 1Password, Bitwarden and Apple Passwords all independently converged on.
Collapsible panes mean it degrades to two-pane and one-pane rather than breaking.
**Rejected:** two-pane (filtering one click deeper), card grid (far fewer items per screen, scales
poorly past a few hundred entries).

---

### D8 — Theming: full theme engine

**Status:** Accepted
**Why:** KeePassXC's most-cited weakness is its dated, unthemeable interface. This is a direct,
cheap differentiator (USP 3). Tokens also make the WCAG contrast guard possible.
**Rejected:** named themes without an editor; light/dark only.
**Consequence:** a hard rule — **zero hardcoded colours anywhere** — plus two guard tests (every
token resolves in every theme; every pair passes AA contrast).

---

### D9 — Format name: **KEEP**, extension `.keep`

**Status:** Accepted
**Expansion:** Keyhold Encrypted Entry Package.
**Why:** A _keep_ is the fortified inner stronghold of a castle — exactly what a _keyhold_ holds —
and simultaneously the plain verb _to keep_. Short, warm, unclaimed.
**Rejected:** `.hold`, `.ward`, `.trove`, and from earlier brainstorming `.bastion`, `.redoubt`,
`.coffer`, `.chest`, `.reliquary`, `.stash`, `.crypt`, `.cipher`, `.sealed`, `.enigma`, `.codex`,
`.grimoire`, `.ledger`, `.sanctum`.
**Family:** `.keep` (vault) · `.keepx` (exchange bundle) · `.keeptheme` (theme) · `.keepbak`
(backup). Full rationale in [`../00-Overview/01-Naming-And-Glossary.md`](../00-Overview/01-Naming-And-Glossary.md).

---

### D10 — Everything is user-configurable

**Status:** Accepted
**Anahat's exact instruction:** _"I want it fully customizable and configurable by the user based on
what features or levels of security or auth they want to enable or disable."_
**Decision:** Named security presets (Relaxed / Balanced / Strict / Paranoid) **plus** an
independent override for every individual setting, with a visible "modified from preset" marker.
**Consequence:** Phase 14 is a real phase, not a settings screen bolted on at the end. Every feature
built in phases 4–13 must expose its behaviour as a setting from the moment it is written.

---

### D11 — Zero cost and zero hosting, for the user _and_ the maintainer

**Status:** Accepted
**Anahat's exact instruction:** _"I just want this to be a foss utility where I won't have to pay
for anything or host anything."_
**Consequence:** no server, no paid API, no code-signing certificate in v1 (D16), GitHub free tier
only, GitHub Pages if a site is ever wanted. The one network feature (HIBP Pwned Passwords) is free
and needs no API key — verified during planning.

---

### D12 — Repository: `AnahatM/Keyhold`, private for now

**Status:** Accepted
**Anahat's exact instruction:** _"setup a git repo in this codebase and push it online to GitHub
privately for now."_
**Consequence:** flipped public at v1 (backlog G1). Blocked on tooling — see `MANUAL-BACKLOG.md`.

---

### D13 — The renderer never holds the master key

**Status:** Accepted
**Decision:** The main process holds the KEK, the DEK and the decrypted vault. The renderer holds
only a **safe projection** — titles, usernames, emails, URLs, tags, folders, dates, metadata,
history summaries, health flags. Passwords, note bodies, security-question answers and attachment
bytes are fetched on demand, per reveal, with a TTL.

**Why:** most Electron password managers decrypt the whole vault into renderer memory, where a
single XSS or one compromised npm dependency reaches every secret at once. This is the strongest
available answer to the "Electron is insecure" criticism, and it is architectural rather than
defensive.

**Rejected:** the full decrypted vault in the renderer — simpler, and what nearly everyone does.

**Consequence:** search, sort and filter must work on the projection; deep search is delegated over
IPC. A property test asserts the projection can never contain a secret field. This constraint
shapes Phase 2 and every phase after it, so it had to be decided up front.

---

### D14 — Argon2 via `hash-wasm` (pure WASM)

**Status:** Accepted
**Why:** Avoids a per-platform native binary in the Electron build matrix, which is the single most
common source of cross-platform packaging pain. `kdbxweb` needs an Argon2 implementation supplied
externally anyway, so one WASM implementation serves both the native format and KDBX interop.
**Rejected:** `@node-rs/argon2` and `argon2` native bindings — marginally faster, materially harder
to ship.
**Consequence:** conflicts with backlog D5 (memory-locking key material), which would need a native
addon. Accepted trade-off.

---

### D15 — Attachments as separate encrypted chunks

**Status:** Accepted
**Decision:** Attachments are appended to the `.keep` file as independent, individually encrypted,
length-prefixed chunks addressed by id — not embedded in the record payload.
**Why:** keeps the records body small and fast to decrypt on unlock, avoids 33% base64 bloat, and
lets a large attachment be read only when opened — while the vault stays a single portable file.
**Rejected:** base64 inside the payload (slows every unlock); a sidecar folder (breaks the
single-file promise, which is the whole transfer story).

---

### D16 — Unsigned builds in v1

**Status:** Accepted
**Why:** Follows directly from D11. A Windows EV certificate and an Apple Developer ID both cost
money annually.
**Mitigation:** publish SHA-256 checksums with every release, document the exact SmartScreen and
Gatekeeper steps in the README, and pursue reproducible builds (backlog D6) as the trust substitute.
**Consequence:** backlog D8; recorded in `MANUAL-BACKLOG.md`.

---

### D17 — Positioning: the empty quadrant

**Status:** Accepted
**Decision:** Position Keyhold as _"KeePassXC's independence with 1Password's polish, without
running a server"_, and lead marketing with the **version history and device/network audit trail**
rather than with "secure and open source", which every competitor says.
**Why:** analysis in [`../00-Overview/02-Competitive-Analysis.md`](../00-Overview/02-Competitive-Analysis.md)
found that everything modern requires a server or an account, and everything local looks dated. The
audit trail in particular exists today only in enterprise, cloud-hosted, paid tools — plus Apple
Passwords, as of iOS 26.
**Consequence:** the README must lead with the audit trail, and must include an honest table of
where competitors win (autofill, mobile, third-party audits, maturity). Honesty converts better
than omission.

---

## Session 2 — 2026-09-02 · Phase 0 scaffold decisions

Resolutions of the implementation questions I1 and I2 deferred above, plus two forced by
the toolchain.

---

### D18 — TypeScript pinned to 5.9, not 7.x

**Status:** Accepted (resolves I1)
**Why:** TypeScript 7.0 is current, but `typescript-eslint@8` declares
`typescript >=4.8.4 <6.1.0`. Adopting TS 7 today means losing **type-aware linting** —
`no-floating-promises`, `no-unsafe-*`, `switch-exhaustiveness-check` and the rest all
require a type program. In a codebase where an unawaited promise can mean a secret is not
zeroed, those rules are worth more than being on the newest major.
**Revisit when:** `typescript-eslint` ships TS 7 support.

### D19 — Vite pinned to 7.x

**Status:** Accepted
**Why:** Forced. `electron-vite@5` peers `vite ^5 || ^6 || ^7`; vite 8 is current but
unsupported. `@vitejs/plugin-react@6` requires vite 8, so plugin-react is pinned to 5.2.0
to match.

### D20 — The preload is CommonJS, not ESM

**Status:** Accepted
**Decision:** The preload bundle is emitted as `index.cjs` with `format: 'cjs'`, with
`electron` as the only external.
**Why:** Not a preference — a hard Electron constraint.
[Sandboxed preload scripts run as plain CommonJS with no ESM context.](https://www.electronjs.org/docs/latest/tutorial/esm)
Since `sandbox: true` is non-negotiable (it is part of decision D13's defence), the preload
cannot be ESM.
**Why this is dangerous enough to write down:** an `.mjs` preload **builds cleanly and
launches cleanly, then silently never runs.** `window.keyhold` is simply `undefined`, every
feature is dead, and there is no error anywhere — not in the build, not in the console, not
in the main process. It was caught here only by adding a launch smoke test.
**Consequence:** `npm run test:smoke` and `src/main/smoke.ts` exist specifically to catch
this class of defect, and are run after any change to main, preload, or the build config.

### D21 — Argon2 parameter calibration deferred to Phase 1

**Status:** Deferred (I2 remains open)
**Why:** Phase 0 ships no cryptography. Calibration needs the real Argon2 implementation to
measure against, so it belongs in Phase 1 where `hash-wasm` is actually wired up.

### D22 — Crypto and format implementations live in `src/main`, not `src/shared`

**Status:** Accepted
**Decision:** `@shared` holds types, constants and pure data shapes only. Every
implementation that touches key material or the filesystem lives under `src/main/`.

**Why:** the original plan (in the founding spec) put these in `shared/crypto/` and
`shared/format/`. That turns out to be wrong for two reasons, discovered while building
Phase 1:

1. **`@shared` is compiled by `tsconfig.web.json`**, because the renderer imports the IPC
   contract from it. Anything in `@shared` that imports `node:crypto` or `node:zlib` fails
   to type-check in the renderer environment — and the fix of loosening that tsconfig would
   remove the very check that keeps shared code honest.
2. **More importantly, it would make the crypto layer importable from the renderer.** The
   whole point of decision D13 is that the renderer cannot reach key material. Putting the
   key-derivation function somewhere the renderer can `import` it is the opposite of that,
   even if nothing imports it today.

**Consequence:** `src/shared/format/types.ts` holds the container's types and constants —
useful to both sides, dangerous to neither. `src/main/crypto/` and `src/main/format/` hold
the implementations. The renderer lint zone additionally makes `import ... from '@main/*'`
a hard error, so this is enforced rather than merely intended.

**Supersedes:** the module layout sketched in the founding spec §10. The spec is history
and is not edited; this entry is the current truth.

---

## Decisions deferred to implementation

Recorded so they are consciously decided rather than accidentally defaulted.

| #      | Question                                                  | Decide by                                                                                                                                     |
| ------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~I1~~ | ~~Exact Electron and React majors~~                       | **Resolved in Phase 0** — Electron 44.1.1, React 19.2.8. See D18–D20 for the constraints that shaped the rest of the matrix                   |
| I2     | Argon2 default `m`, `t`, `p`                              | Calibrating on the dev machine to ≈500 ms unlock, then writing the result into each vault's header (Phase 1). Deferred from Phase 0 — see D21 |
| I3     | Deep search: inverted index in main, or linear scan       | Measuring against a 10 000-record synthetic vault (Phase 7)                                                                                   |
| I4     | Whether `.keepx` should carry an expiry at all            | It can only ever be advisory, enforced by the importing client. Decide in Phase 11 and label honestly if kept                                 |
| I5     | Whether the vault activity log (backlog D3) pulls into v1 | After Phase 6, once the audit-trail machinery exists and the marginal cost is visible                                                         |
