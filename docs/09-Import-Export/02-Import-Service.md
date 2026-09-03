# The import service

> The transaction between a parser and a vault: holding the chosen file, the dry run, the
> duplicate rule, the commit, the undo, and the destruction of everything that was held.
> Current reference. Implemented by `src/main/import-service/`, the `kh:import:*` handlers in
> `src/main/ipc/register.ts`, and the shared contract in `src/shared/model/import-plan.ts`.
>
> **Status: the service, the six `kh:import:*` channels and the progress event are built,
> registered and tested, and the wizard is bound to them through `ipc-gateway.ts`. Nothing
> mounts `ImportWizard`.** The path exists end to end and has no entry point in the running
> app. The native menu declares `vault.import` and `menu-bridge.ts` now routes menu commands
> into the renderer, but it has no case for that one — it falls through to the bridge's
> "no handler" warning. See §9.

---

## 1. Why a service exists between the parsers and the vault

The two halves of import were built to be uninteresting on their own, and both succeed at
that. A parser in `src/main/import/` is a pure function from a string to
`ImportResult` — drafts, folder paths, warnings — and knows nothing about a vault. The wizard
in `src/renderer/src/import/` is a state machine over a gateway interface and knows nothing
about a file. Neither can be given the other's job without ruining the property that makes it
testable.

What sits between them is the part with the consequences. It is the only code in the app that
holds a plaintext dump of somebody's entire password vault in memory; it is the only write
that can add three thousand records and a folder tree in one act; and it is the only
operation the user is offered a way to take back. `ImportService` is that middle, and it is a
class rather than a sequence of handlers because all three of those facts are about **state
held between IPC calls** — the file between `chooseFile` and `preview`, the parse between
`preview` and `commit`, the pre-merge snapshots between `commit` and `undo`.

---

## 2. Four properties, and where each one is enforced

These are the claims the wizard's screens rest on. Each is structural — a shape the renderer
cannot express — rather than a rule some handler is trusted to apply.

| Property                              | Enforced by                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A preview cannot commit**           | `preview` mints an `ImportPlanId`; `commit` accepts that id plus the user's decisions and nothing else. `ImportCommitRequest` carries no records |
| **The preview runs the commit**       | One parse, held in `plan.ts`, projected for the screen and re-used for the write. There is only one of them, so the two cannot disagree          |
| **Nothing secret crosses**            | Every value that leaves the service goes through the shared `previewRecord`. The parse itself lives in `HeldImportPlan.secretRecords`            |
| **A cancelled import leaves nothing** | `discard` zeroes the bytes and drops every parse derived from them                                                                               |

The first is worth restating in the negative, because it is the one a reader is most likely
to assume is merely conventional. There is **no shape the renderer can hand to `commit` that
describes data.** It cannot supply records, a mapping, or a format id — only a pointer at a
parse this process already performed and is still holding. A compromised renderer replaying a
stale plan id therefore commits the parse the user already saw, or is refused; it cannot
smuggle a record of its own into the vault through the import path.

The plausible alternative fails all four. Re-parsing at commit time from a path the renderer
names is simpler and holds less memory, and between the two parses the file can change on
disk, the mapping can be edited and the format can be re-detected — so the records committed
are not the records approved. A dry run that can disagree with the run is decoration.

---

## 3. What is held, and for how long

| Held       | Contains                                          | Dropped by                              |
| ---------- | ------------------------------------------------- | --------------------------------------- |
| The source | the file's bytes, in a `SecretBytes`              | `discard`, which zeroes them            |
| The plan   | one parse: every password in the file             | `discard`, `commit`, or a newer preview |
| The batch  | pre-merge copies of records the vault already had | `undo`, or eviction past the batch cap  |

**The bytes live in a `SecretBytes`, not a `Buffer`.** `SecretBytes` overrides `toString`,
`toJSON` and `util.inspect`, so a stray log line or a `JSON.stringify` of a state object
prints `[SecretBytes: redacted]` rather than a thousand passwords, and `destroy()` overwrites
the page rather than merely dropping the reference.

