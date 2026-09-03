# 07.01 · The merge flow

How a person reaches the engine in [`00-Merge-Engine.md`](./00-Merge-Engine.md), and what
holds while they are in it.

The engine is pure and knows nothing about files, dialogs or keys. Everything on this page is
the apparatus around it: four channels, one screen in front of the resolver, and the rules
about who owns a decrypted copy of somebody else's vault while it exists.

---

## 1 · Four channels, and no path in either direction

`kh:sync:prepare` · `kh:sync:resolve` · `kh:sync:commit` · `kh:sync:discard`

Declared in `src/shared/model/sync-plan.ts` beside the payloads they carry, re-exported by
`src/shared/ipc/api.ts` rather than restated there.

**No file path crosses the bridge in either direction.** The renderer never names a file to
open and never learns where the one it merged came from. `prepare` opens the dialog in the
main process, reads the chosen file there, and returns a plan id, a report and the name of the
backup that was taken.

| Channel   | Takes                   | Returns                |
| --------- | ----------------------- | ---------------------- |
| `prepare` | nothing                 | `MergePreview \| null` |
| `resolve` | plan id + conflict→side | `MergeReport`          |
| `commit`  | plan id                 | `MergeCommitResult`    |
| `discard` | plan id                 | nothing                |

`null` from `prepare` means the file dialog was dismissed. It is not an error and it is not a
screen: nothing happened, so the flow ends.

### Why `prepare` is one call and not four

It does the file dialog, an Argon2id decrypt of the other copy, the mandatory pre-merge
backup, and the first merge — all before returning. Splitting it would create a state in which
a user has picked a file and the backup has not been taken, and the backup existing before the
first conflict is on screen is the entire point of it. Someone looking at four hundred
conflicts must already have the copy that lets them walk away.

The cost is that the window waits for a KDF. See §4.

### The other copy is opened with _this_ vault's key

There is no second password prompt. A merge is between two copies of one vault, and reading
the other one with the open vault's key is what makes that structural rather than something
the app hopes is true — a genuinely different vault simply fails to decrypt, and the user is
told so in those terms.

### Nothing that crosses can be made to hand over a credential

The report carries lengths where a value would be (see `00-Merge-Engine.md` §5), a resolution
is the word `ours` or `theirs`, and the merge re-runs in the main process from the accumulated
choice map. An unrecognised side is **refused**, never defaulted: defaulting would silently
pick a winner, which is the last-writer-wins behaviour the whole engine exists to prevent.

---

## 2 · Who owns the plan

A prepared plan holds a decrypted copy of another entire vault. It has exactly three ends:

1. **`commit`** — applied, and the session drops it.
2. **`discard`** — dropped explicitly.
3. **The lock** — every plan goes when the key goes.

In the renderer, ownership passes at one point: the moment `prepare` returns a preview to a
component that is still mounted.

- **Before that point** it belongs to `MergeFlow`, which discards it if the preview arrives
  after the screen is gone. That is not hypothetical — the vault auto-locking during Argon2 is
  exactly this case, and nothing else knows the id by then.
- **After that point** it belongs to `MergeResolver`, which discards from its own teardown
  however it closes: applied, cancelled, or unmounted by a route change.

Both discard the same id on the ordinary path and the second one is refused politely. That is
deliberate: a discard already done costs one refused call, and a discard skipped because each
side assumed the other had done it costs a decrypted vault.

---

## 3 · The base snapshot is written last, and only on success

`commit` replaces the document, saves through the ordinary path — so the watcher bracketing,
the rolling backups and the header stamping all apply exactly as they do to an edit — and only
then stores the merged state as the new ancestor.

Only after the write returns. A snapshot describing a state no file ever held would make the
_next_ merge read the user's real edits as changes away from something that never existed.
`snapshotIsSafeToStore` is where that condition lives, so it cannot be forgotten at a call
site.

---

## 4 · The wait in front of the resolver

`MergeFlow` (`src/renderer/src/sync/MergeFlow.tsx`) owns the three states that exist before a
preview does:

| State       | What is on screen                                                         |
| ----------- | ------------------------------------------------------------------------- |
| `preparing` | The shared indeterminate `ProgressBar`, saying what the wait is for       |
| `failed`    | The message, plus why a file usually will not open, plus "choose another" |
| `ready`     | `MergeResolver`, and nothing of `MergeFlow`'s own                         |

**The wait is indeterminate, and says so.** There is no KDF progress channel anywhere in the
app yet — unlock has the same gap — so the bar reports no value and the copy commits to
nothing it cannot know. Building a real one belongs with unlock rather than only here; it is
tracked in the Phase 12 list. Inventing a percentage in the meantime would be worse than
admitting the truth.

---

## 5 · The ways in

