# The session model

> Unlocking, locking, and everything that guards a vault while it is open.
> Current reference. Implemented by `src/main/session/`.

---

## 1. The lifecycle

```
   no vault ──inspect──► locked ──unlock / quick unlock──► unlocked
                            ▲                                 │
                            └────────── lock ─────────────────┘
                                  manual · idle · sleep
                                  screen-lock · minimise · blur
```

`SessionController` is the only thing the IPC layer talks to. `VaultService` underneath it
knows how to open and read a vault and deliberately knows nothing about throttling, idle
timers, clipboards or the OS key store — which is what let it be tested exhaustively
without mocking Electron.

---

## 2. Locking is one operation

The single most important property in this whole area: **lock does everything, always.**

```
lock(reason)
  ├─ disarm the auto-lock watchers
  ├─ clear the clipboard
  ├─ destroy the DEK          ─┐
  ├─ drop the decrypted document  ├─ VaultService.lock()
  └─ revoke every secret grant ─┘
```

A lock that does four of those five is a lock that leaves the user's password sitting in
Win+V. There is exactly one lock path and every caller — the menu, the IPC handler, the
auto-lock timer, `window-all-closed`, `will-quit` — routes through it.

**Locking never saves.** An unattended write is how a half-finished edit becomes the saved
state. Unsaved changes are prompted about while the user is still there.

---

## 3. Argon2 runs on a worker thread

Argon2 is CPU-bound and synchronous inside the WASM module, so it blocks whatever thread it
is on for the full derivation — half a second at the defaults, several seconds on a
high-cost vault.

**The renderer being a separate process does not solve this.** The renderer stays
responsive, but it cannot paint anything the main process has not sent it, and every IPC
reply queues behind the blocked loop. The window stops repainting and the OS marks the app
"not responding" — at exactly the moment it is doing its most important work.

So `KdfRunner` owns a worker thread. One worker, one request at a time: concurrent
derivations at 64 MiB each can genuinely exhaust a modest machine, and nobody unlocks two
vaults at once. It is created lazily, disposed when idle, and `unref`ed so a pending
derivation never delays quit.

`KdfProvider` is an interface so tests can inject an in-process implementation. There is
deliberately **no silent fallback** inside `KdfRunner` — a missing worker in a packaged app
is a real bug, and quietly deriving on the main thread would hide it behind a frozen window
rather than a clear failure.

---

## 4. Throttling — what it does and does not buy

**It does not protect the vault file.** Anyone who can copy a `.keep` can attack it offline
at whatever speed their hardware allows, and no app-side delay touches that. Argon2's memory
hardness is the only defence there, and it is the real one.

**What it protects is the running app**: someone at an unattended, locked machine gets a
handful of tries before the delay makes guessing pointless. A colleague, a housemate, a
hotel room.

| Attempt | Delay                                                                                      |
| ------- | ------------------------------------------------------------------------------------------ |
| 1–3     | none — typos are normal, and punishing them makes the app hostile without deterring anyone |
| 4       | 2s                                                                                         |
| 5       | 4s                                                                                         |
| 6       | 8s                                                                                         |
| …       | doubling, capped at 5 minutes so a forgotten vault is never locked out for hours           |

Reset completely on a successful unlock.

---

## 5. Auto-lock

| Trigger     | Default    | Why                                                                                                                                                                         |
| ----------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System idle | 10 minutes | Uses **OS-wide** idle time, not in-app activity                                                                                                                             |
| Sleep       | on         | `suspend` fires _before_ the RAM image is written, so keys are gone first — which matters on a machine without full-disk encryption, where the hibernation file is readable |
| Screen lock | on         | The user explicitly said they were leaving                                                                                                                                  |
| Minimise    | **off**    | Minimising to check something else is not walking away                                                                                                                      |
| Blur        | **off**    | Same                                                                                                                                                                        |

**Idle time comes from `powerMonitor.getSystemIdleTime()`, deliberately.** Tracking activity
inside Keyhold's own window would lock the vault while the user is actively working two
windows over — which is exactly what trains people to raise the timeout until it is
useless, or turn it off.

---

## 6. Clipboard hygiene

The clipboard is the leakiest part of any password manager, and the leak is not the copy —
it is what the OS does afterwards. Windows clipboard history (Win+V) keeps 25 entries
indefinitely and **cloud clipboard syncs them to every machine on the same Microsoft
account**. macOS clipboard managers record every change by design. Any app can read the
clipboard with no prompt.

So a secret is written with no-retain markers, in **one atomic item**:

| Platform | Markers                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| Windows  | `ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory`, `CanUploadToCloudClipboard` |
| macOS    | `org.nspasteboard.ConcealedType`                                                                            |

**All of them travel with the text in a single write.** Writing plain text first and
decorating it afterwards produces two clipboard events, and history captures the first,
undecorated one — the markers would appear to work while achieving nothing.

Two honest limits:

- **The markers are advisory.** A clipboard manager that ignores them still records the
  value. The clear timer is the part that does not depend on anyone else's cooperation.
- **Clearing only fires if the clipboard still holds our value.** Without that check,
  copying a password and then a URL wipes the URL thirty seconds later, from the user's
  point of view at random.

Electron 44 replaced the synchronous clipboard with a Promise-based, MIME-keyed API, so all
of this is async. `clearOnExit` is deliberately fire-and-forget: `will-quit` is synchronous
and blocking shutdown on a clipboard round-trip buys nothing.

---

## 7. Quick unlock — and what it honestly is

