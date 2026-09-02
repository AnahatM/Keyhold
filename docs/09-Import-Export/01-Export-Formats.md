# Export formats

> Four ways out, what each one loses, and why a plaintext export is treated as dangerous.
> Current reference. Implemented by `src/main/export/`.
>
> **Status: the engine is built and tested, and Keyhold's own JSON export re-imports. The
> IPC channel, the export dialog and KDBX are not.** See §8.

---

## 1. A password manager you cannot leave is a trap

That is the whole reason this exists, and it is why the **compatible CSV** is not an
afterthought: it writes Bitwarden's exact eleven columns, and the test that proves it works
runs Keyhold's own `bitwardenCsvParser` over the output rather than eyeballing the header.

| Format           | File     | Loses                                                            |
| ---------------- | -------- | ---------------------------------------------------------------- |
| Keyhold JSON     | `.json`  | Nothing. Round-trips exactly, including history and its origins  |
| Keyhold CSV      | `.csv`   | History, attachments, icons, custom-field types, record identity |
| Compatible CSV   | `.csv`   | The above, plus all dates and trash state                        |
| Encrypted parcel | `.keepx` | Nothing, and it is the only one that is safe to send             |

---

## 2. Every plaintext export is a catastrophe waiting to happen

The engine is shaped around that rather than warning about it in a comment.

**The result type makes the warning unforgettable.** The two results are a discriminated
union on `containsSecrets`, and the readable branch names its payload `secretBytes`, not
`bytes`. A caller cannot reach the bytes without narrowing, and narrowing lands them on an
object whose `warning` is a required, non-nullable string. That is as far as a type system
goes — it cannot force the UI to render it — but nobody writes a plaintext file here without
holding the reason not to.

**The engine writes no files.** Not a rule, a structure: there is no path to default to and
no temp directory to leak into, because the filesystem is entirely the caller's.

**Trashed records are excluded unless `includeTrashed === true`** — an explicit `true`, not
any truthy value — in all four formats, and the exclusion is _itself reported as a loss_, so
the count is visible either way. Exporting someone's deleted records into a file they email
themselves is a real harm.

**A subset export prunes folders and tags** to what the selected records reference, plus
folder ancestors. Shipping the whole tree with a three-record parcel discloses the shape and
names of a vault the recipient was never given. Whole-vault exports keep everything,
including empty folders, so the round-trip guarantee holds.

**Loss messages never carry values**, like the import warnings and the health report. The
guard is a property test that plants a marker in every secret, asserts it appears in the
_bytes_ — so the test cannot pass for the wrong reason — and never in the loss list.

---

## 3. CSV injection is a real vulnerability, and the fix has a real cost

A cell beginning `=`, `+`, `-`, `@`, tab or CR is executed as a formula by Excel and Sheets.
A credential manager that exports `=cmd|'/c calc'!A0` into a spreadsheet has handed someone
a shell.

Every such cell is prefixed with `'`. The cost is the interesting part and is not hidden: a
password of `-hunter2` is written `'-hunter2`, so **a neutralised value is no longer
byte-identical to the vault**. Each neutralised cell is counted per column and reported as
an `altered` loss naming the column and the count, never the value. Verified directly —
`=cmd|'/c calc'!A0` and `-hunter2` come out as `'=cmd|'/c calc'!A0` and `'-hunter2`, with
both columns reported.

Neutralisation happens **before** escaping. A guard added outside the quotes is a subtly
different bug and has its own test.

The JSON export neutralises nothing, because nothing opens JSON as a spreadsheet. And the
guard is a setting — someone piping into a script has a real reason to turn it off.

### The BOM is emitted by default

Without one, Excel on Windows opens UTF-8 as the system ANSI code page and mangles every
non-ASCII character — silent corruption in the file whose entire job is carrying data out.
The cost is that a naive `split(',')` script sees the BOM glued to the first column name, so
it is a setting. Keyhold's own reader strips it, and the round-trip tests run at the default.

Line endings are CRLF, per RFC 4180 and because Excel is the consumer that cares. The reader
takes either.

---

## 4. What the flat formats will not do: invent rows

One row per version, or per URL, would re-import as several near-identical records and
silently multiply the vault. So repeatable values are packed into a single cell in
**Bitwarden's own `label: value` format** — which `parsePackedFields` reads back — and
everything a cell cannot hold is dropped _and named_.

The compatible CSV is exactly Bitwarden's eleven columns and nothing more. Adding `tags` or
`email` would make it more complete and less _accepted_; everything Keyhold has that
Bitwarden does not goes into `fields`, Bitwarden's own extension point. Two mappings worth
flagging: `login_username` takes the email when there is no username (or the imported record
is unusable), and the first `otp-secret` custom field is hoisted into `login_totp` (or every
account gets re-enrolled by hand).

---

## 5. JSON is written field by field, and is deterministic

Never `JSON.stringify(record)`. Key order would otherwise come from whichever file the
document was parsed out of, so the same vault would serialise differently on two machines —
and a future cached or derived field would silently join a plaintext export.

