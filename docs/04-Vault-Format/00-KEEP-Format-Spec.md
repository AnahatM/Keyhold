# The KEEP format — specification

**KEEP** — _Keyhold Encrypted Entry Package_. File extension `.keep`.
**Format version:** 1
**Status:** current reference. Implemented by `src/main/format/container.ts`.

> **This document is written to be implementable by someone who has never seen Keyhold's
> source.** That is deliberate. Keyhold's third goal is that you can leave whenever you
> want (G3), and a documented format is what makes that true even if this project is
> abandoned tomorrow. If anything here is ambiguous enough to block a clean-room
> implementation, that is a bug — please report it.

---

## 1. Overview

A `.keep` file is a single, self-contained, authenticated ciphertext container. It holds:

- **one encrypted body** — all records, in one blob
- **zero or more encrypted chunks** — one per attachment
- **one plaintext header** — the parameters needed to derive the key, authenticated but
  not encrypted

The key is derived from the master password alone. **No device-specific input enters the
key derivation**, which is what makes the file portable: copy it to a USB stick, a cloud
folder, or an email attachment and it opens anywhere, given the password.

---

## 2. Byte layout

All integers are **little-endian, unsigned**.

```
offset  size      field
──────  ────────  ──────────────────────────────────────────────────────
0       8         MAGIC — the ASCII bytes "KEYHOLD" followed by 0x00
8       2         formatVersion (uint16)
10      4         headerLength (uint32)
14      N         header — UTF-8 JSON, plaintext (see §3)
14+N    4         bodyLength (uint32)
…       12        body nonce
…       …         body ciphertext
…       16        body authentication tag
…       4         chunkCount (uint32)

  then, repeated chunkCount times:
        16        chunk id (raw bytes; rendered as 32 lowercase hex characters)
        4         chunkLength (uint32) — nonce + ciphertext + tag
        12        chunk nonce
        …         chunk ciphertext
        16        chunk authentication tag
──────  ────────  ──────────────────────────────────────────────────────
```

`bodyLength` and `chunkLength` each count the **nonce, ciphertext and tag together**, not
the ciphertext alone.

### Magic bytes

```
4B 45 59 48 4F 4C 44 00
```

A file that does not begin with exactly these eight bytes is not a KEEP file. Readers must
reject it rather than attempting recovery.

---

## 3. The header

UTF-8 JSON. Plaintext, and readable without the password — it must be, because it says how
to derive the key.

```json
{
  "formatVersion": 1,
  "vaultId": "0b8e...-uuid",
  "deviceId": "6f21...-uuid",
  "kdf": {
    "alg": "argon2id",
    "memoryKib": 65536,
    "iterations": 3,
    "parallelism": 4,
    "salt": "<base64, ≥16 bytes>"
  },
  "cipher": "AES-256-GCM",
  "wrappedDek": {
    "nonce": "<base64, 12 bytes>",
    "ciphertext": "<base64, 32 bytes>",
    "tag": "<base64, 16 bytes>"
  },
  "createdAt": 1756771200000,
  "modifiedAt": 1756771200000,
  "generation": 1,
  "recordCount": 0,
  "attachmentCount": 0
}
```

