# The IPC surface

> Every channel, what it validates, and the two places secret material deliberately crosses.
> Current reference. Implemented by `src/shared/ipc/`, `src/main/ipc/register.ts` and
> `src/preload/index.ts`.

---

## 1. The three files, and why it takes three

| File                             | Owns                                                                     |
| -------------------------------- | ------------------------------------------------------------------------ |
| `src/shared/ipc/api.ts`          | The contract: channel names, the `KeyholdApi` shape, the result union    |
| `src/shared/ipc/*-validation.ts` | Runtime validation, because TypeScript is erased before any of this runs |
| `src/main/ipc/register.ts`       | The handlers, the error scrubber, and the allow-list                     |
| `src/preload/index.ts`           | The bridge — every member enumerated by hand                             |

The contract is in `@shared` so both sides import the same names; a renderer that typed a
channel string itself would be one typo away from a silent no-op.

---

## 2. The channel groups

| Group         | Needs an open vault | Notes                                                              |
| ------------- | ------------------- | ------------------------------------------------------------------ |
| `app`         | no                  | Version and platform                                               |
| `session`     | no                  | Unlock, lock, file dialogs, clipboard, quick unlock                |
| `vault`       | mixed               | Inspect, create, unlock, save, summary                             |
| `credentials` | yes                 | List, get, reveal, deep search, full CRUD                          |
| `generator`   | **no**              | Generation is pure; choosing a password before unlocking is normal |
| `health`      | yes                 | The offline analysis                                               |
| `history`     | yes                 | Diffs, restores, clearing, and the network-name probe              |

---

## 3. Secret material crosses in exactly two places

Everything else is a projection. These two are deliberate, and both are bounded.

**`credentials.revealSecret`** — one `SecretRef` at a time, through the broker: rate-limited,
TTL-scoped, and dropped entirely on lock. The eight ref kinds are a closed union rather than
a path string, so the set of askable things is finite and reviewable rather than parsed. The
four `historic-*` kinds carry a version number, and that number is part of the broker key —
so walking a record's whole password history costs one grant per version rather than one in
total.

**`generator.generate`** — returns the password in plaintext. That is a bounded exception,
not an oversight: the renderer has to render it, that _is_ the feature, and what crosses is
one value the user just asked to see, not yet stored anywhere and not yet attached to an
account. Decision D13 is about the renderer never holding _the vault's_ secrets; one
freshly-generated string is a different proposition. It is written down here so that if it
ever stops being true — a generator that silently saves, say — the exception is visible
rather than assumed.

### Everything else is projected first

- `credentials.list/get` → `CredentialProjection` (`src/main/vault/projection.ts`)
- `history.diff/compare` → `FieldDiffProjection` (`src/main/history/diff-projection.ts`)
- `health.analyse` → `VaultHealthReport`, which contains no secret by construction

The history diff is the second projection boundary in the codebase and follows the first
one's rules exactly: built field by field rather than spread, and a fact _about_ a secret
(its length) is not the secret. `VaultService` exposes the raw `diffVersion` and the
projected `diffVersionProjection` as **separate methods** rather than one method with a
flag, so the raw form cannot be sent by passing the wrong boolean.

---

## 4. Validation treats every payload as hostile

Every handler validates before touching the vault. Three rules the validators follow:

**Objects are rebuilt field by field, never spread.** A spread carries whatever extra
properties the payload contained into something that gets encrypted and stored forever.

**Unknown names are rejected, not ignored.** An unknown custom-field type would decide
wrongly whether a value is secret. An unknown health rule id would silently disable nothing.
An unknown versioned field would make a restore button do nothing at all, which is the
hardest kind of bug for a user to report.

**Bounds live where they are enforced, not in the validator.** `requireGeneratorOptions`
checks that a length is a positive whole number and stops there; `GENERATOR_LIMITS` lives in
the engine and the engine enforces it. A second copy of "length is 8 to 256" in the
validation layer is a second list, and it disagrees the first time either changes.

That is also why `generator.limits` exists as a channel: the UI reads the bounds and
defaults across the contract instead of restating them. A slider with `min={8}` typed into
it is exactly the second list this rule is about.

---

## 5. Errors are scrubbed, always

No error crosses raw. `toFailure` maps the known cases to structured codes and turns
everything else into a fixed sentence, because an arbitrary error message can carry a
filesystem path, a filename, or — from a crypto library — a fragment of what was being
processed. The real cause is logged in the main process, where it stays.

The exceptions are errors written _for_ a user and checked to be safe:

- `VaultError` — the message is the user-facing explanation.
- `RateLimitExceededError` — says what tripped and how to reset it.
- `IpcValidationError` — names the field, never its value.
- `GeneratorConfigurationError` — names the character class at fault and deliberately never
  echoes the user's exclusion string back.

---

## 6. The preload bridge

Four rules, and all four are about the same thing: the bridge is the whole boundary, so
nothing generic may cross it.

1. **Every member is enumerated by hand.** No `invoke(channel, ...args)` helper — one of
   those would undo the allow-list, letting the renderer call any handler, including ones
   added later by someone who never read this page.
2. **Nothing here holds state.** It forwards and returns. No caching a revealed secret.
3. **Secrets cross only per explicit request**, one item at a time.
4. **Events are subscribe-only on fixed channels.** No general `on(channel, fn)`.

If `contextIsolation` is ever off, the bridge **throws** rather than degrading to putting
the API on `window` for any page script to reach.

---

## 7. The launch smoke test is part of this surface

`npm run build && npm run test:smoke` drives 40 checks through the **real** IPC surface in a
real Electron process. It exists because the defect class it was written for — a
sandboxed-ESM preload — builds cleanly, launches cleanly, and silently leaves
`window.keyhold` undefined. No unit test catches that.

It now also asserts the boundary properties that only exist end to end:

- A projection returned over IPC contains no password and no note body.
- A history diff reports a password change as a **length**, and the serialised diff contains
  no old password.
- An old password is still reachable through the broker, so the guard above is about the
  diff rather than about the value being unrecoverable.
- A health report contains no secret.
- The generator refuses an impossible configuration, and its error does not echo the user's
  exclusion string back.

Both leak guards are fault-injected. Making `toDiffProjection` pass the value through where
it should pass a length fails with
`SMOKE-FAIL failed checks: history-diff-reports-a-password-change-as-a-length, history-diff-has-no-secret-value`.

**The runner refuses to run against a stale build.** That check exists because of a real
mistake made while fault-injecting: the build failed its typecheck, the smoke test ran
happily against the previous build, and reported a pass. A smoke test that silently tests
code you are not looking at is worse than none — it produces confident wrong answers.
