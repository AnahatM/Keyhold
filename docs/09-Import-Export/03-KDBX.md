# KDBX 4

> KeePass's own encrypted database, read and written. Implemented by `src/main/kdbx/`,
> `src/main/import-service/kdbx-source.ts` and `src/main/export/kdbx.ts`.
>
> **Version 4 only, and version 3 is decided against rather than deferred** — see §6.
>
> Current reference. The decision behind it is [D32](../12-Roadmap/02-Decision-Log.md); the
> XML reader it leans on is [D31](../12-Roadmap/02-Decision-Log.md).

---

## 1. Why this exists at the top of the list

Decision D11 says nothing here holds anybody hostage. An export nobody else can open would
hold them anyway. `.kdbx` is the format KeePass, KeePassXC, KeePassium, KeeWeb, Strongbox and
every mobile port read, so it is the one that makes "you can leave" true rather than a slogan
— and in the other direction it is how the largest population of self-hosting password users
arrives without first dumping their whole vault to a plaintext file.

The KeePass **CSV** and **XML** exports were already supported and both require the user to
write every password they own to disk in the clear. `.kdbx` needs no plaintext intermediate at
all.

---

## 2. No dependency, and why that was not obvious

This was recorded for months as blocked on installing `kdbxweb`. It was not, and nobody had
checked — the "blocked" label was a guess that outlived the two minutes it would have taken to
test. Every primitive KDBX 4 needs was already here:

| KDBX 4 needs                     | Where it already was                                                |
| -------------------------------- | ------------------------------------------------------------------- |
| Argon2d / Argon2id               | `src/main/crypto/kdf.ts`, over `hash-wasm` — the vault's own KDF    |
| AES-256-CBC                      | Node `crypto`                                                       |
| ChaCha20                         | Node `crypto` — 16-byte IV: 4-byte LE counter, then a 12-byte nonce |
| HMAC-SHA256, SHA-256, SHA-512    | Node `crypto`                                                       |
| AES-256-ECB (the legacy AES-KDF) | Node `crypto`                                                       |
| gzip                             | `node:zlib`, already used by the KEEP container                     |
| The inner XML                    | `src/main/import/xml-reader.ts` (D31)                               |

So the library would have bought a **schema mapping** — the part that has to be written and
tested here whichever way it went — at the price of a third-party parser standing in the path
of an untrusted file.

**This is composition, not invention.** Nothing in `src/main/kdbx/` implements a cipher, a hash
or a KDF. It implements KeePass's framing around them, which is a file format.

---

## 3. The shape of a KDBX 4 file

```
signature1  0x9AA2D903          uint32 LE
signature2  0xB54BFB67          uint32 LE      (0xB54BFB65 is KeePass 1's .kdb)
version     0x00040000          uint32 LE      major = high 16 bits
─── outer header, plaintext ────────────────────────────────────────────────
  id: uint8 · length: uint32 · data                (KDBX 3 used a uint16 length)
  2 CipherID · 3 CompressionFlags · 4 MasterSeed · 7 EncryptionIV
  11 KdfParameters (a VariantDictionary) · 12 PublicCustomData · 0 End
─── authentication ─────────────────────────────────────────────────────────
  SHA-256(header)               32 bytes         unkeyed: catches corruption
  HMAC-SHA256(headerKey,header) 32 bytes         keyed: catches tampering, and IS
                                                 the password check
─── HMAC block stream ──────────────────────────────────────────────────────
  per block: HMAC(blockKey(i), uint64LE(i) ‖ uint32LE(len) ‖ data) · len · data
  a zero-length block terminates, and its HMAC must still verify
─── inside, once decrypted and decompressed ────────────────────────────────
  inner header: 1 InnerRandomStreamID · 2 InnerRandomStreamKey · 3 Binary · 0 End
  then the XML
```

### Keys

```
compositeKey   = SHA-256( SHA-256(utf8(password)) )
transformedKey = KDF(compositeKey)                        Argon2d / Argon2id / AES-KDF
cipherKey      = SHA-256( masterSeed ‖ transformedKey )
hmacKey        = SHA-512( masterSeed ‖ transformedKey ‖ 0x01 )
blockKey(i)    = SHA-512( uint64LE(i) ‖ hmacKey )         header uses i = 2^64 − 1
```

**The composite key is a concatenation of each credential's SHA-256.** With a password alone
that collapses to the double hash above. **Key files and Windows-account credentials are not
supported**, and a database using one fails the header HMAC — indistinguishable from a wrong
password, which is why the wrong-password message says so out loud.

---

## 4. The order the reader works in, which is the security property

1. Parse the outer header.
2. Check its SHA-256. Unkeyed, so it catches corruption and nothing else — anyone editing the
   header can recompute it. It runs first because a damaged file should fail instantly rather
   than after the seconds Argon2 takes.
