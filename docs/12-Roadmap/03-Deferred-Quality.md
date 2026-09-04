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

- [ ] `CredentialEditor` type picker — no test. Appending a template's fields without losing
      what was already typed is the behaviour worth pinning.
- [ ] `iconFor` in `CredentialList` — no test that a chosen icon still beats a type icon.

- [ ] `src/main/recovery/diagnose.ts` — the **256 MB size cap** is still unexercised, and
      deliberately: the smallest file that would trip it is 256 MB and writing one per run
      costs more than the branch is worth. The folder walk and the directory filter now have
      tests. The read-before-listing ordering is not observable from outside — recorded in
      `diagnose.test.ts` rather than claimed.
- [ ] `src/renderer/src/recovery/DiagnosticsView.tsx` — no test. The dismissed-dialog case
      (which must not clear a report already on screen) is the one worth having.

- [ ] `src/renderer/src/vault/TotpField.tsx` — no test. The self-refresh timer, the expiring
      state and the copy-through-the-broker path are all unasserted.

- [ ] `src/main/kdbx/header.ts` — no test of its own. Covered indirectly by the KDBX round
      trip, so a refusal that stopped firing would be caught only if it also broke a read.
- [ ] `src/main/import-service/kdbx-source.ts` — the attachment-marker append path has no
      reachable test, because Keyhold's own writer never emits an attachment. Needs either a
      hand-built fixture or a `binaries` input on `writeKdbx`.
- [ ] `src/renderer/src/health/use-breach-check.ts` — no test for the error branch or for the
      availability re-query after a run.
- [ ] `src/renderer/src/settings/SecuritySessionSection.tsx` — the breach opt-in row has no
      test. The confirm dialog is the consent step, and nothing asserts it appears before the
      setting flips.

## Owed documentation

- [ ] `docs/03-Data-Model/00-Credential-Model.md` — says nothing about record types or field
      templates. It states a custom-field-type count that **is** guarded; the new record-type
      count is not stated anywhere and must not be until it is.

- [ ] `docs/08-Diagnostics/00-Recovery-And-Diagnostics.md` — predates the feature being
      reachable. Needs the three channels, the tool view, and the "held in main rather than
      accepted back from the renderer" decision.

- [ ] `docs/05-Features/` — no page for one-time codes at all. The engine, the channel, the
      field and the separate rate-limit key are undocumented.

- [ ] `docs/09-Import-Export/03-KDBX.md` — written, but the import-service section does not
      mention the `.kdbx` route through `openVault`, only the parser side.
- [ ] `docs/06-UI-Design-System/` — the breach panel's tokens and the `--kh-breach-*` classes
      are undocumented.

## Owed guards

- [ ] The **second half** of the reachability rule is still one hand-written check at a time.
      `tools/bridge-is-used.test.ts` now generalises the first half — every member of
      `KeyholdApi` must be used somewhere under `src/renderer/`, which catches a capability
      that was never wired up, and found three on its first run. What it cannot see is a call
      site that _exists_ inside a component nothing renders; that is how `BreachSection` was
      stranded despite `useBreachCheck` calling the bridge. Only the smoke run reaches it, and
      only where somebody wrote the check. **This is the highest-value item left on this page.**