| Platform | What guards the stored key                           | Biometric prompt?                  |
| -------- | ---------------------------------------------------- | ---------------------------------- |
| macOS    | Keychain + an explicit **Touch ID** prompt each time | **Yes**, where the hardware exists |
| Windows  | **DPAPI**, bound to the Windows account              | **No**                             |
| Linux    | Desktop secret store (kwallet / gnome-libsecret)     | No                                 |

**Windows quick unlock is not biometric, and the code says so.** `safeStorage` uses DPAPI,
which ties the ciphertext to the Windows user account — a real protection against another
local user or someone copying the file elsewhere, but **anyone already sitting at an
unlocked Windows session can use it**. Windows Hello has no Electron API and would need a
native module, which conflicts with decision D14; it is in the backlog.

The capability description is generated in the main process and rendered verbatim, rather
than written into the UI — which is precisely how the distinction would otherwise get lost.
Overstating it would lead someone to enable it in a threat model where it does not hold.

**What is stored is the DEK, wrapped again** under a key the OS key store controls — an
independent wrapping of the same data key (the envelope design, decision D13). The master
password is never stored in any form. Revoking deletes that one wrapping and touches
nothing else.

Enrolment records the vault's `generation`, so **re-keying invalidates every enrolment** —
otherwise the old key would keep working and the rotation would have achieved nothing.

`unlockWithKey` is a separate method from `unlock`, not a branch inside it. There is no
password check on that path and none is needed: possession of the correct DEK _is_ the
proof, because a wrong key fails the container's authentication tag. Keeping them separate
is how a bypass avoids being added by accident later.

---

## 8. Wipe after failed attempts

Off by default (`null`), opt-in, and refused below three attempts — a lower threshold would
fire on ordinary typos, which is a data-loss trap rather than a security setting.

When it fires it removes the vault **and its backups**. Leaving the backups would make the
whole feature theatre.

This is a genuinely dangerous option: a forgotten password or a child at the keyboard
destroys the vault permanently. It exists because some threat models want it, and it is
gated accordingly.

---

## 9. Master-password strength

Uses **zxcvbn**, in the main process only, lazily loaded. The password never crosses the
bridge and ~3 MB of dictionaries never enter the renderer bundle.

The naive alternative is actively misleading: counting character classes rates `P@ssw0rd1!`
as excellent — four classes, ten characters — when it is among the first few thousand
guesses any real attacker makes.

Two additions on top of zxcvbn:

**App-specific terms** (`keyhold`, `vault`, `master`, `password`…) are passed as
`userInputs`, so they are matched with zxcvbn's own machinery — catching `Keyh0ld!` and
reversals — rather than by a substring check any small mutation defeats.

**A 12-character floor**, because a score alone is not enough. zxcvbn rates `MyVault2024`
at 3, which is reasonable for an ordinary site login and not reasonable for the single key
to every credential someone owns. A score judges patterns; length judges the search space.

The minimum is score **3, not 4**. Demanding the maximum pushes people toward writing the
password on a note beside the machine, which is a worse outcome than a merely-strong
passphrase they can remember.

The crack-time figure is computed from the guess count against **10,000 guesses/second** —
a deliberately pessimistic estimate for an offline attacker against Argon2id at 64 MiB,
where memory bandwidth rather than compute is the ceiling. It is named and explained in
`strength.ts` rather than buried as a constant, because a crack-time claim should be
arguable.

---

## 10. Preferences

Machine-scoped, in `userData/preferences.json`. **Nothing secret** — vault paths, timings,
and the OS-wrapped quick-unlock records, which are themselves ciphertext only the OS key
store can open.

Deliberately separate from vault settings, which live _inside_ the encrypted file: those are
properties of the data and should travel with it, while these are properties of this
machine and should not. Carrying a vault to a friend's laptop must not import your idle
timeout.

Coerced field by field on read. Rejecting a whole file for one bad field would discard every
other setting the user had chosen.

---

## 11. Absolute deadlines cross the bridge

`ThrottleState.lockedUntil` and `ClipboardState.clearsAt` are absolute epoch timestamps, not
only durations.

A duration is stale the instant it crosses IPC. Mirroring one into component state and
decrementing it gives two sources of truth that drift the moment a status refresh lands
mid-tick — and computing the deadline in the renderer would mean calling `Date.now()` during
render, which is impure and which React's compiler rightly refuses. Sending the fixed point
lets the UI derive a live countdown by subtraction. Both processes share a machine, so
clock skew is moot.

---

## 12. Tests

| File                                   | Covers                                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.test.ts`                      | Clipboard markers in one atomic write, the do-not-clear-someone-else's-copy check, throttle timing to the millisecond with an injected clock, auto-lock setting coercion                                |
| `session-controller.test.ts`           | The create → lock → unlock cycle, lock clearing the clipboard, throttling refusing an attempt, quick-unlock enrolment and revocation, the wipe threshold firing at exactly N and taking backups with it |
| `strength.test.ts`                     | Bad passwords rejected, app-specific terms caught, the length floor, and that nothing reversible is returned                                                                                            |
| `kdf-runner.test.ts`                   | Worker output matches in-process byte for byte, **the calling thread stays free**, concurrent requests do not cross replies                                                                             |
| `npm run test:smoke -- --vault <path>` | The whole stack in the real app: create → lock → wrong password rejected → unlock → list, against a real file on disk                                                                                   |

The smoke cycle is the only check that proves the layers are wired to each other rather than
merely correct in isolation.
