# Recovery and diagnostics

> How far a `.keep` parses without a password, which of the copies beside it is the best one,
> what is still wrong after it opens, and a shareable report that carries no user content.
> Current reference. Implemented by `src/main/recovery/` and `src/shared/model/recovery.ts`.
>
> **Status: every analysis is built and tested — 140 tests. Nothing a user can reach
> exists.** There is no `kh:recovery:*` channel in `CHANNELS`, no diagnostics screen, and no
> caller that lists a directory and feeds it in. There is also, deliberately and permanently,
> **no code anywhere that executes a repair plan.** See §9.

---

## 1. It reports, and it never repairs

That is the decision the whole module is built around, and it is not caution — it is that
every repair here is one line, and that is precisely the trap.

Corruption has causes: a crash mid-write, a merge that resolved badly, a disk that is
failing, a partial restore, an import that committed early, a bug in an older build.
"This record's folder is missing" is at least three different events, and they want three
different responses. Reassigning a duplicate id, clearing a history array, dropping a
dangling attachment — each takes a moment, and each **destroys the evidence of which cause
produced the state**. After a silent fix the three are indistinguishable.

It is also the only way an undo can mean anything. A user who was asked, and who was told the
price, can decide the price is too high.

So `RepairPlan` describes proposals and there is deliberately **no function anywhere that
takes one and executes it**. `src/main/organisation/integrity.ts` and
`src/main/attachments/audit.ts` already follow the same rule; this module is the third
instance of it rather than an exception to it.

The one thing a caller may safely conclude from a clean report is that the folder walks in
`folder-tree.ts` will terminate for a reason other than their cycle guards.

---

## 2. An AEAD failure has no partial credit, and the plan says so out loud

Every plan carries a standing `unrecoverable` statement, whether or not anything is wrong:

> If the vault reports an authentication failure, either the bytes are wrong or the password
> is wrong, and nothing in the file can say which. There is no partial decryption of an
> authenticated region: AES-256-GCM returns the whole plaintext or nothing at all.

That exists so a plan cannot imply a salvage that does not exist. There is no brute force and
no "recover what we can", because neither is a thing — and a hopeful progress bar over a
sealed region is worse than a sentence saying plainly that the route does not exist.

Three further statements are appended when the findings warrant them:

| Triggered by                                       | What it says cannot be recovered                                                                                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `body-truncated`, `body-length-implausible`        | The missing part of the body cannot be reconstructed from this file, and the bytes that are here will not authenticate without it. Another copy is the only route |
| `header-truncated`, `header-unreadable`            | Without a readable header there are no KDF parameters and no wrapped data key. The correct password cannot derive a key the file does not describe                |
| `chunk-framing-broken`, `chunk-count-disagreement` | Attachments past the break are not in this file; the records before them are unaffected                                                                           |
| `missing-chunk` (attachments)                      | Detaching the metadata tidies the record; it does not bring the file back                                                                                         |

---

## 3. The report keeps a basename and never a directory

A diagnostic report is written to be pasted into a bug report. It is therefore bound by a
rule **stricter** than the safe projection's:

> **Ids, counts, byte offsets and timestamps only. Never a user-authored string.**

Not a password, a note body, a security answer or an attachment byte — and also not a record
title, not a folder name, not a tag name, and no filename beyond a basename. The safe
projection carries titles because the renderer must draw them; a report would carry them
because someone forgot, and then a titled list of somebody's accounts lands in a public issue
tracker.

A home directory is a person's real name often enough to matter, so `SurveyedFile` carries a
`name` and **has no path field at all**. The caller supplied the listing, so it can rejoin on
the name; the survey structurally cannot leak a directory. `buildRecoveryReport` takes
`vaultPath` and keeps only `basename(vaultPath)`. `readKeepThemeFile`'s sibling reasoning
applies to error strings too: an OS error carries the absolute path, so it is never echoed.

Every upstream analysis already refuses to produce a user string, and this module adds no new
source of one:

- `document-diagnosis.ts` drops the organisation checker's `name` field and withholds the
  record validator's message, because that message names the offending field **by its label**
  and a label is the user's own text.
