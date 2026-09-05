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

- [ ] `src/main/recovery/diagnose.ts` — the **256 MB size cap** is still unexercised, and
      deliberately: the smallest file that would trip it is 256 MB and writing one per run
      costs more than the branch is worth. The folder walk and the directory filter now have
      tests. The read-before-listing ordering is not observable from outside — recorded in
      `diagnose.test.ts` rather than claimed.
- [ ] `src/main/import-service/kdbx-source.ts` — the attachment-marker **append** path is
      still reachable only from a real KeePassXC database, because Keyhold's own writer emits
      no attachments to count. It is part of the manual interop check (`MANUAL-BACKLOG.md` →
      M-KDBX-INTEROP) rather than something a fixture can reach. What is now guarded is the
      agreement between the two sides: both derive from `KDBX_ATTACHMENT_MARKER` in the parser
      — they used to keep separate hardcoded copies — and `keepass-xml.test.ts` round-trips
      the composer through the reader.

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