**The decoded text is never retained.** A JavaScript string is immutable and cannot be zeroed,
so a held `string` copy of the file would be a second plaintext dump that `discard` is
structurally unable to destroy. `HeldSource.readSecretText` decodes on demand and hands the
result to its caller, which drops it as soon as the parse is done: one transient copy per
parse, collectable immediately, rather than one permanent copy for the life of the wizard.
That asymmetry is the point — **the shape that can be destroyed is the shape that lives.**

**Exactly one plan is kept per source.** A second preview of the same file supersedes the
first rather than sitting beside it, so the number of plaintext parses this process holds is
bounded by the number of files the user has open, which is one.

**Committed batches deliberately survive a `discard`.** The wizard closes its file the moment
the import lands and offers "undo" immediately afterwards; dropping the batch at that point
would withdraw the offer at the exact moment it is made. `discardAll` — registered as a lock
observer in `register.ts`, so nothing has to remember to call it — drops them too, because an
undo means nothing against a vault whose key has just been destroyed, and a batch's snapshots
are records out of that vault.

The batch cap (`MAX_UNDOABLE_BATCHES`) is small and evicts oldest-first. A batch holds full
copies — passwords included — of every vault record a merge touched, so the retained plaintext
is bounded by a constant rather than by how many imports someone has run today. It is
deliberately not one, so that a user who imports two files back to back can still take back
the first.

---

## 4. The duplicate rule: title + login identity + host

Stated once, in `@shared/model/import-plan.ts`, so the main process's matcher and the
wizard's explanation of a match are the same function. All three components are non-secret,
which is what lets the rule live in shared code at all.

- **Title**, trimmed, case-folded, internal whitespace collapsed. `"Google"` and `"google "`
  in two exports of the same account are not two accounts.
- **Login identity** — the username, or the email when there is no username. Username first
  because that is what the source stored; the parsers already mirror an email-shaped username
  into `email`, so preferring `email` would collapse two accounts whose usernames merely share
  a mailbox.
- **Host** of the first URL that yields one, `www.` stripped, with `android://<hash>@package`
  reduced to the package name — the certificate digest varies by build, so matching the whole
  string would make every app login unique to its exporter.

Any smaller key over-matches somewhere that costs the user data. Title alone turns five Google
accounts into one. Identity alone collapses forty sites that share one email address. Host
alone collapses a household. Title + host still merges the five Google accounts; identity +
host still merges a personal and a work login on one mailbox. The triple is the smallest key
that gets the case the wizard exists for exactly right — **importing the same file twice must
not produce two of everything** — while leaving genuinely distinct accounts distinct.

Two limits are stated rather than hidden. A record with neither an identity nor a host
degrades to a title-only key, which is deliberate: re-importing a file of title-and-password
rows must still be caught, and the cost of a false positive is bounded because the default
action is `skip` and every group is shown for the user to override. And a vault record with
username `alice` and email `alice@x.com` will not match an imported record whose only
identifier is `alice@x.com`; those become two records, which is the **safe** failure — an
extra row the user can merge, rather than one lost silently to a false match.

Trashed records are never match candidates. A record the user deleted must not silently
absorb an import.

---

## 5. What "merge" means, and why the policy is asymmetric

`merge.ts` owns the dangerous answer of the three, and it is written as **a single function
returning both the patch and the description of the patch**, because those two must not be
able to disagree. The review screen's "this would replace the password" and the write that
then replaces the password are the same computation, run twice, with the second run's result
actually applied. A separate "describe what a merge would do" routine is exactly the thing
that drifts, and the field it drifts on first is the password.

| Field family                                          | Effect                                                                                                    |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Single-valued text — password, username, email, notes | `fills-empty` when the vault's is empty; `replaces` when both are present and differ; otherwise unchanged |
| Set-valued — urls, tags, custom fields                | `adds` only. Never subtractive                                                                            |
| Folder                                                | `fills-empty` only, and **never** `replaces`                                                              |

