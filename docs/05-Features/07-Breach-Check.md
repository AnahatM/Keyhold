# The breach check

> Keyhold's single, opt-in, off-by-default exception to "this application makes no network
> requests". Current reference. Implemented by `src/main/breach/`,
> `src/shared/model/breach.ts` and `src/renderer/src/health/BreachSection.tsx`.
>
> **Status: shipped and reachable.** `BreachService` is the composition root, two channels
> carry it (`kh:breach:availability` and `kh:breach:run`), the panel lives at the bottom of
> the health dashboard, and the opt-in sits behind a confirmation dialog on the settings
> screen. Nothing runs on its own — see §7, which is now a description rather than a list of
> what is missing, and decision **D33** for why it reaches the user this way and not another.
>
> Read §6 before touching the CSP: this feature does **not** need `connect-src` relaxed and
> would gain nothing from it.

---

## 1. k-anonymity, in plain English

1. The password is hashed with SHA-1, **on this machine**.
2. Only the **first five hex characters** of that hash are sent — twenty bits.
3. The service replies with every hash suffix it holds that begins with those five
   characters: several hundred to a thousand of them.
4. The comparison happens here, offline, against that list.

Twenty bits partitions the corpus into 1,048,576 buckets, so a prefix names roughly eight
hundred real passwords. The service never sees the password and never sees the full hash, and
cannot tell which of the candidates behind a prefix was being asked about. **Nothing
identifying the account is sent in any form** — no username, no URL, no title, no record id.

### The request order is shuffled, and that is a privacy control

What a sweep does hand over, unavoidably, is a set of prefixes from one address inside one
paced window. The _grouping_ is inherent — k-anonymity protects which password sits behind a
prefix, never which set of prefixes belongs to one person — and it is recorded in
[`../00-Overview/03-Threat-Model.md`](../00-Overview/03-Threat-Model.md) §2, _what Keyhold
does not protect against_, rather than hidden.

The **order** is not inherent, and it used to be the vault's own record order: `byPrefix` is a
`Map`, and a `Map` iterates in insertion order. An ordered multiset of a few hundred twenty-bit
values is a strong linking handle, so the same vault swept a month later from a different
address would have emitted very nearly the same recognisable sequence — turning "someone
checked something" into "this is the same vault as last month". `Add-Padding` does not help
with this: it hides how many candidates sit behind each answer, not the order the questions
were asked in.

So `client.ts` shuffles the sweep's prefixes with `shuffleInPlace` — the project's
CSPRNG-backed Fisher-Yates, via `randomInt`'s rejection sampling — before sending any of them.
Results are still returned in the caller's order, so nothing downstream pays for it.
`client.test.ts` sweeps a fixed twelve-password vault five times and asserts the request
sequences are not all identical, while the prefix multiset and the caller-facing result order
are unchanged. (Recorded as audit finding N7.)

`hash.ts` enforces the asymmetry structurally rather than by asking callers to be careful:
`passwordRange()` returns a `prefix` (5 characters, transmitted) and a `suffix` (35
characters, **must not leave the process**), and the transport's signature accepts a prefix
and nothing else. The full digest helper is not exported at all — an exported "give me the
whole hash of this password" function is precisely the shape that ends up being called from
somewhere it should not be.

### SHA-1, in 2026

Not a choice. The Pwned Passwords corpus is indexed by SHA-1, so a lookup against it is a
SHA-1 lookup or it is nothing. This is **not** a security use of SHA-1: nothing here relies on
collision resistance, on preimage resistance, or on the hash protecting the password. The hash
is an index into someone else's table, and its brokenness is irrelevant to that job. Keyhold's
actual password hashing is Argon2id, elsewhere.

The digest is upper-case hex over the **UTF-8** bytes, both stated explicitly rather than left
to a default: the corpus was built that way, so a password containing an accent or an emoji
only matches if it is encoded the same — and a silent default change would produce wrong
answers for exactly the users whose passwords are least likely to be in the corpus anyway.

### Never log any of the four

Not the password, not the digest, not the suffix, **and not the prefix**. The prefix is safe
to _send_ — that is the design — but a prefix sitting in a log file next to a record title
re-attaches the anonymised half to the identifying half, which is the one thing the whole
argument depends on not happening. There is no logging in the directory at all, and
`client.test.ts` property-tests that nothing returned from it carries any of the four.

---

## 2. Off by default is structural, not a flag

A setting that defaults to false is one forgotten `if` away from being on. So the off state
here is **the absence of the capability**:

