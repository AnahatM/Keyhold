# Health rules

> The offline vault analysis: what it checks, how it scores, and why the report can never
> carry a password. Current reference. Implemented by `src/main/health/rules.ts`.
>
> **Status: the rules engine is built and tested; the IPC channel, the dashboard and the
> opt-in HIBP check are not.** See §6.

---

## 1. The rules

`analyseVault(document, options)` is pure — no I/O, no clock of its own. `now` is a
parameter, so the tests are deterministic.

| Rule                   | What it flags                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `reused`               | The same password on more than one record. Reports the whole **cluster**, because the user needs to know which records to fix |
| `weak`                 | Password entropy below a threshold                                                                                            |
| `old`                  | `passwordUpdatedAt` older than the configured age                                                                             |
| `expired` / `expiring` | Via `expiresAt` or `rotationIntervalDays` measured from `passwordUpdatedAt`                                                   |
| `insecureUrl`          | An `http://` URL, ignoring `localhost` and `127.0.0.1` which are legitimately plain HTTP                                      |
| `incomplete`           | No password, or no username **and** no email                                                                                  |
| `duplicate`            | Same normalised URL host **and** same username/email — two records for one account                                            |
| `emptyTitle`           | A record with no title is unfindable by search                                                                                |

**Trashed records are excluded from every rule.** Someone who deleted a weak password has
dealt with it; continuing to score them down for it would train them to ignore the
dashboard.

**Expiry takes the earlier of `expiresAt` and the rotation interval**, so one setting cannot
quietly cancel the other.

**`weak` and `old` skip records with no password**, which `incomplete` already flags —
otherwise one defect is penalised twice and the score reads worse than the vault is.

---

## 2. The report never contains a password

This is the constraint everything else is shaped around, because a health report crosses to
the renderer and the renderer must never hold secret material (decision D13).

The report carries **record ids, counts and severities**. Nothing derived from a password.

Three specific decisions this forced:

**Reuse cluster ids are synthetic counters** (`reused-1`), deliberately _not_ a hash of the
shared password. A hash would be a stable, offline-attackable handle on the password itself
crossing the boundary.

**`insecureUrl` reports the host, never the URL.** A URL can carry credentials in its
userinfo (`http://user:pass@host/`), so copying the raw URL into the report would be a real
leak. The property-test fixture plants a marker in exactly that position.

**An empty password is not "reused"**, even though many records may share `''`.

The guard is a property test: plant a recognisable marker in every password in a fixture
vault, serialise the whole report, assert the marker appears nowhere. Fault injection —
setting a cluster's label to the shared password — fails it four ways.

---

## 3. Entropy here is a cheap heuristic, and says so

The classic `length × log2(pool)` model, counting code points rather than UTF-16 units. No
new dependency.

Its limits are documented bluntly in the function: it does not know about dictionary words,
dates, keyboard walks or l33t substitutions, so `Anahat1998!` scores 72 bits and is
guessable in seconds. It **over-estimates human passwords and is accurate for generated
ones** — which makes it a lower bound on badness: a password it calls weak really is weak.

zxcvbn is already a project dependency and is deliberately _not_ used here. It costs
megabytes of dictionaries and milliseconds per password; over thousands of records, every
time the dashboard opens, that is the wrong trade. zxcvbn is used where a single password is
being chosen — the master password — and this heuristic is used where thousands are being
swept.

---

## 4. Scoring is arguable, not magic

```
score = 100 − (average per-record penalty)
```

Weights: `reused` 30 · `weak` 25 · `expired` 15 · `old` 10 · `insecureUrl` 10 ·
`duplicate` 6 · `incomplete` 5 · `expiring` 3 · `emptyTitle` 3.

**Reuse tops the list because it is the only failure that spreads** — one breach compromises
every record sharing that password. `weak` sits just below: it falls to an offline attack but
compromises exactly one account. `old` is well below `weak` because age is a proxy for risk,
not risk itself. The tail is hygiene and findability rather than exposure.

Two deliberate properties, both tested:

**The cap is not renormalised to the enabled rule set.** Renormalising would change the score
of a vault that never broke the rule you just switched off. As written, disabling a rule can
only raise the score or leave it — a property test asserts this for every rule.

**The score is reproducible from the report itself** — a test asserts
`score === round(100 − Σ penalty / analysedCount)`, so the number on the dashboard can be
audited rather than taken on faith.

An honest edge: some rules are mutually exclusive on one record (`incomplete` needs the
absent password that `weak` and `reused` require). The worst mutually-consistent combination
totals **99**, so a maximally-broken vault scores 1, not 0. The weights were left round
rather than tuned to hit 100, and the 99 is pinned in a test so a weight change breaks a test
rather than a paragraph of prose.

---

## 5. Duplicate detection, and its stated limit

Identity is username, falling back to email. **A record identified by username and its twin
identified only by email will not match.**

That asymmetry is deliberate: a missed duplicate costs a suggestion nobody sees, while a
false one tells the user to merge two genuinely different accounts.

---

## 6. Not built yet

- The IPC channel, the dashboard view, and per-rule settings persistence.
- **The opt-in HIBP breach check.** Deliberately absent — no network code, no stub, no
  fetching import anywhere in these files. It is a separate, off-by-default piece of work
  behind a plain-English explainer.
- **A `missing-2FA` rule.** Listed in the roadmap, but the record model has no 2FA field to
  key it off — only a generic `otp-secret` custom-field type. It needs a design decision
  rather than a guess.
- **Score history over time**, which needs a `VaultDocument` field.

A guard test asserts `DEFAULT_HEALTH_THRESHOLDS.passwordAgeWarningDays` equals
`DEFAULT_VAULT_SETTINGS.passwordAgeWarningDays`, per the "no second list" rule.