`replaces` is the one genuinely destructive effect this whole screen can produce, which is why
`ImportMergeEffect` names it separately and why the wizard warns specifically when the field
is `password`.

**Set-valued fields are additive because an export's omission is not the user's intent.** A
merge that removed a URL the user had would be deleting data on the strength of a file that
omits things for reasons of its own.

**Folder is the asymmetric one, and the asymmetry is the interesting part.** Filing is a
decision the user made _in this vault_; an import from another product's tree has no standing
to overrule it, and unlike a password the previous location is not recoverable from the record
itself. So a merge can put a loose record into a folder and cannot move one out of the folder
its owner chose.

Effects that come out `unchanged` are not emitted at all — a list of eight rows saying
"nothing" would bury the one row that matters. And `extraTags` from the commit request
deliberately never reach a merge: they apply to _imported_ records, and a merged record is one
the user already had, so stamping it with an `imported-2026-09` tag would be an edit nobody
asked for.

---

## 6. The commit is a pure function, and nothing is aborted over one bad row

Everything written goes through the operations that already own these rules — `buildCredential`
for a record, `findOrCreateFolderPaths` for a folder, `ensureTags` for a tag, `applyPatch` plus
`appendVersion` for an edit. None of it is assembled in `commit.ts`. That is not tidiness: an
import that constructed records itself would be a **second definition of what a valid record
is**, and the two would drift on the day someone adds a field. The parsers produce
`NewCredentialInput` for exactly this reason, and this module is where that promise is kept.

Nothing here touches a key, a file or a clock it was not handed. The caller installs the
returned document and saves it. The rules about what an import does to a vault are the part
most likely to acquire a subtle bug, and keeping them free of I/O is what lets each of them be
tested directly rather than through an unlocked vault.

**A record the vault refuses becomes a warning and a skip, not an exception.** Refusing a
three-thousand-record export over one bad row is how a user ends up retyping their vault by
hand. The warning names the record's _position_ and nothing else, because the reason a record
was refused is built from the value that broke the rule, and that value is a password as often
as not.

**The counts add up.** `importedCount + skippedCount + mergedCount === plan.recordCount`,
always. It is the one arithmetic a user can check against the preview they approved, and the
renderer's own summary in `duplicate-decisions.ts` predicts it independently — two
calculations a test can hold against each other.

Folders are created for what the import **actually needs**, which is narrower than what the
file mentions: a folder whose every record the user chose to skip would otherwise appear in
their sidebar, empty, as the only trace of an import they were told changed nothing.

---

## 7. Undo, and the three-part guard that licenses it

An import that cannot be undone is one people are afraid to run, and a password manager whose
migration step is frightening is one nobody migrates to. But the offer has to be real: an
"undo" that half-works, or that removes a record the user edited in the meantime, is worse
than no offer, because they will have believed it.

Undo removes records **by id**. That description is only safe while the vault is in exactly
the state the commit left it in, so `undo` refuses unless **all three** hold:

1. the caller's `expectedVaultGeneration` equals the vault's current generation;
2. this batch's own recorded generation equals it too;
3. the vault has **no unsaved changes**.

The third is not redundant, and it is the one a generation-only check would miss. A generation
moves on a _save_. A user who edited an imported record and has not saved yet has not moved
the generation at all — so a two-part check would let the undo run and silently take that edit
with it, while claiming it was only removing what the import added.

That guard is what licenses the two otherwise-alarming things `undo.ts` does: it calls
**`purgeCredential`, not `trashCredential`** — an imported record was never the user's data,
and leaving three thousand of them in the Trash to be found later is not undoing anything —
and it **restores a merged record wholesale from a snapshot**, which would clobber a
concurrent edit if a concurrent edit were possible.

It is still defensive on top of that. A created folder that somehow holds a record or a child
folder is left standing and left out of the result, and a created tag still carried by a record
is kept. The guard should make all three impossible; "should" is not the standard for the code
path whose entire job is not losing data.

