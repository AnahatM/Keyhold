# Export formats

> Six ways out, what each one loses, and why a plaintext export is treated as dangerous.
> Current reference. Implemented by `src/main/export/`.
>
> **Status: the engine, the preview and the three `kh:export:*` channels are built and
> tested, Keyhold's own JSON export re-imports, and KDBX 4 export re-imports through
> Keyhold's own KeePass reader.** `ExportDialog` is written and nothing mounts it, so there
> is no user-reachable way to reach the channels yet. See §8 for the channels, §10 for what
> is outstanding, and [`03-KDBX.md`](./03-KDBX.md) for the KeePass format in detail.

---

## 1. A password manager you cannot leave is a trap

That is the whole reason this exists, and it is why the **compatible CSV** is not an
afterthought: it writes Bitwarden's exact eleven columns, and the test that proves it works
runs Keyhold's own `bitwardenCsvParser` over the output rather than eyeballing the header.

| Format           | File     | Encrypted | Loses                                                            |
| ---------------- | -------- | --------- | ---------------------------------------------------------------- |
| Encrypted parcel | `.keepx` | yes       | Nothing                                                          |
| KeePass database | `.kdbx`  | yes       | History, attachments, origins — see [`03-KDBX.md`](./03-KDBX.md) |
| Keyhold JSON     | `.json`  | no        | Nothing. Round-trips exactly, including history and its origins  |
| Keyhold CSV      | `.csv`   | no        | History, attachments, icons, custom-field types, record identity |
| Bitwarden JSON   | `.json`  | no        | History, attachments, origins, security questions                |
| Compatible CSV   | `.csv`   | no        | The above, plus all dates and trash state                        |

**The two encrypted formats are the two that are safe to send.** A parcel is Keyhold talking
to itself and loses nothing; a `.kdbx` goes somewhere else and is what makes "you can leave"
true rather than a slogan.

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
any truthy value — in every format, and the exclusion is _itself reported as a loss_, so
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

## 8. The IPC channel

Three channels, in `src/main/ipc/register.ts`, over the shared names in
`EXPORT_CHANNELS`. What is absent from that list matters more than what is in it.

| Channel             | Does                                                       |
| ------------------- | ---------------------------------------------------------- |
| `kh:export:formats` | Returns the registry. The dropdown has no list of its own. |
| `kh:export:preview` | What this export would cost, computed without writing.     |
| `kh:export:run`     | Opens the save dialog, writes the file, reports where.     |

**No channel returns bytes.** The save dialog opens in the main process, the file is
written in the main process, and the renderer learns only the file name, the directory and
the byte length. A channel that handed the bytes back would put a plaintext copy of the
whole vault in the renderer for as long as the garbage collector felt like keeping it,
which is decision D13's prohibition arrived at from the other direction. It is also why
there is no path anywhere in an `ExportPlan`: a path travelling renderer → main would be
attacker-controlled if the renderer were ever compromised, while a path the user chose in
an OS dialog is a genuine act of consent.

### The confirmation is checked in main

`PLAINTEXT_CONFIRMATION_PHRASE` is matched by `matchesPlaintextConfirmation`, in the
handler, against **the raw text the user typed** — which is why `PlaintextExportPlan`
carries `confirmation: string` and not `confirmed: boolean`. A boolean would make the gate
exactly as strong as the renderer, and the renderer is the part decision D13 declines to
trust. The renderer runs the same matcher, but as an affordance: it greys out a button.
The main process's check is the gate.

A mismatch comes back as `{ status: 'failed', code: 'CONFIRMATION_REQUIRED' }` rather than
as a thrown error, because "that is not the phrase" is something a person can act on and an
`INVALID_REQUEST` is not.

### Two cross-checks a hostile renderer has to get past

1. **The plan's `kind` must agree with the registry** about whether that format is
   encrypted. `kind` is redundant with `format` on purpose, so the two can be compared: a
   plan claiming `plaintext` for the parcel, or `encrypted` for a CSV, is either a bug or an
   attempt to route a readable dump around the confirmation. Both are refused rather than
   guessed at.
2. **`scope.includeTrashed` must be present and boolean.** The engine's `ExportSelection`
   makes it optional so a forgetful caller gets the safe behaviour; at this boundary a
   person is choosing, so an omission is a bug, and silently reading it as `false` would
   export less than was asked for while looking like it worked.

`requireExportPlan` shapes; the handler decides. That split is why an empty confirmation
_parses_ — the handler needs to be able to report it as an outcome the dialog can render.

### Writing the file

`mode: 0o600` on the three readable formats. That file is the vault in the clear, and on a
shared machine the default umask hands it to every other account. It is a no-op on Windows,
where the ACL comes from the directory — which is the other reason the dialog, not this
code, chose the directory. The plaintext buffer is zeroed after the write: it does not
reach the copies V8 may have made, and it does remove the one reference we control.

