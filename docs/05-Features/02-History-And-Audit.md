# History and the audit trail

> What changed, when, and from which device and network. Keyhold's headline feature.
> Current reference. Implemented by `src/main/history/`, `src/main/vault/vault-service.ts`
> and `src/renderer/src/history/`.
>
> **Status: built and in use end to end — engine, provenance capture, IPC and the timeline
> UI. What remains is exporting one record's history, comparing two arbitrary points, and
> the `merge` origin Phase 12 will write.** See §8.

---

## 1. What the feature is

Every edit to a record can be kept: which fields moved, what they held before, when it
happened, and — at the user's chosen level — which machine, which account and which network
it happened from.

No other free, local password manager records provenance. KeePassXC keeps password history
with timestamps and nothing about where; Bitwarden and 1Password have audit trails behind a
paid or organisation tier and a server. Keyhold's is offline, free, and lives inside the
encrypted file, so it travels with the vault and is never exposed by the file itself. See
`docs/00-Overview/02-Competitive-Analysis.md`.

---

## 2. Deltas point backwards, and that is the load-bearing decision

A version stores **the values that were replaced**, never the values that replaced them.
The state at any point is reconstructed by starting from the live record and walking
backwards, applying each snapshot in turn.

Two things follow, and both are the reason for the choice:

**Pruning stays lossless for what survives.** Retention drops the _oldest_ versions. With
backward deltas the retained versions are exactly the ones still reachable from the
present, so every entry the user can see is an entry they can restore. Forward deltas would
need the pruned base to reconstruct anything, so pruning would silently break the entries
it left behind — a timeline full of restore buttons that do the wrong thing.

**The current record is always intact.** There is no replay to arrive at "now", so no
corrupt version can make the live record unreadable.

A test asserts the pruning property directly rather than inferring it, and fault injection
confirms it: reversing the prune direction fails four tests, including
`still resolves every surviving version after pruning`.

---

## 3. Every timeline entry is a restorable state

One function, `resolveState(credential, n)`, answers both "what does entry _n_ show on the
left of its diff" and "what does restoring entry _n_ produce". Deliberately one function:
two would eventually disagree, and the failure would be a restore button that writes
something other than what the user was looking at.

`resolveState` returns **every** versioned field, not just the ones that version recorded.
A version stores only what changed, so a field is recovered by _not_ finding it in any
snapshot on the way back. Reading `snapshot.password` directly on a version that did not
touch the password would return nothing, and a UI would render "empty" — a lie about the
record's past. `historicSecret` exists for the cases that genuinely want "did this version
record this field", and it returns `null` rather than guessing.

### What counts as versioned

Fourteen fields: title, username, email, password, urls, securityQuestions, notes, custom,
tags, folderId, favorite, icon, expiresAt, rotationIntervalDays.

`historyEnabled` is deliberately not one. Toggling history is a real change that must be
saved — but a version recording it would be an entry with nothing to show, and turning
history _on_ would immediately create a version documenting that history was turned on.

Adding a field to `VersionedValues` without listing it in `VERSIONED_FIELDS` is a compile
error, by the same construction that guards the secret boundary. Without it, a new field
would be changed, saved, and never recorded — data loss with no failing test and no error.

---

## 4. A restore is itself a change

Restoring appends a version with `action: 'restore'`, capturing the device and network it
was done from. The one operation that rewrites a record must not be the one operation the
audit trail cannot see. It also means a restore can be undone from the timeline like
anything else, which is tested (`is itself restorable — undoing a restore`).

A restore that changes nothing writes nothing: no version, no `updatedAt` bump, no dirty
vault.

Restores go through `applyPatch`, so they are validated exactly like a hand edit. A version
from a corrupted file cannot bypass a record's invariants by arriving through the history
door — there is a test that plants an over-length title in a snapshot and expects the
restore to throw.

`restoreField` restores one field and leaves the rest alone. That is the common case by a
distance: _"that was the password I used before"_, without undoing six months of other
edits.

---

## 5. Provenance, and the privacy levels

