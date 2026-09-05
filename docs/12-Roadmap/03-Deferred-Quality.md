# Deferred quality — tests and documentation owed

> **The debt ledger.** Keyhold is in a build-fast phase: features ship with a lightweight
> doc skeleton and only the tests that protect data or secrets. Everything skipped is written
> down here, in the same commit that skipped it, so the debt is visible rather than forgotten.
>
> This file is a queue, not a record. Entries leave it by being done.

---

## 🗑️ Marked for deletion before the repository goes public

**This file is internal process bookkeeping and is not meant to ship.** It is kept for now
because its queue is not empty. Delete it — and its row in
[`_INDEX.md`](./_INDEX.md) — when either of these becomes true:

1. **Every entry below is closed**, or
2. **The manual work in [`../../MANUAL-BACKLOG.md`](../../MANUAL-BACKLOG.md) is finished and
   the app is at a ready state**, at which point what is left here is a handful of known,
   deliberate gaps that belong in
   [`01-Feature-Backlog.md`](./01-Feature-Backlog.md) rather than in a ledger of debt.

Anything still open at that point should be **moved, not dropped** — a gap that is real does
not stop being real because the file recording it was tidied away.

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

- [x] ~~`src/main/recovery/diagnose.ts` — the **256 MB size cap**.~~ **Done**, and the reason
      it sat here for months was wrong. The entry said "the smallest file that would trip it is
      256 MB and writing one per run costs more than the branch is worth" — true of _writing_
      one, and irrelevant to a branch that only reads `stat().size`. `truncate` sets a length
      without writing contents: **0 ms to create, 1 ms to remove**, measured. Both sides of the
      branch are asserted in one run, and the cap is exported so the test cannot hold a second
      copy of the number. The read-before-listing ordering is still not observable from
      outside — recorded in `diagnose.test.ts` rather than claimed.
- [x] ~~`src/main/import-service/kdbx-source.ts` — the attachment-marker **append** path.~~
      **Done.** It was recorded as reachable only from a real KeePassXC database, because
      Keyhold's own writer emitted no attachments to count. `writeInnerHeader` had always
      accepted a binary pool; only `writeKdbx` insisted on an empty one. It now takes
      `binaries` as an injection point — beside the `kdf` and `random` ones already there for
      the same kind of reason — and the test builds a database with two attachments and
      asserts the **count**, through the warning a user actually sees. An append path that
      always wrote `1` would pass a contains-check and lie to everyone with two; that
      injection is one of the two run, and both fail. What the manual interop check still
      adds is different and still worth doing: whether a _KeePassXC-written_ attachment is
      shaped the way this writer's is.

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

- [x] ~~The **second half** of the reachability rule.~~ **Done** —
      `tools/renderer-is-reachable.test.ts`. The entry that used to sit here said this half
      "needs a running app"; it does not. Walking the import graph from the application entry
      and from every test file answers it statically: a module nothing imports cannot run,
      whatever its own tests say. It found four dead modules on its first run — two complete
      gateway doubles nothing drives and two unused barrels — now backlog E23 and E24. The
      three candidate forms were measured before one was chosen, and the measurements are in
      the file so nobody repeats them blind. Four fault injections, including the anti-rot
      half that refuses an exemption for a module which has since been wired up. What still
      needs a running app is the third question — whether a reachable component renders
      anything — and that remains `src/main/smoke.ts`'s job.
- [x] ~~**No gate runs `npm run dev`.**~~ **Done** — `tools/dev-smoke.mjs`, wired into
      `verify:full` as `npm run test:dev-smoke`. It starts electron-vite, attaches to the
      renderer over CDP and asserts five things: the page is served by the dev server, `#root`
      has children, the preload bridge is attached over `http:`, no Content-Security-Policy
      violation was logged, and Vite's HMR socket connected. The dev server was the third
      configuration nothing exercised — a different origin, a different CSP, a bridge over the
      network stack and a live websocket — and a blank window there survived every other gate
      in this repository. All three fault injections were run: dropping `'unsafe-inline'` from
      the development `script-src` reproduces the original defect and the failure prints the
      violation verbatim; leaving `connect-src` at `'none'` fails on the websocket; inverting
      the `app.isPackaged` gate fails naming the `file:` URL the window loaded instead.
