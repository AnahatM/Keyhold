# One-time passwords (TOTP)

> RFC 6238 codes from the seeds already sitting in people's vaults, computed in the main
> process, with `now` as a parameter everywhere. Current reference. Implemented by
> `src/main/totp/` and `src/shared/model/totp.ts`.
>
> **Status: the engine is built and tested — 151 tests, including the published RFC 4226 and
> RFC 6238 vectors for all three algorithms. Nothing a user can reach exists.** There is no
> `kh:totp:*` channel in `CHANNELS`, no code display, and no countdown ring. See §8.

---

## 1. The vectors pass, for all three algorithms, and that is the only reason to trust any of it

TOTP has no error detection. A broken implementation and a correct one both emit six digits,
in the right format, at the right moment. The only way to tell them apart is to check against
numbers somebody else computed.

`totp.test.ts` reproduces both appendices exactly:

- **RFC 4226 Appendix D** — the secret `12345678901234567890`, counters 0 through 9, six
  digits, HMAC-SHA1. All ten.
- **RFC 6238 Appendix B** — six instants (59 s, 1111111109, 1111111111, 1234567890,
  2000000000 and 20000000000), eight digits, a 30-second period, for **SHA1, SHA256 and
  SHA512**.

The three RFC keys are not one key at three lengths by accident. HMAC block sizes differ, so
a SHA-512 vector computed with the 20-byte SHA-1 key would exercise a different path in the
key-padding step and prove less. The RFC repeats `1234567890` out to each hash's block size,
and that is what the fixture reproduces.

If those ever stop passing, nothing else in the module is trustworthy.

There is no invented cryptography here (hard rule 3). HMAC comes from Node's `crypto`; the
only arithmetic is RFC 4226's dynamic truncation, which is a byte offset and a modulo. The
mask on the high bit of the first selected byte is in the RFC precisely so the result is a
positive 31-bit integer on every platform, rather than leaving sign handling to the
implementation.

---

## 2. `now` is a parameter, everywhere, and it is not negotiable

Nothing in `src/main/totp/` reads a clock. `now` arrives from the caller in Unix
milliseconds, exactly as `analyseVault` takes its `now`, for three reasons:

1. **The published vectors are times.** Verifying against them requires being able to _say_
   it is 1970-01-01T00:00:59Z. A module that reads `Date.now()` internally can only be tested
   by mocking the global clock, which is a test proving the mock works.
2. **The period boundary is where off-by-one lives**, and the only way to test the instant a
   code rolls over is to name that instant.
3. **A code is a pure function of (seed, parameters, instant).** Making that literally true in
   the signature is what lets a UI pre-compute the next code before the current one lapses,
   and what lets verification walk a skew window without lying about the time.

`totpWindowAt` floors twice — to whole seconds, then to whole periods — rather than dividing
milliseconds by the period in one go. `Math.floor` is correct for negative numbers too, so a
pre-epoch `now` produces a negative counter that `counterToBytes` rejects with a sentence,
instead of a `RangeError` out of a buffer write.

### The window is absolute instants, never "seconds remaining"

`TotpWindow` carries `counter`, `startsAt` (inclusive), `expiresAt` (exclusive) and
`periodMs`. A duration is correct only at the moment it is computed; every millisecond after
that it is a lie, and the lie grows. By the time "23 seconds left" has been serialised, sent
across the contextBridge, put into a store and rendered, some of those seconds are gone — and
if the renderer is busy, or the machine sleeps mid-countdown, the number is wrong by an
unbounded amount with nothing to correct it against.

An absolute deadline does not go stale. The renderer subtracts its own `Date.now()` on every
frame and is right every time. This codebase has already learned the lesson once: the secret
broker's grants carry `expiresAt`, not a TTL countdown.

`totpRemainingMs` clamps to `[0, periodMs]`, because a UI handed `-400` will draw a ring that
has gone backwards past zero. `totpProgress` exists so the ring, the bar and the
"about-to-expire" colour all read the same number — three components each dividing by the
period themselves is three chances to pick a different rounding and disagree on screen.

---

## 3. Base32 rejects rather than producing confidently-wrong digits

A seed reaches the decoder from an `otpauth://` URI, from a CSV another manager wrote, from a
QR code, or from a human retyping what a website printed. Those sources disagree about case,
whitespace, grouping and padding, so `decodeBase32` accepts all of it:

