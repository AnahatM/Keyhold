# Security audit — 2026-09-02

> A read-only sweep of the whole main process, the preload bridge, the IPC surface, the
> crypto and format layers, the filesystem paths, the one subprocess call, and the
> dependency tree. Nothing was fixed; everything found is written down here.
> Point-in-time snapshot, not current reference.
>
> **Scope note.** `src/` was being actively written while this ran. Nine main-process
> subsystems — `activity`, `attachments`, `breach`, `organisation`, `recovery`, `shell`,
> `sync`, `theme`, `totp` — appeared **after** the sweep and are explicitly not covered; see
> "What this audit did not cover". The findings and the "checked and found fine" list
> describe the tree as it stood during the sweep.

---

## Summary

**The thing this codebase is most afraid of is not happening.** The secret boundary —
decision D13, the project's strongest claim — was swept end to end and came back clean:
every path that returns data to the renderer goes through `toProjection`,
`toDiffProjection`, `VaultHealthReport`, or a single brokered `revealSecret`, and none of
them carries a password, a note body, a security answer, a hidden custom value, or an
attachment byte. The cryptographic use is careful in the ways that actually matter — fresh
CSPRNG nonces with no caller-supplied-nonce API, full-length tags, the header bound as AAD,
KDF floors and ceilings enforced before the KDF runs, rejection sampling instead of modulo,
and a `SecretBytes` wrapper that redacts through all three stringification paths. `npm audit
--omit=dev` reports **0 vulnerabilities**, and no production dependency pulls in native code
or network access.

What the sweep did find is a cluster of **window- and process-level hardening gaps, all of
the same shape**: a control that `security.ts` implements correctly is either overridden
elsewhere, or applied to one code path and not its neighbour, or left enabled in a packaged
build because it was written for development. The single most important one is that
`window.ts` installs a second `setWindowOpenHandler` that replaces the hardened one and
drops its scheme check. None of these is reachable without either a compromised renderer or
control of the process environment — but a compromised renderer is exactly the attacker
D13 exists to defeat, and the whole point of `security.ts` is that it holds when that
happens.

**15 findings: 2 high, 3 medium, 6 low, 4 informational.** No critical.

---

## Findings, by impact

### S1 — HIGH · A second window-open handler replaces the hardened one

`src/main/window.ts:53-56` against `src/main/security.ts:95-100`

`applyWebContentsHardening` installs a `setWindowOpenHandler` that checks the scheme before
handing a URL to the OS:

```ts
// security.ts:98
if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url);
return { action: 'deny' };
```

`createMainWindow` then installs its own, twenty lines after calling `hardenWindow(window)`:

```ts
// window.ts:53
window.webContents.setWindowOpenHandler(({ url }) => {
  void shell.openExternal(url);
  return { action: 'deny' };
});
```

`setWindowOpenHandler` holds **one** handler per WebContents; the later call replaces the
earlier one. So the handler actually in force on the main window is the permissive one, and
the scheme check that `security.ts` was careful to write never runs.

**What that gets an attacker.** A compromised renderer calls `window.open(...)` with any URI
it likes and the main process hands it to `shell.openExternal`, which asks the OS to invoke
whatever application is registered for that scheme. On Windows that is the registered
protocol-handler surface — a long list of installed applications, several of which have
historically accepted attacker-controlled arguments. `file:` and UNC paths are in the same
bucket. The renderer needs no Node access to do this; `window.open` is plain DOM.

`window.ts` also loses the `{ action: 'deny' }`-with-reasoning comment and the
`will-attach-webview` context that made the security.ts version reviewable, which is the
second cost of having two.

**Fix.** Delete the handler in `window.ts` entirely. `applyWebContentsHardening` already
runs for this window twice over — once from the `web-contents-created` hook in `index.ts:66`
and once from `hardenWindow` — so removing the duplicate loses nothing and restores the
check. Then add a guard test that opens a `WebContents`, invokes the registered handler with
`ms-settings:`, `file:///`, and a malformed string, and asserts `shell.openExternal` was not
called. This is precisely the defect class that `security.test.ts` cannot see today, because
it asserts the *configuration object* and never the *installed handlers*.

---

### S2 — HIGH · `will-navigate` opens any scheme externally, with no check at all