- `file-inspection.ts` reports the salt and the wrapped data key as byte **lengths**. The
  salt is not secret in the cryptographic sense — it is plaintext in a file anyone holding
  the file can read — but it is key material, and key material has no business in a document
  written to be shared. "The salt is 4 bytes when it must be at least 16" is still a real
  finding.
- `text.ts` bounds a borrowed message at 200 characters and redacts unknown quoted tokens.

`report.test.ts` proves it: a fixture in which **every** user-authored string, name, title and
directory path carries one marker, swept over the serialised result. One token searched for
once, rather than a list of forbidden words, so the assertion cannot rot as fields are added.

### The three borrowed messages, and why each is safe

Only three messages from other layers are ever repeated. `parseHeader`'s quotes our own field
names and, twice, an algorithm identifier read from a header that is plaintext by design.
`assertUsableKdfParams`'s quotes numbers and an algorithm name. `assertValidHistory`'s quotes
a record id, a version number and a field name — **except** for one case, an unexpected
snapshot key, which in the corrupt vault this module exists to describe could be any string at
all, possibly a fragment of a decrypted note. `redactUnknownFields` replaces exactly that,
keeping the named invariant rather than throwing the whole message away.

The 200-character cap is a backstop, not the defence. A truncated secret is still a secret,
so nothing relies on it; it exists so a pathological file cannot turn one finding into a page
of text.

---

## 4. Walking a file as far as it goes, without a password

`inspectVaultFile(bytes)` is deliberately **not** `readContainer`. The reader's job is to
refuse: the first thing wrong is a thrown `VaultError` and nothing after it is examined,
which is correct, because continuing to read a damaged container is how a truncated vault
gets half-loaded and then saved over.

This walk does the opposite. It reads as far as it can, notes every finding, and reports the
boundary in bytes — because "could not open file" helps nobody, while "the header is intact
but the body is truncated at 4,096 bytes" names _what happened_ (a crash, a full disk, a
half-synced cloud folder) and points at the backup that will not have it.

Everything it can share with the reader it does share: field widths and ceilings from
`@shared/format/types.ts`, header validation from `parseHeader`, Argon2 bounds from
`assertUsableKdfParams`. Only the traversal is written twice, because the two traversals
answer different questions.

It reads bytes and nothing else — no filesystem, no clock, no key, no password — which is
what lets the fault-injection tests build damaged containers in memory from a real one.

`reachedStage` is the last of the ten `INSPECTION_STAGES` that completed: `magic`,
`format-version`, `header-length`, `header-bytes`, `header-json`, `body-length`, `body-bytes`,
`chunk-count`, `chunk-framing`, `complete`. `stoppedAt` names the stage, the byte offset, how
many bytes were expected and how many were available.

Fifteen `FILE_DIAGNOSTIC_CODES` are reachable without the password, which is the point: a
user whose vault will not open should be told _where_ it stops being readable before they are
asked to type anything.

### `structurallyIntact` is not a promise that it will open

Every length, offset and framing rule checked out. Authentication happens under the data key,
which does not exist until someone types the master password. The `verdict` says so in words,
because a green tick that means less than the reader thinks it means is worse than no tick.

---

## 5. Ranking the copies beside it

When a vault will not open, the answer is almost never "repair it" — it is "there are four
other complete copies of this file in the same folder, and this one is the newest". The write
path already puts them there: five rolling backups, plus whatever an interrupted write left
behind. `surveyVaultFiles` lays them out in the order worth trying.

It does **no I/O**. The caller lists the directory and hands the entries in, optionally with
each file's bytes. That is not squeamishness about `readdir`: it is what lets the ranking be
tested against many combinations of size, age, generation and damage without a temp directory,
and it keeps the one module that talks about damaged files from being able to touch one.
Supplying the bytes is what upgrades a row from "8 MB, modified Tuesday" to "generation 214,
header intact, container complete" — the difference between a guess and an answer.

Six roles: `vault`, `backup`, `legacy-backup`, `orphaned-temp`, `quarantined-temp`,
`other-vault`. Classification is case-insensitive throughout, because NTFS and the default
APFS configuration both are, and treating `Vault.keep.bak.1` and `vault.keep.bak.1` as
different files would mean missing a backup on exactly the platforms these files live on.
`other-vault` is listed but never ranked as a copy of _this_ vault, because it is not one.