- `PwnedPasswordsClient` takes a `BreachTransport`. Construct it with none and there is
  nothing it can send with.
- **There is no fallback.** It does not lazily import a transport, construct a default one, or
  reach for `fetch`. `client.ts` imports nothing that can make a request — the real transport
  is in `https-transport.ts`, which nothing in the client's module graph references.
- With no transport, a check returns `unknown` / `disabled` **without hashing the password at
  all**. Not "computes the prefix and then declines to send it" — it never touches the
  password.

Turning the setting on is what causes a transport to be built and handed in, at the
composition root. Nothing further down the stack can turn the network on.

`no-network.test.ts` checks this four ways, because a behavioural test alone would pass for a
module that merely happened not to be called:

1. **Repo-wide, over the source.** Hard rule 5 is repo-wide, so the scan is: every `.ts`/`.tsx`
   file under `src/`, recursively, and exactly one of them — `https-transport.ts` — may name a
   way to originate a request. The capabilities are named rather than pattern-matched on
   "http" so the failure message says which one appeared: `fetch`, `XMLHttpRequest`,
   `WebSocket`, `EventSource`, `sendBeacon`, an import of `http`/`https`/`http2`/`net`/`tls`/
   `dns`/`dgram` (with or without the `node:` prefix) or of a third-party HTTP client, and
   Electron's own `net`/`netLog`. A **test** file may _name_ `fetch` — booby-trapping it is how
   the behavioural half works — but may not call one or import a module that can.
2. **Directory-strict, plus the module graph.** Inside `src/main/breach/` mentioning a network
   API is enough to fail, as is an import from `electron` or a literal `http(s)://` URL; and
   the transport must be unreachable from `client.ts` through **any chain of imports**, walked
   transitively across the whole repository rather than one level deep or one directory wide.
3. **Behaviourally, with `fetch` booby-trapped** for the whole file, so a request attempted
   anywhere below fails loudly here rather than quietly succeeding on somebody's machine.
4. **By what is not computed.** `passwordRange` is spied on and must never be called. That is
   the difference between a feature that is off and one that is merely quiet.

There is deliberately **no test that makes a real request**. The range API is free and public,
and hitting it from a test suite would still be wrong: it would leak the fact that this
machine ran these tests, it would flake on a plane, and it would make the suite's result
depend on somebody else's uptime.

### The guard parses the source; it does not pattern-match it

Worth knowing before anyone simplifies it back. The scan used to read source as text — a
hand-rolled comment stripper, a regex per API, and a graph walk over `'./…'` specifiers — and
a subsystem audit found it **failed open in three ways at once**, each measured by planting a
violation and watching all fourteen tests pass:

| Finding | The hole                                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **N10** | The graph walk captured only relative specifiers, so `from '@main/breach/https-transport.js'` — the project's own alias style — was invisible                |
| **N18** | The comment stripper had no notion of string literals, so a line containing `'/*'` opened a block comment that never closed and blinded the rest of the file |
| **N17** | One directory, non-recursively, for a rule that is repo-wide                                                                                                 |

Specifiers, identifiers and calls now come from the **TypeScript parser**, the same one that
compiles the project: comments are trivia and never become nodes, so N18 is closed by
construction rather than by a better regex. Aliases are read out of `tsconfig.node.json`
itself rather than restated (hard rule 8), so N10 cannot recur when an alias is added. And the
walk covers all of `src/`, which closes N17. A local import that fails to resolve is a
**failure**, not a skip — "the walk did not understand this line" and "there is nothing there"
must never look the same to a security guard.

The last block of the structural half plants each of those violations into a throwaway source
tree and asserts the scan fails on it, because a guard nobody has watched fail is not known to
work — and these three were watched to pass for months.

---

## 3. Three answers, and the third one is the point

`breached` · `safe` · `unknown`. If a lookup that failed — offline, timed out, rate-limited,
5xx, garbled — were reported as `safe`, a user would read "no breaches found" and believe
something nobody actually checked. That is worse than being told nothing, and the failure mode
that produces it is a single missing `else`.

So every failure path lands on `unknown` with one of seven reasons:

| Reason        | Means                                                                            |
| ------------- | -------------------------------------------------------------------------------- |
| `disabled`    | No transport was supplied. The default state of the whole feature                |
| `offline`     | No route, DNS failure, connection refused, TLS failure — all one thing to a user |
| `timeout`     | A request was abandoned at its deadline rather than left hanging                 |
| `rateLimited` | HTTP 429, and the service said so again after we waited                          |
| `serverError` | HTTP 5xx. Their problem, not ours, and not an answer                             |
| `badResponse` | A 4xx, or a body that is not a suffix list                                       |
| `cancelled`   | The caller aborted the run                                                       |

