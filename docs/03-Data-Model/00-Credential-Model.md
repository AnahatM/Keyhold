# The credential model

> The record schema, what counts as secret, and the rules that govern changing one.
> Current reference. Implemented by `src/shared/model/credential.ts` and
> `src/main/vault/credential-ops.ts`.

---

## 1. The record

```
Credential
├── id                 UUID v7 — time-sortable, so creation order is free
├── type               'login' (v1; the discriminator exists for the backlog's item types)
├── title, favorite, folderId, tags[], icon
├── fields
│   ├── username, email                    non-secret
│   ├── password                           SECRET
│   ├── urls[]                             non-secret, first is primary
│   ├── securityQuestions[]  { question — non-secret · answer — SECRET }
│   ├── notes                              SECRET
│   └── custom[]         { label, type, value, hidden, order }
├── attachments[]      metadata only; the bytes are separate encrypted chunks
├── meta               createdAt · updatedAt · passwordUpdatedAt · lastUsedAt
│                      useCount · expiresAt · rotationIntervalDays
├── history            enabled · maxVersions · versions[]
└── trashedAt          soft delete, and the sync tombstone
```

### `passwordUpdatedAt` is separate from `updatedAt`

Because the health dashboard asks _"how old is this password"_, not _"when did anything on
this record last change"_. Renaming a record must not make an ancient password look freshly
rotated. `applyPatch` moves it only when the password value actually differs, and there is a
test for exactly that.

### `trashedAt` is a tombstone, not just a flag

The user-facing reason is a Trash they can restore from. The **load-bearing** reason is
sync: a hard delete merged against a device that still holds the record faithfully brings it
back, because a missing record and a never-seen record are indistinguishable. A tombstone
says "this was deleted", which is a fact a merge can act on.

---

## 2. What counts as secret — declared once

`src/shared/model/credential.ts` is the single place this is decided. The projection
builder, the property test, and the secret broker all read from it. A definition that
existed in two places would disagree within a month.

| Always secret                                         | Never secret                      |
| ----------------------------------------------------- | --------------------------------- |
| `password`                                            | `username`, `email`               |
| `notes`                                               | `urls`                            |
| security-question **answers**                         | security-question **questions**   |
| custom fields of type `password`, `pin`, `otp-secret` | other custom types, unless hidden |
| attachment bytes                                      | attachment metadata               |

**`notes` is secret because it is free text.** People keep recovery codes, backup phrases
and PINs in notes constantly, so treating it as ordinary content would quietly defeat the
whole boundary.

**A custom field is secret if its type says so _or_ the user marked it hidden.** Defaulting
the rest to visible is what lets the list show "Account number: 4471" without a round trip,
while leaving the user in control of anything they consider sensitive (decision D10).

### Adding a field is a type error until you classify it

```ts
type _AllCoreFieldsClassified = keyof CredentialFields extends
  SecretCoreField | (typeof NON_SECRET_CORE_FIELDS)[number] ? true : [...]
```

A new field nobody classified would otherwise default to crossing the boundary, and that
failure would be silent. This makes it a compile error.

---

## 3. Custom fields

Thirteen types: `text`, `password`, `email`, `url`, `number`, `date`, `datetime`,
`boolean`, `multiline`, `phone`, `pin`, `otp-secret`, `address`.

Stored in display order with `order` renumbered contiguously on every write, so a later
drag-and-drop never has to reason about gaps.

**Duplicate ids are rejected.** Not cosmetic: the reveal path addresses fields _by id_, so a
duplicate would silently hand back the wrong value — a correctness bug with a security
shape.

---

## 4. Operations, and why they are pure

`credential-ops.ts` holds pure functions over a `VaultDocument`. Nothing there touches a
key, a file, or a clock it did not receive.

That is deliberate. The rules about what a valid record is, what a change means, and what
deletion does are the part most likely to acquire a subtle bug, and keeping them free of
I/O is what lets all 29 of their tests run without unlocking a vault.

Everything returns a **new** document. Mutating in place would make undo — which every
destructive action offers — a matter of carefully reversing each field rather than simply
keeping the previous value.

### `applyPatch` reports what changed

```ts
{ credential, changedFields: ['password', 'title'] }
```

Two consumers need this:

- **A no-op patch returns an empty list**, so the caller skips the save entirely. Without
  it, opening a record and closing it would bump `updatedAt`, create a history version and
  dirty the vault for no user-visible change.
- **Phase 6's history** stores only the fields that moved. A full snapshot per edit would
  grow without bound on a frequently-edited record, and "which fields changed" is a question
  only the code doing the merge can answer cheaply.

### Duplicate regenerates every id

The record's, and each custom field's and security question's. Sharing ids with the
original would make the two records' fields indistinguishable to the reveal path.

History is **not** copied — it belongs to the original record's past, and carrying it over
would attribute edits to a record that did not exist when they happened. Attachments are
not copied either: duplicating a 20 MB PDF because someone wanted a second login is not what
they asked for.

### Trash retention runs on save, not on a timer

A vault that is never opened never loses anything. Retention measured against wall-clock
time while the app was closed would mean opening a vault after a long break silently purges
a trash the user never saw.

---

## 5. Limits, and why there are two sets

|      | `credential-ops`                          | `credential-validation` (IPC)                                                                                |
| ---- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Why  | A record should not bloat the vault       | Ten thousand custom fields arriving over IPC should be rejected before anything validates them one at a time |
| When | Every create and update, including import | Every payload from the renderer                                                                              |

Title 400 chars · fields 64 KiB · notes 1 MiB · 32 URLs · 64 tags · 128 custom fields ·
32 security questions.

---

## 6. Validation treats the renderer as hostile

`src/shared/ipc/credential-validation.ts`. Every object is **rebuilt field by field**, never
spread — a spread carries whatever extra properties the payload contained into a record that
is then encrypted and stored forever.

An unknown custom-field type is **rejected, not defaulted to `text`**. The type decides
whether a value is treated as secret, so guessing it wrong would put a password into the
safe projection.

Create and edit have separate validators, because **absent and empty mean different things
in an edit**: absent is "leave it alone", empty is "clear it". Reusing the create validator
would make every edit a full replacement.

---

## 7. Tests

| File                                    | Covers                                                                                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/vault/credential-ops.test.ts` | Defaults, the change-detection matrix for every tracked field, the no-op case, `passwordUpdatedAt` separation, duplicate id rejection, trash/restore idempotence, retention boundaries |
| `src/main/vault/projection.test.ts`     | The property test that no secret survives projection                                                                                                                                   |
| `npm run test:smoke -- --vault <path>`  | Full CRUD in the running app, **including an assertion that the live IPC surface never returns a password or a note in a projection**                                                  |

That last one is fault-injected: adding a `leaked` field to the projection fails with
`failed checks: projection-has-no-password`.
