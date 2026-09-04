# Recovery and diagnostics

> How far a `.keep` parses without a password, which of the copies beside it is the best one,
> what is still wrong after it opens, and a shareable report that carries no user content.
> Current reference. Implemented by `src/main/recovery/` and `src/shared/model/recovery.ts`.
>
> **Status: shipped and reachable.** "Diagnose a vault" is a tool view in the sidebar, three
> `kh:recovery:*` channels carry it, and `diagnose.ts` is the caller that reads the folder and
> feeds the analyses. There is also, deliberately and permanently, **no code anywhere that
> executes a repair plan.** See §1 and §9.

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
- `text.ts` bounds a borrowed message at 200 characters. It is **not** a redactor, and the
  redactor that used to live beside it has been removed — see below.

`report.test.ts` proves it: a fixture in which **every** user-authored string, name, title and
directory path carries one marker, swept over the serialised result. One token searched for
once, rather than a list of forbidden words, so the assertion cannot rot as fields are added.

### Two borrowed messages, and one that is composed instead

Only **two** messages from other layers are still repeated, and both are safe for reasons
worth writing down because they are not obvious. `parseHeader`'s quotes our own field-name
literals and, twice, an algorithm identifier read from a header that is plaintext by design —
anything in it is already readable by whoever holds the file, and the salt and the wrapped key
appear only as lengths. `assertUsableKdfParams`'s quotes numbers and an algorithm name.

**History failures are no longer borrowed at all**, and the reason is the most instructive
thing on this page. `assertValidHistory` interpolates the offending value into its message — a
snapshot key, a changed-field name, a version number — and all three come out of the document,
where in the corrupt vault this module exists to describe they can hold anything. A fragment of
a decrypted note is the case everyone means.

That message used to reach the report through a scrubber that replaced any double-quoted run
not on an allow-list. **Two shapes walked past it**, and both are now regression tests in
`document-diagnosis.test.ts`:

- **A length cap ran first and took the closing quote with it.** Past roughly 175 characters of
  key the message was truncated mid-token, the scanner found no `"…"` pair at all, and the whole
  message — key included — went through untouched.
- **The key supplied its own quotes.** `x" <secret> "password` presents the scanner with two
  pairs it is happy about and leaks everything _between_ them. Reordering the cap and the scrub
  fixes the first and does nothing for the second.

There is a third shape no quoted-run scrubber could ever have covered: the ascending-order
message interpolates the version number **unquoted**, and a version number out of a corrupt file
is only a number because the type says so.

So `history-detail.ts` **composes** the sentence instead, from literals in that file plus values
that are safe by construction — a count, a 1-based position, a length, or a field name taken
from `VERSIONED_FIELDS` itself rather than from the document. Nothing that came out of the file
is interpolated, so there is nothing to scrub. **Do not reintroduce a scrubber, however much
simpler it looks:** scrubbing is the losing side of the exchange, because it has to win against
every shape forever while a shape only has to be new once.

It describes rather than decides. `assertValidHistory` remains the only judge of whether a
history is valid; this module is never asked unless it has already thrown, and it can neither
suppress nor invent a finding. What it does duplicate is the _order_ the invariants are checked
in, so the sentence describes the violation that actually fired. If `versioning.ts` grows an
invariant the walk has not been taught, the caller gets `UNATTRIBUTED_HISTORY_DETAIL` — vaguer,
still true, and never a leak. Failing to a vaguer sentence is the correct direction to fail in,
and `history-detail.test.ts` pins it down.

A length and a position, and deliberately **not a hash prefix**: a reader needs enough to find
the offending key in their own vault, and a position plus a character count does that without
reproducing it. A truncated digest would identify it more precisely and was rejected — this
report is written to be pasted somewhere public, and a short digest of a short secret is
recovered offline by guessing. A length leaks one number about a value; a digest leaks the
value to anyone patient.

The 200-character cap in `sanitiseDetail` is a backstop, not the defence. A truncated secret is
still a secret — worse, truncation is exactly what defeated the redactor — so nothing relies on
it. It exists so a pathological file cannot turn one finding into a page of text.

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

