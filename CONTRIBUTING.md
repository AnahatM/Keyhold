# Contributing to Keyhold

Thanks for looking. Keyhold is a password manager, so the bar for changes is higher than
for most projects — but the rules are short and written down rather than assumed.

## Before you start

- **Read [`CLAUDE.md`](./CLAUDE.md).** It is the project's operating manual: stack,
  architecture, hard rules, naming conventions, and the list of things that bite.
- **Read [`docs/00-Overview/03-Threat-Model.md`](./docs/00-Overview/03-Threat-Model.md)**
  if you are touching anything security-adjacent.
- **Check [`docs/12-Roadmap/02-Decision-Log.md`](./docs/12-Roadmap/02-Decision-Log.md)**
  before proposing an architectural change. It may already have been decided, with reasons.
- **Check [`docs/12-Roadmap/01-Feature-Backlog.md`](./docs/12-Roadmap/01-Feature-Backlog.md)**
  before proposing a feature. It is probably already there, possibly with a note on why it
  is not built yet. That file also lists ideas that were explicitly rejected, and why.

## Setup

```bash
npm install
npm run dev          # hot-reloading dev build
npm run verify       # lint + typecheck + test — must be green before any commit
npm run build        # production build
npm run test:smoke   # launches the real app and checks the preload bridge (run after build)
```

Node 22 or newer.

## The hard rules

These are not style preferences. A pull request that breaks one will not be merged.

1. **No secret in the renderer.** The renderer holds a _safe projection_ — titles,
   usernames, URLs, tags, dates. Never passwords, note bodies, security-question answers,
   TOTP seeds, or attachment bytes. If a feature seems to need them there, the feature
   design is wrong. See decision D13.
2. **No secret in a log, an error message, a URL, or a crash report.** Ever.
3. **CSPRNG only.** `crypto.randomBytes`. `Math.random()` is banned by lint and there is no
   legitimate exception.
4. **Never invent cryptography.** Standard, boring primitives. A crypto change is a
   decision-log entry before it is a pull request.
5. **Zero network.** The only permitted request in the entire app is the opt-in HIBP check.
   No icon fetching, no font CDN, no telemetry, no update ping that is on by default.
6. **Never lose data.** Atomic writes, backups, tombstones, undo. If a change could lose a
   credential in any scenario, it needs a different design.
7. **Zero hardcoded colours.** Every colour is a `--kh-*` token, enforced by guard tests.

## Style

The formatter and linter are the authority — run `npm run lint:fix && npm run format`.
Naming conventions are in
[`docs/00-Overview/01-Naming-And-Glossary.md`](./docs/00-Overview/01-Naming-And-Glossary.md).

Every source file starts with `// SPDX-License-Identifier: GPL-3.0-or-later`. The lint rule
will add it for you.

## Tests

Test core systems, not everything. Crypto, the vault format, the merge engine, import
parsers, the password generator, health rules, history, and theme tokens all get real tests.
Thin wrappers, config objects and React components generally do not. **No coverage number is
chased**, and a test that could never fail is maintenance cost with no return.

**If you add a guard, break it on purpose first.** A test you have never seen fail is not
known to work. This is a real project rule, and it has already caught a genuine hole in the
SPDX rule the first time it was applied.

## Pull requests

- One coherent change per PR. Say **why**, not just what.
- Run `npm run verify` and paste the result.
- Update the matching page in `docs/` in the same PR. A stale doc is worse than no doc.
- If you touched `src/main/security.ts`, `src/main/crypto/`, `src/main/format/`, `src/shared/format/types.ts`, or the
  IPC contract, say so — those get a closer read.
- **Never edit `docs/specs/`.** Those are frozen point-in-time design records.
  A spec that has drifted from the code is history, not a bug.

## Security issues

Do not open a public issue. See [`SECURITY.md`](./SECURITY.md).

## Licence

Keyhold is GPL-3.0-or-later. By contributing you agree your contribution is licensed the
same way.
