# Setup & scripts

> How to run, build, verify and package Keyhold. Current reference — update when the
> scripts change.

## Requirements

- **Node 22 or newer** (`engines.node` enforces this)
- npm 10 or newer
- Windows or macOS. Linux is a backlog item (F1), not currently built or tested.

No native toolchain is required. This is deliberate: Argon2 comes from `hash-wasm` (pure
WebAssembly) precisely so there is no per-platform native binary to compile — see decision
D14.

## Scripts

| Script                                                            | What it does                                                                                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run dev`                                                     | electron-vite dev server with hot reload for the renderer and restart-on-change for main/preload                                                                               |
| `npm run build`                                                   | Typecheck, then build main, preload and renderer into `out/`                                                                                                                   |
| `npm start`                                                       | Preview the production build                                                                                                                                                   |
| `npm run ensure:electron`                                         | Fetches the Electron binary `npm run dev` needs. Runs automatically as `postinstall`; run it by hand if the install was offline. See _The Electron binary_ below               |
| `npm run verify`                                                  | **lint + typecheck + build + test.** The gate. Must be green before any commit                                                                                                 |
| `npm run verify:full`                                             | **`format:check` + `verify` + `test:smoke` + `test:dev-smoke`.** Everything CI runs, in one command                                                                            |
| `npm run lint` / `lint:fix`                                       | ESLint                                                                                                                                                                         |
| `npm run format` / `format:check`                                 | Prettier                                                                                                                                                                       |
| `npm run typecheck`                                               | `tsc --noEmit` against both tsconfigs                                                                                                                                          |
| `npm test` / `test:watch` / `test:ui`                             | Vitest                                                                                                                                                                         |
| `npm run test:smoke`                                              | Launches the real built app and verifies the preload bridge. **Run after `npm run build`**                                                                                     |
| `npm run test:dev-smoke`                                          | Starts the **dev server**, attaches over CDP, and asserts the renderer actually mounted. Needs no build                                                                        |
| `npm run package` / `package:win` / `package:mac` / `package:dir` | electron-builder, configured in `electron-builder.yml`. `package:dir` skips the installer and leaves an unpacked build, which is what you want when debugging packaging itself |

## The Electron binary

`npm install` on its own does not leave you with a runnable Electron. As of v44 the
published `electron` package has no `scripts` field at all — the `postinstall` hook that
used to download `dist/electron.exe` is gone — so npm unpacks the JavaScript half of the
package and nothing fetches the binary. Nothing warns. The failure lands later, on the
first `npm run dev`, as a bare `Error: Electron uninstall` thrown from inside
electron-vite, which names neither what is missing nor how to get it.

This is not a broken machine and not a bad clone: a fresh `git clone` plus `npm install`
reproduces it every time, on every platform. `npm run package` is unaffected, because
electron-builder downloads its own copy into a separate cache — so the app can package
perfectly while the dev server cannot start at all, which is exactly the sort of split
that sends you looking in the wrong place.

`tools/ensure-electron.mjs` fetches it, wired as this project's own `postinstall`. That is
what makes `git clone && npm install && npm run dev` sufficient on a machine that has never
seen the project. It is safe to re-run — it exits early when `dist/version` already matches
— picks the right build for the host platform and arch, and reuses the shared
`~/.cache/electron` download, so a second machine is usually a cache hit rather than a
download. Run `npm run ensure:electron` by hand if the install happened offline.

This does not weaken hard rule 5, zero network by default, which governs what the shipped
application does at runtime. This is an install-time fetch on a developer's machine, the
same way `npm install` itself just fetched every other dependency.

## Project layout

```
src/
  main/        Electron main process — owns every secret. Node.
    index.ts       entry point, single-instance lock, lifecycle
    security.ts    CSP, hardened webPreferences, navigation lockdown
    window.ts      BrowserWindow creation
    smoke.ts       launch self-check, only under KEYHOLD_SMOKE=1
  preload/     The contextBridge. The only channel between the two processes.
  renderer/    React UI. Browser only — no Node, no secrets.
  shared/      Types and pure logic used by both. Must compile in BOTH environments.
