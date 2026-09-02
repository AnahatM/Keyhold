# Naming & glossary

> Every name in Keyhold, what it means, and why it was chosen. Read this before inventing a new
> name for anything — the conventions here are deliberate.

---

## 1. The app: **Keyhold**

A coined compound that reads two ways simultaneously:

- **The thing that holds your keys.** Literal, immediately understood.
- **A *hold*, in the fortification sense** — a defensible place where valuables are kept. This is
  the metaphor the entire naming system extends from.

Chosen for being one short word, memorable, unclaimed in the password-manager space, and giving an
obvious wordmark (a keyhole or lock glyph).

**Rejected:** *Coffer* (strong imagery, but old-world and slightly precious) · *Cipherfold*
(technical and crypto-forward, but longer to type and less warm) · keeping the literal folder name
*Credentials-App* (perfectly descriptive, but weak as an open-source project people star and share).

**Written style:** always `Keyhold`, one word, capital K only. Never `KeyHold`, `keyHold` or
`Key Hold`. The npm package and binary are lowercase `keyhold`.

---

## 2. The file format: **KEEP**

### Expansion

> **KEEP** — **K**eyhold **E**ncrypted **E**ntry **P**ackage

### Why "keep"

A **keep** is the fortified inner stronghold at the centre of a castle — the most defensible
structure, where the things that matter most are kept. It is exactly what a *keyhold* holds, so the
app name and format name reinforce each other rather than competing.

It is also, simultaneously, the plain English verb: *this is where you **keep** things.* A user who
knows nothing about castles still reads `passwords.keep` correctly on first sight. That double
reading — evocative to those who notice, obvious to those who don't — is what made it the pick.

**Rejected format names,** recorded so the ground is not re-tread:

| Family | Candidates | Why not |
|---|---|---|
| Fortification | `.hold`, `.bastion`, `.redoubt` | `.hold` is on-brand but abstract as a noun; the others are long and archaic |
| Protection | `.ward` | Genuinely good — a ward is both a magical protection and a walled castle section, and "warden" was available for a future CLI. More fantasy-flavoured than we wanted |
| Treasure | `.trove`, `.coffer`, `.chest`, `.reliquary`, `.stash` | `.trove` was the runner-up — warm and positive — but abandons the castle metaphor the app name establishes |
| Crypto | `.crypt`, `.cipher`, `.sealed`, `.enigma` | `.crypt` puns nicely on cryptography but carries funereal connotations |
| Record | `.codex`, `.grimoire`, `.ledger`, `.sanctum` | Too generic, or too fantasy |

---

## 3. The extension family

Every Keyhold file type, what it holds, and whether it is encrypted.

| Extension | Full name | Contents | Encrypted | Passphrase |
|---|---|---|---|---|
| **`.keep`** | KEEP — Keyhold Encrypted Entry Package | The vault: all records, all history, all attachments | **Yes** — Argon2id + AES-256-GCM | The master password |
| **`.keepx`** | KEEPX — Keyhold Encrypted **Exchange** Package | A *subset* of records, packaged for transfer to another device or person | **Yes** | Its **own** passphrase, independent of the master password |
| **`.keeptheme`** | Keyhold Theme | An exported custom theme — a small JSON token map | No | — (contains no secrets) |
| **`.keepbak`** | Keyhold Backup | A rolling automatic backup of a `.keep` | **Yes** | Identical to its source vault |
| `.keep.tmp` | *(transient)* | Atomic-write staging file, renamed over the target after `fsync` | **Yes** | — |

### Why `.keep` and `.keepx` are different things

This distinction matters and should be preserved in all UI copy:

- A **`.keep`** is **your vault**. It is the whole thing. It opens with your master password.
- A **`.keepx`** is **a parcel**. It carries only what you chose to put in it, and it has its own
  passphrase — so handing one to someone never means handing over your master password, and never
  exposes anything you did not select.

