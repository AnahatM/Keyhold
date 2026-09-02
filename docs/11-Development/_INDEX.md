# 11 · Development

How to work on Keyhold.

| Page                                                   | What it covers                                                                                                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`00-Setup-And-Scripts.md`](./00-Setup-And-Scripts.md) | Requirements, every npm script, project layout, the three tsconfigs, path aliases, lint zones, and the toolchain version decisions (why TypeScript 5.9 and not 7, why the preload is CommonJS) |
| [`01-Testing-Policy.md`](./01-Testing-Policy.md)       | What gets tested and what deliberately does not, the fault-injection rule for guards, the two test environments, and the launch smoke test                                                     |

**The gate:** `npm run verify` (lint + typecheck + test) must be green before any commit.
After touching `src/main`, `src/preload` or the build config, also run
`npm run build && npm run test:smoke`.

**Related:** [`CLAUDE.md`](../../CLAUDE.md) is the operating manual;
[`CONTRIBUTING.md`](../../CONTRIBUTING.md) is the contributor-facing version.