Snapshot keys follow `VERSIONED_FIELDS` and origin keys follow `AUDIT_LEVEL_FIELDS.full`, so
both orders come from the model rather than a second list, with a test asserting the emitted
order matches. Pretty-printed by default: this is the file a user opens to check what they
are about to hand over.

The envelope is a **superset of a vault body**, which is why the encrypted parcel's payload
opens both through `parseKeyholdJson` and through the ordinary `parseVaultDocument` — one
payload shape, two readers, no conversion step. Both are asserted.

Parsing treats the file as hostile, like `format/header.ts`: a `.json` export can be handed
to a user by anyone and, unlike the vault body, has never been through an AEAD before it is
parsed. Errors name the **path** of the bad field and never its value, with a test proving a
bad password field does not appear in the message. `assertValidCredential` and
`assertValidHistory` are the final gate, so the rules about validity stay in the modules
that own them.

---

## 6. The encrypted parcel invents no cryptography

`createVaultKeys` → `newHeader` → `writeContainer`. No second AEAD, no hand-rolled
derivation, nowhere a nonce is chosen. The DEK is destroyed in a `finally`.

Three decisions:

- **`.keepx`, not `.keep`.** It takes an explicit passphrase and an optional record subset,
  which is the glossary's definition of a parcel. A `.keep` "save as" is
  `VaultService.save()` to another path, not an export.
- **The bytes are deliberately non-deterministic** — fresh salt, fresh DEK, fresh nonces per
  call. A byte-deterministic encrypted export would mean nonce reuse under a reused key. The
  test asserts the ciphertexts _differ_ and the decrypted payloads are identical.
- **Attachment chunks are filtered to the selected records.** A three-record parcel must not
  carry the file attached to a fourth; that is a disclosure the sender could not see. Chunks
  the caller could not supply are reported, not dropped quietly.

---

## 7. The round trip closes

`src/main/import/keyhold-json.ts` reads the JSON export back, and it is registered first in
`PARSERS` because its format marker is unambiguous while every other format is inferred from
a column set. It is a thin adapter: the reading and the hardening live beside the writer,
because a reader that drifts from its writer is how a format quietly stops round-tripping.

**Importing an export is not a restore, and the parser says so.** `NewCredentialInput` has
no slot for identity, timestamps or history — `buildCredential` owns all three, and it must,
or an importer becomes a second definition of what a valid record is. So a re-import creates
records with new ids and fresh history, and warns about exactly that. Restoring a vault is
copying the `.keep` file back, which is lossless by construction; this path is for merging
one vault into another. Trashed records are skipped even when the export carried them:
reviving a deletion nobody asked to take back is the kind of surprise that costs trust.

### It is the one strict parser

Every other importer is deliberately lenient — refusing a 3,000-row export over one bad line
is how a user ends up retyping their vault. Keyhold's own format is the opposite case: a
malformed record in a file _we_ wrote means the file is damaged or was hand-edited, and
importing the rest produces a silently incomplete vault that looks complete. The same reader
opens the encrypted parcel, where partial acceptance would be plainly wrong. The parser
contract encodes this as `STRICT_PARSERS`, and still requires the refusal to be a
`VaultError` — an error the IPC layer will pass through rather than scrub — that leaks no
value.

`tests/fixtures/import/keyhold.json` is a committed, byte-exact export. Unlike the other
fixtures it was written by this repo, which is the point: it pins the on-disk format, so a
change to the writer that would stop older exports opening breaks a test rather than a
user's file. `tests/fixtures/` is excluded from Prettier for the same reason — reformatting
a fixture makes it stop being what it claims to be.

---

## 8. Not built

- **The IPC channel (`kh:export:*`) and the export dialog** — including the type-to-confirm
  step, restrictive file permissions, and the shred reminder. All three are caller and
  filesystem concerns, and the engine writing no files is what makes "no plaintext export to
  a default path" structurally true rather than a rule someone has to remember. The engine
  hands the caller everything those need: `containsSecrets`, the mandatory `warning`, and
  the itemised loss list.
- **KDBX 4 export** (roadmap Phase 11) — needs `kdbxweb` plus our WASM Argon2, and
  verification against a real KeePassXC.
- **Bitwarden _JSON_ export.** The compatible CSV covers the leaving-Keyhold path; the JSON
  is a second, richer target and a separate serialiser.
- **The parcel's record chooser**, and deliberately **no advisory expiry**: an expiry nothing
  enforces and nothing checks is a false sense of security, and half of it is worse than
  none.

---

## 9. Tests

89 in `src/main/export/`, 13 in `src/main/import/keyhold-json.test.ts`, plus the shared
parser contract.

**Sixteen fault injections, fifteen caught, and the sixteenth is the interesting one.**
Making `serialiseIcon` assign `value` unconditionally failed _nothing_: `JSON.stringify`
drops keys whose value is `undefined`, so the conditional assignment on the **writing** side
is defence in depth, not the thing keeping the round trip honest. The load-bearing guard is
on the **reading** side — re-injected there, it failed exactly one test, the `'value' in
icon` assertion, which exists precisely because `toEqual` forgives a present-but-`undefined`
key. Both the result and the reason are recorded in the test file's header rather than
quietly fixed.
