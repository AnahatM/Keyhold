# 14 · Audits

Phase 17's findings. Each page is a **dated snapshot**, not current reference: it records
what was true on the day it was written, so that a later reader can tell what has since been
fixed rather than re-deriving the whole sweep.

| Page                                               | Date       | What it covers                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`00-Security-Audit.md`](./00-Security-Audit.md)   | 2026-09-02 | The secret boundary, secrets in logs and errors, Electron hardening, the preload bridge, IPC validation, cryptographic use, the filesystem and the one subprocess call, and the dependency tree                                                                                                     |
| [`01-Doc-Code-Audit.md`](./01-Doc-Code-Audit.md)   | 2026-09-02 | Every page under `docs/` and every root markdown file, checked against the code it describes: stale numbers, moved paths, and absence claims that have rotted                                                                                                                                       |
| [`02-Subsystem-Audit.md`](./02-Subsystem-Audit.md) | 2026-09-02 | The nine main-process subsystems that landed after the first sweep — `activity`, `attachments`, `breach`, `organisation`, `recovery`, `shell`, `sync`, `theme`, `totp` — plus the eleven renderer modules that landed with them. `breach/`, the project's only network code, gets a pass of its own |

---

## How to read these

**Every finding is anchored to a `file:line` on both sides**, and each one separates what
was **measured** from what was **reasoned**. A finding marked as reasoned was derived from
documented platform behaviour rather than from a reproduction — neither audit ran the app.

**Both pages carry a "checked and found fine" list, and those matter as much as the
findings.** They exist so the next person does not re-investigate settled ground, and so
nobody "fixes" a deliberate choice into a defect.

**Nothing was changed by the audits themselves.** All three were read-only over `src/`. A
finding is outstanding unless it carries a `STATUS:` line saying otherwise, and those lines are
added by whoever fixes the finding, after reading the code that fixes it.

**Every page has a scope note at the top, and it matters.** `src/` was being written while
each ran. The first two pages do **not** cover nine main-process subsystems — `activity`,
`attachments`, `breach`, `organisation`, `recovery`, `shell`, `sync`, `theme`, `totp` — which
landed after their sweep; **`02-Subsystem-Audit.md` covers exactly those**, plus the renderer
modules that landed with them, and carries a plain verdict on whether `breach/` is safe to
wire up.

**The gap none of the three pages covers:** `src/main/ipc/register.ts` held 40 handlers when
the security audit read it and has kept growing since — the six `kh:import:*` channels and the
`kh:settings:*` group both landed afterwards. None of the handlers added since that sweep has
been read against the secret-boundary checklist by any audit. That is the next pass. Count them
with `grep -c 'handle(CHANNELS\.' src/main/ipc/register.ts` rather than trusting a number
written here.

---

## Standing items

- **Findings are marked as they are fixed, and only against read code.** A `STATUS:` line on a
  finding means someone opened the file and saw the fix, not that a commit message claimed it.
  An optimistic status column is worse than none: it is the one thing that would make these
  pages actively misleading rather than merely dated.
- `docs/superpowers/specs/` is **out of scope for all three audits, permanently.** It is
  history: a spec that has drifted from the code is the record of an earlier decision, not a
  bug.
- **`PRIVACY.md` needs a hand.** It is a published promise about behaviour and has gone stale in
  the direction that under-claims — see doc-audit finding F7. Recorded in `MANUAL-BACKLOG.md`.

---

**Related:** [`../12-Roadmap/00-Master-Checklist.md`](../12-Roadmap/00-Master-Checklist.md)
Phase 17 is the work these pages discharge.
[`../00-Overview/03-Threat-Model.md`](../00-Overview/03-Threat-Model.md) is what the security
audit measured against;
[`../02-Security/01-Process-Hardening.md`](../02-Security/01-Process-Hardening.md) is the
design most of its findings concern.
