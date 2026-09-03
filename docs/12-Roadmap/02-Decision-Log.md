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

## Session 3 — Decisions forced by the code

Four entries recorded after the fact, in the pass that caught the documentation up with
`src/`. Each was already implemented when it was written down, which is the wrong order — the
implementations carry the full argument in their module docblocks, and these entries exist so
the decision is findable from here rather than only by whoever opens the right file.

---

### D23 — The global network kill-switch is machine-scoped, fail-closed, and dominant

**Status:** Accepted
**Decision:** A single machine-scoped preference, `Preferences.networkAllowed`, decides whether
this **installation** may make a request at all. It is ANDed with the vault's own breach-check
setting, and the kill-switch wins. `src/main/network-policy.ts` owns both questions.

**Why.** Hard rule 5 has always said the breach check is "off by default, behind a global
network kill-switch" — two switches. The opt-in existed; the kill-switch did not, and a
subsystem audit found no flag anywhere in `src/` gating it (finding N38). The rule described
two switches and the code had one.

That gap is larger than it sounds. A per-vault "check my passwords" toggle answers _should this
vault use the service_. It does not answer _may this installation talk to the network at all_,
which is the question someone on an air-gapped machine, a corporate build, or a threat model
that treats any egress as a signal actually needs answered — and it is a question they need
answered **once**, not per vault and not per feature.

**Why machine-scoped and not a vault setting.** Vault settings travel inside the `.keep` file.
A vault carried to a friend's laptop must not be able to turn that machine's network on, which
is exactly what would happen if the only switch lived in the file. The two are therefore not
redundant: one follows the data, the other stays with the machine.

**Fail closed.** Only the literal boolean `true` enables it. A missing key, `null`, the string
`"true"`, a truncated preferences file, or a file written by a future build all read as
`false`. The `=== true` comparison is against a value TypeScript already calls a boolean, and
it is deliberate: what reaches it came out of a JSON file a person can edit and a half-finished
write can truncate, and the annotation is erased long before any of that. A kill-switch that
fails open on corruption is not a kill-switch.

**Off means the capability is absent, not disabled.** The policy decides whether the transport
is _constructed_. There is no `if (allowed)` inside the request path for a future refactor to
skip, and `NetworkPolicy.observe` exists so anything holding a transport built while the switch
was on is told to drop it. That preserves the strongest property of the existing breach design:
with no transport the password is never even hashed.

**Rejected:**

- **A vault setting only** — travels to other people's machines. See above.
- **A flag read at each call site** — `policy.allowsNetwork() && settings.enabled` written at a
  call site is a second copy of the rule, and the second copy is the one that forgets a switch.
  `allowsBreachCheck` composes it in one place.
- **Caching the answer** — a cached "yes" outliving the user's decision to go offline is the one
  failure mode the class exists to prevent, so it reads through on every question.

**What it deliberately does not gate:** `shell.openExternal`. Handing a URL to the user's own
browser makes the request _as the user_; Keyhold is not the one talking to the network, and a
switch that silently broke every documentation link would teach people to leave it on. This is
why the setting is worded "let Keyhold make network requests" rather than "go offline". It also
does not touch the renderer's CSP: `connect-src 'none'` is unconditional and stays that way.

**Consequence:** the composition root must read the policy _and_ the feature setting before it
constructs a breach transport. Nothing constructs one today — `NetworkPolicy` has no caller
outside its own test — so wiring the breach check is now a matter of using this, not of
inventing it. See [`../05-Features/07-Breach-Check.md`](../05-Features/07-Breach-Check.md) §7.

---

### D24 — Import is a transaction: one held parse, an asymmetric merge, and a three-part undo guard

**Status:** Accepted
**Decision:** The commit half of import is a service holding state between IPC calls
(`src/main/import-service/`), not a set of independent handlers. A preview parses once and
holds the result; a commit can only point at that held parse; a merge is additive except on
single-valued text; and an undo is refused unless the vault is in exactly the state the commit
left it in.

**Why a held parse.** The plausible alternative re-parses at commit time from the file the
renderer names. It is simpler and holds less memory, and it is wrong: between the two parses
the file can change on disk, the mapping can be edited, and the format can be re-detected — so
the records committed are not the records approved. A dry run that can disagree with the run is
decoration. Holding the parse also means `ImportCommitRequest` can carry no records, no mapping
and no format, so there is no shape a compromised renderer can hand to `commit` that describes
data it invented.

**Why the merge policy is asymmetric.** Set-valued fields (urls, tags, custom fields) are
additive only, because removing a URL on the strength of an export's omission is deleting data
for a reason that has nothing to do with the user's intent. Single-valued text may be
`replaced`, and that is the one genuinely destructive effect the screen can produce, which is
why it is named separately and warned about specifically for `password`. **Folder is the
asymmetric case:** `fills-empty` but never `replaces`. Filing is a decision the user made in
_this_ vault, an import from another product's tree has no standing to overrule it, and unlike
a password the previous location is not recoverable from the record itself.