`src/main/security.ts:88-93`

```ts
contents.on('will-navigate', (event, url) => {
  if (!isAllowedNavigation(url)) {
    event.preventDefault();
    void shell.openExternal(url);
  }
});
```

Same class as S1, and independent of it: this path has never had a scheme check. Anything
that is not `file:` (or localhost in development) is cancelled *and then handed to the OS*.
A compromised renderer setting `location.href = '<scheme>:<payload>'` reaches
`shell.openExternal` with a fully attacker-chosen URI. The Electron guidance on this is
explicit — validate the scheme before `openExternal`, never pass through what you just
decided was untrusted.

The asymmetry is the tell: the same file already knows to check `^https?:$` in the
`setWindowOpenHandler` twenty lines below, so this is an omission rather than a decision.

**Fix.** Extract the scheme test into one predicate and use it in both places; open only
`http:` and `https:` externally and drop everything else silently. Cover it with the same
guard test as S1.

---

### S3 — MEDIUM · `ELECTRON_RENDERER_URL` is honoured in packaged builds

`src/main/window.ts:58-63`

```ts
const devServerUrl = process.env.ELECTRON_RENDERER_URL;
if (devServerUrl !== undefined && devServerUrl !== '') {
  void window.loadURL(devServerUrl);
} else {
  void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}
```

There is no `app.isPackaged` gate. Anyone who can set an environment variable for the
Keyhold process — a tampered shortcut, a user-level persistence mechanism, a parent process,
a poisoned `.desktop`/launch agent — chooses what the main window loads, in a window that
has the preload bridge attached. `isAllowedNavigation` does not help: it guards
`will-navigate`, not the initial `loadURL`. The CSP is applied to the response, but
`script-src 'self'` resolves against *that* origin, so scripts served by the attacker's own
host run and can call every method on `window.keyhold` — including `vault.unlock` and
`credentials.revealSecret`.

This is not remote code execution on its own; it requires local write access to the user's
environment. But it converts "can set an env var" into "can drive the vault API", which is a
much shorter step than it should be, and the fix is one clause.

**Fix.** `if (!app.isPackaged && devServerUrl …)`. `HARDENED_WEB_PREFERENCES` already gates
`devTools` on exactly this, so the idiom is in the file next door.

---

### S4 — MEDIUM · The smoke harness ships in packaged builds and is armed by an env var

`src/main/index.ts:108`, `src/main/smoke.ts:40-41`, `smoke.ts:106`, `smoke.ts:394-430`

`runSmokeCheck` is imported unconditionally by the main entry point, so it is in the
production bundle, and `isSmokeRun()` tests only `process.env.KEYHOLD_SMOKE === '1'`. With
that set, the app executes a generated script in the renderer via
`webContents.executeJavaScript`. With `KEYHOLD_SMOKE_VAULT` also set, that script calls
`window.keyhold.vault.create(path, 'a-smoke-test-master-passphrase')` against the given
path — which, if the path is an existing vault, rotates it into `.bak.1` and replaces it
with an empty one under a passphrase printed in the source. It then calls `app.exit()`.

The precondition is the same as S3 (control of the environment), and the same reasoning
applies: a dev affordance that survives into a shipped binary is a lever that should not be
there. The data-loss angle matters as much as the disclosure one here, given goal G1.

**Fix.** `isSmokeRun()` should also require `!app.isPackaged`, or `smoke.ts` should be
excluded from the production main bundle in `electron.vite.config.ts` and imported
dynamically. The smoke runner in `tools/smoke.mjs` launches an unpackaged build, so gating
on `app.isPackaged` costs nothing.

---

### S5 — MEDIUM · `netsh` is invoked by bare program name

`src/main/history/network-name.ts:153`

```ts
const output = await runCommand('netsh', ['wlan', 'show', 'interfaces']);
```

The macOS branch four lines below uses `/usr/sbin/system_profiler` — an absolute path,
correctly. The Windows branch does not. `execFile` with a bare name resolves through
`CreateProcess`'s search order, which begins with the application directory and, depending
on `SafeProcessSearchMode`, can include the current working directory before `%PATH%`. A
`netsh.exe` dropped in either location is executed by Keyhold, in Keyhold's process context,
on the ordinary save path.

