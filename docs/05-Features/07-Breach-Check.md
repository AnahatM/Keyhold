# The breach check

> Keyhold's single, opt-in, off-by-default exception to "this application makes no network
> requests". Current reference. Implemented by `src/main/breach/` and
> `src/shared/model/breach.ts`.
>
> **Status: the client, the transport and the projection are built and tested — 142 tests,
> including a structural guard that reads the source of every file in the directory. Nothing
> a user can reach exists.** There is no `kh:breach:*` channel in `CHANNELS`, no setting to
> turn it on, and no composition root that builds the transport — so today the client is
> constructed with none and answers `unknown` / `disabled` without hashing anything. See §7,
> and read §6 before touching the CSP.

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
identifying the account is sent in any form** — no username, no URL, no title, no record id,
and no ordering that would let requests be grouped back into one person's vault.

A network observer learns that Keyhold asked about _something_. That residual leak is recorded
in [`../00-Overview/03-Threat-Model.md`](../00-Overview/03-Threat-Model.md) §2 — _what
Keyhold does not protect against_ — rather than hidden.

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

`no-network.test.ts` checks this three ways, because a behavioural test alone would pass for a
module that merely happened not to be called:

1. **Structurally, over the source.** No file in `src/main/breach/` other than
   `https-transport.ts` may so much as _name_ a network API — `fetch`, `XMLHttpRequest`,
   `WebSocket`, `EventSource`, `sendBeacon`, `node:http`/`https`, `node:net`, `node:tls`,
   `node:dns`, `node:dgram`, an import from `electron`, or a literal `http(s)://` URL — and
   the transport must be unreachable from `client.ts` through **any chain of imports**, walked
   transitively rather than one level deep. The APIs are named rather than pattern-matched on
   "http" so the failure message says which capability appeared.
2. **Behaviourally, with `fetch` booby-trapped** for the whole file, so a request attempted
   anywhere below fails loudly here rather than quietly succeeding on somebody's machine.
3. **By what is not computed.** `passwordRange` is spied on and must never be called. That is
   the difference between a feature that is off and one that is merely quiet.

There is deliberately **no test that makes a real request**. The range API is free and public,
and hitting it from a test suite would still be wrong: it would leak the fact that this
machine ran these tests, it would flake on a plane, and it would make the suite's result
depend on somebody else's uptime.

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
memory-only, bounded (128 ranges by default), and dropped by `clearCache()`, which the lock
path should call. Bodies are cached rather than parsed maps, because the string is smaller
than the `Map` built from it and because re-parsing on a hit means a cached answer and a
fresh one go through identical code.

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

## 7. Not built yet

- **The IPC channel.** No `kh:breach:*` entry in `CHANNELS`.
- **The setting.** `DEFAULT_BREACH_CHECK_SETTINGS` exists in `@shared`, and there is no
  settings surface that reads or writes it, and no persistence for it.
- **The composition root.** Nothing calls `createHttpsTransport()` and hands the result to a
  client. Until something does, the feature is off in the strongest available sense —
  see §2.
- **The health-dashboard integration.** `BreachProjection` and `BreachReport` are shaped for
  the dashboard and nothing renders them. The eight offline health rules are unaffected: they
  are, and remain, entirely local.
- **A security audit of this code.** Roadmap Phase 17 records `breach/` as **the project's
  first network code**, landed after the security sweep, and says plainly that it needs its
  own pass before it ships. That is outstanding.
- **Cancellation from a UI.** `BreachRunOptions.signal` is honoured end to end and there is
  nothing to press.

---

## 8. Tests

142 in `src/main/breach/`.

| File                      | Tests | Covers                                                                                                                                                                                                           |
| ------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.test.ts`          | 36    | Every failure producing `unknown` and never `safe` · prefix deduplication and cache reuse against an injected fake · the property that nothing returned names the password, its digest, its prefix or its suffix |
| `range.test.ts`           | 27    | Strict line parsing, padding rows, the count cap, case-insensitive matching, and each of the three faults                                                                                                        |
| `https-transport.test.ts` | 23    | That `Add-Padding` is sent on every request · the fixed origin and prefix validation · the capped body read · `Retry-After` normalisation                                                                        |
| `transport.test.ts`       | 19    | Status classification and thrown-error classification, including reading `fetch`'s wrapped `cause`                                                                                                               |
| `no-network.test.ts`      | 14    | The three-way guard of §2 — source, behaviour, and what is not computed                                                                                                                                          |
| `projection.test.ts`      | 13    | Band boundaries, that no count survives, and that the three run counts are computed rather than subtracted                                                                                                       |
| `hash.test.ts`            | 10    | `password` → `5BAA6` derived from first principles rather than trusted as a copied constant, and the prefix/suffix split                                                                                         |

---

## 9. Related

- [`01-Health-Rules.md`](./01-Health-Rules.md) — the eight rules that are entirely offline, and the report this one would join
- [`../00-Overview/03-Threat-Model.md`](../00-Overview/03-Threat-Model.md) — §2, the residual leak this feature accepts
- [`../02-Security/01-Process-Hardening.md`](../02-Security/01-Process-Hardening.md) — the CSP and the empty remote-host allow-list
- [`../12-Roadmap/02-Decision-Log.md`](../12-Roadmap/02-Decision-Log.md) — D10 (every feature ships a setting) and D13 (the safe projection)
