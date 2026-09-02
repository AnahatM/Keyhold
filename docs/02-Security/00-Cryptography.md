# Cryptography

> The key hierarchy, why each primitive was chosen, how secrets are handled in memory, and
> the rules that must never be broken. Current reference.
>
> The on-disk encoding is in [`../04-Vault-Format/00-KEEP-Format-Spec.md`](../04-Vault-Format/00-KEEP-Format-Spec.md).
> What this does and does not defend against is in [`../00-Overview/03-Threat-Model.md`](../00-Overview/03-Threat-Model.md).

---

## 1. The one rule

**Never invent cryptography.** Every primitive here is standard, widely analysed, and
boring on purpose. Novel cryptography is how password managers get broken, and a clever
scheme that nobody else has reviewed is a liability regardless of how elegant it looks.

A change to any primitive is a decision-log entry before it is a pull request.

---

## 2. The key hierarchy

```
   master password
         │
         │  Argon2id(salt, memory, iterations, parallelism)  ─── slow, memory-hard
         ▼
   KEK  (32 bytes)   ── key-encryption key. Never stored. Destroyed right after use.
         │
         │  AES-256-GCM unwrap
         ▼
   DEK  (32 bytes)   ── data-encryption key. Random. Stored only in wrapped form.
         │
         ├── AES-256-GCM(nonce, gzip(records), AAD = header bytes)  ── the vault body
         └── AES-256-GCM(nonce, attachment,    AAD = chunk id)      ── one per attachment
```

### Why the DEK exists at all

Deriving a key from the password and encrypting the vault with it directly would be
simpler. Envelope encryption buys three things that are worth the extra concept:

**Changing the master password rewraps 32 bytes.** Not the whole vault. On a large vault
that is the difference between instant and a progress bar — and, far more importantly,
between an atomic operation and one that can fail halfway through and lose data. Goal G1
is "never lose a credential", and a password change that rewrites every byte of the vault
is a data-loss risk taken for no reason.

**Extra unlock methods become additive.** Biometric quick-unlock stores its own
independently wrapped copy of the same DEK in the OS keychain. Revoking it deletes that
copy and touches nothing else. Key files (backlog A3), hardware keys (D1) and the recovery
kit (A4) all use the identical shape, with no format change.

**The DEK can be rotated** without the user changing anything they have to remember.

---

## 3. Primitives

### Argon2id — key derivation

The current password-hashing standard (RFC 9106). Memory-hard, so cracking costs the
memory budget _per guess_ — which is what makes GPUs and ASICs, with their enormous
parallelism but comparatively little fast memory per core, far less effective than they
are against PBKDF2 or bcrypt.

| Parameter   | Default         | Floor          | Ceiling |
| ----------- | --------------- | -------------- | ------- |
| memory      | 64 MiB          | 19 MiB (OWASP) | 2 GiB   |
| iterations  | 3               | 2              | 32      |
| parallelism | 4               | 1              | 16      |
| salt        | 16 random bytes | 16 bytes       | —       |

**Both bounds matter, for different reasons.** The floor stops a downgraded header from
silently making a vault trivially crackable while still opening normally. The ceiling stops
a hostile `.keep` declaring 64 GiB of memory cost from turning "open this file" into a
denial of service. The header is plaintext in a file anyone can hand you; it is validated
before it is used.

**Calibration.** Parameters are measured on first run, targeting roughly 500 ms, and are
never chosen below the shipped default — on a fast machine the search can hit the target
early, and accepting that would mean a powerful computer produces a _weaker_ vault than a
slow one, which is exactly backwards. There is a guard test for precisely this.

Because the chosen values live in the header, an old vault keeps opening with its original
parameters even after the defaults rise. They change only when the user re-keys.

**Implementation:** `hash-wasm`, pure WebAssembly (decision D14). A native binding would
be somewhat faster but would add a compiled artefact per platform to every build — and the
same WASM implementation also serves the KDBX importer, which requires an Argon2 supplied
from outside.

### AES-256-GCM — encryption

An AEAD: encryption and authentication in one primitive. A modified ciphertext fails
loudly instead of decrypting to plausible garbage. That property is what lets Keyhold say
"this file has been tampered with" rather than silently loading corrupted records.
Hardware-accelerated on every CPU the app targets.

**Nonces are 12 bytes, generated fresh from the CSPRNG for every single encryption.**
Nonce reuse under one key is catastrophic in GCM — it leaks the XOR of two plaintexts and
enables forgery of further messages. There is deliberately **no API that accepts a
caller-supplied nonce for encryption**; the only way to encrypt is to let the module
generate one.

**Tags are the full 16 bytes.** Truncating makes forgery cheaper for no real saving.

### The AAD bindings

| What is encrypted   | AAD                              | What that prevents                                                                                                                                                                     |
| ------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The vault body      | the exact plaintext header bytes | Editing the KDF parameters, generation counter or wrapped key. The header must be readable before a key exists, so it cannot be encrypted; AAD gives integrity without confidentiality |
| An attachment chunk | that chunk's raw 16-byte id      | Relocating a valid encrypted attachment onto a different record's id, which would otherwise decrypt happily                                                                            |
| The wrapped DEK     | none                             | —                                                                                                                                                                                      |

