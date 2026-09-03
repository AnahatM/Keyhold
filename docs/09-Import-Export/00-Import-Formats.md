# Import formats

> The twelve parsers, what each column becomes, and what is deliberately dropped.
> Current reference. Implemented by `src/main/import/`.
>
> **Status: the parsing half is built and tested, and so is the commit half** — the
> `kh:import:*` channels, the mapping wizard, deduplication, the dry run and undo all landed
> after this page was first written and are documented in
> [`02-Import-Service.md`](./02-Import-Service.md). **Nothing mounts the wizard**, so none of it
> is reachable by a user yet. What is outstanding on this page is the format list in §6.
>
> **That count is guarded.** `tools/doc-counts.test.ts` imports `PARSERS` from
> `src/main/import/index.ts` and fails if this page's number, the `_INDEX` row, or the §3
> table's row count stops matching the registry — hard rule 9, because this number had already
> rotted once from eleven to twelve with nothing to catch it.

---

## 1. The shape of the thing

```
file bytes → detectFormat() → parser.parse() → ImportResult
                                                 ├── records[]   drafts, not Credentials
                                                 ├── folders[]   every path, ancestors included
                                                 └── warnings[]  what was dropped, and why
```

Parsers produce **drafts**, not records. `buildCredential` owns ids, timestamps and history,
and an import path that constructed records itself would be a second, divergent
implementation of what a valid record is.

Two placeholder conventions the commit stage must resolve:

- `folderId: "import-folder:<path>"` — real folder ids do not exist until folders are
  created, and the parser has no way to make one.
- `custom[].id: "imported-field-N"` — unique within each record, which is all
  `assertValidCredential` requires.

Both are documented in `src/shared/model/import.ts`. A commit stage that forgets the folder
placeholders will produce records pointing at folders that do not exist, which is why they
are conspicuous strings rather than something that could pass for an id.

---

## 2. Detection is deliberately strict

Each parser's `detect` keys on a tight column set. An unfamiliar variant of a format falls
through to the **generic mapper** rather than being parsed by the wrong parser — a
mis-parse silently puts a password in the notes field, while the generic mapper asks the
user to confirm the mapping.

`index.test.ts` asserts no fixture is claimed by two parsers. That test earned its place:
loosening Safari's `detect` from an exact set to a subset left the _detection_ test passing,
because `PARSERS` ordering was quietly doing the work `detect` should have done.

---

## 3. What each column becomes

| Source                | → Keyhold                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Keyhold JSON**      | Keyhold's own export, read back in — the lossless path, and the only source format this app wrote. Everything the export carries is read. `NewCredentialInput` has no slot for record ids, created/updated dates, or history, so those are **reported, not silently dropped**: a re-import creates new records with fresh history. Importing an export is a merge, not a restore — restoring is copying the `.keep` file back. |
| **Bitwarden CSV**     | `name`→title · `login_username` · `login_password` · `login_uri` (newline-split)→urls · `notes` · `folder`/`collections`→folder · `favorite` · `login_totp`→custom `otp-secret` · `fields` (`name: value` lines)→custom, type guessed · `reprompt`→**dropped, reported**                                                                                                                                                       |
| **Bitwarden JSON**    | as above, plus `folderId` resolved via `folders[]`; field types 0→guessed, 1→`password`, 2→`boolean`, 3→reported; cards→custom (`number`→`password`, `code`→`pin`); identities→custom (`ssn`/`passport`/`licence`→`password`); `deletedDate`/`passwordHistory`/`fido2Credentials`→reported                                                                                                                                     |
| **LastPass**          | `name` · `username` · `password` · `url`→urls (the `http://sn` secure-note sentinel dropped) · `extra`→notes · `grouping` (backslash-nested)→folder · `fav` · `totp`                                                                                                                                                                                                                                                           |
| **Chrome/Edge/Brave** | One Chromium format, one parser: `name` · `url` · `username` · `password` · `note`                                                                                                                                                                                                                                                                                                                                             |
| **Firefox**           | `url`→urls, **title derived from it** (the export has no title column) · `username` · `password` · `httpRealm`/`formActionOrigin`→custom · `guid` and the three timestamps→**dropped, reported**                                                                                                                                                                                                                               |
| **Safari / Apple**    | `Title` · `URL` · `Username` · `Password` · `Notes` · `OTPAuth`→`otp-secret`                                                                                                                                                                                                                                                                                                                                                   |
| **1Password 8**       | `Title` · `Url` · `Username` · `Password` · `Notes` · `Tags`→tags · `Favorite` · `OTPAuth` · `Archived`→row skipped, reported                                                                                                                                                                                                                                                                                                  |
| **Dashlane**          | `title` · `username` · `password` · `url` · `note` · `category`→folder · `otpSecret`/`otpUrl` · `username2`/`username3`→custom "Alternate login"                                                                                                                                                                                                                                                                               |
| **NordPass**          | logins, cards and identities in one file; card/identity columns→custom with proper labels (`cardnumber`→`password`, `cvc`→`pin`, `expirydate`→`date`, `address1/2`→`address`)                                                                                                                                                                                                                                                  |
| **KeePass**           | KeePassXC and the older 1.x-style CSV: `Title`/`Account` · `Username`/`Login Name` · `Password` · `URL`/`Web Site` · `Notes`/`Comments` · `Group`→folder tree · `TOTP` · `Icon` and the timestamps→**dropped, reported**                                                                                                                                                                                                       |
| **Generic**           | A synonym table maps any recognised header; anything unrecognised becomes a custom field with a guessed type **and a warning**. An explicit `ColumnMapping` from the wizard overrides everything.                                                                                                                                                                                                                              |