3. Derive the keys.
4. Check the header's HMAC. **The real check**, and the password check.
5. Read and authenticate every block **before decrypting any of them**.
6. Decrypt, decompress, read the inner header, read the XML.

A reader that decrypted before authenticating would be feeding attacker-chosen ciphertext to a
padding-sensitive CBC decrypt, which is the padding-oracle shape exactly. The CBC path's own
padding error is swallowed for the same reason.

---

## 5. Protected values

Individual values are protected by a **single continuous ChaCha20 keystream consumed in
document order** — the second protected value uses the bytes that follow the first one's.
Getting this wrong produces noise for everything after the first value, and a round-trip test
cannot see it: a reader and writer that both restart per value agree perfectly. There is a
case for it, and the injection is recorded.

The key is `SHA-512(innerStreamKey)`: bytes 0–31 the ChaCha20 key, 32–43 the nonce, counter 0.

Substitution is a **string pass over the raw XML**, not a tree walk, in both directions
(`read.ts` `revealProtectedValues`, `write.ts` `protectValues`). Two reasons: document order is
a property of the byte sequence, and a protected value's content is base64, so it cannot
contain `<`, `>` or `&` and the match cannot be ended early by the data. This is the one place
in the codebase where a regex touches XML, and `xml-reader.ts` exists precisely because that is
otherwise wrong.

On the way in, the `Protected` attribute is **removed** as the plaintext is substituted. Leaving
it would tell `keepass-xml.ts` to skip a value it can now read — a correct decryption that
still loses every password.

---

## 6. KDBX 3 is refused by name

A version-3 database protects its in-XML values with **Salsa20**, which Node does not provide,
and hand-writing a stream cipher is what "never invent cryptography" forbids. Composing a
primitive that ships in the platform is not the same act as implementing one.

So a `.kdbx` that is version 3 is refused with the way out in the sentence: re-save it from
KeePassXC, which writes KDBX 4 by default. **Twofish** and a **KeePass 1 `.kdb`** are refused
the same way — by name, with what to do — because "not a KeePass database" is a lie to somebody
holding a KeePass database.

---

## 7. Import: no KDBX-specific record mapper

A `.kdbx` needs a passphrase, so it cannot be an `ImportParser` — those take a string and
nothing else. It takes the same door as a Keyhold `.keep`, dispatched on the **file signature**
rather than the extension, because a file somebody renamed is still the file it was:

```
kh:importer:openVault  →  readVaultAsImportSource
                              ├── looksLikeKdbx?  →  readKdbxAsImportSource  →  KeePass XML
                              └── otherwise       →  readVaultAsImportSource →  Keyhold JSON
                          then the ordinary path: detect → dry run → duplicates → commit → undo
```

The decrypted XML is handed to **`import/keepass-xml.ts`**, which already reads that schema.
That is D30's shape applied again, and it is the point rather than a shortcut: a second mapping
for the same schema is rule 8's second list, in the place where a disagreement silently loses a
field.

**Attachments are not imported.** A KDBX keeps them in the inner header, where nothing in the
XML mentions them, so `kdbx-source.ts` counts them and appends the count as an XML **comment** —
the one thing `xml-reader.ts` skips, so it cannot be mistaken for data. `keepass-xml.ts` reads
that comment, adds it to any inline `<Binary>` elements it finds, and reports the total.

---

## 8. Export: what KeePass has no room for

| Keyhold                                         | → KeePass                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| title / username / password / first URL / notes | `Title` · `UserName` · `Password` (protected) · `URL` · `Notes` (protected) |
| URLs after the first                            | `URL 2`, `URL 3`, … — KeePass's `URL` is singular                           |
| email                                           | an `Email` field, only when it differs from the username                    |
| custom fields                                   | their own label; protected exactly when `isCustomFieldValueSecret` says so  |
| security questions                              | `Security question: <prompt>`, answer protected                             |
| tags                                            | `<Tags>`, `;`-separated                                                     |
| folders                                         | the group tree, rebuilt from paths                                          |
| **version history**                             | **dropped, reported** — see below                                           |
| **attachments**                                 | **dropped, reported**                                                       |
| **origins**                                     | **dropped, reported** — no field exists for them                            |

**History is the real loss.** KeePass has a `History` element, but it holds whole prior
_entries_ with their own times, while Keyhold's versions record which fields changed and where
the change came from. Synthesising entries would invent timestamps and provenance the vault
never had, and an export that invents data is worse than one that admits a gap.

