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

- [ ] `src/main/recovery/diagnose.ts` — the **256 MB size cap** is still unexercised, and
      deliberately: the smallest file that would trip it is 256 MB and writing one per run
      costs more than the branch is worth. The folder walk and the directory filter now have
      tests. The read-before-listing ordering is not observable from outside — recorded in
      `diagnose.test.ts` rather than claimed.
- [ ] `src/renderer/src/recovery/DiagnosticsView.tsx` — no test. The dismissed-dialog case
      (which must not clear a report already on screen) is the one worth having.

- [ ] `src/main/import-service/kdbx-source.ts` — the attachment-marker append path has no
      reachable test, because Keyhold's own writer never emits an attachment. Needs either a
      hand-built fixture or a `binaries` input on `writeKdbx`.

## Owed documentation

_Empty._ Two of the five entries that were here turned out to be **stale rather than owed**,
which is worth recording: `docs/05-Features/` did have a one-time-codes page (`05-TOTP.md`) and
`docs/09-Import-Export/03-KDBX.md` did document the `openVault` route — both had been written
and the ledger entry never removed. A third was wrong in its premise: the breach panel
introduces no `--kh-breach-*` token at all, because it is built entirely from the existing
scale, which is the design system working rather than a gap.

The lesson is the one this file already states about itself — **it is a queue, not a record.**
An entry that stays after the work is done costs a later reader the time it takes to discover
that, and quietly overstates how much is outstanding.

## Owed guards

- [ ] The **second half** of the reachability rule is still one hand-written check at a time.
      `tools/bridge-is-used.test.ts` now generalises the first half — every member of
      `KeyholdApi` must be used somewhere under `src/renderer/`, which catches a capability
      that was never wired up, and found three on its first run. What it cannot see is a call
      site that _exists_ inside a component nothing renders; that is how `BreachSection` was
      stranded despite `useBreachCheck` calling the bridge. Only the smoke run reaches it, and
      only where somebody wrote the check. **This is the highest-value item left on this page.**
