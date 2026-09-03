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

> **Numbering note, settled.** An earlier plan reserved `13-Appendix/` for the Phase 17 audit
> findings, which would have claimed `13` twice. It was resolved the other way: **the audit
> findings live in [`../14-Audits/`](../14-Audits/_INDEX.md)**, `13` belongs to packaging
> alone, and `13-Appendix/` was never created and is not planned. `docs/_INDEX.md`, the Phase
> 17 and Phase 19 roadmap items and the audit pages themselves all name `14-Audits/`. If you
> find a pointer at `docs/13-Appendix/`, it is stale — fix it rather than creating the folder.

**Related:** [`electron-builder.yml`](../../electron-builder.yml) is the configuration and
is commented throughout; [`build/README.md`](../../build/README.md) covers icons and
installer artwork; [`docs/11-Development/`](../11-Development/_INDEX.md) covers everything
that happens before packaging.