| Level     | Captures                                                           |
| --------- | ------------------------------------------------------------------ |
| `none`    | The action only. History still works; it says nothing about where. |
| `device`  | Device name, platform, app version. **The default.**               |
| `network` | Adds the OS user and the network name.                             |
| `full`    | Adds the OS release and the local IP.                              |

**The level is enforced at capture, never at display.** A field that was never captured
cannot leak, cannot be recovered by an attacker holding the master password, and cannot be
un-hidden by a future version of the app that has forgotten why the setting exists.
Filtering at display time would have left all of it in the file — and the file is the thing
people copy to a USB stick and hand to someone.

The default stops at `device` because that is the level that answers the question people
actually have — _"was this me, on my own machine?"_ — while a network name says where you
were and an IP says something about the network you were on.

The guard is a sweep over `AUDIT_PRIVACY_LEVELS`: each level captures a set of injected,
unmistakably-named values, and the test asserts every key present is one the level permits.
Fault injection — ungating `osUser` — fails it for `none` and `device`.

### Creation provenance sits on the record, not in the version array

`meta.createdOrigin`. Creation has no previous state to snapshot, so a version describing
it would be an entry the timeline could not diff and the restore button could not act on.
It is captured once and never changes, which also makes it the one origin that survives
history being switched off.

A vault written before this field existed simply has none. `normaliseRecord` fills it with
the verb alone — never with anything about _this_ machine, because the record was not
created here, and inventing a plausible origin would put a false entry in the one part of
the app whose entire value is being trustworthy about provenance.

---

## 6. Nothing here may block a save

`netsh wlan show interfaces` and `system_profiler SPAirPortDataType` are slow: tens of
milliseconds on a good day, seconds on a machine with a confused adapter, and occasionally
never on one with a hung network stack. A save that waits on any of that is a save that can
hang, and a password manager that hangs while saving is worse than one that records no
network name.

So `capture()` is **synchronous** and reads a cache that a background probe keeps warm. A
cold cache means the origin carries no network name; the next save gets it. There is a test
that hands the capture a promise which never settles and asserts it returns immediately.

Related decisions in `network-name.ts`:

- **`execFile`, never `exec`.** `exec` goes through a shell. Nothing interpolates user input
  today, but a future "probe this interface" argument would, and the safe form costs nothing
  now.
- **One probe at a time.** Without the in-flight guard a bulk import would spawn a `netsh`
  per record; a test fires twenty captures and asserts one probe.
- **A failed probe forgets the name** rather than keeping the last one. Keeping it would be
  a lie about _when_ it was true, recorded in an audit trail.
- **The SSID is matched by shape, not by the literal string `SSID`** — `netsh` prints its
  keys in the display language, so the literal fails on every non-English Windows install.
  `BSSID` is excluded **by name**: it is the access point's MAC address, and recording it
  instead of the network name would be both wrong and a meaningfully worse leak.
- Reading the machine can throw — `os.userInfo()` genuinely does on a machine with no passwd
  entry for the running uid — so every read is wrapped. A save must not fail because the
  audit trail could not name the user.

---

## 7. History and the secret boundary

A version's snapshot holds the values that were replaced, so for a password change it _is_
an old password. It is treated exactly like a live one.

**In the projection:** non-secret old values cross verbatim, so a timeline can render
`"Gmail" → "Google"` with no round trip. `password` and `notes` cross only as a length, so a
mask renders at the right width. `securityQuestions` and `custom` go through the same
per-entry projectors as the live record, so an old answer and an old hidden value are
stripped by exactly the code that strips the current ones. `secretFields` tells the UI which
rows get a reveal button, derived here so the classification lives in one place.

**Fetching an old secret** uses four new `SecretRef` kinds — `historic-password`,
`historic-notes`, `historic-answer`, `historic-custom` — mirroring the four live ones one
for one. They are separate kinds rather than an optional `versionNumber` on the live refs,
because an optional field makes "the current password" and "a password from two years ago"
the same request with a property missing, and a dropped property is the kind of mistake that
returns the _wrong_ secret rather than an error.