The writer is deliberately conservative where the reader is generous: **AES-256-CBC**, because
it is what every KeePass build has supported longest and this format exists so somebody can
leave; **Argon2id** rather than KeePass's default Argon2d, because it is what this app already
uses (D14) and one KDF decision is better than two that can drift; and the **KDF cost
parameters are the vault's own**, so a database exported from a vault is never the easier of
the two to attack.

Timestamps are KDBX 4's encoding: base64 of a little-endian uint64 of seconds since
0001-01-01 UTC. **Not** KDBX 3's ISO string, which a KeePass build reading a 4 shows as the
year 1.

---

## 9. Bounds, because every number here came from a file

| Ceiling              | Value  | What it stops                                     |
| -------------------- | ------ | ------------------------------------------------- |
| `MAX_HEADER_FIELD`   | 10 MB  | A header field claiming to be gigabytes           |
| `MAX_BLOCK`          | 16 MB  | One block claiming the same                       |
| `MAX_PAYLOAD`        | 512 MB | The total, and the gzip bomb — enforced _by_ zlib |
| `MAX_KDF_MEMORY`     | 2 GB   | An unlock that exhausts the machine               |
| `MAX_KDF_ITERATIONS` | 1,000  | An unlock that never finishes                     |
| `MAX_AES_KDF_ROUNDS` | 100 M  | The same, on the legacy KDF                       |

Each is checked **before** anything is allocated on the strength of the number, and 64-bit
values stay `bigint` until after the comparison — converting first and checking second is how a
bound gets bypassed by a value that has already lost its precision.

---

## 10. What the tests prove, and what they do not

**Proven offline.** ChaCha20 against RFC 8439's own vectors, with an independent reference
implementation in the test file so the assertion is not Node agreeing with itself. The key
chain recomputed the long way. Byte order asserted against literal bytes. Block reordering,
duplication, truncation and forged terminators all refused. A full write → read round trip, and
a full **vault → `.kdbx` → Keyhold's KeePass importer** loop, where the two halves were written
months apart for different reasons and neither was adjusted to make the other pass.

**Not proven.** That KeePassXC opens these files. Nothing offline can prove it — a round trip
passes for any self-consistent implementation, including a wrong one. The cryptography is
pinned to published vectors, so the gap is not the framing or the key chain; it is the
**schema**: whether KeePass wants these element names, in this nesting, with times in this
encoding.

Until somebody checks, the export screen carries a **Not verified yet** badge on the KDBX
format saying exactly that, and the README and the landing page describe it as untested
rather than as a route off the app.

### The manual check, when there is a KeePassXC to hand

Install KeePassXC (keepassxc.org, or `winget install KeePassXCTeam.KeePassXC`), export a
vault with a few records, at least one folder, at least one custom field and at least one
security question, choosing **KeePass database (KDBX 4)**. Open it with that passphrase and
look at four things — each one is a different layer failing:

1. **Every record is present, in the right group.** The group tree is the part most likely
   to be nested wrongly.
2. **Passwords are hidden in the entry list, not shown as plain text.** That is the
   `Protected="True"` attribute working; if they are visible, the inner stream is not being
   applied to the values it should be.
3. **Created and modified dates look like real dates, not the year 1.** A wrong date means
   the timestamp encoding is KDBX 3's ISO string rather than KDBX 4's base64 uint64.
4. **Custom fields carry their labels, and a secret one is shown as protected.**

Then the other direction: make a small database in KeePassXC with an **attachment** on one
entry, save it as KDBX 4, and import it into Keyhold. The attachment must be reported as not
imported. That path is covered by a test — `writeKdbx` takes a `binaries` injection point so
the suite can build a database with attachments and assert the count — but the test cannot
say whether a KeePassXC-written attachment is shaped the way Keyhold's writer shapes one,
which is the same self-consistency gap as everything else here.

**If KeePassXC refuses the file outright rather than opening it wrongly, that is the better
failure**: it means the framing or the key chain is off, which is the half with the most test
coverage and the easiest to bisect. A file that opens with wrong contents points at
`src/main/export/kdbx.ts` (the schema); a file that will not open points at `src/main/kdbx/`
(the framing).

Three bugs were found by tests rather than by review, and each is recorded where it was fixed:

- **`ByteWriter` wrote into a discarded buffer** on any append that crossed its capacity.
  `this.#view.setUint32(this.#room(4), …)` resolves the receiver before the argument.
- **`ByteReader.bytes` returned a view, not a copy, for a `Buffer`** — `Buffer.prototype.slice`
  overrides the typed-array method. The inner-stream key was a window onto the payload, so
  zeroing the payload zeroed the key and every protected value decrypted to noise, from a file
  that was byte-for-byte correct. Only running the reader and writer together found it.
- **The `otp-secret` type was set twice**, here and in `guessCustomFieldType`. Found by an
  injection that failed nothing, which is a finding rather than a pass.