Cancelling is `{ status: 'cancelled' }`, not a failure. Dismissing a save dialog is the
system working, and reporting it as an error is how people learn to ignore export errors.

The default file name is `keyhold-export-<date><extension>`, with the extension read from
the registry and never written out at the call site. The specific mistake that prevents is
a parcel saved as `.keep` — the one file-name error in this app a person could not recover
from by renaming, because they would then try to open it as their vault.

---

## 9. The preview runs the real export

`previewExport` does the entire export in memory for the three readable formats and throws
the bytes away, zeroing them first.

That is wasteful and it is the point. The loss list the dialog shows is then _literally_
the list the file would carry, produced by the same code on the same records. The promise
this whole feature rests on — "it is impossible to export a CSV and be surprised that
history is gone" — is only true if the two are one computation. A preview that
reimplemented "CSV drops history" in its own words would be right until someone changed
what CSV drops, and would then go on confidently describing the old behaviour with nothing
to catch it.

**The parcel is the one exception.** Sealing it means an Argon2id derivation: a second of
deliberate work for a result that is discarded, and a computation with no bearing on what
is lost. So `parcelPlan` is split out of `exportEncrypted`, both call it, and the only
thing the preview skips is the key.

`ExportPreview.trashedInScope` is reported **whether or not those records would be
written**. "12 records in the Trash are being left out" and "12 will be included" are the
same fact, and the user is owed it in both directions — a dialog that could only say
"excluded" would go silent at the moment the number matters most.

---

## 10. Not built

- **Mounting `ExportDialog`.** The dialog, its steps, the loss list, the passphrase strength
  meter and the type-to-confirm surface are all written and tested against
  `fake-export-gateway.ts`; nothing renders the component, so the three channels above have no
  caller in the running app. The native menu carries a `vault.export` command and
  `src/renderer/src/shell/menu-bridge.ts` routes menu commands into the renderer, but it has
  no case for that one. The import wizard is in exactly the same position — see
  [`02-Import-Service.md`](./02-Import-Service.md) §9.
- **The KDBX interop check.** The format is built in both directions and a vault survives
  export → import through Keyhold's own KeePass reader. What no offline test can prove is that
  **KeePassXC** opens the file, because a round trip passes for any self-consistent
  implementation. That is `MANUAL-BACKLOG.md` M-KDBX-INTEROP, and it is the one outstanding
  thing about this format. KDBX **3** is decided against rather than deferred: its inner
  protection is Salsa20, which Node does not provide.
- **The parcel's record chooser**, and deliberately **no advisory expiry**: an expiry nothing
  enforces and nothing checks is a false sense of security, and half of it is worse than
  none.

---

## 11. Tests

Every serialiser in `src/main/export/`, the preview in `preview.test.ts`, the IPC boundary
in `src/shared/ipc/export-validation.test.ts`, the JSON round trip in
`src/main/import/keyhold-json.test.ts`, and the shared parser contract.

No count is written here on purpose. A total in prose is true on the day it is typed and
silently false a week later, with nothing that fails when it drifts — this page previously
claimed 89 and was wrong by twelve. Run `npx vitest run src/main/export src/shared/ipc` for
the current number; what is worth stating in prose is _what is covered_, which changes only
when someone decides it should.

`preview.test.ts` asserts the one claim the dialog makes: that the preview and the run
agree, for every format in the registry, in both trash directions. Six fault injections,
all six caught — an empty loss list, `trashedInScope` read only one way round, the
discarded plaintext bytes riding along in the result, `unknownIds` zeroed, the parcel
claiming to contain secrets, and an unknown format falling through to "no losses".

`export-validation.test.ts` is written from the other side: every case is a plan a
**compromised renderer** would want to send. A parcel with no passphrase, a `kind` that
disagrees with its format, a `confirmed: true` boolean where the typed phrase belongs, an
absent `includeTrashed`, an unknown format id, an unknown `kind` falling through to
plaintext. Six injections, six caught.

**Sixteen fault injections in the engine, fifteen caught, and the sixteenth is the
interesting one.**
Making `serialiseIcon` assign `value` unconditionally failed _nothing_: `JSON.stringify`
drops keys whose value is `undefined`, so the conditional assignment on the **writing** side
is defence in depth, not the thing keeping the round trip honest. The load-bearing guard is
on the **reading** side — re-injected there, it failed exactly one test, the `'value' in
icon` assertion, which exists precisely because `toEqual` forgives a present-but-`undefined`
key. Both the result and the reason are recorded in the test file's header rather than
quietly fixed.
