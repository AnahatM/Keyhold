<!--
  Keyhold's conventions are in CLAUDE.md; the ones that come up most in review are below.
  If a box does not apply, say why rather than deleting it — "no new colours" on a docs-only
  change is a useful thing to have said.
-->

**What this changes, and why**

**How it was verified**

- [ ] `npm run verify:full` is green (format, lint, typecheck, tests, build, launch smoke)
- [ ] Every guard added here was **fault-injected** — broken on purpose, seen to fail, fixed.
      A guard nobody has watched fail is not known to work.

**The rules this touches**

- [ ] No secret in a log, an error message, a URL, or the renderer
- [ ] No hardcoded colour — every colour is a `--kh-*` token
- [ ] CSPRNG only; no `Math.random()` near anything security-relevant
- [ ] No second list — a value with a home is referenced, never restated
- [ ] The system's doc moved in the same pass as its code