The exploitation precondition — write access to the app directory or the working directory —
is real on a machine where the app was extracted to a user-writable folder, which is exactly
what the planned portable Windows build produces.

Everything else about this call is right: `execFile` not `exec` (so no shell), a 2-second
timeout, a 512 KiB output bound, `windowsHide`, and every failure mode collapsing to `null`.

**Fix.** `join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'netsh.exe')`, with the
existing null-on-failure behaviour covering a missing binary.

---

### S6 — LOW · The failed-attempt wipe leaves recoverable copies behind

`src/main/session/session-controller.ts:289-300`

```ts
await rm(path, { force: true });
for (let index = 1; index <= 10; index += 1) {
  await rm(`${path}.bak.${index}`, { force: true });
}
```

It removes the vault and ten backup slots. It does not remove `${path}.tmp` — the orphan an
interrupted write leaves, which `findOrphanedTemp` exists to surface — nor
`${path}.recovered-<timestamp>`, which `quarantineOrphanedTemp` deliberately creates and
which the same file says is "never deleted… the only copy of something". Either can be a
complete, openable vault.

For a feature whose entire purpose is destruction, leaving a full copy on disk is a broken
promise rather than a bug in the ordinary sense.
`docs/02-Security/02-Session-Model.md:180` states it as "removes the vault **and its
backups**", which a reader will take to mean everything.

The feature is off by default, requires an opt-in of at least three attempts, and is not
wired to any UI yet — which is the only reason this is low rather than medium.

**Fix.** Enumerate the directory for `basename(path)` plus any of the known suffixes
(`.tmp`, `.bak.N`, `.recovered-*`) and remove them all, or state the limit honestly in the
setting's own copy. This is worth deciding before the settings screen exposes it.

---

### S7 — LOW · Unguarded `new URL()` inside the window-open handler

`src/main/security.ts:98`

`new URL(url)` throws on a string that is not a valid URL, and the throw is inside a handler
Electron invokes from the main process. A renderer calling `window.open('not a url')` turns
into an exception on a path with no `try`. (Reachable only once S1 is fixed and this handler
is the live one, which is why it is filed below S1 rather than with it.)

**Fix.** Parse inside a `try`, and return `{ action: 'deny' }` from the `catch` — deny is
already the answer on every path, so failing closed costs nothing.

---

### S8 — LOW · No IPC sender validation

`src/main/ipc/register.ts:97`

```ts
ipcMain.handle(channel, async (_event, ...args: unknown[]) => { … });
```

The sender is discarded. The Electron security checklist asks for `event.senderFrame`
validation so that a frame the app did not create cannot invoke a handler.

The practical risk here is low, and deliberately so: `nodeIntegrationInSubFrames` is false,
`frame-src 'none'` and `webviewTag: false` mean there are no other frames, and
`will-navigate` (S2 aside) keeps the top frame on the app's own pages. It is also true that
D13 already treats the renderer as hostile, so a sender check adds little against the
attacker this project models. Recording it because "we considered it and here is why it is
not needed" is a better state than silence.

**Fix (optional, defence in depth).** Assert `event.senderFrame === mainWindow.webContents.mainFrame`
in the `handle` wrapper — one place, all channels.

---

### S9 — LOW · The one subprocess-spawning channel has no rate limit

`src/main/ipc/register.ts:405-408` → `src/main/history/origin.ts:172` →
`network-name.ts:50`

`kh:history:networkName` calls `refreshNetwork()`, which deliberately bypasses the 60-second
cache because a user watching a spinner asked for a fresh answer. `#refresh` de-duplicates
*concurrent* calls but not sequential ones, so a renderer looping on this channel keeps a
`netsh` or `system_profiler` process running back to back for as long as it likes. Each is
bounded at 2 seconds and 512 KiB, so this is a nuisance rather than an outage — but it is
the only channel in the app that can start a process, and it is the only one with no
throttle of any kind.

**Fix.** A minimum interval between forced refreshes (a few seconds), or route it through the
same broker-style counter the reveal path uses.

---

### S10 — LOW · `preferences.json` is written non-atomically and without a restrictive mode

`src/main/session/preferences.ts:152`, and the same pattern in
`src/main/window-state.ts:117`