| Field                            | Type   | Meaning                                                                                                                                                                       |
| -------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formatVersion`                  | uint   | Must equal the preamble's version field. Duplicated so the version is readable without parsing JSON, and so editing the preamble is detectable.                               |
| `vaultId`                        | string | Stable identity of this vault across copies and devices.                                                                                                                      |
| `deviceId`                       | string | Which device last wrote the file. Used by sync to recognise its own writes.                                                                                                   |
| `kdf`                            | object | Argon2id parameters (§4).                                                                                                                                                     |
| `cipher`                         | string | Always `"AES-256-GCM"` in version 1.                                                                                                                                          |
| `wrappedDek`                     | object | The data key, encrypted under the key-encryption key (§5).                                                                                                                    |
| `createdAt`, `modifiedAt`        | uint   | Unix milliseconds.                                                                                                                                                            |
| `generation`                     | uint   | Monotonic; incremented on every save. Cheap external-change detection.                                                                                                        |
| `recordCount`, `attachmentCount` | uint   | Advisory counts. `attachmentCount` **must** match the actual chunk count, and a reader must reject the file if it does not — that mismatch is how a truncated tail is caught. |

### Key ordering is normative

The header is serialised with keys in **exactly the order shown above**, including inside
`kdf` and `wrappedDek`.

This matters because **the header's raw bytes are the AAD for the body** (§6). The AAD must
be byte-identical on write and on read. An implementation that reorders keys, changes
whitespace, or re-serialises the header before verifying will fail to open vaults written
by a conforming implementation.

**A reader must retain the exact header bytes it read from the file and use those as the
AAD.** Never re-serialise a parsed header to obtain the AAD.

### The header is untrusted input

The header is parsed before anything has been authenticated. A malicious `.keep` can
contain anything at all. Implementations must:

- type-check every field rather than trusting `JSON.parse` to produce the declared shape
- validate that base64 fields really are base64 — many decoders silently drop invalid
  characters, which would turn a corrupted salt into a wrong key reported as "wrong
  password"
- enforce the KDF bounds in §4 **before** running the KDF

---

## 4. Key derivation

**Argon2id**, per RFC 9106.

| Parameter     | Default         | Minimum         | Maximum           |
| ------------- | --------------- | --------------- | ----------------- |
| `memoryKib`   | 65 536 (64 MiB) | 19 456 (19 MiB) | 2 097 152 (2 GiB) |
| `iterations`  | 3               | 2               | 32                |
| `parallelism` | 4               | 1               | 16                |
| `salt`        | 16 random bytes | 16 bytes        | —                 |
| Output length | 32 bytes        |                 |                   |

The minimum is the OWASP recommendation. **The maximum matters as much as the minimum:**
without a ceiling, a hostile file declaring 64 GiB of memory cost turns "open this file"
into a denial of service.

Keyhold calibrates `memoryKib` on first run, targeting roughly 500 ms on the creating
machine, and never chooses less than the shipped default. Because the chosen values are
stored in the header, an old vault keeps opening with its original parameters even after
the defaults rise; parameters change only when the user re-keys.

The output is the **key-encryption key (KEK)**. It never encrypts vault data directly.

---

## 5. Envelope encryption

```
master password ──Argon2id(salt, m, t, p)──►  KEK (32 bytes)
                                                │
                                    AES-256-GCM decrypt
                                                ▼
                                          DEK (32 bytes)
                                                │
                        AES-256-GCM(nonce, gzip(body), header) ──► the vault
