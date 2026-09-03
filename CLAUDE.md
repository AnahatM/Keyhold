# CLAUDE.md — Keyhold

Project instructions. Loaded after the global `~/.claude/CLAUDE.md` and **wins on every conflict**.

---

## What this is

**Keyhold** — a free, open-source, fully offline credential manager for Windows and macOS, built
with Electron. One encrypted file, no account, no server, no telemetry, no subscription, nothing to
host, nothing to pay for.

Read [`docs/00-Overview/00-What-Is-Keyhold.md`](./docs/00-Overview/00-What-Is-Keyhold.md) first.

**The canonical TODO is [`docs/12-Roadmap/00-Master-Checklist.md`](./docs/12-Roadmap/00-Master-Checklist.md).**
Work the phases in order. Tick items as they land. Nothing lives only in chat.

---

## Stack

| Layer        | Choice                                                                       |
| ------------ | ---------------------------------------------------------------------------- |
| Shell        | Electron (pinned at scaffold) — Windows + macOS, x64 + arm64                 |
| Build        | electron-vite                                                                |
| UI           | React 19 + TypeScript **strict**                                             |
| Styling      | Hand-written CSS over custom-property tokens. **No Tailwind, no CSS-in-JS.** |
| State        | Zustand                                                                      |
| Tests        | Vitest                                                                       |
| Packaging    | electron-builder — NSIS + portable (Win), DMG + zip (macOS)                  |
| Argon2id     | `hash-wasm` (pure WASM — **never** a native binding)                         |
| AES-256-GCM  | Node `crypto`, main process only                                             |
| KDBX interop | `kdbxweb` + our WASM Argon2                                                  |
| Strength     | `@zxcvbn-ts/core`, lazily loaded, **main process only**                      |

---

## Commands

```bash
npm run dev          # electron-vite dev with HMR
npm run build        # production build
npm run package      # electron-builder for the current platform
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit across both tsconfigs (node + web)
npm test             # Vitest
npm run test:watch
```

**Before claiming anything is done:** `npm run lint && npm run typecheck && npm test` must all pass.
Show the output. Never assert without evidence.

---

## Architecture — the non-negotiable part

```
MAIN (Node)      keys · crypto · file I/O · decrypted vault · all secret material
   │  contextBridge — typed, allow-listed, schema-validated both ways
PRELOAD          contextIsolation:true · sandbox:true · nodeIntegration:false
   │
RENDERER (React) the SAFE PROJECTION only — titles, usernames, emails, urls,
                 tags, folders, dates, metadata, history summaries, health flags.
                 NEVER passwords, note bodies, security-question answers,
                 TOTP seeds, or attachment bytes.
```

**The renderer never holds the master key or any secret material.** Secrets are fetched per reveal,
per copy, over IPC, with a TTL. This is decision D13 and it is the project's strongest security
claim — see [`docs/12-Roadmap/02-Decision-Log.md`](./docs/12-Roadmap/02-Decision-Log.md). If a
feature seems to need secrets in the renderer, the feature is wrong, not the architecture.

**Crypto:** master password → Argon2id → KEK → unwraps a random DEK → DEK encrypts the vault body
with AES-256-GCM. Envelope encryption is why changing the master password is instant and why extra
unlock methods are additive.

---

## Hard rules

1. **No secret in a log, an error message, a URL, a crash report, or the renderer.** Ever.
2. **CSPRNG only.** `crypto.randomBytes`. `Math.random()` never touches anything security-relevant —
   not a salt, not a nonce, not a generated password, not an id.
3. **Never invent cryptography.** Standard primitives only. If a crypto change seems needed, it is a
   decision-log entry first.
4. **Zero hardcoded colours.** Every colour is a `--kh-*` token. Two guard tests enforce this:
   every token resolves in every theme, and every foreground/background pair passes WCAG AA.
5. **Zero network by default.** The only exception is the opt-in HIBP check, off by default, behind
   a global network kill-switch. Nothing else may make a request — not for icons, not for updates,
   not for fonts, not for telemetry.
6. **Never lose data.** Atomic writes (tmp → fsync → rename), rolling backups, tombstones not
   deletions, a mandatory pre-merge backup, trash with restore, undo on destructive actions,
   dry-run before every import.
7. **Every feature ships a setting.** Decision D10 — the user decides their own security/convenience
   trade-off. Expose behaviour as configuration when it is written, not later.
