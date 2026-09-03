# 05 · Features

One page per feature. Folders are added as each lands.

| Page                                                     | Phase | What it covers                                                                                                                                                                             |
| -------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`00-Password-Generator.md`](./00-Password-Generator.md) | 8     | Four generation modes, why `requireEachClass` is charged against entropy rather than given away free, and the anti-bias guard                                                              |
| [`01-Health-Rules.md`](./01-Health-Rules.md)             | 13    | The eight offline rules, the scoring weights and their reasoning, and why the report can never carry a password                                                                            |
| [`02-History-And-Audit.md`](./02-History-And-Audit.md)   | 6     | Why version deltas point backwards, the four audit privacy levels, and why nothing on the save path may block on the network                                                               |
| [`03-Search-Sort-Filter.md`](./03-Search-Sort-Filter.md) | 7     | The query language, why `note:` degrades instead of lying, ranking, and why every sort is total and stable                                                                                 |
| [`04-Attachments.md`](./04-Attachments.md)               | 9     | Why the chunk id is random rather than the digest, reference counting, where the size limits come from, and MIME sniffing                                                                  |
| [`05-TOTP.md`](./05-TOTP.md)                             | —     | Why the RFC vectors are the only reason to trust any of it, why `now` is a parameter, and why base32 rejects rather than producing confidently-wrong digits                                |
| [`06-Organisation.md`](./06-Organisation.md)             | 7     | The folder-delete policy being the caller's choice, the three cycle guards, `findOrCreateFolderPath` as the import commit stage's dependency, and why every drag has a keyboard equivalent |
| [`07-Breach-Check.md`](./07-Breach-Check.md)             | 13    | k-anonymity in plain English, why off-by-default is structural rather than a flag, why a failure is never `safe`, and why the CSP must not be relaxed to enable it                         |

**Still to come:** the import wizard and export dialog (Phases 10–11), settings (14), and the
health dashboard (13). Import parsing is documented separately in
[`09-Import-Export`](../09-Import-Export/_INDEX.md); the merge engine in
[`07-Sync-And-Merge`](../07-Sync-And-Merge/_INDEX.md).

**Three of these are engines with no way in.** TOTP, organisation and the breach check are
built and tested with no `kh:*` channel of their own; each page's status blockquote says
exactly what is missing.
