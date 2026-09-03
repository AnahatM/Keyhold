# 05.08 · Session activity

> What this session did with the vault — unlocks, failed unlocks, locks, reveals, copies,
> clipboard clears, saves and imports. In memory only, cleared on lock, and never persisted.

> **Status:** built and reachable. `main/activity/` records it, `kh:activity:list` reads it,
> and `renderer/src/activity/ActivityView.tsx` is the `activity` tool view, opened from the
> sidebar or from **Vault ▸ Session Activity** in the native menu.

---

## 1. The question it exists to answer

A password manager's version history records every **change**: what a field held before, when
it moved, and — at the privacy level the user chose — from which device and network. That is
the durable audit trail, and it lives inside the ciphertext where it belongs.

It cannot see a **read**. Revealing a password changes nothing, so nothing is versioned, and
the vault file is byte-identical afterwards. Yet reading is precisely what somebody else
sitting at an unattended machine would do — they would not edit anything, because editing is
noticed.

So the activity log covers the half history structurally cannot: _did something just walk my
vault?_

---

## 2. Four decisions, and why each is the way round it is

### It is never persisted, and there is no option to persist it

A durable list of which credentials were revealed and when is a **second, unencrypted index
of the vault's contents**. It says which accounts exist, which are used, and how often — and
it says it in a file that survives the lock, which is the one thing the lock is for.

The vault's own encrypted history is the durable trail, and it is durable precisely because
it is inside the ciphertext. This log covers reads, and reads are the entries whose durable
record would be most dangerous. `activity-log.ts` ships no serialiser, deliberately, so
nothing in it can be reused to build one by accident. A persisted variant would need a
decision-log entry and would have to default to off.

### It holds ids and counts, never values and never names

`ActivityEntry` has **no field that could hold a secret and no field that could hold a
title**. A reveal entry carries the credential's id and which kind of secret it was; a save
carries a count. Turning an id into a name happens in the renderer, at display time, against
the safe projection it already holds — and only when the reader asks (§4).

`session-activity-binding.test.ts` serialises the whole snapshot and asserts that a record's
title, a password and the vault's filesystem path are all absent from it. Serialising the
whole thing rather than checking named fields is what keeps that true when a field is added.

### It is cleared on lock

Like the secret broker's grants. A lock that leaves behind a list of everything the session
revealed is a lock in name only, and that list is more use to somebody sitting down at the
locked machine than the lock screen is.

`SessionActivity.locked()` clears the ring and **returns** the lock entry rather than storing
it, so the view can still say why the vault closed without the entry outliving the log. The
notice carries no vault label: naming the vault in the announcement that it just locked would
be the one disclosure the lock exists to prevent, spoken aloud by a live region.

### It is a ring, not a list

Bounded at `ACTIVITY_LOG_CAPACITY`. The workload that overflows it — a bulk import, a runaway
reveal loop — is exactly the workload where an unbounded log would allocate hardest, so the
bound matters most at the moment it bites. `droppedCount` is carried so the view can say the
list is partial rather than implying it is complete.

---

## 3. What records what, and where

The recorder is owned by `SessionController`, not by `VaultService`, because most of what it
records is not about the file: a failed unlock has no vault, a lock is the vault going away,
and a clipboard clear is the OS. The session is the only object that sees all of them.

| Kind              | Recorded from                    | Note                                                                                                     |
| ----------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `unlock`          | `SessionController.#afterOpen`   | Carries the method: `password`, `quick-unlock` or `created`, so a new vault does not report as an unlock |
| `unlock-failed`   | `unlock`'s catch                 | Recorded before the wipe check, so a vault destroyed by the last attempt still has that attempt in view  |
| `lock`            | `lock()`                         | Clears the ring; the notice is returned, not stored                                                      |
| `reveal`          | `SessionController.revealSecret` | Only when something was actually revealed — a refused or expired grant is not a read                     |
| `copy`            | `copySecret`                     | Distinct from a reveal: the value left the app                                                           |
| `clipboard-clear` | the clipboard's state transition | See below                                                                                                |
| `save`            | `save()`                         | Carries the record count that was written                                                                |
| `import`          | `commitImport`, via the recorder | Carries records **created**, never the file's row count                                                  |

**The clipboard clear is recorded from a state transition, not from a call.** There are three
causes and only one is a method: the auto-clear timer fires inside `SecretClipboard`,
`clearClipboard()` is the user, and `clearOnExit()` is the lock. Watching `hasSecret` go
`true → false` catches all three with nothing to keep in sync. It is gated on an open vault,
because `clearOnExit` is deliberately fire-and-forget and its notification can land after the
lock has already cleared the log.

**The import recorder is one method wide.** `ImportActivityRecorder` declares `imported()` and
nothing else, and `commitImport` builds a fresh counts object rather than forwarding its
outcome — which also carries the whole rebuilt document and every merged secret snapshot.
Typing the parameter narrowly makes reaching for those a compile error rather than a
convention.

---

## 4. Naming a record is off by default

A row reads "Password revealed", not "Password revealed for Barclays", until the reader turns
names on.

The argument is in `activity-presentation.ts` and is worth restating, because the instinct is
that names are obviously more useful. This list is compact, timestamped, screenshot-friendly
and read aloud by screen readers — which makes it a genuinely different disclosure from the
credential list it derives from, even though both show the same titles. The credential list
binds a title to nothing and scrolls away; this binds a title to a time and an action.

The question the log exists for is answered by counts and rates without naming anything.
Turning names on is one click for somebody who wants "what did I just do" instead.

At audit privacy level `none` the entries carry **no id at all**, so the toggle has nothing to
resolve and the rows stay unnamed whatever it says. That is belt and braces, not the only
guard.

---

## 5. Read on demand, never pushed

`kh:activity:list` is a poll. The log is appended to on nearly every action, so an event per
entry would be a steady stream of IPC feeding a panel that is closed almost all of the time —
and the panel is something people open to answer a question, not a feed they watch.

The channel answers with the snapshot **plus** the last lock notice, because `locked()` does
not store that entry: a reader arriving after a lock would otherwise find an empty log and no
way to say why.

---

## 6. What this replaced

Both `ActivityLog` and `SessionActivity` were finished and thoroughly tested, and were
constructed **nowhere outside their own tests**. Not one action in the running app recorded
anything, and every test of the recorder passed the whole time.

That is worth recording here rather than quietly fixing, because it is a failure mode no test
of a subsystem can catch: a component can be entirely correct and entirely unreachable, and
the two are indistinguishable from inside. `session-activity-binding.test.ts` exists to drive
the **caller**, and every one of its cases fails when the corresponding recorder call is
deleted.

---

## 7. Related

- [`02-History-And-Audit.md`](./02-History-And-Audit.md) — the durable trail, and the four
  privacy levels this log also obeys
- [`../02-Security/`](../02-Security/_INDEX.md) — the lock model and the secret broker
- [`../12-Roadmap/01-Feature-Backlog.md`](../12-Roadmap/01-Feature-Backlog.md) — D3, which
  this closed
