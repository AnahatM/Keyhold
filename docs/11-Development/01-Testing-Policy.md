# Testing policy

> What Keyhold tests, what it deliberately does not, and the one rule that makes the tests
> worth having.

## The principle

**Tests exist for the systems where a silent regression would be expensive** — not for
coverage. A wall of tests nobody reads is not thoroughness, and a test that could never fail
is maintenance cost with no return.

**No coverage number is chased. Ever.** If a coverage report appears in this repo, it is
diagnostic, never a target.

## What gets tested

| Area                        | Why it earns tests                                                                                                                                                                                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cryptography**            | Roundtrip, wrong-password failure, single-bit tamper detection, KDF parameter handling, key rotation. A silent break here is catastrophic and invisible                                                                                                                                                     |
| **The KEEP container**      | Serialise/parse roundtrip, version gating, migration, truncated and corrupt files, orphaned temp files                                                                                                                                                                                                      |
| **Atomic writes**           | Crash-during-write simulation. Goal G1 is "never lose a credential"                                                                                                                                                                                                                                         |
| **The merge engine**        | The full conflict matrix, plus a property test asserting no merge ever loses a record                                                                                                                                                                                                                       |
| **Import parsers**          | One fixture per format, plus malformed input. Nineteen formats is nineteen chances to silently drop a field                                                                                                                                                                                                 |
| **Export**                  | Roundtrip through every own-format; KDBX export must re-import losslessly                                                                                                                                                                                                                                   |
| **Password generator**      | Charset guarantees, exclusion correctness, entropy maths                                                                                                                                                                                                                                                    |
| **Health rules**            | Each rule's boundary conditions                                                                                                                                                                                                                                                                             |
| **History**                 | Versioning-on-change, retention pruning, restore, diff correctness, and that each privacy level captures exactly what it claims and nothing more                                                                                                                                                            |
| **Theme tokens**            | Every token resolves in every theme; every foreground/background pair passes WCAG AA                                                                                                                                                                                                                        |
| **The safe projection**     | A property test that it can never contain a secret field. This is a security boundary, not a convenience                                                                                                                                                                                                    |
| **The cross-cutting rules** | The ones a machine can check: colour literals outside the token layer, a secret reaching a log, an error or a URL, and file length. Which of `CLAUDE.md`'s cross-cutting rules are guarded, which are deliberately not, and why, is settled in [the Master Checklist](../12-Roadmap/00-Master-Checklist.md) |
| **Security configuration**  | `src/main/security.test.ts` — the hardened `webPreferences` and the CSP                                                                                                                                                                                                                                     |

## What does not get tested

- React components, in general. Rendering is not the risk here.
- Thin IPC wrappers that only forward.
- Configuration objects.
- Getters, setters, and anything whose test asserts that JavaScript works.
- Anything where writing the test is harder than reading the code it covers.

## The rule that makes guards real

> **Break it on purpose before you trust it.**

A guard test that has never been seen to fail is not known to work — it is a false sense of
coverage, which is worse than no coverage, because it stops anyone looking.

Every guard in this repo must be fault-injected with the exact defect it claims to catch,
and the injection recorded in the test file's header comment.

**This has already paid for itself.** The first version of the SPDX header rule
(`tools/eslint-rules/spdx-header.js`) compared only the _text_ of the first comment and
never its _type_ — so it happily accepted a block comment. The fault-injection case caught
it immediately, on the first run, before the rule was ever trusted.

Injections performed so far:

| Guard                                    | Defects injected                                                                                                                            | Result                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/eslint-rules/spdx-header.test.js` | Missing header · header not first · block comment instead of line comment · wrong licence                                                   | All four caught. The block-comment case found a real hole in the rule                                                                                                                                                                                                                                                                                          |
| `src/main/security.test.ts`              | `sandbox: false` · `'unsafe-eval'` added to `script-src` · `connect-src *`                                                                  | All three caught, 4 assertions failed                                                                                                                                                                                                                                                                                                                          |
| `tools/smoke.mjs` + `src/main/smoke.ts`  | Preload removed, simulating the sandboxed-ESM-preload bug                                                                                   | Caught: `SMOKE-FAIL preload bridge missing`                                                                                                                                                                                                                                                                                                                    |
| `tools/file-length.test.ts`              | 20 code lines appended to a 488-line file · **60 comment lines** appended to the same file · an allow-listed file stubbed down to 10 lines  | First and third caught. The second correctly did **not** fire — that is the comment discount working, and it is the half of the guard most likely to break silently. An earlier attempt injected into a file whose size had been guessed rather than measured, and caught nothing; that near-miss is why the ceiling in that file is quoted from a measurement |
| `tools/no-secret-in-a-log.test.ts`       | A secret interpolated into a URL template · `searchParams.set` with a secret · an innocent help URL whose path contains the word "password" | First two caught. The third correctly ignored — a URL rule that failed on a constant help link would be switched off in a week, so that case is the one that decides whether the rule ships                                                                                                                                                                    |

## Numbers written in prose

Hard rule 9: a number written in a document gets a test that parses it back out of the
document. Three guards enforce it — `tools/doc-counts.test.ts` for the README's format and
theme counts, `tools/keep-spec-matches-code.test.ts` for the KEEP format spec's byte
offsets, field sizes, magic bytes and KDF parameters, and `tools/doc-paths.test.ts` for
every file path a document cites.

The KEEP spec one matters most and is worth saying why: that document is written to be
**implementable by a third party**, and the no-lock-in claim rests on it. A drifted number
there does not confuse a colleague — it produces a wrong reader, on somebody else's machine,
months later, with nothing to trace it back to. It is fault-injected in both directions,
including from the code side, because the guard has to fire when a constant moves away from
the prose and not only when somebody edits the prose.

**Per-file test counts are deliberately not written down.** The feature pages used to carry
tables of how many tests each file had; they say `npx vitest run <dir>` instead. That is a
better answer than a number: it is current by construction, and it tells a reader how to see
the tests rather than how many there are. Restoring counts in order to guard them would add
churn to every feature page on every test added, for a figure nobody acts on.

## Test environments

Vitest runs two projects, because the two halves of the app have different rules:

| Project    | Environment | Covers                                                                                                                 |
| ---------- | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `node`     | `node`      | `src/main`, `src/preload`, `src/shared`, `tools`. Real crypto, real filesystem. Where the security-critical tests live |
| `renderer` | `jsdom`     | `src/renderer`. UI logic only — there are no secrets here to test                                                      |

Test files sit beside the code they cover, named `<name>.test.ts`.

## The launch smoke test

`npm run test:smoke` starts the **real built application** under `KEYHOLD_SMOKE=1`, waits
for the renderer to load, and verifies the preload bridge is present.

It exists because a whole class of Electron defects is invisible to both the build and the
unit tests, and only appears at runtime. The specific one that motivated it: a sandboxed
preload emitted as ESM builds cleanly, launches cleanly, and simply never runs — leaving
every feature dead with no error anywhere.

Run it after any change to `src/main`, `src/preload`, or the build configuration.

## Related

- [`00-Setup-And-Scripts.md`](./00-Setup-And-Scripts.md)
- [`CLAUDE.md`](../../CLAUDE.md#testing-policy)