The union is closed rather than a free-form message, so the UI can phrase each one itself and
— more importantly — so no failure path can smuggle a fragment of a password, a hash or a
prefix into a human-readable string that then crosses the bridge.

`classifyStatus` treats **only 200** as an answer. This API has exactly one success shape, so
anything else — including a 304, or a 3xx that somehow survived `redirect: 'error'` — is
`badResponse`. An HTTP error is a _returned value_ and a network failure is a _thrown_ one,
following `fetch`'s own split: a 429 is a completed exchange with a status, while a refused
connection never got that far. Both end at `unknown`, but keeping them distinct means the
client never has to guess whether it spoke to the service at all.

### Parsing fails toward "unknown", never toward "safe"

There are two ways to not find a suffix in a list: because it genuinely is not there, and
because what came back was **not a list**. Conflating them reports a captive-portal login
page, a proxy error or a truncated body as good news.

So `parseRangeBody` is strict on purpose. The format is machine-generated and completely
uniform — 35 hex characters, a colon, a count — so **one line that does not match is enough**
to conclude we are not looking at what we think we are looking at, and the honest verdict from
that point is `malformed`, never a count and never zero. Three faults: `oversized`, `empty`,
`unparseableLine`.

- **An empty body is not "no matches".** A real range response always has entries — with
  padding on, hundreds of them — so nothing at all means the response was not one.
- **A count of `0` means "not present"**, wherever it appears, including in the vanishingly
  unlikely case that a padding row collides with the suffix being sought.
- **Counts are capped at fifteen digits**, so a body claiming a four-hundred-digit count
  cannot become `Infinity` and then a `breached` verdict on a number that was never a number.
- **Matching is case-insensitive in both directions.** Hex is hex; the case carries no meaning
  and must not be allowed to carry a verdict.
- **A duplicated suffix takes the largest count.** Between two readings of an already-suspect
  body, the one that tells the user to change their password is the one that cannot hurt them.
- **The body is capped at 1 MiB**, read one character past the cap so "exactly at" is
  distinguishable from "over" — a truncated body that still parses is the dangerous outcome,
  because the missing tail could be the very entry being sought.

---

## 4. `Add-Padding` is a privacy control, not a formality

Without padding, a range response is as long as that range's entry list, and every range has a
different, publicly known length. An observer who can see the **size** of an encrypted
response — which TLS does not hide — can therefore narrow, and often uniquely determine, which
prefix was requested, undoing a good part of the k-anonymity the feature rests on.

`Add-Padding: true` makes the service pad every response with randomly generated suffixes,
each carrying a count of `0`, so responses are of a uniform, uninformative size. It costs
nothing and is supported for exactly this purpose. `https-transport.test.ts` asserts the header
is sent on every request, because a header that is silently dropped **fails invisibly** — the
answers stay correct while the privacy property quietly stops holding.

The rest of the request, and why each part is there:

- **`GET`, one fixed origin (`https://api.pwnedpasswords.com/range/`), no path built from user
  input.** The prefix is validated against `^[0-9A-F]{5}$` before it is placed in the URL —
  belt and braces, since we generated it — so nothing can traverse out of the endpoint or
  append a query.
- **`redirect: 'error'`.** A redirect is a request to a host we did not choose. There is no
  legitimate reason for this endpoint to move mid-request, and following one would send the
  prefix somewhere unaudited.
- **`credentials: 'omit'`, `referrer: ''`.** No cookie sent or stored, no referrer offered.
  There is no session here and there must never appear to be one. There is deliberately no
  `cache: 'no-store'`: Node's `fetch` keeps no HTTP cache at all, so there is nothing to
  disable and the option is not even in its type.
- **A version-free User-Agent (`Keyhold`).** The API asks callers to identify themselves and
  it is fair to do so. A version string would narrow an observer's view of _which_ Keyhold
  user this is, and the whole point is to be one of a crowd.
- **A capped, streamed body read**, so a hostile or broken endpoint cannot make the process
  allocate without bound.

---

## 5. Sweeping a vault without abusing a free service, and without persisting anything

A vault of 3,000 records is not 3,000 requests. Passwords are grouped by prefix, so duplicated
passwords collapse to one lookup and unrelated passwords sharing a prefix ride along with it;
ranges already fetched this session are reused; requests are spaced by a configurable interval;
a 429 is honoured once and then stops the run rather than being retried into the ground; and a
run that has failed several times consecutively gives up instead of grinding through thousands
of doomed requests at ten seconds each.

