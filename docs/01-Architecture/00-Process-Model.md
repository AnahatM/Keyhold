# Process model & the IPC contract

> How the two processes divide responsibility, what may cross between them, and why.
> Current reference.
>
> The security controls on the window itself are in
> [`../02-Security/01-Process-Hardening.md`](../02-Security/01-Process-Hardening.md).

---

## 1. The division

|                        | Main process                                               | Renderer process                                                       |
| ---------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| Runtime                | Node                                                       | Chromium, sandboxed                                                    |
| Trust                  | Trusted                                                    | **Semi-trusted**                                                       |
| Holds                  | KEK, DEK, the decrypted document, all crypto, all file I/O | The **safe projection** and UI state                                   |
| Never holds            | —                                                          | Passwords, note bodies, security answers, TOTP seeds, attachment bytes |
| Talks to the other via | `ipcMain.handle`                                           | `window.keyhold.*`, through the preload                                |

The renderer is treated as compromisable because it runs a large dependency tree and a
DOM. That is decision D13, and everything below follows from it.

---

## 2. Module map

```
src/
  shared/                  compiled for BOTH environments — types and pure logic only
    ipc/api.ts             the contract: channel names + the window.keyhold shape
    ipc/validation.ts      runtime validators used on both sides
    model/credential.ts    the record model AND the declaration of what counts as secret
    model/vault-document.ts the decrypted vault body, settings, summaries
    format/types.ts        KEEP container constants and types

  main/                    everything that touches keys or the filesystem
    crypto/                secret.ts · random.ts · kdf.ts · aead.ts · envelope.ts · errors.ts
    format/                container.ts · header.ts · migrations.ts
    vault/                 vault-service.ts · projection.ts · secret-broker.ts · atomic-write.ts
    ipc/register.ts        handler registration, validation, error scrubbing
    security.ts            CSP, hardened webPreferences, navigation lockdown
    window.ts · index.ts · smoke.ts

  preload/index.ts         the contextBridge. The only channel between the two.

  renderer/                React. No Node, no secrets.
```

**Why crypto is in `main/` and not `shared/`** (decision D22): `@shared` is compiled by the
renderer's tsconfig, so anything there importing `node:crypto` fails to type-check — and,
far more importantly, putting key derivation somewhere the renderer can `import` it is the
opposite of what D13 exists to enforce. `@shared` holds types and constants; `main` holds
implementations. The renderer lint zone makes `import … from '@main/*'` a hard error, so
this is enforced rather than merely intended.

---

## 3. The safe projection

`src/main/vault/projection.ts` builds the only view of a credential that may cross.

| Crosses                                                             | Never crosses                                     |
| ------------------------------------------------------------------- | ------------------------------------------------- |
| title, username, email, urls, tags, folder, favourite, icon         | password, notes                                   |
| security-question **prompts**                                       | security-question **answers**                     |
| custom-field labels, types, order                                   | values of secret-typed or user-hidden fields      |
| attachment metadata (name, size, mime, hash)                        | attachment bytes                                  |
| `hasPassword`, `passwordLength`, `hasNotes`                         | the values themselves                             |
| history: version number, timestamp, changed-field names, **origin** | version `snapshot` — those are previous passwords |
| all timestamps, use counts, rotation settings                       | —                                                 |

Two design points:

**A fact _about_ a secret is not a secret.** `hasPassword` and `passwordLength` let the UI
render a correctly-sized masked field and distinguish "not set" from "hidden" without
carrying anything usable. Length is a very small leak and a deliberate, bounded trade.

**The projection is built field by field, never by spreading and deleting.** A spread is
additive by default, so a field added to `Credential` later would silently start crossing
the boundary and nothing would fail. Explicit construction means a new field simply does
not appear until someone deliberately adds it — the correct default for a security
boundary.

### The guard

`src/main/vault/projection.test.ts` plants a unique marker in **every** secret position,
projects the record, and asserts no marker survives anywhere in the serialised output.

Because it hunts for markers rather than checking named fields, it cannot be defeated by a
_new_ field being added and forgotten — which is exactly what a hand-written per-field
assertion would miss.

Fault-injected three ways, all caught: spreading instead of building explicitly; including
`version.snapshot`; ignoring the user's `hidden` flag.

---

## 4. Getting a secret out, deliberately

The renderer must still be able to reveal a password when the user clicks reveal. That is
the one hole in the wall, and it is shaped to stay small:

```
renderer          preload            main
   │                 │                 │
   │ revealSecret(ref)                 │
   ├────────────────►│ invoke          │
   │                 ├────────────────►│ validate the ref  (closed union, not a path string)
   │                 │                 │ broker.grant()    (rate limit + TTL)
   │                 │                 │ look up ONE value
   │                 │◄────────────────┤ IpcResult<string | null>
   │◄────────────────┤                 │
```

- **One secret per request.** There is no bulk call. A compromised renderer must ask for
  each secret individually — slow, visible, and impossible while locked.