Undo is single-use — the batch is deleted on success. A second undo of the same batch would be
a no-op at best and, once the ids had been reused by something else, a removal of records that
are not ours.

---

## 8. The IPC surface

Six channels in `IMPORT_CHANNELS`, spread into `CHANNELS` in `src/shared/ipc/api.ts` so the
main process's allow-list and the preload bridge both read the one list, plus one pushed event.
What is absent from the list matters as much as what is on it.

| Channel                 | Does                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `kh:import:formats`     | Returns the registry as descriptors. Never a parser, and the dropdown has no list of its own |
| `kh:import:choose-file` | Opens the native dialog, reads the file, detects the format, holds the bytes here            |
| `kh:import:preview`     | The dry run. Writes nothing, and mints the plan id a commit requires                         |
| `kh:import:commit`      | Applies a held plan under the user's per-group decisions, then saves                         |
| `kh:import:undo`        | Takes a committed batch back, under the guard in §7                                          |
| `kh:import:discard`     | Destroys the held file and every parse of it                                                 |

`kh:event:import-progress` is main → renderer, so it lives in `EVENTS` rather than `CHANNELS`.
It is fire-and-forget to whichever window exists: a progress tick that cannot be delivered is
not worth failing an import over. The four phases are `parsing`, `matching`, `writing` and
`saving`, and each is determinate, for the same reason the Argon2 unlock is — a still bar is
indistinguishable from a hang.

**No channel accepts a path, and no channel returns file content.** The dialog is opened by the
main process, exactly as `chooseVaultToOpen` is, and for a reason that matters more here rather
than less: a path the renderer supplied would be attacker-controlled if the renderer were ever
compromised, and this path is handed to `readFile` in the process that holds the master key. A
path the user picked in an OS dialog is a genuine act of consent, and the OS — not Keyhold —
decides what they were allowed to reach. The path is read and **never returned**; what comes
back is a basename and an opaque id. The directory is of no use to the wizard and is precisely
the sort of thing that ends up in a screenshot attached to a bug report.

### What the boundary checks, and what it deliberately does not

`register.ts` shapes every request — ids against the id pattern, `sampleSize` as an index,
`expectedVaultGeneration` through `requireGeneration` rather than `requireIndex`, because a
generation counts saves over the life of a vault and passes ten thousand.

`duplicateActions` is the deliberate exception: its **shape** is checked and its **values** are
not. The service narrows every entry to one of the three real actions and falls back to
`DEFAULT_DUPLICATE_ACTION`, which is `skip` — so a partial or malformed map imports nothing
rather than importing duplicates. Refusing at the boundary instead would mean a renderer bug
presents to the user as "your file is bad".

### The refusal codes are named, and two of them are load-bearing

`IMPORT_ERROR_CODES` lives beside the channels that carry it, because both sides need the same
strings and rule 8 says they get them from one list. They were briefly declared twice, once on
each side of the process boundary, with a test that read one file as _text_ and compared it
against the other — a guard doing the job a shared constant does for free, and one that only
works while somebody remembers to keep it pointed at the right file.

| Code                      | Means                                                                     |
| ------------------------- | ------------------------------------------------------------------------- |
| `import/stale-plan`       | The plan was discarded, superseded, or never minted here. Re-preview      |
| `import/stale-undo`       | The vault moved on since the commit. The offer is withdrawn, not retried  |
| `import/unknown-format`   | No parser in the registry carries that id                                 |
| `import/mapping-required` | A `needsMapping` format was previewed without one                         |
| `import/file-too-large`   | Larger than any credential export plausibly is                            |
| `import/unreadable-file`  | The parser refused it outright — an encrypted export, or JSON that is not |

The wizard reacts to the first two **by name** rather than by message, because "run the preview
again" and "the vault moved on" are specific answers a generic error box cannot give.

These are deliberately not `VaultError`s. Every code in that enum means _this file is damaged,
hostile, or from the future_, and saying that because a preview went stale would be a lie told
on the one screen where the user is already nervous about their whole vault.