```ts
writeFileSync(preferencesFile(), JSON.stringify(next, null, 2), 'utf8');
```

Default mode (`0o666` less umask) and a plain truncating write, against
`atomic-write.ts:120`, which opens the vault's temp file with `0o600` and does
tmp → fsync → rotate → rename → fsync-dir. The file holds `quickUnlock[].protectedDek` — the
DEK wrapped by DPAPI or Keychain. The wrapping is what protects it, and the file is inside a
per-user directory, so this is not a disclosure on its own; it is an asymmetry with the
project's own standard, and on a POSIX box with a permissive umask it is a world-readable
file containing key ciphertext.

The non-atomic write is the more interesting half: a crash mid-write truncates the file and
silently drops every quick-unlock enrolment and the recent-vault list. Recoverable (the
master password always works), but it contradicts the "never lose data" instinct applied
everywhere else.

**Fix.** `writeFileSync(file, data, { encoding: 'utf8', mode: 0o600 })`, and write via a
temp file plus `renameSync`.

---

### S11 — INFORMATIONAL · `MAX_STRING_BYTES` counts UTF-16 code units, not bytes

`src/shared/ipc/validation.ts:52,58`

```ts
export const MAX_STRING_BYTES = 1_048_576; // 1 MiB
…
if (value.length > MAX_STRING_BYTES) …
```

`String.prototype.length` is UTF-16 code units. A string of astral-plane characters at the
limit is roughly 4 MiB of UTF-8 and 4 MiB in V8's heap. The cap still bounds the attack, so
this is not a hole — but the constant's name promises something it does not measure, and
`docs/01-Architecture/00-Process-Model.md:150` repeats the byte framing.

**Fix.** Rename to `MAX_STRING_LENGTH`, or measure with `Buffer.byteLength(value, 'utf8')`
and keep the name.

---

### S12 — INFORMATIONAL · A no-op ternary that reads as a security check

`src/main/vault/vault-service.ts:441`

```ts
return isCustomFieldValueSecret(field) ? field.value : field.value;
```

Both branches are identical. The comment above it explains that asking for a non-secret
value here is "either redundant or a probe", so returning it either way is the intended
behaviour — but the expression looks like a gate to anyone skimming, and a reviewer
checking whether the secret classification is enforced on this path will read it as a
positive answer. Behaviour is correct; the code lies about why.

**Fix.** `return field.value;`, with the existing comment kept.

---

### S13 — INFORMATIONAL · `ICON_KINDS` is declared twice

`src/shared/ipc/credential-validation.ts:118` duplicates `src/shared/model/credential.ts:344`.
Hard rule 8 ("no second list") applied to a list that decides what a validator accepts. They
agree today. Nothing would fail if they stopped agreeing — an icon kind added to the model
would be rejected at the IPC boundary with "icon.kind is not a known kind", which presents
as a UI bug rather than a validation bug.

**Fix.** Import `ICON_KINDS` from the model.

---

### S14 — INFORMATIONAL · Array caps are duplicated as literals with no guard

`src/shared/ipc/credential-validation.ts:39-42` (`MAX_URLS` 32, `MAX_TAGS` 64,
`MAX_CUSTOM_FIELDS` 128, `MAX_SECURITY_QUESTIONS` 32) and
`src/main/vault/credential-ops.ts:36-39` (the same four names and values).

The header comment in `credential-validation.ts` justifies the double-check explicitly —
one layer caps to protect the validator, the other to protect the vault — and that reasoning
is sound. What is missing is a test asserting the two sets of numbers agree. If the ops
layer were raised and the validation layer were not, the IPC boundary would silently become
the real limit and the ops cap would never fire.

**Fix.** Either import one from the other, or a two-line test asserting equality.

---

### S15 — LOW (correctness, security-adjacent) · The renderer's plain-copy path relies on a denied permission

`src/renderer/src/vault/SecretField.tsx:197`, against `src/main/security.ts:131-135`

```ts
void navigator.clipboard.writeText(value).then(() => { setCopied(true); });
```

