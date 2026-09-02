# 14 · Audits

Phase 17's findings. Each page is a **dated snapshot**, not current reference: it records
what was true on the day it was written, so that a later reader can tell what has since been
fixed rather than re-deriving the whole sweep.

| Page                                             | Date       | What it covers                                                                                                                                                                                  |
| ------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`00-Security-Audit.md`](./00-Security-Audit.md) | 2026-09-02 | The secret boundary, secrets in logs and errors, Electron hardening, the preload bridge, IPC validation, cryptographic use, the filesystem and the one subprocess call, and the dependency tree |
| [`01-Doc-Code-Audit.md`](./01-Doc-Code-Audit.md) | 2026-09-02 | Every page under `docs/` and every root markdown file, checked against the code it describes: stale numbers, moved paths, and absence claims that have rotted                                   |

---

## How to read these

**Every finding is anchored to a `file:line` on both sides**, and each one separates what
was **measured** from what was **reasoned**. A finding marked as reasoned was derived from
documented platform behaviour rather than from a reproduction — neither audit ran the app.

**Both pages carry a "checked and found fine" list, and those matter as much as the
findings.** They exist so the next person does not re-investigate settled ground, and so
nobody "fixes" a deliberate choice into a defect.

**Nothing was changed.** These audits were read-only over `src/`; every fix named here is
still outstanding unless a later commit says otherwise.

**Both pages have a scope note at the top, and it matters.** `src/` was being written while
they ran: nine main-process subsystems — `activity`, `attachments`, `breach`, `organisation`,
`recovery`, `shell`, `sync`, `theme`, `totp` — landed after the sweep and are **not
covered**. `breach/` in particular is the project's first network code and needs an audit of
its own before it ships.

---

## Standing items

- `docs/_INDEX.md` does not yet list this folder, and the Phase 17 and Phase 19 checklist
  items still point at `docs/13-Appendix/`. See doc-audit finding F10 — it has to be fixed by
  hand, because these pages cannot edit the index that would reach them.
- `docs/superpowers/specs/` is **out of scope for both audits, permanently.** It is history:
  a spec that has drifted from the code is the record of an earlier decision, not a bug.

---

**Related:** [`../12-Roadmap/00-Master-Checklist.md`](../12-Roadmap/00-Master-Checklist.md)
Phase 17 is the work these pages discharge.
[`../00-Overview/03-Threat-Model.md`](../00-Overview/03-Threat-Model.md) is what the security
audit measured against;
[`../02-Security/01-Process-Hardening.md`](../02-Security/01-Process-Hardening.md) is the
design most of its findings concern.
