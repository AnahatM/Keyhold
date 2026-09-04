# Deferred quality — tests and documentation owed

> **The debt ledger.** Keyhold is in a build-fast phase: features ship with a lightweight
> doc skeleton and only the tests that protect data or secrets. Everything skipped is written
> down here, in the same commit that skipped it, so the debt is visible rather than forgotten.
>
> This file is a queue, not a record. Entries leave it by being done.

---

## The rule that put things here

**Ship the feature. Write down what it is missing. Move on.**

Three things are never deferred, because getting them wrong costs a user their data or their
secrets rather than costing us an afternoon:

1. **Anything touching crypto, the KEEP container, atomic writes, or the merge engine.**
2. **Anything that could put a secret in a projection, a log, an error or a URL.**
3. **Anything that decides whether the app may reach the network.**

Everything else — component tests, presentation tests, exhaustive refusal cases, prose
documentation, decision-log entries longer than a paragraph — goes below and gets done in a
later pass.

---

## How to add an entry

One line per item. Say **what** is missing and **what would break** if it stayed missing —
the second half is what makes an entry worth doing later rather than deleting.

```
- [ ] `path/to/file.ts` — no test for X. Breaks silently if Y.
```

---

## Owed tests

- [ ] `src/main/vault/mirror-backup.ts` — no test. The temp-then-rename, the prune order, the
      same-folder refusal and the path-free error messages are all unasserted. **The
      path-free messages are the one worth doing first**: a destination path names a server
      and often a person, and this string reaches a screen.
- [ ] `blockScreenCapture` — nothing asserts `applyContentProtection` is actually called on
      window creation or on a settings change.

- [ ] `CredentialEditor` type picker — no test. Appending a template's fields without losing
      what was already typed is the behaviour worth pinning.
- [ ] `iconFor` in `CredentialList` — no test that a chosen icon still beats a type icon.

- [ ] `src/main/recovery/diagnose.ts` — no test. The folder walk, the size cap, and the
      skip-a-bad-neighbour paths are covered only by the smoke run against one real vault.
- [ ] `src/renderer/src/recovery/DiagnosticsView.tsx` — no test. The dismissed-dialog case
      (which must not clear a report already on screen) is the one worth having.
- [ ] `kh:recovery:save-report` — nothing tests that it refuses when nothing was diagnosed,
      or that the report is dropped on lock.

- [ ] `src/main/vault/vault-service.ts` `totpCode` — no direct test. Covered only by the smoke
      run and by the generator's own RFC vectors, so a wrong `expiresAt` or a missed
      `otp-secret` type check would ship.
- [ ] `src/renderer/src/vault/TotpField.tsx` — no test. The self-refresh timer, the expiring
      state and the copy-through-the-broker path are all unasserted.
- [ ] `src/shared/ipc/validation.ts` — `totp-code` ref shape has no case in the validator test.

- [ ] `src/main/kdbx/header.ts` — no test of its own. Covered indirectly by the KDBX round
      trip, so a refusal that stopped firing would be caught only if it also broke a read.
- [ ] `src/main/import-service/kdbx-source.ts` — the attachment-marker append path has no
      reachable test, because Keyhold's own writer never emits an attachment. Needs either a
      hand-built fixture or a `binaries` input on `writeKdbx`.
- [ ] `src/main/breach/sweep.ts` — the abort path is asserted only as "the signal is passed
      through". Nothing checks that a cancelled sweep reports `cancelled` end to end.
- [ ] `src/renderer/src/health/use-breach-check.ts` — no test for the error branch or for the
      availability re-query after a run.
- [ ] `src/renderer/src/settings/SecuritySessionSection.tsx` — the breach opt-in row has no
      test. The confirm dialog is the consent step, and nothing asserts it appears before the
      setting flips.
- [ ] `src/shared/ipc/settings-validation.ts` — `requireBreachCheckPatch` refuses a
      renderer-supplied `requestIntervalMs`, and nothing tests that refusal. It is what stops
      a compromised renderer turning the check into a denial-of-service run from the user's
      own address.

## Owed documentation

- [ ] `docs/03-Data-Model/00-Credential-Model.md` — says nothing about record types or field
      templates. It states a custom-field-type count that **is** guarded; the new record-type
      count is not stated anywhere and must not be until it is.

- [ ] `docs/08-Diagnostics/00-Recovery-And-Diagnostics.md` — predates the feature being
      reachable. Needs the three channels, the tool view, and the "held in main rather than
      accepted back from the renderer" decision.

- [ ] `docs/05-Features/` — no page for one-time codes at all. The engine, the channel, the
      field and the separate rate-limit key are undocumented.

- [ ] `docs/05-Features/07-Breach-Check.md` — exists and predates the feature being
      reachable. Needs rewriting for what actually shipped: the two channels, the availability
      projection, the consent dialog, and the fact that the score never includes it.
- [ ] `docs/12-Roadmap/02-Decision-Log.md` — **D33** owed: the breach check reaches the user
      through the health dashboard behind a settings-screen consent, rather than an automatic
      check on unlock (refused: a zero-network app must never make a request the user did not
      just ask for) or a per-record button (refused: N requests to answer what one range
      lookup answers for many).
- [ ] `docs/09-Import-Export/03-KDBX.md` — written, but the import-service section does not
      mention the `.kdbx` route through `openVault`, only the parser side.
- [ ] `docs/06-UI-Design-System/` — the breach panel's tokens and the `--kh-breach-*` classes
      are undocumented.

## Owed guards

- [ ] Nothing asserts that `BreachSection` is reachable from a running app. The subsystem was
      finished and unmounted for months and every test passed the whole time; a smoke check
      that opens the health view and finds the panel is the only thing that would have caught
      it. **This is the highest-value item on this page.**
- [ ] No fault injection on `requireBreachCheckPatch`.