tools/         Build and lint machinery, plus its own tests.
docs/          This tree.
out/           Build output (gitignored).
```

## The three TypeScript configs

| File                 | Covers                                                         | Why separate                       |
| -------------------- | -------------------------------------------------------------- | ---------------------------------- |
| `tsconfig.base.json` | Shared compiler options                                        | One place for `strict` and friends |
| `tsconfig.node.json` | `src/main`, `src/preload`, `src/shared`, `tools`, config files | Node types, no DOM                 |
| `tsconfig.web.json`  | `src/renderer`, `src/shared`                                   | DOM types, no Node                 |

`src/shared` is in **both**, on purpose. That is what stops shared code quietly depending on
a Node type — the reason `Platform` in `src/shared/ipc/api.ts` is spelled out as a union
rather than aliased to `NodeJS.Platform`.

Strictness beyond `strict: true`: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`,
`noUnusedParameters`, `useUnknownInCatchVariables`.

## Path aliases

`@main`, `@preload`, `@renderer`, `@shared` — declared in **three** places:
`electron.vite.config.ts`, `tsconfig.node.json`, and `tsconfig.web.json`.

`tools/alias-parity.test.ts` fails if they drift. Keeping three lists in sync by hand is
exactly the failure this project's rules call out, so it is asserted instead of remembered.

## Lint zones

ESLint applies genuinely different rules per zone, not one blanket config:

| Zone                                    | Notable rules                                                                                                                                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main`, `src/preload`, `src/shared` | Node globals; `console.log` banned (a secret in a log is a leak)                                                                                                                                                                   |
| `src/renderer`                          | Browser globals; **importing `electron`, `node:*`, `fs`, `path`, `crypto`, `os`, `child_process` or `@main/*` is a lint error.** The renderer has no Node access by construction; an import means someone tried to widen that hole |
| tests                                   | A few assertion rules relaxed; nothing security-relevant                                                                                                                                                                           |
| plain `.js` tooling                     | Linted but not type-checked — it sits outside both tsconfigs on purpose                                                                                                                                                            |

Globally: `Math.random()` is banned outright. There is no legitimate use for it here, so it
is a lint error rather than a review discussion.

## Toolchain version notes

**TypeScript is pinned to 5.9, not 7.x.** TypeScript 7 is current, but `typescript-eslint`
declares `typescript >=4.8.4 <6.1.0`, so adopting 7 today would mean losing type-aware
linting — which in a codebase this security-sensitive is a worse trade than being one major
behind. Revisit when `typescript-eslint` ships TS 7 support.

**Vite is pinned to 7.x, not 8.x**, because `electron-vite@5` peers `vite ^5 || ^6 || ^7`.

**The preload is built as CommonJS (`.cjs`), not ESM.** This is not a preference:
[Electron runs sandboxed preload scripts as plain CommonJS with no ESM context](https://www.electronjs.org/docs/latest/tutorial/esm).
An `.mjs` preload builds cleanly, launches cleanly, and then silently never runs, leaving
`window.keyhold` undefined with no error anywhere. `npm run test:smoke` exists specifically
to catch that class of defect.

## The gate

Before any commit:

```bash
npm run verify
```

And after changing anything in `src/main`, `src/preload`, or the build config:

```bash
npm run build && npm run test:smoke
```

### The whole thing, which is what CI runs

```bash
npm run verify:full
```

`format:check` → `verify` (lint → typecheck → build → tests) → `test:smoke` → `test:dev-smoke`,
in that order.

**It contains everything CI enforces, and that is the point.** Formatting used to sit outside
it, as its own workflow step, and the consequence was a local gate that could be green while CI
was red over whitespace alone — which is worse than having no local gate, because it teaches
people that the CI result and the local result are unrelated. The workflow now runs this one
command, so there is one definition of "passing" and it lives in `package.json`.

## Related

- [`01-Testing-Policy.md`](./01-Testing-Policy.md) — what gets tested and what deliberately does not
- [`CLAUDE.md`](../../CLAUDE.md) — the project's operating rules
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — contributor-facing version of the same
