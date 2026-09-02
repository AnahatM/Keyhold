# 13 · Packaging

How Keyhold becomes a downloadable file, and what happens to it on the way.

| Page                                                             | What it covers                                                                                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`00-Building-And-Releasing.md`](./00-Building-And-Releasing.md) | The `package.json` diff to apply, building on each platform, what the artifacts are, the unsigned-binary reality and what users see, the checksum story, the CI workflows, the release checklist |

**The short version:** `npm run package:win` on Windows, `npm run package:mac` on macOS,
output in `release/`. Builds are unsigned by decision D16 — SHA-256 checksums published in
two independent places are the integrity story instead. Releases are drafted by CI on a
`v*` tag and published by a human after the manual checks.

**Three things must be fixed before any of it works:** `.gitignore` currently ignores
`build/`, `package.json` wants one added script, and the repository needs one
`npm run format` pass so the new CI formatting check does not fail on day one. All three
are at the top of `00-Building-And-Releasing.md`.

> **Numbering note.** `docs/_INDEX.md` reserves `13-Appendix/` for the Phase 17 audit
> findings, so `13` is currently claimed twice. Renumbering is a documentation-tree
> decision, not a packaging one; whoever settles it should update `docs/_INDEX.md`, this
> folder, and the Phase 19 roadmap line that names `docs/13-Appendix/03-Doc-Audit-Findings.md`
> together, in one pass.

**Related:** [`electron-builder.yml`](../../electron-builder.yml) is the configuration and
is commented throughout; [`build/README.md`](../../build/README.md) covers icons and
installer artwork; [`docs/11-Development/`](../11-Development/_INDEX.md) covers everything
that happens before packaging.