Cross-cutting: an email-shaped `username` is **mirrored** into `email` with the username
kept verbatim; folder paths are `/`-normalised with every ancestor listed in `folders`.

---

## 4. Two decisions worth recording

**Nothing is dropped silently.** Every column the parser cannot map produces a warning, and
the `WarningLog` collapses per-column complaints to one line rather than one per row — a
2,000-record import must not produce 2,000 identical warnings.

**A warning may never quote a value.** This was a real hole, not a hypothetical: the
original leak guard was a list of five known passwords, and injecting a warning that quoted
an example cell (an account number, a URL) passed straight through it. The guard is now a
property over _every_ value in the fixture, and the re-injection fails two formats.

---

## 5. The CSV reader is hand-written, and why

RFC 4180 by hand rather than a dependency: quoted commas and newlines, doubled quotes, BOM,
mixed CRLF/LF/CR, a final row with no trailing newline, ragged rows, and line tracking so a
warning can say where. A parser is a small amount of well-understood code and a large amount
of supply-chain surface for a security tool that ships zero network access.

**No fixture on disk has a BOM or CRLF.** `.gitattributes` normalises line endings on
checkout, so a fixture committed with CRLF would be silently rewritten and the test
asserting CRLF handling would keep passing while testing nothing — a guard that stops
guarding. The transforms are applied in the test instead, where git cannot reach them.

The fixtures themselves live in `tests/fixtures/import/`, not beside the parsers. That is
the project rule: no credential-export file is committed outside `tests/**/fixtures`, so
"is this someone's real export?" is answerable from a path. Every value in them is
obviously synthetic — `example.com`, `hunter2`, `4111111111111111`.

### Bugs the tests found, before any injection

1. **`JSON.parse` rejects a BOM**, so a Windows-written Bitwarden JSON export failed
   outright.
2. **`guessCustomFieldType` called `2027-03-01` a phone number** — the phone pattern matched
   an ISO date, and value-shape checks ran ahead of label checks. Label checks now run
   first. The same bug had mislabelled the account number `4471-9902`.
3. Bitwarden card `expMonth`/`expYear` (`"5"`, `"2030"`) typed as a date.
4. Bitwarden identity `title` — an honorific — collided with the record's own title.

Six fault injections. Two found genuine holes: the BOM strip was being silently covered for
by `normaliseColumnKey`, which also trims one; and the warning leak guard described above.

---

## 6. Not built yet

- **Formats on the roadmap but not here**: KDBX 3/4, KeePass XML, 1PUX, Proton Pass, Enpass,
  Keeper, RoboForm, Dashlane JSON, and Keyhold's own `.keep`/`.keepx`. Keyhold's own JSON
  export _is_ registered — `keyhold-json.ts`, first in `PARSERS`, and the one strict parser;
  see [`01-Export-Formats.md`](./01-Export-Formats.md) §7.
- **The activity-log entry** an import should write. The rest of the commit half — the
  channels, the wizard, dedupe, the dry run and undo — is built; see
  [`02-Import-Service.md`](./02-Import-Service.md).
- **Bitwarden's encrypted exports** are refused with an explicit reason rather than parsed.
- **Security questions** — none of these formats export them as structured data, so nothing
  maps to `securityQuestions`.
- **Source timestamps and history** — `NewCredentialInput` has no slot for `meta.createdAt`
  or `history.versions`, and `buildCredential` owns both. Carried as explicit warnings
  rather than as a second construction path.

### Confidence, stated honestly

A wrong mapping loses data, so: Bitwarden (both), LastPass, Chromium and Firefox are high
confidence. Safari and Dashlane are medium-high — the optional OTP columns vary by build,
and both forms are accepted. 1Password 8, NordPass and the KeePass 1.x-style CSV are medium:
the column lists are from memory rather than from a file. In every case a variant that does
not match falls through to the generic mapper rather than being mis-parsed, which is what
makes the uncertainty survivable.
