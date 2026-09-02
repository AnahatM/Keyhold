# Keyhold — Documentation

> **Keyhold** is a free, open-source, fully offline credential manager for Windows and macOS.
> Your passwords, in a file you own, encrypted with a key only you have.

**New here? Start with [`00-Overview/00-What-Is-Keyhold.md`](./00-Overview/00-What-Is-Keyhold.md).**

---

## The tree

Folders are created as each system lands, not pre-created empty. Entries marked _planned_ do not
exist yet; the phase that creates them is named.

| Folder                                                    | Contents                                                                      | Status               |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------- |
| [`00-Overview/`](./00-Overview/_INDEX.md)                 | What Keyhold is · naming & glossary · competitive analysis · threat model     | **Written**          |
| [`01-Architecture/`](./01-Architecture/_INDEX.md)         | Process model, module map, the safe projection, the IPC contract              | **Written**          |
| [`02-Security/`](./02-Security/_INDEX.md)                 | Crypto design, key hierarchy, process hardening, the safe-projection boundary | **Written**          |
| [`03-Data-Model/`](./03-Data-Model/_INDEX.md)             | The record schema, the secret classification, field types, operations         | **Written**          |
| [`04-Vault-Format/`](./04-Vault-Format/_INDEX.md)         | The **KEEP** container spec — publishable and implementable by third parties  | **Written**          |
| [`05-Features/`](./05-Features/_INDEX.md)                 | One page per feature — generator, health, history, search so far              | **Partial**          |
| [`06-UI-Design-System/`](./06-UI-Design-System/_INDEX.md) | Tokens, themes, the accent system, the shell, components, a11y rules          | **Written**          |
| `07-Main-Process-Services/`                               | Vault service, clipboard, biometrics, file watcher, origin capture            | _Planned — Phase 2_  |
| `08-Renderer-State/`                                      | Store shape, selectors, the safe projection, secret-fetch lifecycle           | _Planned — Phase 2_  |
| [`09-Import-Export/`](./09-Import-Export/_INDEX.md)       | Every supported format, with per-format field-mapping tables                  | **Partial**          |
| `10-Sync-And-Transfer/`                                   | Portable file · `.keepx` bundles · the merge engine and conflict matrix       | _Planned — Phase 12_ |
| [`11-Development/`](./11-Development/_INDEX.md)           | Setup, scripts, conventions, testing policy, toolchain decisions              | **Written**          |
| [`12-Roadmap/`](./12-Roadmap/_INDEX.md)                   | Master checklist · feature backlog · decision log                             | **Written**          |
| [`13-Packaging/`](./13-Packaging/_INDEX.md)               | Building, the unsigned-binary reality, the release checklist and CI           | **Written**          |
| [`14-Audits/`](./14-Audits/_INDEX.md)                     | The security audit and the docs-vs-code audit, with anchored findings         | **Written**          |
| [`superpowers/specs/`](./superpowers/specs/)              | Point-in-time design specs. **History, not current reference**                | **Written**          |

---

## Reading paths

**"I want to understand the product."**
[What Keyhold is](./00-Overview/00-What-Is-Keyhold.md) → [Competitive analysis](./00-Overview/02-Competitive-Analysis.md) → [Naming & glossary](./00-Overview/01-Naming-And-Glossary.md)

**"I want to understand the security."**
[Threat model](./00-Overview/03-Threat-Model.md) → [Cryptography](./02-Security/00-Cryptography.md) → [Process hardening](./02-Security/01-Process-Hardening.md) → [The KEEP format spec](./04-Vault-Format/00-KEEP-Format-Spec.md)

**"I want to build the next thing."**
[Master checklist](./12-Roadmap/00-Master-Checklist.md) → [Decision log](./12-Roadmap/02-Decision-Log.md) → the relevant `docs/` folder

**"I want to know why something is the way it is."**
[Decision log](./12-Roadmap/02-Decision-Log.md) first. If it is not there, the [founding spec](./superpowers/specs/2026-09-02-keyhold-product-spec.md).

---

## Rules for this documentation

1. **The code is the source of truth.** If a doc disagrees with the code, the code wins — then fix
   the doc.
2. **Change a system, update its doc in the same pass.** A stale doc is worse than no doc.
3. **`docs/` is current reference. `docs/superpowers/specs/` is history.** Never "fix" a spec to
   match today's code — a drifted spec is the record of an earlier decision, not a bug. Update the
   numbered tree instead.
4. **No second list.** If a system wants its own copy of "the formats" or "the views", fold it into
   the existing source of truth.
5. **Numbers, absence claims and file paths in prose all rot.** Either guard the claim with a test
   or put it in an obviously-dated snapshot section.