| Input                 | Why                                                                             |
| --------------------- | ------------------------------------------------------------------------------- |
| `jbswy3dpehpk3pxp`    | Lower case — RFC 4648 §3.4 lets a decoder accept either                         |
| `JBSW Y3DP EHPK 3PXP` | Google, GitHub and Microsoft print seeds in groups of four                      |
| `JBSW-Y3DP-EHPK-3PXP` | Some enrolment pages hyphenate instead                                          |
| a non-breaking space  | What a browser copy from a styled `<code>` block actually puts on the clipboard |
| `JBSWY3DPEHPK3PXP`    | Unpadded — the overwhelmingly common form                                       |
| `MFRGG===`            | Padded — what a strict RFC 4648 encoder emits                                   |

**And everything else is refused.** `0`, `1`, `8`, `9`, punctuation, a `=` that is not
trailing, a character count no encoder could produce, and trailing bits that are not zero.

The temptation is to be forgiving: map `0`→`O` and `1`→`L` — both of which _are_ in the
alphabet, which is exactly what makes the confusion so easy to make and so damaging to
"fix" — drop what does not fit, decode what is left. **That is the worst thing this function
could do**, and there is a test for the `0`/`O` case proving it: the repair succeeds, and
yields a valid key that is not the user's key.

A seed that decodes to the wrong bytes does not fail. It produces six digits, in the right
format, at the right moment, that the service rejects — and the user has a working-looking
authenticator that never lets them in, with no way to tell whether the fault is the seed, the
clock, or the service. An error naming the problem is recoverable in seconds; a silently wrong
key ends in "re-enrol everything".

Two consequences of that reasoning worth recording:

- **The lower-case table only twins letters.** Twinning unconditionally would map `2`–`7`
  onto `R`–`W`, which decodes silently and wrongly.
- **A character count of 1, 3 or 6 within a group is refused.** Each 8-character group
  encodes 5 bytes and a partial group of 2, 4, 5 or 7 characters encodes 1, 2, 3 or 4 bytes.
  Nothing else is producible, so such a string has had a character added or lost. Same for
  non-zero trailing bits (RFC 4648 §3.5 permits rejecting them): no conforming encoder makes
  one, so its presence means the string was truncated, retyped wrong, or transposed.

`decodeBase32Secret` returns `SecretBytes`, because that is what the value _is_: a permanent
authentication key. The wrapper is what stops it reaching a log through `toString`, `toJSON`
or `util.inspect`. **The caller owns it and must `destroy()` it.** The raw `decodeBase32` is
kept separate so every production call site is the one returning a `SecretBytes`, and a
reviewer grepping for raw seed bytes finds exactly one function.

`encodeBase32` is unpadded by default and always upper case: `=` in a query string is at best
noise and at worst a parsing hazard, and matching what every authenticator emits means a
Keyhold-generated URI is byte-comparable with the one the service issued.

---

## 4. No error ever echoes its input

A TOTP seed is a permanent second factor — unlike a password it cannot be rotated without
re-enrolling on the service — and errors get logged, screenshotted and pasted into issue
trackers. So no message in `errors.ts` contains the seed, the URI, a fragment of either, or
"near `JBSW…`".

That rules out the shape a parser normally reaches for (`Invalid character "1" in "AB1C"`), so
every message names the **rule that was broken** instead. The one thing allowed through is a
**character position**, because an index is a property of the string's shape rather than of
its content: it tells the user where to look at a value they are already holding, and tells
anyone reading the log nothing about what is there.

`TotpError` is deliberately **not** a `VaultError`. Nothing here means the vault is damaged
or the password was wrong, and borrowing those codes would make a mistyped seed look like a
corrupt container in the UI and in the logs. Four codes: `INVALID_SEED`, `INVALID_URI`,
`UNSUPPORTED_OTP_TYPE`, `INVALID_PARAMETER`.

`errors.test.ts` and a property test in `base32.test.ts` enforce this rather than trusting
anyone to remember it.

---

## 5. Reading `otpauth://`, liberally; writing it, exactly

```
otpauth://totp/Issuer:account@example.com?secret=JBSW…&issuer=Issuer&algorithm=SHA1&digits=6&period=30
         └type┘└──────── label ─────────┘ └──────────────── parameters ────────────────┘
```

`uri.ts` is the boundary where a pile of other applications' habits meets a strict engine, so
it accepts a case-insensitive type, no label at all, a label with no issuer prefix, a
percent-encoded label, `Issuer: account` with a space, `algorithm=SHA-1` hyphenated, absent
parameters, and unknown parameters (ignored — a URI carrying another authenticator's
extension is still a perfectly good TOTP URI).

### The issuer conflict: the query parameter wins

The issuer can appear twice and the two can disagree. Three reasons, in order of weight:

1. **It is unambiguous and the label is not.** The label has to be split on a colon, and
   account names contain colons — a SIP address, a namespaced login, one somebody simply
   typed. Every such label parses with the wrong issuer.
2. **The format treats the parameter as authoritative.** The label prefix is legacy
   compatibility for readers that predate the parameter.