**Order:** known-good before unknown before known-damaged, then highest generation, then
newest, then largest, then role, then backup index, then name. Every tier ends in a name
comparison, so the order is total and two reports over one folder are comparable.

Generation outranks modification time deliberately. `mtime` is set by whatever last touched
the file — a cloud client, a backup tool, a copy — while `generation` is written by Keyhold
itself and increments once per save. When they disagree, the counter is the one that is about
the vault's contents rather than about the filesystem.

### The `.tmp` is never deleted, and the report explains why

`atomic-write.ts` surfaces an orphaned temp rather than removing it, because it may be a
truncated fragment or it may be the newest complete copy of the vault, and **nothing can tell
which without the master password**. That rule is honoured here and, more importantly,
_explained_ here: every temp entry carries a standing note saying so. A file the app refuses
to clean up looks like a bug unless the user is told what it is.

`quarantined-temp` is a temp that has already been renamed aside. Quarantine got it out of
the way; it did not decide the file was worthless, so it stays a ranked candidate.

---

## 6. What is still wrong after the file opens

A container that authenticates proves the bytes are the bytes that were written. It proves
nothing about whether what was written makes sense. `diagnoseDocument` owns the seven
`DOCUMENT_DIAGNOSTIC_CODES` — the checks nothing else performs:

| Code                           | Severity | Why it is that severity                                                                            |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------- |
| `document-version-unsupported` | critical | Saving over it with today's rules would discard fields this build does not know about              |
| `duplicate-record-id`          | critical | Edits land on whichever is found first; the other silently goes stale                              |
| `duplicate-custom-field-id`    | critical | Reveal addresses fields by id, so a duplicate hands back the **wrong secret**                      |
| `duplicate-question-id`        | critical | The same, for security answers                                                                     |
| `invalid-history`              | warning  | A restore from that timeline could write values the diff never showed                              |
| `record-invalid`               | warning  | Fails a check every create and update enforces                                                     |
| `future-timestamp`             | warning  | Quietly breaks sorting, the password-age rule and trash retention — none of which will look broken |

Folder and tag coherence is **not** re-derived here; `checkOrganisation` already answers it,
and `auditAttachments` already reconciles metadata against chunks. Both are called, neither is
copied — a second implementation of "is this folder tree sound?" would disagree with the first
within a month (hard rule 8). `DocumentDiagnosis` carries their output rather than a
restatement: `attachments` is the existing `AttachmentAudit` verbatim, and `organisation` is
the existing issue with its severity resolved and its `name` dropped.

`ORGANISATION_SEVERITY` is a `Record` over the checker's kinds, so a kind added to
`integrity.ts` without a severity here is a compile error rather than a finding that renders
at the bottom of the report with no colour. The same construction makes
`ATTACHMENT_DIAGNOSTICS` a `Record` over `AttachmentIssueCode`.

`now` is supplied rather than read, so a diagnosis is a pure function of the document and the
moment it was asked about — which is what makes "this timestamp is 40 days in the future"
testable at a boundary instead of at a whim.

---

## 7. The plan says what it costs, and the order is the plan

Fourteen `REPAIR_ACTION_KINDS`, ordered: preserve first, then read-only alternatives, then
changes a person can walk back, then the ones that lose something. **Step 1 is always "copy
everything aside"**, because every step after it is safe only if that one happened. The steps
are not independently reorderable and the numbering says so.

Every action carries four things a user needs before agreeing:

- **`changes`** — what it actually does.
- **`cannotRecover`** — what it cannot bring back, `null` only when it genuinely loses
  nothing. A user agreeing to a repair without being told the price has not agreed to
  anything.
- **`reversible`** — whether it can be undone _from inside the app afterwards_: delete the
  tag, move the folder back, rename the file back. Deliberately **not** "can be undone from
  the copy step 1 proposes", which would be true of everything and would therefore say
  nothing. `false` means the copy is the only way back.
- **`requiresUnlock`** — whether it needs the master password.

"Try another copy first" is proposed ahead of any repair whenever the survey ranks something
above the vault file, and it is honest about its own price: anything saved after that copy
was written is not in it, so compare the generation numbers before letting it replace the
vault.

---

## 8. The rendered report says what was _checked_, not only what failed

