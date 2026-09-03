# 09 · Import & export

Getting data in from other password managers, and out again.

| Page                                             | Phase | What it covers                                                                                                                                                            |
| ------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`00-Import-Formats.md`](./00-Import-Formats.md) | 10    | The eighteen parsers, the full column→field mapping per format, and what each one drops and reports                                                                       |
| [`01-Export-Formats.md`](./01-Export-Formats.md) | 11    | The four ways out, what each loses, why a plaintext export is treated as dangerous, CSV injection, the round trip, and the `kh:export:*` channels                         |
| [`02-Import-Service.md`](./02-Import-Service.md) | 10    | The transaction between a parser and a vault: the held file, the dry run, the duplicate rule, the merge policy, the three-part undo guard, and the `kh:import:*` channels |

**The split worth knowing before reading any of them.** A parser is a pure function from a
string to drafts and knows nothing about a vault; the exporters are pure functions from a
document to bytes and write no files. Everything that actually touches somebody's vault —
holding a plaintext export in memory, committing it, taking it back, opening a save dialog —
lives in exactly two places, and both are in the main process.

**Still to come:** KDBX 4 in both directions, Bitwarden JSON export, mounting the export
dialog, and the activity-log entry an import should write.