8. **No second list.** One route table, one format registry, one token file. If you find a duplicate
   list, fold it in before continuing.
9. **Ship the guard with the system.** A theme gets a contrast test. A registry gets a uniqueness
   test. A number written in prose gets a test that parses it back out of the doc.
10. **Update the system's doc in the same pass as its code.**

---

## Conventions

| Thing            | Convention                                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| TS files         | `kebab-case.ts`                                                                                                                                 |
| React components | `PascalCase.tsx`, one per file                                                                                                                  |
| Types            | `PascalCase` · functions/vars `camelCase` · constants `SCREAMING_SNAKE_CASE`                                                                    |
| CSS tokens       | `--kh-<category>-<name>`                                                                                                                        |
| IPC channels     | `kh:<domain>:<action>`                                                                                                                          |
| Tests            | `<name>.test.ts` beside the source                                                                                                              |
| Secrets          | Anything holding secret material carries `secret` / `Secret` / `SecretString` in its name, so a reviewer can see at a glance where secrets flow |

Every source file carries an SPDX header: `// SPDX-License-Identifier: GPL-3.0-or-later`

Files stay short and single-purpose. Split by concern before a file becomes unpleasant to edit.

---

## Testing policy

**Test** (a silent regression here would be expensive): crypto · the KEEP container · atomic
writes · the merge engine · import parsers · export roundtrips · the password generator · health
rules · history versioning · theme token completeness and contrast.

**Do not test:** React components in general, thin IPC wrappers, config objects, or anything whose
test could never fail. No coverage target is chased.

---

## Docs map

| Need                                                  | Go to                                                                                                                      |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Entry point                                           | [`docs/_INDEX.md`](./docs/_INDEX.md)                                                                                       |
| **What to build next**                                | [`docs/12-Roadmap/00-Master-Checklist.md`](./docs/12-Roadmap/00-Master-Checklist.md)                                       |
| Deferred ideas                                        | [`docs/12-Roadmap/01-Feature-Backlog.md`](./docs/12-Roadmap/01-Feature-Backlog.md)                                         |
| Why something is this way                             | [`docs/12-Roadmap/02-Decision-Log.md`](./docs/12-Roadmap/02-Decision-Log.md)                                               |
| Naming, KEEP, extensions, glossary                    | [`docs/00-Overview/01-Naming-And-Glossary.md`](./docs/00-Overview/01-Naming-And-Glossary.md)                               |
| Positioning & USPs                                    | [`docs/00-Overview/02-Competitive-Analysis.md`](./docs/00-Overview/02-Competitive-Analysis.md)                             |
| Security posture                                      | [`docs/00-Overview/03-Threat-Model.md`](./docs/00-Overview/03-Threat-Model.md)                                             |
| Frozen founding design (**history — never "fix" it**) | [`docs/superpowers/specs/2026-09-02-keyhold-product-spec.md`](./docs/superpowers/specs/2026-09-02-keyhold-product-spec.md) |
| Things only Anahat can do                             | [`MANUAL-BACKLOG.md`](./MANUAL-BACKLOG.md)                                                                                 |

---

## Watch out for

- **`.keep` vs `.keepx`.** A `.keep` is _the vault_, opened with the master password. A `.keepx` is
  _a parcel_ — a chosen subset, under its own separate passphrase. Never blur these in code or copy.
- **Argon2 takes real time by design.** Always run it off the UI thread and always show determinate
  progress. A frozen window during unlock is a bug, not a cost of doing business.
- **Nonce reuse is catastrophic.** Generate a fresh random nonce for every single encryption. Never
  derive one, never count one, never cache one.
- **The header is plaintext but authenticated (AAD).** Reading it without decrypting is intended.
  Modifying it must break the tag.
- **Origin capture must never block a save.** SSID lookup shells out; treat it as best-effort and
  fully async, with a silent fallback to the interface name.
- **The safe projection is a security boundary, not a performance optimisation.** Adding a secret
  field to it is a vulnerability, and the property test exists to catch exactly that.
- **`docs/superpowers/specs/` is history.** A spec that has drifted from the code is a record of an
  earlier decision, not a bug to fix.

---

## Version control

Git, on `main`. Remote: `AnahatM/Keyhold`, **private for now**.

- Commit per completed slice, once lint, typecheck and tests are green.
- **Stage by explicit path. Never `git add -A` or `git add .`.**
- Never push, force-push, or open a PR unless asked.
- Commit messages end with the co-authorship trailer defined in the session.