`applySessionHardening` denies **every** permission unconditionally, including the
clipboard ones that Electron routes through `setPermissionRequestHandler` /
`setPermissionCheckHandler`. If `clipboard-sanitized-write` is among them at runtime, this
promise rejects, the copy silently does nothing, and — because there is no `.catch` — the
rejection is unhandled and the "Copied" announcement never fires.

**Marked as reasoned, not measured:** this depends on how Electron 44 routes
`clipboard-sanitized-write` for a user-gesture write, and this audit did not run the app.

**Fix.** Either route non-secret copies through the main process like secret ones (which
also removes the split-brain of two clipboard paths), or allow-list exactly
`clipboard-sanitized-write` in the permission handlers and add the `.catch`. Worth
resolving either way, because the failure mode is invisible.

---

## Checked, and found fine

Recorded so nobody re-investigates these, and so nobody "fixes" one of them into a defect.

**The secret boundary (finding class #1) — swept, nothing found.**

- `src/shared/model/credential.ts` declares the classification once, and both compile-time
  exhaustiveness checks (`_allCoreFieldsClassified`, `_allVersionedFieldsListed`) are real
  type errors, not comments.
- `src/main/vault/projection.ts` builds every projection field by field. No spread of a
  `Credential`. `password`/`notes` cross only as lengths; security answers only as
  `hasAnswer`; custom values only when `isCustomFieldValueSecret` is false; attachments as
  metadata only.
- `src/main/history/diff-projection.ts` does the same for both sides of a diff, and reuses
  the same per-entry projectors, so an old security answer is stripped by exactly the code
  that strips the current one.
- Every one of the 40 `handle(...)` registrations in `src/main/ipc/register.ts` was read.
  The only routes that return secret material are `credentials.revealSecret` and
  `session.copySecret` (both `SecretRef`-addressed, brokered, TTL'd, rate-limited) and
  `generator.generate`, which is the documented bounded exception. `credentials.deepSearch`
  returns ids only. `health.analyse` returns ids, counts, severities, entropy bits, and a
  host string taken from `normaliseHost`, which strips userinfo with `lastIndexOf('@')` —
  correctly, including a password containing `@`.
- `VaultService` exposes `diffVersion` (values) and `diffVersionProjection` (safe) as
  separate methods, and only the projected one is reachable from IPC.
- `src/preload/index.ts` enumerates every member by hand. No generic `invoke`, no
  caller-supplied channel, no state, one fixed event channel, and a hard throw when
  `contextIsolation` is off.
- The renderer holds no secret store: `credential-store.ts` keeps projections only,
  `SecretField.tsx` keeps a revealed value in component state keyed so navigation unmounts
  it, and `generation-history.ts` is capped at five and lives in component state.
- **Everything the renderer persists was checked**, including the modules that landed during
  the audit. `localStorage` is written by exactly four places — `theme/appearance-store.ts`
  (appearance settings), `shell/AppShell.tsx` (pane layout),
  `onboarding/onboarding-storage.ts` (a version, a step id, three booleans and an outcome,
  every field named, with a marker test proving extra fields cannot ride along), and
  `organisation/expansion-storage.ts` (folder ids, capped, already in the safe projection).
  Both of the new ones scope their key by `vaultId` and document that `localStorage` is an
  ordinary readable file in the user profile. `commands/recent-commands.ts` deliberately
  persists nothing. No secret reaches any of them.
- No `dangerouslySetInnerHTML`, no `innerHTML`, no `eval`, no `new Function` anywhere in
  `src/renderer` or `src/preload`.

**Secrets in places nobody looks.**

- Only two `console.*` calls exist in `src/main` (`ipc/register.ts:103`, `index.ts:89`).
  Both log an `Error`, never the handler arguments, so a password submitted to
  `vault:unlock` is not in scope for them. `IpcValidationError` is documented and
  implemented never to interpolate the offending value (`validation.ts:36-39`).
- `SecretBytes` overrides `toString`, `toJSON`, and `nodejs.util.inspect.custom`, so a key
  reaching any of those three paths redacts.
- `kdf-worker.ts:62-69` returns only `error.message` and never the password.
- No error constructor in `crypto/errors.ts` interpolates key material, a password, or a
  full path; `chunkIntegrity` interpolates a random chunk id, which is not user content.
- `no-console` is a lint error (allowing only `warn`/`error`) across `src/main`,
  `src/preload`, and `src/shared`.

**Electron hardening.** Every control in `HARDENED_WEB_PREFERENCES` is set explicitly and
matches `docs/02-Security/01-Process-Hardening.md`. The CSP is `default-src 'none'` with no
`unsafe-eval`, no `unsafe-inline` in `script-src`, and `connect-src 'none'`.
`X-Content-Type-Options: nosniff` is added. `webviewTag` is false and `will-attach-webview`
is prevented anyway. Permissions are denied through both handlers. `devTools` is gated on
`!app.isPackaged` and devtools are closed on sight if opened another way. Hardening is
applied from `web-contents-created`, so it covers WebContents nobody remembered to harden.
The single-instance lock is in place. (The gaps are S1–S4, all of which are about controls
being overridden or bypassed rather than absent.)

**Cryptographic use.**

- One nonce per encryption, from `randomBytes`, with no API accepting a caller's nonce.
  Tags are never truncated; both lengths are asserted on the decrypt path.
- The body is bound to the exact header bytes as AAD, and the reader retains the bytes it
  read rather than re-serialising. `serialiseHeader` fixes key order explicitly.
- Each attachment chunk is bound to its own raw id, so a relocated chunk fails.
- `assertUsableKdfParams` runs before Argon2, in both `KdfRunner.derive` and `InProcessKdf`,
  and enforces algorithm, integer-ness, floor, ceiling and minimum salt length. The
  constants match the published spec exactly.
- The KEK is destroyed in a `finally` on all three envelope paths.
- `unwrapDek` swallows the underlying cause deliberately, so the error cannot hint at how
  close a guess was, and there is no separate password verifier to act as an oracle.
- `SecretBytes.equals` is constant-time.
- `randomInt` uses rejection sampling with a correctly computed byte width and limit;
  `shuffleInPlace` and `randomChoice` both route through it; the generator uses nothing else.
- **`Math.random()` appears nowhere in `src/`, `tools/`, or `tests/`** other than in prose
  explaining that it is banned. The lint ban (`no-restricted-properties` on `Math.random`)
  is in the base config block with no `files` restriction, so it applies project-wide; it is
  switched off only for test files. It would not catch an aliased `Math` object, which is a
  theoretical gap and not one worth closing.

**Filesystem and process.**

- `writeVaultFileAtomically` writes to `.tmp` with mode `0o600`, `fsync`s the file, rotates
  backups by **copying** the live vault (never moving it, so no instant exists with no file
  at the vault path), renames atomically, then `fsync`s the directory — with a documented
  Windows no-op. On failure it removes the temp so it is not later mistaken for a crashed
  write. `findOrphanedTemp` reports and never acts.
- Paths reaching the filesystem come from OS dialogs opened by the main process, not from
  the renderer; `requireVaultPath` additionally rejects NUL bytes; `requireId` constrains ids
  to `[A-Za-z0-9_-]{1,128}`, so an id can never carry a separator or a traversal.
- The container reader is bounds-checked through a single `Reader`, caps the body and each
  chunk at 256 MiB, passes `maxOutputLength` to `gunzipSync`, and cross-checks the chunk
  count against the header.
- `execFile`, never `exec`; no shell anywhere; the only subprocess call is the network probe.

**Network.** At the time of the sweep there was no network code in `src/` at all — no
`fetch`, no `node:http`/`https`, no `net.request`, no `XMLHttpRequest`, no WebSocket. That
changed during the audit: see "the moving target" below. As of the final re-check there is
**exactly one `fetch` call site in the entire repository**,
`src/main/breach/https-transport.ts:119`, and nothing outside `src/main/breach/` imports that
module, so no runtime path reaches it — the handler count in `register.ts` is unchanged at
40 and there is no `kh:breach:*` channel.

**Dependencies.** `npm audit --omit=dev`, run 2026-09-02:

```
found 0 vulnerabilities
```

The four runtime dependencies are `hash-wasm` (pure WebAssembly, pinned `4.12.0`),
`@zxcvbn-ts/core` + `@zxcvbn-ts/language-common`, `react`/`react-dom` (pinned), and
`zustand` (pinned). None is a native binding; none opens a socket. Pinning the
security-relevant ones exactly while allowing `^` on the zxcvbn packages is a defensible
split, since zxcvbn is lazily loaded in the main process and never sees key material.

---

## What this audit did not cover, and why

- **The app was never run.** Everything here is static reading. S15 in particular is a
  reasoned conclusion about Electron's permission routing, not an observed failure, and
  S1–S4 are reasoned from documented Electron semantics (single handler per WebContents,
  `app.isPackaged`) rather than from a reproduction.
- **`npm audit` covers advisories, not behaviour.** No dependency was read. A supply-chain
  compromise that has not been disclosed looks exactly like a clean audit.
- **The renderer was swept for secret handling, not reviewed as UI.** Accessibility,
  focus management and XSS-via-React (there is no `dangerouslySetInnerHTML` anywhere) are
  Phase 17's other sweeps, not this one.
- **The import parsers were read for secret leakage in warnings and for spreads of
  untrusted input, not audited as parsers.** Their own fuzz/robustness story is in
  `docs/09-Import-Export/00-Import-Formats.md` and its fault-injection record.
- **Export is not wired to IPC yet**, so no file-writing path for plaintext exports exists
  to audit. When it lands, the plaintext formats need the same `0o600` treatment the vault
  temp file gets, and the same overwrite confirmation.
- **Attachments, sync/merge, HIBP, and settings persistence do not exist yet**, so their
  security is not assessable.
- **No git command was run**, by instruction. That means M1 in `MANUAL-BACKLOG.md`
  ("create the remote and push") could not be verified as done or not done, and no claim is
  made about what is committed.
- **Nine main-process subsystems landed after the sweep and are NOT audited.** By the final
  re-check, `src/main/` had gained `activity/`, `attachments/`, `breach/`, `organisation/`,
  `recovery/`, `shell/`, `sync/`, `theme/` and `totp/` — none of which existed when the
  findings above were drawn up. Nothing in them is registered on an IPC channel yet (the
  handler count is unchanged at 40), so they are not reachable at runtime, and they are
  visibly mid-flight: `https-transport.ts:15` names a `no-network.test.ts` guard that has
  not been written yet. **Treat "checked and found fine" as scoped to the tree as it stood
  during the sweep.** Four of these need a real audit before they ship, and for the same
  reasons the findings above exist:
  - **`breach/`** is the first network code in the project. On a read of
    `https-transport.ts` alone it is careful — one fixed origin, a hex-validated prefix,
    `Add-Padding`, `redirect: 'error'`, `credentials: 'omit'`, no referrer, a version-free
    User-Agent, a capped streamed body — but it needs the off-by-default gating, the global
    kill-switch and the guard test its own header promises, and then a proper review.
  - **`attachments/`** moves file bytes, which is the one secret class the projection has
    never had to carry.
  - **`recovery/`** and **`sync/`** touch key material and merge, respectively; both are
    the kind of code where a quiet mistake is expensive.

- **Other agents were editing `src/` during this sweep.** `src/renderer/src/commands/`,
  `src/renderer/src/generator/`, `src/renderer/src/health/` and `src/renderer/src/settings/`
  appeared or grew mid-audit and were read in their state at that moment — the settings
  folder alone went from one file to ten. Nothing in them was half-written in a way that
  produced a finding, and the secret-boundary sweep was re-run over the renderer after they
  landed (no secret store, no `localStorage` secret, no `dangerouslySetInnerHTML`), but they
  are the least settled part of this report. In particular, a settings screen that persists
  the audit privacy level and the clipboard TTL will add write paths to
  `preferences.json` — see S10 before that lands.

---

## Related

- [`01-Doc-Code-Audit.md`](./01-Doc-Code-Audit.md) — the documentation half of Phase 17.
  S1 and S2 have their documentation face there as F20; S6 contradicts
  `02-Session-Model.md:180`; F10 there records that this folder is not yet listed in
  `docs/_INDEX.md` and needs to be added by hand.
- [`../02-Security/01-Process-Hardening.md`](../02-Security/01-Process-Hardening.md) — the
  design this audit measured `security.ts` against.
- [`../00-Overview/03-Threat-Model.md`](../00-Overview/03-Threat-Model.md) — what is in
  scope to defend at all.