**The version number is part of the broker key**, so revealing v3 and then v7 costs two
grants against the rate limit rather than one. Walking a record's entire password history is
exactly the automated harvesting the limit exists to notice. That is fault-injected: dropping
the version from the key was **not** caught by the original test suite, which is what led to
the two broker tests that now cover it.

---

## 8. The timeline UI

`src/renderer/src/history/`. Three rules it exists to honour, in the order they read badly
when broken:

**Each row is a state, and expanding it shows exactly what its button restores.** One
function in the main process is behind both, so the component cannot invent a second idea
of what a row means.

**Old secrets are still secrets.** A password row shows a mask of the right width and a
reveal button; the value goes through the broker, one at a time, under the same rate limit
and clipboard rules as the live one. Only `password` and `notes` get that button — a
historic security answer needs an id the diff row does not carry, and guessing one would
fetch the _wrong_ secret rather than fail, so the button is absent rather than broken.

**Provenance the user switched off is not mentioned.** `originSummary` returns an empty
string rather than "Unknown device": a message like that on every row reads as a fault in
the app rather than as the setting its owner chose, and would push people to turn
provenance back on to make it go away. There is a test for exactly that.

Smaller decisions worth recording:

- **Before is struck through as well as dimmed.** Never colour alone — in the high-contrast
  theme, or to a colour-blind reader, two identical-looking strings either side of an arrow
  leave which-is-which a guess.
- **Restore asks twice but does not open a dialog.** The restore is itself versioned and so
  undoable from the same timeline; a modal would be ceremony over an action that cannot lose
  anything. The second click stops a misclick, not a disaster.
- **Clear history is the exception** — it genuinely loses data, so it says how many versions
  and that it cannot be undone.
- **One clock for the whole list.** `useNow` ticks once a minute; two rows each calling
  `Date.now()` can disagree across a boundary, which looks like a bug in the ordering. The
  timer is cleared on unmount, and `Date.now()` is never called during render — the rule
  this codebase already had to learn once.
- **The diff is fetched on the click, not from an effect** watching `expanded`. An effect
  would call `setState` synchronously on every open, which cascades renders, and the fetch
  is a response to a user action rather than a synchronisation with anything outside React.

### Still to come

- **Exporting a single credential's history** (roadmap Phase 6).
- **Comparing two arbitrary points.** `history.compare` exists on the contract and in the
  service; nothing in the UI calls it yet.
- **Restoring a single field from the timeline.** `restoreField` exists end to end and is
  tested; it needs a per-row control, which wants the diff rows to become interactive.
- **`merge` origins.** `HistoryAction` includes `'merge'` for Phase 12's three-way merge;
  nothing writes one yet.

## 9. Tests

| File                                   | Covers                                                                                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/history/versioning.test.ts`  | Versioning on change only · retention pruning and its direction · reconstruction across pruning · diff correctness · restore, and undoing a restore · the history invariants |
| `src/main/history/origin.test.ts`      | The privacy-level sweep · never probing at a level that would not record · synchronous capture under a hung probe · SSID/BSSID parsing                                       |
| `src/main/vault/projection.test.ts`    | That no old secret survives projection, and that an old password crosses only as a length                                                                                    |
| `src/main/vault/secret-broker.test.ts` | That each version of a historic secret costs its own grant                                                                                                                   |

**Seven fault injections, all caught** — after the seventh exposed a genuine gap in the
broker's coverage rather than confirming one:

| Injection                                              | Result                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Privacy level ignored for `osUser`                     | 4 failures across `none` and `device`                                                       |
| Pruning keeps the oldest instead of the newest         | 4 failures, incl. the reconstruction property                                               |
| `resolveState` walks forward instead of backward       | 4 failures                                                                                  |
| The version snapshots the new values, not the replaced | 4 failures                                                                                  |
| A restore is not itself recorded                       | 3 failures                                                                                  |
| The projection sends the old password verbatim         | 4 failures, incl. the marker property test                                                  |
| `refKey` drops the version number                      | **Not caught** — no broker test covered historic refs. Two were added; re-injected, caught. |