3. **The parameter survives handling.** Label prefixes get rewritten by applications that
   re-display and re-export a code; the parameter is copied verbatim far more often.

The disagreement is **not** silently discarded: the label's issuer comes back as `labelIssuer`
with an `issuerMismatch` flag, so a UI can say "this link says Big Corp in one place and
BigCorp in another" rather than picking one and pretending. Case and surrounding whitespace
are not a mismatch — flagging `GitHub` against `github` would be noise on a real difference of
nothing.

### HOTP is refused loudly

An `otpauth://hotp/` link throws `UNSUPPORTED_OTP_TYPE`. HOTP means storing a counter,
incrementing it on every use, persisting that increment atomically, and resynchronising when
the user generates a code they never type — none of which exists, and half of which would be a
data-integrity feature rather than a crypto one. Treating one as time-based would produce six
digits that look exactly like a valid code and are always wrong, which is the worst failure
mode this module has, because the user would blame the service. The error says the seed has
been kept, so nothing is lost if HOTP is ever added.

`hmacOtpSecretCode` is exported anyway, because it is the primitive TOTP is defined in terms
of and because RFC 4226 publishes vectors for it. Exporting it is not support for HOTP
accounts.

### RFC 6238's `T0` is deliberately unsupported

The Key Uri Format has no way to express an epoch offset, so a `T0` set here could not survive
an export, an import, or a move to another authenticator — a value the vault could hold and
never round-trip. Nothing in the wild uses it.

---

## 6. Parameters: reject rather than fall back

| Parameter                | Default (absent) | Accepted range                                         |
| ------------------------ | ---------------- | ------------------------------------------------------ |
| `algorithm`              | `SHA1`           | `SHA1`, `SHA256`, `SHA512` — any case, hyphen optional |
| `digits`                 | `6`              | 6 – 10                                                 |
| `periodSeconds`          | `30`             | 1 – 86,400                                             |
| skew steps (verify only) | `1`              | 0 – 10                                                 |

The defaults are not preferences — they are what the Key Uri Format specifies and what every
other authenticator assumes, and differing by one would produce confidently wrong codes for
every URI that omits a parameter, which is most of them.

`minDigits` is 6 because RFC 4226 requires it and a shorter code is brute-forceable inside one
period. `maxDigits` is 10 because dynamic truncation yields a 31-bit integer, so an eleventh
digit would be a leading zero on every code — not more security, just a wider box.
`maxPeriodSeconds` is a day: nothing real uses more than 60, but the bound exists so a
malformed `period=99999999999` is rejected by a rule rather than by whatever the arithmetic
happens to do.

**Every function throws on an unreadable value rather than substituting the default.** A URI
saying `algorithm=SHA-3` is not a URI that meant SHA-1, and quietly generating SHA-1 codes for
it would produce the same failure the base32 decoder refuses to produce. The one place a
default _is_ used is a parameter that is genuinely absent, which the format defines as meaning
the default.

`normaliseDigits` does not use `Number.parseInt`, which reads `8abc` as 8 and `8.5` as 8 — a
malformed parameter silently accepted as a well-formed one. A `^\d+$` test comes first.

`assertTotpParameters` re-checks at the point of use, and is not redundant with the parsers:
parameters also arrive from the vault file, from an IPC payload and from a merge, none of
which went through `normaliseDigits`. Types are erased at runtime, so it is the only thing
standing between a hand-edited `"digits": 0` and a division that yields `NaN`.

---

## 7. Verification has a skew window; generation must not

TOTP's one real-world failure mode is a wrong clock. A machine thirty seconds slow produces
the previous step's code, the service rejects it, and nothing anywhere says why. So
`verifyTotpSecretCode` accepts one step either side by default, which covers the drift an
unsynchronised machine accumulates in practice. It is a real trade: it triples the codes an
attacker may guess at any instant, three of 10⁶ rather than one.

`TotpVerification.skewSteps` reports **which** step matched — 0, −1, +1 — rather than
swallowing it, because that is a diagnosis. A user whose codes only ever match at −1 has a
clock roughly a period slow, which is the single most common cause of "my authenticator
stopped working" and is invisible from a plain true/false.

**Generation gets no such tolerance and must not.** A generated code goes to somebody else's
verifier, which has its own window; widening ours would just move the guess. There is no
"probably right" code to emit — there is the code for the step we are in, and if our clock is
wrong the honest fix is to fix the clock. A caller that wants a neighbouring step asks for it
by name, by passing a different `now`.

Two details in the comparison:

- **`timingSafeEqual`, and every step is compared even after one has matched.** The time taken
  depends on the window size and nothing else. A short circuit would leak which step matched
  through timing — weak, but free to avoid.