### The disclosure statement is a promise, so it is data before it is prose

Every report opens with the claim itself, printed from `DISCLOSURE_STATEMENT` in
`src/main/recovery/report.ts`:

> This report repeats nothing that was typed into the vault — no passwords, notes, titles,
> usernames, emails, web addresses, field labels, security questions or answers, tag or folder
> names, and no attachment names or directory paths. It does carry the vault file's name, the
> names of the files beside it, this vault's id and this device's id, which are stable
> identifiers worth stripping before pasting this somewhere public.

It used to read _"This report contains no passwords, notes, titles, names, or file paths"_, and
that was **wrong in both directions**. A snapshot key out of a corrupt document could carry a
fragment of a decrypted note past the redaction — the two bypasses in §3 — and the report has
always carried file names and the header's ids on purpose. Under-claiming a disclosure is as
much a broken promise as over-claiming one: a sentence that only lists what is withheld invites
someone to paste stable correlatable identifiers and possibly a personal filename
(`divorce-vault.keep`) into a public issue tracker without noticing.

So the two halves are kept as **lists** — `DISCLOSURE_WITHHELD` and `DISCLOSURE_CARRIED` — and
the sentence is checked against them. `report.test.ts` plants a **separate** marker for each
withheld category in a poisoned vault and sweeps the finished report for it, and asserts each
carried item really is present. Adding a category to the list without the report actually
withholding it fails, and so does a sentence that stops naming one.

Prose alone could not be checked: a guard that reads the same string the renderer prints agrees
with itself no matter how wrong both are, which is exactly the failure mode this whole change
exists to remove. **Quote the constant, not this page** — if the two ever disagree, the constant
is right and this section is stale.

Findings sort loudest first (`critical`, `warning`, `info`) and stably within a severity, so
two runs over one vault are directly comparable.

---

## 9. How it reaches the user

Everything in §1–§8 was finished, tested and callable from nothing for two phases. This section
is what closed that, and the gap had exactly the shape `CLAUDE.md` warns about: pure functions
that each take precisely what they need, and no caller performing the `readdir` that would give
them anything to work on.

### The caller

`src/main/recovery/diagnose.ts` is the one place here that touches the filesystem. It reads the
vault **first and separately** — a folder that cannot be listed must not stop the file the user
actually asked about from being inspected — then walks the folder: skipping directories,
skipping a neighbour whose `stat` fails, and listing anything past 256 MB without reading it,
because a 4 GB file beside the vault is not a vault and reading it to find that out would hang
the dialog.

Every one of those is a `catch` that exists so **the report arrives**. This runs when somebody
is already in trouble and has no other tool to reach for; a diagnostic that throws on a missing
file has failed at its one job. `diagnose.test.ts` covers them, and records the two branches it
cannot reach from outside rather than implying it does.

### The three channels

| Channel                     | Does                                                                        |
| --------------------------- | --------------------------------------------------------------------------- |
| `kh:recovery:diagnose`      | Diagnoses the **open** vault, using its own path and its decrypted document |
| `kh:recovery:diagnose-file` | Opens a file dialog in main and diagnoses whatever was picked               |
| `kh:recovery:save-report`   | Writes the last report to a file the user names                             |

**Neither diagnose channel takes a path.** One uses the open vault's; the other opens the dialog
in the main process. A path travelling renderer → main would be attacker-controlled if the
renderer were ever compromised, which is the same rule the import, export and attachment dialogs
follow.

`diagnose-file` deliberately passes **no document**: the file the user picked is almost certainly
not the one that is open, and diagnosing one file's container against another's contents would
produce a report that is wrong in a way nobody could see.

### The report is held in main, not handed back

`save-report` takes no argument. The last report this process produced is kept in `register.ts`
and rendered there.

The alternative — accepting the report back from the renderer and writing that — would mean
validating a large nested structure at the boundary and then writing renderer-supplied text into
a file the user believes Keyhold wrote. Holding it is smaller, needs no validator, and makes the
saved file **necessarily** the one that was shown.