**No message here carries a value out of the file being imported.** That file is a plaintext
dump of somebody's entire vault, and these messages are shown on screen, written into the
import report and pasted into bug reports. `unreadableFile` in particular does not carry the
parser's own message through: a failure deep inside `JSON.parse` produces
`Unexpected token p in JSON at position 41`, and the bytes around position 41 are somebody's
password. The user is told which file and which format — both of which they chose — and nothing
that came out of the file.

---

## 9. Not built yet

- **A way in.** `ImportWizard` is mounted by nothing.
  `src/renderer/src/import/index.ts` documents the three lines that mount it. The native menu
  carries a `vault.import` command and `src/renderer/src/shell/menu-bridge.ts` routes menu
  commands into the renderer's stores — but it handles the four tool views, the palette and
  the shortcut sheet, and `vault.import` reaches its `default` branch and is logged as
  unhandled. Import is not a tool view: it is a modal over the vault screen, not a region of
  the shell, so the tool-view table does not reach it. Export is in exactly the same position.
- **The activity-log entry.** An import is the largest single write the app performs and it
  does not appear in the vault activity log. `ACTIVITY_KINDS` in `@shared/model/activity.ts`
  already declares an `import` kind and nothing in `src/main/import-service/` writes one;
  `ImportCommitResult` already carries the counts such an entry would need.
- **Formats the parsers do not cover**, and therefore the service cannot import: KDBX 3/4,
  KeePass XML, 1PUX, Proton Pass, Enpass, Keeper, RoboForm and Dashlane JSON. See
  [`00-Import-Formats.md`](./00-Import-Formats.md) §6.
- **`isSingleValued` in `src/main/import/generic-csv.ts`** still restates what
  `SINGLE_VALUED_IMPORT_TARGETS` declares. Re-pointing it is a rule 8 fix recorded beside the
  constant.

---

## 10. Tests

`import-service.test.ts`, `plan.test.ts`, `merge.test.ts`, `source-store.test.ts` and
`error-codes.test.ts` in `src/main/import-service/`, plus `wizard-machine.test.ts`,
`duplicate-decisions.test.ts` and `ImportWizard.test.tsx` on the renderer side.

No total is written here on purpose — a count in prose is true the day it is typed and silently
false a week later, with nothing that fails when it drifts. Run
`npx vitest run src/main/import-service src/renderer/src/import` for the current number. What
is worth stating is _what is covered_, which changes only when someone decides it should:

- The plan/commit identity — that a commit writes the parse the preview projected, and that a
  stale, superseded or discarded plan id is refused.
- The duplicate rule at each of its edges: the five-Google case, the shared-mailbox case, the
  title-only degradation, and trashed records never matching.
- Every merge effect, in both directions, including the folder asymmetry and the
  `unchanged`-is-not-emitted rule.
- The count identity, and the renderer's independent prediction of it.
- The undo guard, one refusal per part of it, and the two protective refusals inside
  `undo.ts`.
- That `discard` destroys the bytes rather than dereferencing them, and that a plan whose
  source has been discarded cannot commit.
- That no message, warning or projection carries a value out of the imported file.

`ImportWizard.test.tsx` covers the property `discard` exists for: **there is no path out of
that component that does not call it**, unmount included.

---

## 11. Related

- [`00-Import-Formats.md`](./00-Import-Formats.md) — the parsers this service consumes, and the column mappings
- [`01-Export-Formats.md`](./01-Export-Formats.md) — the way back out, and §7 for the round trip that closes through `keyhold-json`
- [`../01-Architecture/01-IPC-Surface.md`](../01-Architecture/01-IPC-Surface.md) — the contract these six channels are part of
- [`../03-Data-Model/00-Credential-Model.md`](../03-Data-Model/00-Credential-Model.md) — `buildCredential`, which owns identity, timestamps and history
- [`../12-Roadmap/02-Decision-Log.md`](../12-Roadmap/02-Decision-Log.md) — D24, the merge policy and the undo guard