**Why the undo guard has three parts.** Undo removes records by id, which is only a safe
description while the vault is exactly as the commit left it. Checking the save generation
alone is not enough: a generation moves on a _save_, so a user who edited an imported record
and has not saved yet has not moved it — and a generation-only check would let the undo run and
take that edit with it while claiming it only removed what the import added. So the caller's
expected generation, the batch's own generation, and "no unsaved changes" must all hold. That
guard is what licenses `purgeCredential` rather than `trashCredential`, and restoring a merged
record wholesale from a snapshot.

**Rejected:** re-parsing at commit; a boolean `confirmed` from the renderer in place of held
state; an undo that repairs what it can and reports the rest — an undo that half-works is worse
than no offer, because the user will have believed it.

**Consequence:** the service is the only place in the app holding a plaintext dump of an entire
vault, so what it holds and when it is destroyed is itself part of the design — bytes in a
`SecretBytes` that can be zeroed, decoded text never retained, one plan per source, and a
bounded number of undoable batches. Full argument in
[`../09-Import-Export/02-Import-Service.md`](../09-Import-Export/02-Import-Service.md).

---

### D25 — "Absolute path" is not the question; "names local storage" is

**Status:** Accepted
**Decision:** Every path arriving from outside — a double-clicked file, a dragged file, an
`argv` entry, or a path the renderer sends back over IPC — is checked against an **allow-list
of shapes that name this machine's own storage** (`src/shared/model/local-path.ts`), not
against `path.isAbsolute`.

**Why this is a security check and not a formatting check.** On Windows, touching a path is not
a local operation. `\\attacker.example\share\x.keep` is a perfectly ordinary absolute path — it
has no URL scheme, no `..` segment, and a `.keep` extension — and the moment anything calls
`stat` on it the OS opens an **SMB connection to a host the attacker named** and by default
performs an NTLMv2 handshake with the logged-in user's credentials. Three things go wrong at
once: an outbound network connection from an app whose hard rule 5 is zero network by default;
a credential disclosure, since the NTLMv2 response is offline-crackable and is the standard
payload of a UNC-path phishing link; and a synchronous hang in the main process, before any
window exists, for as long as the connection takes to time out. None of it requires the file to
exist, and none of it requires the user to do more than double-click a `.lnk` someone sent
them. (Subsystem audit finding N1.)

**Why an allow-list.** The refused shapes are UNC (`\\host\share`), its forward-slash spelling,
a device path to a UNC (`\\?\UNC\…`), the device namespace (`\\.\pipe\…`), and a rooted path
with no drive (`\Users\…`, which resolves against whichever drive is current). A deny-list of
those five would be one Windows path syntax away from being wrong again, and Windows has more
path syntaxes than anyone has a complete list of. The one Windows shape that names local
storage is a drive letter followed by a separator, so that is what is allowed.

**A doubled POSIX root is refused too**, and that is not pedantry: `//host/share/v.keep` is a
syntactically valid POSIX path _and_ the forward-slash spelling of a Windows UNC share, and the
platform-agnostic validator at the IPC boundary does not know which OS the string came from.
Accepting a bare leading `/` there would have let the attack through the one check that most
needed to stop it. POSIX calls a leading `//` implementation-defined and `path.posix.normalize`
collapses it, so refusing it costs nothing real.

**Why it lives in `@shared`.** Two places need the same answer and rule 8 says they get it from
one list: `src/main/shell/file-open-request.ts` receives paths from the OS, and
`src/shared/ipc/validation.ts` receives them back from the renderer. Both were letting a UNC
path through. It is written as a regex rather than over `node:path` because this module is
compiled into the renderer's project and must stay free of Node built-ins.

**Consequence:** recorded in [`../00-Overview/03-Threat-Model.md`](../00-Overview/03-Threat-Model.md)
§1 as a threat Keyhold defends against, because "opening a file cannot make a network
connection" is a property a user of an offline password manager is entitled to assume and would
never think to ask about.

---

### D26 — A merge refuses on a duplicate id rather than resolving it

**Status:** Accepted
**Decision:** `mergeDocuments` asserts that records, folders and tags each hold no repeated id,
on all three inputs, before it reads anything — and throws a named `DuplicateIdError` carrying
the side, the entity and every offending id.

**Why refusing is the answer.** Two entries under one id is corruption: identity is what the
whole engine merges _by_, so the input does not describe a state the model can represent. There
are three honest responses, and two of them cost the user something this one does not.

- **Keep one and report the other.** That is a lost credential with a note attached, and a note
  is not a password. Hard rule 6 has no "but we said so" clause. This was the pre-existing
  behaviour, and it was silent: `new Map` keeps the last entry for a repeated key, so the merge
  discarded one before looking at either — and could lose a second, unrelated record as a
  knock-on. (Subsystem audit finding N3.)