Merging is the third whole-vault flow, alongside import and export, and it shares their store
(`useTransfer`) rather than having one of its own. All three are modal, all three act on the
whole vault, and a merge running over a half-finished import is the same hazard wearing a
different name — while holding a decrypted copy of a _second_ vault. One `active` field makes
that state unrepresentable rather than merely discouraged, and closing on lock is written
once instead of twice.

Reachable from the command palette (`Merge another copy of this vault`) and the File menu
(`Merge Another Copy…`). Both need an unlocked vault, because the other copy is opened with
this one's key.

The menu entry is **not** flagged `exposesCredentialData`, and the distinction is worth
stating because a merge plainly touches secrets. That flag marks a command that puts
credential data somewhere a person can read it — an export file, a revealed field — and is
what keeps such commands out of the tray. A merge shows lengths, writes only an encrypted
backup, and re-runs every decision in the main process.

---

## 5a · When the file changed underneath you

The watcher reports an external change; `ExternalChangeBanner` is what the user sees, and
`external-change.ts` decides what it may offer.

**The decision is a table, tested over every combination of the flags, and separate from the
component that renders it.** That split is the whole point: "the file changed" has an obvious
response, and the obvious response is wrong in three of the four cases.

| Situation                                   | Offered                      | Why not reload                                                 |
| ------------------------------------------- | ---------------------------- | -------------------------------------------------------------- |
| A different `vaultId` at this path          | Lock · dismiss               | It is not a version of this vault; reading it would mix two    |
| Disk is _older_ than memory                 | Merge · dismiss              | It would replace what you have with something that predates it |
| Disk is newer, unsaved edits in this window | Merge · dismiss              | It would discard edits that exist in no file at all            |
| Disk is newer, nothing unsaved              | **Reload** · merge · dismiss | —                                                              |

A withheld reload is always explained. A missing button with no reason reads as a bug and
sends the user looking for another way to do the thing being prevented.

The banner lives in `AppShell`'s full-width `banner` slot rather than inside the detail pane.
That is a layout fact, not a preference: below the narrow breakpoint the detail pane is shown
only when a record is selected, so a notice mounted there vanishes in a narrow window with
nothing selected — which is exactly the wrong person to hide it from.

### Reloading

`kh:vault:reload` takes no argument. There is one vault open, one path it came from, and the
renderer knows neither. There is no password prompt either: the DEK belongs to the vault rather
than to a session, so another device that unlocked with the same password unwrapped the _same_
key and sealed a body this session can read. It is also why changing the master password is
instant.

`VaultService.reloadFromDisk` refuses in two cases, and both are enforced there rather than at
the caller so the rule holds for every caller:

- **Unsaved changes** → `UNSAVED_CHANGES`. The banner already avoids offering the button, and
  the service refuses anyway. A reload is a read that destroys: the in-memory document is
  replaced wholesale, and a record that was never written has no tombstone, no history entry
  and no undo. The repeated check is what makes "never lose data" survive a caller that
  forgets, and an edit landing between the check and the call.
- **A different vault id** → `DIFFERENT_VAULT`. Read from the plaintext header before the body
  is unsealed, so it costs nothing.

Outstanding secret grants are revoked on the way through. They are keyed by record id, and
after a reload an id either means a different record or nothing — a grant that outlived its
document is a reveal nobody asked for.

---

## 5b · Noticing the cloud folder

A `.keep` in Dropbox or iCloud is how Keyhold does multi-device without a server, and it is the
arrangement the whole merge engine is for. It has one sharp edge that is invisible until it
cuts: **the vault is one file, and a sync client copies whole files.** Two devices that both
save while one is offline do not produce a merged vault — the client picks a winner and keeps
the other as a conflicted copy, and the edits on the losing side exist only in that copy.

`shared/model/cloud-folder.ts` recognises the situation from the vault's path and
`CloudFolderNotice` says so, in the vault panel where the vault is described.

**Not an alert, deliberately.** Nothing is wrong when it appears; interrupting somebody to say
their setup is supported but has a caveat is how a warning gets trained away before the day it
matters. It names the remedy — the merge flow — because a warning without one is only something
to worry about.

**In `shared`, and there is no channel.** Detection is a question about a string and the vault's
path is already in the safe projection, so the renderer answers it itself. A channel would have
been a round trip, a validator, and a second home for the provider table.

The matching is **whole-segment**, and that is the part with a cost attached. A miss loses the
user a warning, which is recoverable — the merge engine works either way. A false positive
tells somebody with a folder called `Megabytes` that their vault is inside MEGA, which is the
app being wrong about something they can see, and it makes every later warning cheaper. Prefix
matching is allowed only where a client genuinely generates suffixed names: `OneDrive - Contoso`
and `GoogleDrive-someone@example.com` are real, `googledrive-` on its own is not.

Syncthing is the exception: it syncs whatever folder it is pointed at, so there is no name to
look for. It is recognised by the `.stfolder` marker it leaves, which needs a directory listing
rather than a string — so that check is separate, for a caller willing to pay for the read.

