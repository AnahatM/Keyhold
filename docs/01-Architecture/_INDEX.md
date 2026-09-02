# 01 · Architecture

How Keyhold is put together.

| Page                                           | What it covers                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`00-Process-Model.md`](./00-Process-Model.md) | The main/renderer division, the module map, the **safe projection** and its guard, how a single secret is deliberately released, the IPC contract and its runtime validation, structured error codes, the preload rules, and the vault lifecycle |

**Related:** [`../02-Security/01-Process-Hardening.md`](../02-Security/01-Process-Hardening.md)
covers the window-level controls (CSP, sandbox, navigation).
[`../03-Data-Model/`](../03-Data-Model/) will document the record schema when Phase 5 lands.