- **Keep both under fresh ids.** Minting an id needs a CSPRNG, which makes the engine impure
  and its output unreproducible between the resolver loop's two passes; the new id is a _new
  record_ to the other device, so the duplicate propagates rather than resolving; and it severs
  the record from its ancestor, its history and its attachment chunks. That is repairing
  corruption by manufacturing more of it.
- **Refuse.** Costs nothing. The engine is pure and writes no file, so a refusal leaves both
  vaults exactly as they were, on disk, with every record still in them.

**And the user already has a repair path.** `document-diagnosis.ts` emits `duplicate-record-id`
for precisely this state, which means the codebase's answer to "what do I do about it" predates
this guard and is not merging. The error is named rather than bare so a dialog can say _which
file, which list, which ids_ and point at the diagnosis, instead of saying "merge failed".

**Scope:** records, folders and tags. Custom fields, security questions and attachments are
deliberately not checked here — `assertValidCredential` already refuses a record with duplicate
ids in those lists, and a second copy of that rule would be the duplicate list rule 8 forbids.

**Consequence:** a merge is the one operation that reads two meanings of a thing at once and
writes a single answer. Doing that when the thing has two meanings _on one side_ is how a vault
loses a password, so this sits alongside "absence is not deletion" as a rule that outranks
convenience. See [`../07-Sync-And-Merge/00-Merge-Engine.md`](../07-Sync-And-Merge/00-Merge-Engine.md) §3.

---

### D27 — A history export carries provenance, not old passwords

**Decision:** `kh:history:export` writes one credential's audit trail — what changed, when, and
from where — with every secret value rendered as a length, exactly as it already crosses to the
renderer. It does **not** offer old passwords, with or without a confirmation.

**Why not include them.** The obvious reading of "export a credential's history" is "everything
in it", and that reading is wrong here for a reason specific to this data: a record's history is
the one place a vault keeps passwords the user has _stopped_ using. Those are the passwords most
likely to be reused elsewhere, least likely to have been rotated since, and least likely to be
missed if the file leaks. A plaintext file of every password an account has ever had is a worse
artefact than a plaintext file of every password it has now, and Keyhold already offers the
second one under a type-to-confirm.

**Why the feature is still worth having.** Provenance is Keyhold's headline differentiator, and
the questions people take it to — when did this change, from which device, on whose network —
are all answered without a single secret. That is also what makes the export shareable: it can
go to a colleague, a support ticket or an incident write-up as it stands.

**The alternative, and why not.** An opt-in "include old values" checkbox behind the same
type-to-confirm the full export uses would be consistent and is the obvious counter-proposal. It
was rejected because it makes the dangerous artefact reachable from a screen whose stated
purpose is the safe one, and because it is redundant: anybody who genuinely wants old secret
values has the full encrypted export, which keeps them encrypted. A feature that is safe by
construction needs no confirmation dialog, and a confirmation dialog is not a substitute for
being safe by construction.

**Consequence:** no `PLAINTEXT_AFTERMATH_REMINDER`, no shred warning and no type-to-confirm on
this path, because there is nothing in the file that warrants one — and the guard that keeps
that true is a test asserting a planted secret never appears in the output, the same shape as
the projection's.

---

### D28 — A health rule may ship off, but only from a named list

**Decision:** health rules are on by default, as D10 says. `missingTotp` is the first exception,
and exceptions are enumerated in `HEALTH_RULES_OFF_BY_DEFAULT` — a rule may not simply be added
in the off position.

**Why this rule is an exception.** Every other rule flags something the user did wrong and can
undo: a reused password, a weak one, an `http://` URL. "No second factor" is different in two
ways. It fires on most records in a normal vault, because most accounts have no TOTP — so on
first run it would flag the majority of the list at once. And it is frequently **not
actionable**: an enormous number of sites offer no second factor at all, so the finding is a
fact about the site rather than a mistake by the user.

**The score is what settles it.** `missingTotp` carries weight 8. If it fires on most records,
the health score becomes dominated by something largely outside the user's control, and a score
that moves mostly on things you cannot change is a score you stop reading. That devalues the
other nine rules, which are all directly actionable. Turning it on is then a deliberate act by
somebody who wants a 2FA audit — for whom it is exactly the right rule.

**Why a list rather than a free choice.** The test that caught this said it well: _"a rule added
in the off position would be a silently missing check"_. That risk is real and does not go away
because one exception is justified — the next rule could be added off by accident, or off
because it was noisy in development, and nobody would notice. So the principle stays enforced
and the exception is named: `settings-plan.test.ts` asserts that every rule not on that list is
on, which makes shipping a rule off a change to a constant somebody has to write down.

**Rejected: turn it on and let people switch it off.** Consistent, and it spends the one thing
the health dashboard cannot get back — a user's belief that a finding means something. A
first-run screen listing most of the vault under a heading they cannot act on is how a feature
gets switched off wholesale rather than tuned.

**Consequence:** `settings-copy.ts` no longer treats "not every rule is on" as a weakened
trade-off, because at the defaults that is now simply untrue. It compares against the defaults,
the way the entropy threshold beside it already did.

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