`looksLikeConflictedCopy` recognises the names the real clients write for a losing side. It is a
hint rather than a rule: a match is offered as a merge candidate, a non-match is excluded from
nothing, and the patterns are allowed to be generous because a false positive costs one
unnecessary suggestion.

---

## 5c · The copies the client left behind

When two devices both save, the sync client writes the loser next to the vault under a name it
invented — `personal (Anahat's conflicted copy 2026-09-03).keep`, or
`personal.sync-conflict-20260903-120000-ABCDEFG.keep`. Those files hold real edits, they look
like clutter, and the usual instinct is to delete them.

`kh:sync:candidates` finds them and describes each one, and `kh:sync:prepare` takes the id of
one instead of opening a dialog. Making somebody locate that file themselves — under a name
their client chose, in a folder they did not — is asking them to do the app's job at exactly
the moment they are least sure what the file is.

**No path, in either direction.** A candidate is an opaque id and a filename; the id → path map
lives in the main process and is rebuilt on every scan. That is the entire security argument for
the channel: `prepare` taking an id it minted is a closed set, where `prepare` taking a filename
would be an instruction to read whatever the renderer named. An id the process does not
recognise is refused, not guessed at.

**Everything is read from the plaintext header**, so a candidate is described — item count, when
it was saved, how many times — before anyone commits to opening it and before any key is used.
That is what the header being authenticated-but-not-encrypted is for.

Three exclusions, each a file that would otherwise be offered as a merge candidate when it is
nothing of the sort:

| Excluded                  | Why                                                                |
| ------------------------- | ------------------------------------------------------------------ |
| The vault itself          | Merging a file with itself is a no-op that looks like a real offer |
| Our own pre-merge backups | Merging one back in silently undoes the merge that created it      |
| A different `vaultId`     | Somebody else's vault, named like a conflicted copy                |

The pre-merge exclusion is the subtle one and it looked like dead code: a backup of `personal`
matches no conflict pattern, so nothing was testing it. It becomes reachable the moment somebody
opens a conflicted copy _as_ their vault — an ordinary thing to do — because its backups then
inherit the conflict wording. That case is now the test.

A scan is per-file fault-tolerant. A folder a sync client is working in holds half-written and
locked files; giving up on the first `EBUSY` would find nothing exactly when the client is
busiest, which is when a conflicted copy has just appeared.

---

## 6 · Guards

| Claim                                                                 | Held by                                                                                                                                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| No secret value reaches the screen                                    | `MergeResolver.test.tsx`, driven from a report with a planted value                                                                            |
| Nothing is written while conflicts remain                             | `MergeResolver.test.tsx` → `FakeSyncGateway`, which refuses exactly as `MergeSessionStore` does                                                |
| A plan arriving after the screen is gone is discarded                 | `MergeFlow.test.tsx`                                                                                                                           |
| A dismissed dialog is not an error                                    | `MergeFlow.test.tsx`                                                                                                                           |
| An unrecognised side is refused, not defaulted                        | `register.test.ts`                                                                                                                             |
| The merge row exists in the palette                                   | `smoke.ts` → `palette-offers-every-transfer`                                                                                                   |
| The menu command is lock-gated                                        | `menu-commands.test.ts`, which compares both directions                                                                                        |
| Reload is offered only when it loses nothing                          | `external-change.test.ts`, over every combination of the flags                                                                                 |
| A reload never runs over unsaved edits                                | `vault-service.test.ts`                                                                                                                        |
| The banner reaches the screen at all                                  | `smoke.ts` → `external-change-banner-offers-a-reload`                                                                                          |
| A cloud folder is recognised, and an ordinary one is not              | `cloud-folder.test.ts`, whose larger half is what must **not** be detected                                                                     |
| The notice reaches the screen                                         | `smoke.ts` → `cloud-folder-notice-names-the-provider`, with the run's own vault placed inside a `Dropbox` folder so there is something to find |
| A conflicted copy is found, and a backup or a stranger's vault is not | `conflict-candidates.test.ts`                                                                                                                  |
| The copy that was picked is the one merged                            | `MergeFlow.test.tsx`, asserting the id `prepare` was called with                                                                               |
| No path reaches the renderer                                          | `smoke.ts` → `conflicted-copy-listed-without-a-path`, against a real copy of the run's own vault                                               |

Every one of these was fault-injected with the bug it claims to catch before being trusted;
each test file names its injections in its own header.

---

## 7 · Still to come

The reload prompt, a saved merge report and a view for it, cloud-folder detection, provider
"conflicted copy" handling, and a KDF progress channel shared with unlock. Tracked in
[`docs/12-Roadmap/00-Master-Checklist.md`](../12-Roadmap/00-Master-Checklist.md), Phase 12.