`BreachReport.requestCount` is reported rather than inferred, because "how many requests did
checking my vault actually make?" is a question a user of a zero-network application is
entitled to a real answer to — and because it is the assertion that proves deduplication
works.

| Setting             | Default  | Why                                                                                                                           |
| ------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `enabled`           | `false`  | See §2 — the off state is the absence of a transport                                                                          |
| `requestIntervalMs` | `100`    | The range API is free, unauthenticated and run at someone else's expense; a client that fires as fast as it can is abusing it |
| `requestTimeoutMs`  | `10_000` | A hung request must not hold a sweep open indefinitely                                                                        |

**Nothing is persisted and nothing is logged.** No result reaches disk, no hash is stored, and
no "this password was breached" flag is kept anywhere — a stored flag is a stored fact about a
password, and it would outlive both the password and the user's opt-in. The range cache is
memory-only, bounded (128 ranges by default), and dropped by `clearCache()`. Bodies are cached
rather than parsed maps, because the string is smaller than the `Map` built from it and
because re-parsing on a hit means a cached answer and a fresh one go through identical code.

**The cache dies with the lock.** It is deliberately not self-clearing — reopening the
dashboard should not re-ask the service the same questions — so a client held across a
lock/unlock cycle would carry it over. Its keys are the prefixes of passwords in the vault
that was open: a partial twenty-bit fingerprint of that vault, sitting in main-process memory
after the event whose entire meaning is that nothing derived from the vault is still there.
`BreachService.reset()` closes that, wired to `SessionController.onLock` in
`src/main/index.ts`, and it discards the client entirely rather than only emptying the cache.
See §7. (Audit finding N15, closed.)

### The exact count does not cross the bridge

`BreachProjection` carries a **band**, not a count, for the same reason health cluster ids are
synthetic counters rather than hashes (decision D13): an exact corpus count is very nearly a
fingerprint. The corpus holds hundreds of millions of passwords but the counts are long-tailed
and mostly distinct, so knowing a password appears _exactly_ 3,861,493 times narrows it to a
handful of candidates and often to one — a stable, offline-checkable handle on a password,
sitting in the semi-trusted renderer.

| Band     | Count       | Reading                                                                   |
| -------- | ----------- | ------------------------------------------------------------------------- |
| `none`   | —           | `safe` **or** `unknown`; the caller must read `status` to tell them apart |
| `low`    | 1 – 9       | Still a breach, still means change it — plausibly one person's leak       |
| `high`   | 10 – 99,999 |                                                                           |
| `severe` | ≥ 100,000   | In every cracking dictionary on earth, and will be tried first            |

`severe` still covers tens of millions of candidate passwords and identifies none of them,
while "change this now" versus "change this" — the entire actionable content of a count —
survives the reduction intact.

`safe` and `unknown` sharing the `none` band is deliberate: a band alone can never be mistaken
for a verdict, so a UI that renders one without checking `status` shows nothing alarming —
the failure that is merely unhelpful rather than the one that is dangerous.

`BreachReport` reports `breachedCount`, `safeCount` and `unknownCount` separately, none derived
by subtraction. A run where a third of the records could not be reached is not a clean bill of
health, and a summary saying only "2 breached" would read as though the other 98 had been
cleared.

---

## 6. Do not relax the CSP to enable this

`src/main/security.ts` sets `connect-src 'none'` in the renderer's Content-Security-Policy, and
`ALLOWED_REMOTE_HOSTS` is empty. It is worth stating explicitly, because "the app needs to
reach an API, so the CSP must allow it" is the obvious wrong conclusion:

**Relaxing `connect-src` would grant the _renderer_ network access and would buy this feature
nothing.**

The request is made by Node's `fetch` in the **main process**. The CSP is a directive attached
to the renderer's document; it governs what the page may originate and does not traverse to a
main-process `fetch` at all. So the check works with `connect-src 'none'` exactly as it works
without it — and loosening it would open the one hole the policy exists to close, in the one
process this project treats as semi-trusted.

That is the whole reason the network code lives where it does. All of it is in
`https-transport.ts`, in the main process, behind a `BreachTransport` interface whose only
argument is twenty bits of a hash, so that "does Keyhold talk to the internet?" is answerable
by reading one short file — and so that nothing can acquire the ability to make a request by
importing something that merely sounds harmless.

