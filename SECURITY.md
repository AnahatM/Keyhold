# Security policy

Keyhold stores people's passwords. Security reports are the most valuable contribution
anyone can make to this project, and they are treated accordingly.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting:
**[Security → Report a vulnerability](https://github.com/AnahatM/Keyhold/security/advisories/new)**

Include, as far as you can:

- What the issue is, and which component it is in (`src/main`, `src/preload`, `src/renderer`, the vault format, an import parser).
- How to reproduce it. A failing test or a proof-of-concept vault file is ideal.
- What an attacker gains, and what they need in order to exploit it.
- The Keyhold version, your OS, and your build (a GitHub release, or one you compiled).

**Never include a real vault file or a real password in a report.** If a specific vault is
needed to reproduce, say so and a sanitised reproduction will be worked out with you.

## What to expect

|                          |                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| First response           | Within 7 days                                                                                                                  |
| Assessment and severity  | Within 14 days                                                                                                                 |
| Fix for a critical issue | As fast as is realistically possible, then an immediate release                                                                |
| Disclosure               | Coordinated. A 90-day window is offered by default; shorter or longer by agreement                                             |
| Credit                   | In the changelog and the in-app security page, unless you prefer anonymity                                                     |
| Bounty                   | **None.** The project has no funding and never will (decision D11). This is stated plainly so nobody spends time expecting one |

## Scope

**In scope** — anything that weakens the guarantees in
[`docs/00-Overview/03-Threat-Model.md`](./docs/00-Overview/03-Threat-Model.md):

- Cryptographic flaws: key derivation, encryption, nonce handling, key wrapping, the KEEP container.
- Secret material reaching the renderer process, a log, an error message, a crash report, or disk in plaintext.
- Bypasses of `contextIsolation`, `sandbox`, the CSP, or the IPC allow-list.
- A vault file, an import file, or a `.keepx` bundle that causes code execution or memory disclosure when opened.
- Data-loss bugs. Losing a credential is a security failure here, not merely a bug (goal G1).
- Any unexpected network request. Keyhold makes none unless the user has explicitly enabled the HIBP check.

**Out of scope** — these are documented limitations, not vulnerabilities:

- Anything requiring an already-compromised operating system, a keylogger, or malware reading process memory.
- Reading secrets from memory while the vault is unlocked. This is unavoidable and is stated in the threat model.
- The absence of a master-password recovery mechanism. That is a design decision, not a flaw.
- Unsigned builds triggering SmartScreen or Gatekeeper warnings. Known and documented (decision D16).
- Social engineering, physical access to an unlocked machine, or a weak master password chosen by the user.

## For contributors

If a pull request touches `src/main/security.ts`, `src/shared/crypto/`, `src/shared/format/`,
or the IPC contract, say so in the description. Those files carry guard tests that must
keep passing, and changes there get a closer read.

The standing rules are in [`CLAUDE.md`](./CLAUDE.md#hard-rules). The short version:
never invent cryptography, never use `Math.random()` for anything security-relevant,
never put a secret in the renderer, and never make a network request.