The **x** reads as **exchange**: the file you hand over.

---

## 4. Glossary of internal terms

Use these terms consistently in code, comments, docs and UI copy.

### Data model

| Term | Meaning |
|---|---|
| **Vault** | One `.keep` file and everything inside it. A user may have several, switched between. |
| **Record** / **Credential** | One stored entry. Interchangeable; prefer *credential* in UI copy, *record* in code. |
| **Field** | One named value on a record. Core fields are fixed; custom fields are user-defined and typed. |
| **Custom field** | A user-added, typed, reorderable, optionally-hidden field. 14 types in v1. |
| **Attachment** | A file stored inside the vault as its own encrypted chunk. |
| **Version** | One historical state of a record, holding only the fields that changed plus its origin. |
| **Origin** | The device, network, OS user, platform and app version recorded on a version. The audit trail. |
| **Tombstone** | A soft-deleted record kept as a deletion marker, so sync cannot resurrect it. |
| **Trash** | The user-facing view of tombstoned records, with restore and auto-purge. |
| **Folder** | A hierarchical container. A record is in at most one. |
| **Tag** | A flat label. A record may have many. |
| **Smart view** | A saved, rule-based filter — e.g. "weak AND untagged". |

### Cryptography

| Term | Meaning |
|---|---|
| **KEK** — Key Encryption Key | 32 bytes derived from the master password by Argon2id. **Never stored, anywhere.** |
| **DEK** — Data Encryption Key | 32 random bytes that actually encrypt the vault body. Stored only *wrapped*. |
| **Wrapping** | Encrypting one key with another. Lets unlock methods be added or revoked without re-encrypting the vault. |
| **Envelope encryption** | The KEK-wraps-DEK scheme as a whole. Why changing your master password is instant. |
| **AAD** — Additional Authenticated Data | Data authenticated but not encrypted. The plaintext header is AAD, so tampering with it breaks the tag. |
| **Nonce** | A number used once. A fresh random 96-bit value per encryption. **Never reused under the same key.** |
| **Chunk** | An independently encrypted region of the container. One per attachment. |
| **Generation** | A monotonic counter in the header, incremented on every save. Used to detect external changes. |

### Architecture

| Term | Meaning |
|---|---|
| **Safe projection** | The subset of record data the renderer is permitted to hold. Contains **no secrets, ever.** See decision D13. |
| **Secret material** | Passwords, note bodies, security-question answers, TOTP seeds, attachment bytes. Main process only. |
| **Deep search** | Searching inside secret material. Delegated to the main process, because the renderer does not have it. |
| **Base snapshot** | The last-synced vault state, stored so a three-way merge is possible. |
| **Three-way merge** | Comparing local, remote and the base to determine what genuinely conflicts. |
| **Security preset** | A named bundle of settings — Relaxed / Balanced / Strict / Paranoid — that individual settings can override. |
| **Privacy level** | How much origin metadata is captured: `none` / `device` / `network` / `full`. |

---

## 5. Naming conventions in code

| Thing | Convention | Example |
|---|---|---|
| TypeScript files | `kebab-case.ts` | `vault-service.ts` |
| React components | `PascalCase.tsx` | `CredentialDetail.tsx` |
| Types and interfaces | `PascalCase` | `Credential`, `SafeProjection` |
| Functions and variables | `camelCase` | `unwrapDek`, `safeProjection` |
| Constants | `SCREAMING_SNAKE_CASE` | `DEFAULT_CLIPBOARD_TTL_MS` |
| CSS tokens | `--kh-<category>-<name>` | `--kh-color-surface-raised` |
| IPC channels | `kh:<domain>:<action>` | `kh:vault:unlock` |
| Test files | `<name>.test.ts` beside the source | `container.test.ts` |

**One hard rule:** anything holding secret material carries `secret`, `Secret` or `SecretString` in
its name, so a reviewer scanning a diff can see at a glance where secrets flow.