---

## 7. How it reaches the user

Everything below this line was outstanding for months while the engine above it was finished
and tested. That gap is the reason **D33** exists, and the reason a smoke check now opens the
health view and looks for the panel: no test of a component can see that nothing renders it.

### The two switches

Hard rule 5 promises the check sits behind _two_, and `src/main/network-policy.ts` owns both.
`Preferences.networkAllowed` is the machine-scoped master switch — off by default,
fail-closed on anything that is not the literal boolean `true`, persisted in
`preferences.json`, validated at the IPC boundary. `NetworkPolicy.allowsBreachCheck` ANDs it
with the vault's own `breachCheck.enabled`, in one place, so no call site writes the
conjunction itself and forgets a switch.

Machine-scoped rather than a vault setting, deliberately: vault settings travel inside the
`.keep` file, and a vault carried to a friend's laptop must not be able to turn that machine's
network on. Full argument in decision D23 and
[`../02-Security/01-Process-Hardening.md`](../02-Security/01-Process-Hardening.md) §5.

### `BreachService` — the composition root

`src/main/breach/service.ts` is the only module that imports `https-transport.ts`, and it is
a class rather than a function because the answer changes underneath it: the kill-switch can
be flipped while the vault is open, the vault setting can be edited, and the vault can lock.
All three take effect at the next question rather than the next restart.

- **`availability()`** asks `NetworkPolicy` and returns a `BreachAvailability`. It decides
  nothing itself. The first version of the IPC handler read `networkAllowed` off the machine
  settings and derived the answer there; `network-policy.test.ts` failed it on the spot, and
  the guard was right — a second module branching on that preference is the copy that
  eventually says yes when it should say no.
- **`client()`** returns `null` when either switch is off, and **drops the client** at the
  same time rather than merely declining to use it. Turning the check off has to take the
  cached prefixes with it, or the setting is a hint rather than a switch.
- **`reset()`** is wired to the vault lock through `SessionController.onLock` in
  `src/main/index.ts`, which closes the obligation §5 describes: the range cache is the 20-bit
  prefixes of the open vault's passwords, and it must not outlive the event whose entire
  meaning is that nothing vault-derived still does.

The off state is still the absence of a transport. The policy decides whether
`createHttpsTransport()` is _called_ — there is no `if (allowed)` inside a request path for a
future refactor to skip.

### The two channels

| Channel                  | Answers                                                                      |
| ------------------------ | ---------------------------------------------------------------------------- |
| `kh:breach:availability` | A `BreachAvailability`: the two switches, `canRun`, and the reason if not    |
| `kh:breach:run`          | A `BreachReport`. Takes no arguments — the renderer chooses nothing about it |

`kh:breach:run` accepting **no payload at all** is the point. Pacing, timeouts and which
records are swept are decided in the main process; the renderer's entire contribution is that
somebody pressed a button. `requireBreachCheckPatch` enforces the other half — a settings
patch may carry `enabled` and nothing else, so a compromised renderer cannot set
`requestIntervalMs` to zero and turn a privacy feature into a denial-of-service run from the
user's own address.

Both channels degrade to "off" when no service was wired — in a test, or any embedding that
did not build one. A missing composition root must read as _the feature is not available_,
never as an error the user has to interpret, and certainly never as a reason to reach the
network another way.

### The panel

`BreachSection` sits at the bottom of the health dashboard, below the score and the rules.
Three things about it are load-bearing:

- **Nothing starts on its own.** Every other panel in the app fetches when it mounts. This one
  waits for a click, because a request made because somebody opened a screen is a request they
  did not ask for. `useBreachCheck` fetches _availability_ on mount — that reads two switches
  and sends nothing — and calls `run` from the button and nowhere else. The smoke check
  asserts both halves: the panel is present, and there is no report and no error on screen.
- **When it cannot run, it names the switch.** There is no disabled button with a tooltip: a
  control that looks like it might work if you clicked it right teaches people to keep
  clicking. The three reasons — `locked`, `networkOff`, `notEnabled` — call for three
  different actions, and `breachAvailability()` in `@shared` decides which applies so the
  dashboard and any future surface cannot disagree.
- **The report dies with the screen.** It is component state, so closing the dashboard drops
  it. A breach report is a list of which of your records are compromised; keeping it alive
  past the screen that displays it would be a small copy of the vault's worst news sitting in
  memory for no reason.

### The consent step