A report listing three findings and nothing else leaves the reader unable to tell a clean bill
of health from a check that never ran. That matters most for the attachment reconciliation,
which is silently skipped when the caller has no chunk list — so the checklist says so,
in capitals, rather than leaving a missing check to look like a passing one.

The checklist is derived from the code tables (`FILE_DIAGNOSTIC_CODES`,
`DOCUMENT_DIAGNOSTIC_CODES`), so a check added without appearing in the report is not
possible.

**Plain text, deliberately not Markdown.** This is pasted into terminals, mail and issue
trackers that all treat backticks and asterisks differently, and a report that renders wrongly
in half of them is worse than one that renders plainly in all of them. Wrapped at 96 columns,
with long tokens left unbroken because the only long tokens are ids and a hyphenated id is one
nobody can search for.

Counts are grouped by hand rather than by `toLocaleString`, which is locale-dependent: the
same report would render `4.096` on a German machine and `4,096` on an English one, and the
tests asserting on those strings would pass on the developer's laptop and fail in CI.

The fourth line of every report is the claim itself: _This report contains no passwords,
notes, titles, names, or file paths._

Findings sort loudest first (`critical`, `warning`, `info`) and stably within a severity, so
two runs over one vault are directly comparable.

---

## 9. Not built yet

- **The IPC channel.** There is no `kh:recovery:*` entry in `CHANNELS`
  (`src/shared/ipc/api.ts`).
- **The diagnostics screen.** Nothing renders `RecoveryReport`, and nothing calls
  `renderRecoveryReport` outside the tests.
- **The caller that gathers the inputs.** Every function here is pure and takes what it needs:
  bytes for the inspection, a directory listing for the survey, a decrypted document and a
  chunk list for the diagnosis. Nothing performs the `readdir`, reads the backups, or supplies
  the chunk list, so today a real diagnosis would always report the attachment reconciliation
  as skipped.
- **A repair executor — and this one is never coming.** See §1. If a repair is ever offered,
  it belongs in the module that owns the data (`credential-ops`, `folder-ops`,
  `attachments`), invoked per-action by an explicit user choice, and not as "apply this plan".
- **A "copy the file to safety" helper.** Step 1 of every plan is a proposal in words; there
  is no code that performs it.
- **`quarantineOrphanedTemp`'s infix as a shared constant.** `survey.ts` restates
  `'.recovered-'` because `atomic-write.ts` builds it inline and does not export it. A guard
  test pins the string; the fix is to export the constant there, and it is recorded rather
  than made because that file is not this module's to edit.

---

## 10. Tests

140 in `src/main/recovery/`.

| File                         | Tests | Covers                                                                                                                  |
| ---------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------- |
| `file-inspection.test.ts`    | 32    | Every stage boundary, with damaged containers built in memory from a real one                                           |
| `document-diagnosis.test.ts` | 26    | The seven document codes, delegation to the organisation and attachment checkers, and the "nothing is repaired" half    |
| `report.test.ts`             | 24    | The marker sweep over every user string, name, title and directory · that the checklist names what ran and what did not |
| `repair-plan.test.ts`        | 21    | The ordering, the `cannotRecover` and `reversible` flags, and the `unrecoverable` statements                            |
| `survey.test.ts`             | 19    | Classification, case-insensitivity, the ranking tiers, and the standing temp-file note                                  |
| `text.test.ts`               | 18    | Digit grouping without a locale, the detail cap, and the unknown-token redaction                                        |

---

## 11. Related

- [`../04-Vault-Format/00-KEEP-Format-Spec.md`](../04-Vault-Format/00-KEEP-Format-Spec.md) — the container layout this walk traverses, and the legacy `.keepbak` extension
- [`../02-Security/00-Cryptography.md`](../02-Security/00-Cryptography.md) — why an authenticated region decrypts whole or not at all
- [`../05-Features/04-Attachments.md`](../05-Features/04-Attachments.md) — `auditAttachments`, whose findings ride along here
- [`../05-Features/06-Organisation.md`](../05-Features/06-Organisation.md) — `checkOrganisation`, which follows the same report-never-repair rule
- [`../07-Sync-And-Merge/00-Merge-Engine.md`](../07-Sync-And-Merge/00-Merge-Engine.md) — the operation most of these findings are downstream of