```

The body is encrypted with a **random data key (DEK)**, not with the password-derived key.
`wrappedDek` is the DEK encrypted under the KEK, with **no AAD**.

Why the indirection:

1. Changing the master password rewraps 32 bytes rather than re-encrypting the whole
   vault — which also means it cannot half-succeed and lose data.
2. Additional unlock methods (biometric, key file, hardware key) are independent wrappings
   of the same DEK, each revocable on its own.
3. The DEK can be rotated without the user changing anything they must remember.

**Unwrapping the DEK is the only password check.** There is no stored verifier — a
separate verifier would be an oracle, and would be one more thing that could disagree with
the actual key. A failed unwrap means the wrong password (or a tampered `wrappedDek`).

---

## 6. Encryption

**AES-256-GCM**, throughout.

|                 |                                                                    |
| --------------- | ------------------------------------------------------------------ |
| Nonce           | 12 bytes, **freshly generated from a CSPRNG for every encryption** |
| Tag             | 16 bytes, never truncated                                          |
| Body AAD        | the exact plaintext header bytes                                   |
| Chunk AAD       | that chunk's raw 16-byte id                                        |
| Wrapped DEK AAD | none                                                               |

**Nonce reuse under the same key is catastrophic** — it leaks the XOR of two plaintexts
and enables forgery of further messages. An implementation must never derive, count, or
cache a nonce.

### Why the body's AAD is the header

The header must be readable before a key exists, so it cannot be encrypted. Passing it as
AAD means any modification — the KDF parameters, the generation counter, the wrapped key —
breaks the body's authentication tag. That yields integrity without confidentiality, which
is exactly the right property for this data.

### Why each chunk's AAD is its own id

Without it, an attacker able to edit the file could move a valid encrypted attachment onto
a different record's id, and it would decrypt happily. Binding the id makes a relocated
chunk fail authentication.

---

## 7. Compression

The body is **gzip-compressed before encryption**, never after — ciphertext is
incompressible by construction.

Attachment chunks are **not** compressed: most attachments are already-compressed formats
(PNG, PDF, ZIP), where a compression pass costs time and saves nothing.

Readers must cap decompressed output (Keyhold uses 256 MiB) to bound a decompression bomb.

---

## 8. Reading a vault — the required order

1. Verify the magic bytes. Wrong → **not a KEEP file**.
2. Read `formatVersion`. Greater than supported → **refuse**; do not attempt to parse.
   Less than 1 → malformed.
3. Read `headerLength` and the header bytes. **Keep those exact bytes**; they are the AAD.
4. Parse and type-check the header. Reject if `header.formatVersion` disagrees with the
   preamble.
5. Validate the KDF parameters against §4 before running anything.
6. Derive the KEK from the password.
7. Decrypt `wrappedDek` with the KEK. Failure → **wrong password**.
8. Decrypt the body with the DEK, passing the retained header bytes as AAD. Failure →
   **tampered**, not "wrong password" — step 7 already proved the password was right.
9. Decompress the body, bounded.
10. For each chunk: read the id and length, decrypt with the id as AAD.
11. Reject if the chunk count disagrees with `header.attachmentCount`.

**Steps 7 and 8 must be reported differently.** Telling someone their password is wrong
when the file is actually corrupt sends them off retyping a password that was never the
problem.

---

## 9. Versioning and migration

A reader **must refuse** a `formatVersion` higher than it supports, rather than parsing
optimistically. Reading a future format with today's rules risks silently discarding
fields on the next save — which is data loss.

Migration is **forward-only** and operates on the decrypted body, never the file. There is
no downgrade path: "open it in an older version and lose your custom fields" is data loss
too.

---

## 10. Durability requirements

Not part of the byte format, but part of conforming behaviour, because a format that is
correct on disk and lost on crash has failed:

1. Write to a temporary file (`vault.keep.tmp`).
2. `fsync` it.
3. Copy the existing vault to a rolling backup.
4. `rename` the temp over the vault — atomic on NTFS and APFS.
5. `fsync` the containing directory (a no-op on Windows).

A crash at any point leaves a complete, valid vault at some path. An orphaned `.tmp` on
next launch must be **surfaced to the user, never silently deleted** — it may hold the
newest data, and nothing can tell without the password.

---

## 11. The extension family

| Extension                  | Contents                                   | Passphrase                      |
| -------------------------- | ------------------------------------------ | ------------------------------- |
| `.keep`                    | The vault                                  | The master password             |
| `.keepx`                   | A chosen subset, for transfer              | Its own, independent passphrase |
| `.keeptheme`               | An exported theme (plain JSON, no secrets) | —                               |
| `.keepbak` / `.keep.bak.N` | A rolling backup                           | Same as its source vault        |
| `.keep.tmp`                | Transient write staging                    | —                               |

`.keepx` uses the same container format. It is distinguished by its content, not its bytes.

---

## 12. Reference implementation

| Concern                   | File                             |
| ------------------------- | -------------------------------- |
| Constants and types       | `src/shared/format/types.ts`     |
| Container read/write      | `src/main/format/container.ts`   |
| Header parse/serialise    | `src/main/format/header.ts`      |
| Migrations                | `src/main/format/migrations.ts`  |
| Argon2id                  | `src/main/crypto/kdf.ts`         |
| AES-256-GCM               | `src/main/crypto/aead.ts`        |
| Envelope encryption       | `src/main/crypto/envelope.ts`    |
| Atomic writes and backups | `src/main/vault/atomic-write.ts` |

Conformance tests live beside each file. `src/main/format/container.test.ts` covers
truncation at every length, a flipped bit across the whole body, header tampering, chunk
relocation, and a hostile header — a useful checklist for any independent implementation.
