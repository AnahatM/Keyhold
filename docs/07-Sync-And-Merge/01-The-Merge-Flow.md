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

## 6 · Guards

| Claim                                                 | Held by                                                                                         |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| No secret value reaches the screen                    | `MergeResolver.test.tsx`, driven from a report with a planted value                             |
| Nothing is written while conflicts remain             | `MergeResolver.test.tsx` → `FakeSyncGateway`, which refuses exactly as `MergeSessionStore` does |
| A plan arriving after the screen is gone is discarded | `MergeFlow.test.tsx`                                                                            |
| A dismissed dialog is not an error                    | `MergeFlow.test.tsx`                                                                            |
| An unrecognised side is refused, not defaulted        | `register.test.ts`                                                                              |
| The merge row exists in the palette                   | `smoke.ts` → `palette-offers-every-transfer`                                                    |
| The menu command is lock-gated                        | `menu-commands.test.ts`, which compares both directions                                         |

Every one of these was fault-injected with the bug it claims to catch before being trusted;
each test file names its injections in its own header.

---

## 7 · Still to come

The reload prompt, a saved merge report and a view for it, cloud-folder detection, provider
"conflicted copy" handling, and a KDF progress channel shared with unlock. Tracked in
[`docs/12-Roadmap/00-Master-Checklist.md`](../12-Roadmap/00-Master-Checklist.md), Phase 12.