**The AAD must be byte-identical on write and on read.** The header is therefore serialised
with an explicit, fixed key order rather than relying on object-literal iteration order,
and a reader retains the exact bytes it read rather than re-serialising a parsed header. A
refactor that reordered those keys would break every existing vault, so the ordering is
asserted by a test.

### gzip — compression

Applied **before** encryption, never after; ciphertext is incompressible by construction.
Attachment chunks are not compressed, because most attachments are already-compressed
formats where a compression pass costs time and saves nothing.

Decompression is bounded at 256 MiB to cap a decompression bomb.

CRIME-style compression oracles do not apply here: there is no channel in which an
attacker supplies chosen plaintext that is compressed together with a secret and whose
length they can observe.

### CSPRNG — randomness

`crypto.randomBytes`, for everything: salts, nonces, data keys, generated passwords, chunk
ids, vault ids.

**`Math.random()` is banned project-wide by lint.** There is no legitimate use for it in
this codebase, so it is a hard error rather than a review discussion, and
`src/main/crypto/random.ts` exists so the rule has an obvious destination.

`randomInt` uses **rejection sampling**, not modulo. Modulo is biased whenever the range
does not divide the generator's output evenly, and for the password generator that bias is
not academic — over a 62-character alphabet it makes some characters measurably likelier,
shrinking the real search space. There is a statistical test for it.

---

## 4. Secrets in memory

`SecretBytes` (`src/main/crypto/secret.ts`) wraps every key.

**Its primary job is redaction, not zeroing.** A raw `Buffer` holding a key is one careless
`console.log`, one `JSON.stringify` of a config object, or one thrown error away from being
written somewhere it can never be taken back from. Every one of those paths goes through
`toString`, `toJSON`, or `util.inspect` — so all three are overridden to return
`[SecretBytes: redacted]`. There is a test asserting each path.

**Zeroing on `destroy()` is secondary and honestly limited.** It shortens the window in
which a key sits in a page that might be swapped or captured in a core dump. It is a real
improvement, not a guarantee: V8 copies buffers, and Node exposes no `mlock`. The threat
model states plainly that memory is not defended while the vault is unlocked, and this
document does not claim otherwise.

Other properties, each for a reason:

- **`use(fn)` rather than a `.bytes` getter.** Reading `secret.bytes` looks harmless at a
  call site; `secret.use(...)` reads as "raw key material is being handled here" and shows
  up in a review.
- **`destroy()` is idempotent**, so `finally { key.destroy() }` can never itself throw.
- **Use after destroy throws** rather than returning stale bytes.
- **`equals` is constant-time**, so comparing derived values cannot leak how many leading
  bytes matched.

The KEK is destroyed immediately after unwrapping the DEK. Keeping a password-derived key
alive for a whole session buys nothing and widens the window in which it can be read.

---

## 5. Reporting failures

Two rules, both load-bearing:

**An error message never contains secret material.** No key, no password, no plaintext, no
full filesystem path. Errors get logged, screenshotted, and pasted into bug reports;
anything in one is effectively public. There is a test asserting the password does not
appear in a failed-unlock error.

**"Wrong password" and "tampered" are distinct codes, from the same mechanism.** Both are
produced only after a real authenticated decryption fails — the password is never tested
separately, because a separate verifier would be an oracle. The distinction is inferred
from _where_ in the read sequence the failure happened:

- The wrapped DEK fails to unwrap → `WRONG_PASSWORD`.
- The DEK unwrapped, but the body fails → `TAMPERED`. The password was demonstrably
  correct, so the file has changed.

That distinction is a UX affordance, not a cryptographic statement — but it matters:
telling someone their password is wrong when the file is actually corrupt sends them off
retyping a password that was never the problem.

---

## 6. What is tested

`src/main/crypto/crypto.test.ts` and `src/main/format/container.test.ts`, 77 tests:

- round trips, and determinism of derivation
- a distinct nonce across 200 encryptions
- a flipped bit detected in ciphertext, tag, nonce, and AAD independently
- **truncation at every length** of a real vault
- **a flipped bit sampled across the whole body**, each detected
- header tampering caught via the AAD binding, with the length kept identical so only the
  binding can catch it
- chunk relocation rejected
- KDF bounds: downgraded, absurd, non-integer, short salt, unknown algorithm
- calibration never returning weaker than the default
- redaction through `String`, template interpolation, and `JSON.stringify` of both an
  object and an array
- statistical bias in `randomInt` across 60 000 samples
- password change preserving the DEK, invalidating the old password, and leaving the
  original wrapping untouched
- multiple independent wrappings of one DEK, with revocation of one not affecting the other

`src/main/vault/atomic-write.test.ts` adds 19 covering durability: interrupted writes,
orphaned temp files, backup rotation, and the guarantee that a failed save consumes no
backup slot.

Fault injections performed and recorded in
[`../11-Development/01-Testing-Policy.md`](../11-Development/01-Testing-Policy.md).