Two obligations follow, and both are tested in `src/main/ipc/recovery-report.test.ts`:

- **Saving before diagnosing is refused**, before a dialog is opened. A save dialog for a file
  that cannot be written is worse than the refusal, because the user picks a name first.
- **The held report is dropped on lock.** It describes the vault that was open — its size, its
  structural problems, its container — and keeping it past a lock would leave a profile of that
  vault in main-process memory after the event whose entire meaning is that nothing
  vault-derived still is. The same obligation the breach client's range cache has.

### The screen

`DiagnosticsView` is the `diagnostics` tool view: an explainer, three buttons, and the report. It
is reachable **while the vault is locked**, which is the whole point — "my vault will not open"
is the case this feature exists for, and a tool you could only reach after unlocking would be
useless for it.

The smoke run drives it end to end: it clicks the sidebar row, presses **Diagnose this vault**,
and asserts a rendered report comes back (`diagnostics-report-is-rendered`). Two named
screenshots are captured from it, and each capture asserts its subject is on screen — because
four screenshots in this repository once drifted onto the wrong one.

### Still not built, and one that never will be

- **A repair executor — never coming.** See §1. If a repair is ever offered it belongs in the
  module that owns the data (`credential-ops`, `folder-ops`, `attachments`), invoked per-action
  by an explicit user choice, and not as "apply this plan".
- **A "copy the file to safety" helper.** Step 1 of every plan is a proposal in words; there is
  no code that performs it.
- **`quarantineOrphanedTemp`'s infix as a shared constant.** `survey.ts` restates
  `'.recovered-'` because `atomic-write.ts` builds it inline and does not export it. A guard
  test pins the string; the fix is to export the constant there, and it is recorded rather than
  made because that file is not this module's to edit.

---

## 10. Tests

In `src/main/recovery/`. No total is written here on purpose: a count in prose is true the day
it is typed and silently false the next time a case lands, with nothing that fails when it
drifts. Run `npx vitest run src/main/recovery` for the current number. What is worth stating is
_what_ each file covers, which changes only when somebody decides it should.

| File                         | Covers                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `file-inspection.test.ts`    | Every stage boundary, with damaged containers built in memory from a real one                                           |
| `document-diagnosis.test.ts` | The seven document codes, delegation to the organisation and attachment checkers, and the "nothing is repaired" half    |
| `report.test.ts`             | The marker sweep over every user string, name, title and directory · that the checklist names what ran and what did not |
| `repair-plan.test.ts`        | The ordering, the `cannotRecover` and `reversible` flags, and the `unrecoverable` statements                            |
| `survey.test.ts`             | Classification, case-insensitivity, the ranking tiers, and the standing temp-file note                                  |
| `text.test.ts`               | Digit grouping without a locale, the detail cap, and the unknown-token redaction                                        |
| `diagnose.test.ts`           | The folder walk: a missing vault, a file that is not one, directories beside it, a path naming nothing                  |

Outside the directory, `src/main/ipc/recovery-report.test.ts` covers the save channel's two
refusals — nothing diagnosed, and the report dropped on lock.

---

## 11. Related

- [`../04-Vault-Format/00-KEEP-Format-Spec.md`](../04-Vault-Format/00-KEEP-Format-Spec.md) — the container layout this walk traverses, and the legacy `.keepbak` extension
- [`../02-Security/00-Cryptography.md`](../02-Security/00-Cryptography.md) — why an authenticated region decrypts whole or not at all
- [`../05-Features/04-Attachments.md`](../05-Features/04-Attachments.md) — `auditAttachments`, whose findings ride along here
- [`../05-Features/06-Organisation.md`](../05-Features/06-Organisation.md) — `checkOrganisation`, which follows the same report-never-repair rule
- [`../07-Sync-And-Merge/00-Merge-Engine.md`](../07-Sync-And-Merge/00-Merge-Engine.md) — the operation most of these findings are downstream of