- **`SecretRef` is a closed discriminated union**, not a free-form path. A path string
  would let the renderer ask for anything and force the main process to decide safety by
  parsing. The set of askable things is finite and reviewable.
- **Every grant expires** (default 30 s) whether or not anything uses it.
- **Rate-limited** (default 60 per minute). Not a serious defence against a determined
  attacker — it can wait — but a tripwire for the case that matters: a bug or hostile
  dependency looping over every record. A human never approaches it.
- **Everything is revoked on lock.**

### Deep search

The renderer cannot search notes, security answers or hidden custom values — it does not
have them. Rather than sending them over so it can, the search runs in the main process
and **only matching ids come back**. The renderer already holds the projections needed to
render results.

---

## 5. The IPC contract

Channel names and the `window.keyhold` shape live together in `src/shared/ipc/api.ts` —
one source of truth, imported by the preload, the renderer and the handlers. The "no
second list" rule applied to the most dangerous list in the codebase.

Naming: `kh:<domain>:<action>`.

### Everything is validated at runtime, on both sides

TypeScript is erased at runtime. A handler typed `(path: string)` will cheerfully receive
`undefined`, an object, or a 500 MB string. `src/shared/ipc/validation.ts` is the actual
type check:

- every string is length-capped (1 MiB) — an uncapped string is a trivial OOM
- ids match a strict allow-list pattern, so one can never carry a path traversal or a
  separator that changes meaning when interpolated
- paths are rejected if they contain a NUL byte
- `SecretRef` is validated branch by branch and **rebuilt field by field**, so a smuggled
  extra property cannot ride along into code that later spreads it
- an unknown discriminant is rejected outright, never defaulted

Validators never echo the offending value — it could be a password, and the message is
destined for a log.

### Errors are structured and scrubbed

Handlers return `IpcResult<T>`, a discriminated union, and **never throw across the
bridge**. An unhandled throw in `ipcMain.handle` serialises the error's message and stack
into the renderer, and a stack carries absolute filesystem paths — a small but free
information leak on every error, forever.

| Code                                                                             | Meaning                                                                                                                                              |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WRONG_PASSWORD`                                                                 | Recoverable. Retry with a different password                                                                                                         |
| `TAMPERED`                                                                       | The password was right; the file has changed                                                                                                         |
| `NOT_A_VAULT`, `UNSUPPORTED_VERSION`, `MALFORMED`, `TOO_LARGE`, `BAD_KDF_PARAMS` | See the format spec                                                                                                                                  |
| `RATE_LIMITED`                                                                   | Too many reveals in the window                                                                                                                       |
| `INVALID_REQUEST`                                                                | Failed validation                                                                                                                                    |
| `INTERNAL`                                                                       | A bug. Reports **that** it happened, deliberately not what — an arbitrary error message may contain a path or a fragment of the data being processed |

---

## 6. The preload

`src/preload/index.ts`. Every member enumerated by hand.

`ipcRenderer` is never exposed, and no exposed function takes a channel name from its
caller. A single `invoke: (channel, ...args) => …` helper would undo the entire
allow-list — the renderer could then reach any registered handler, including ones added
later by someone who never considered this file.

It holds no state, and it throws rather than loading without `contextIsolation`.

**It is built as CommonJS**, because Electron runs sandboxed preloads with no ESM context.
An `.mjs` preload builds cleanly, launches cleanly, and silently never runs. See decision
D20 and `npm run test:smoke`.

---

## 7. The vault lifecycle

```
   closed ──create/unlock──► unlocked ──save──► unlocked
      ▲                          │
      └────────── lock ──────────┘
```

`lock()` destroys the DEK, drops the document reference, and revokes every outstanding
grant. It is idempotent, so it is safe from a `finally`, a `window-all-closed` handler and
a `will-quit` handler that may all fire for one shutdown — and all three call it.

**`lock()` deliberately does not save.** An auto-lock on idle must never write, because
writing unattended is how a half-finished edit becomes the saved state. Unsaved changes
are prompted about while the user is still there.

---

## 8. Tests

| Concern                                                | File                                       |
| ------------------------------------------------------ | ------------------------------------------ |
| The secret boundary (property test + fault injections) | `src/main/vault/projection.test.ts`        |
| Lifecycle, locking, reveals, deep search               | `src/main/vault/vault-service.test.ts`     |
| Grant expiry, revocation, rate limiting                | `src/main/vault/secret-broker.test.ts`     |
| Runtime validation, including `SecretRef`              | `src/shared/ipc/validation.test.ts`        |
| A real end-to-end IPC round-trip in the launched app   | `src/main/smoke.ts` + `npm run test:smoke` |

The smoke test is the only check that catches a handler that was never registered or a
channel name that drifted between the contract and the preload — unit tests exercise the
handler function, not its registration. Fault-injected by removing a handler; caught.