- **A wrong-length candidate is rejected without a compare**, after stripping the spaces and
  hyphens humans type. Length is a property of the format, not of the secret.

---

## 8. What is already in people's vaults, and what is not built

This is the reason the engine was worth building before a UI. The record model has had an
`otp-secret` custom-field type since the field system landed, and **eight import parsers
already write into it** — `bitwarden-csv`, `bitwarden-json`, `lastpass-csv`, `dashlane-csv`,
`onepassword-csv`, `safari-csv`, `keepass-csv` and the generic CSV mapper. Until
`secret-field.ts` existed there was nothing that could do anything with them.

Those parsers store whichever form the source gave, and the sources disagree:

- **A full `otpauth://` URI** — Safari, 1Password and Bitwarden's JSON export.
  `safari-csv.ts` explicitly keeps the whole URI rather than reducing it to the seed, because
  reducing it would throw away everything a TOTP implementation needs beyond the seed itself.
- **A bare base32 seed** — LastPass and many CSVs. The algorithm, digits and period are simply
  not known, and the format's defaults apply.

`parseOtpSecretField` handles both and **reports which arrived** (`TotpSecretSource`), because
it changes what a UI can honestly say: for a bare seed, "SHA-1, 6 digits, 30 seconds" is an
assumption, not a fact read from the record. `totpSecretCodeFromField` and
`verifyTotpSecretCodeAgainstField` destroy the key in a `finally`, including on the error path
— the path where a leaked key matters most.

`src/main/export/generic-csv.ts` already hoists the first `otp-secret` field back into
Bitwarden's `login_totp` column, so the round trip out is closed too.

### Not built yet

- **The IPC channel.** No `kh:totp:*` entry in `CHANNELS`. `totpSecretCodeFromField` is
  written to be the handler's entry point — one field value in, one code and its absolute
  expiry out, no key material outliving the call — and there is no handler.
- **The code display and countdown ring.** `TotpWindow`, `totpRemainingMs` and `totpProgress`
  are shaped for it and nothing renders them.
- **Copying a code**, which should go through the same broker, rate limit and clipboard rules
  as a revealed password.
- **An enrolment UI** — pasting a URI, scanning a QR code, or entering a seed by hand. There
  is no QR decoder in the project and adding one is a dependency decision, not an oversight.
- **`buildOtpauthSecretUri` has no caller.** The writer exists and round-trips against the
  parser in the tests; nothing offers the user a URI or a QR code to move an account
  elsewhere.
- **HOTP.** Refused by design — see §5.
- **The `missing-2FA` health rule.** Named in roadmap Phase 13 as needing a model decision,
  since there is no dedicated 2FA field to key it off; an `otp-secret` custom field is the
  closest thing and the rule does not yet exist.
- **One duplicate to fold in.** `looksLikeOtpUri` in `src/main/import/mapping.ts` predates
  this module and asks the same question as `isOtpauthUri` with its own copy of the same
  regular expression. Folding it in is recorded rather than done, because that file belongs to
  the importers.

---

## 9. Tests

151 in `src/main/totp/`.

| File                   | Tests | Covers                                                                                                                                                                      |
| ---------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base32.test.ts`       | 56    | The RFC 4648 §10 vectors · every accepted spelling · every rejection, including the `0`/`O` case that proves a "helpful" repair yields the wrong key · the no-echo property |
| `uri.test.ts`          | 48    | Every variation that turns up in the wild · the issuer conflict and the mismatch flag · the HOTP refusal · round-tripping through the writer                                |
| `totp.test.ts`         | 27    | RFC 4226 Appendix D · RFC 6238 Appendix B for all three algorithms · the period boundary · the skew window and the reported step                                            |
| `errors.test.ts`       | 13    | That no message contains any part of its input, and that a position is the only thing that gets through                                                                     |
| `secret-field.test.ts` | 7     | Both stored forms, the reported source, and that the key is destroyed on both paths                                                                                         |

---

## 10. Related

- [`../03-Data-Model/`](../03-Data-Model/_INDEX.md) — `otp-secret` and `SECRET_CUSTOM_FIELD_TYPES`, which classify a seed alongside a password
- [`../09-Import-Export/00-Import-Formats.md`](../09-Import-Export/00-Import-Formats.md) — the eight parsers that already write these seeds
- [`../09-Import-Export/01-Export-Formats.md`](../09-Import-Export/01-Export-Formats.md) — the `login_totp` hoist on the way out
- [`../02-Security/00-Cryptography.md`](../02-Security/00-Cryptography.md) — why Argon2id is the project's password hash and SHA-1 here is not one
- [`../12-Roadmap/02-Decision-Log.md`](../12-Roadmap/02-Decision-Log.md) — D13, why the seed never reaches the renderer