Turning the switch on opens a `ConfirmDialog` that explains k-anonymity in the second person
and then says the part that is genuinely a cost: _what it does reveal is that Keyhold is being
used from your network address, each time you run a check_, and that the setting is stored in
the vault file, so it travels with a copy of it.

Turning it **off** is immediate, with no dialog. The asymmetry is deliberate: making somebody
confirm that they want _less_ exposure only teaches them to click through dialogs.

### The score never includes it

`health-score.ts` is computed from the offline rules alone and has no breach input. Two
reasons. A score that moved when a network check ran would make the number depend on whether
somebody had internet that morning, and — worse — a vault that had never been checked would
score the same as one that had been checked and came back clean. The counts are reported
beside the score, never folded into it.

### Still open

- **A security audit of this code.** Roadmap Phase 17 records `breach/` as the project's first
  network code, landed after the security sweep, and says it needs its own pass before it
  ships. Outstanding.
- **Cancellation from the UI.** `BreachRunOptions.signal` is honoured end to end and there is
  still nothing to press. The abort path itself is no longer thinly covered: `sweep.test.ts`
  drives a real cancellation through the real client and asserts the reason is `cancelled`
  rather than `offline`, that no request was made, and that `safeCount` stayed zero. What is
  missing is the control, not the coverage.

---

## 8. Tests

In `src/main/breach/`. No total is written here on purpose: a count in prose is true the day it
is typed and silently false the next time a case lands, with nothing that fails when it drifts.
Run `npx vitest run src/main/breach` for the current number. What is worth stating is _what_
each file covers, which changes only when someone decides it should.

| File                      | Covers                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client.test.ts`          | Every failure producing `unknown` and never `safe` · prefix deduplication and cache reuse against an injected fake · that repeated sweeps of one vault do not emit a recognisable request order · the property that nothing returned names the password, its digest, its prefix or its suffix                                                          |
| `range.test.ts`           | Strict line parsing, padding rows, the count cap, case-insensitive matching, and each of the three faults                                                                                                                                                                                                                                              |
| `https-transport.test.ts` | That `Add-Padding` is sent on every request · the fixed origin and prefix validation · the capped body read · `Retry-After` normalisation                                                                                                                                                                                                              |
| `transport.test.ts`       | Status classification and thrown-error classification, including reading `fetch`'s wrapped `cause`                                                                                                                                                                                                                                                     |
| `no-network.test.ts`      | The four-way guard of §2 — the repo-wide scan, the directory-strict scan and the module graph, the booby-trapped global, what is not computed, and eleven planted cases proving each detector fires — and does not fire on a clean file                                                                                                                |
| `projection.test.ts`      | Band boundaries, that no count survives, and that the three run counts are computed rather than subtracted                                                                                                                                                                                                                                             |
| `hash.test.ts`            | `password` → `5BAA6` derived from first principles rather than trusted as a copied constant, and the prefix/suffix split                                                                                                                                                                                                                               |
| `service.test.ts`         | That nothing is built unless both switches say yes, and which reason is reported when not · that the client is dropped on `reset()`, on a policy change and on the opt-in being turned off · that a settings edit which changes nothing does **not** throw the range cache away · that an observer which throws cannot interrupt teardown              |
| `sweep.test.ts`           | That trashed records and records with no password are excluded rather than counted as unchecked · that the default state makes no request at all · that no password and no count survives into the report · that the caller's clock stamps it. **The abort path is asserted only as "the signal is passed through"** — see the deferred-quality ledger |

Outside the directory, two more carry this feature's weight:

| File                                         | Covers                                                                                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/ipc/settings-validation.test.ts` | That `requireBreachCheckPatch` refuses renderer-supplied pacing four ways, including when the value sent is the default                                           |
| `src/main/smoke.ts`                          | `breach-panel-reachable-and-idle` — the panel is in the running app, and it is idle: no report and no error on screen, so nothing ran because a screen was opened |

---

## 9. Related

- [`01-Health-Rules.md`](./01-Health-Rules.md) — the rules that are entirely offline, and the score this one is deliberately kept out of
- [`../00-Overview/03-Threat-Model.md`](../00-Overview/03-Threat-Model.md) — §2, the residual leak this feature accepts
- [`../02-Security/01-Process-Hardening.md`](../02-Security/01-Process-Hardening.md) — the CSP and the empty remote-host allow-list
- [`../12-Roadmap/02-Decision-Log.md`](../12-Roadmap/02-Decision-Log.md) — **D33** (how this reaches the user), D23 (the kill-switch is machine-scoped), D10 (every feature ships a setting), D13 (the safe projection)
