# Process hardening

> How the Electron shell is locked down, and why the renderer is treated as a semi-trusted
> zone. Current reference. Implemented by `src/main/security.ts`.

---

## 1. The boundary

```
┌──────────────────── MAIN PROCESS (Node) ─── TRUSTED ────────────────────┐
│  KEK · DEK · the decrypted vault · all crypto · all file I/O            │
│  The smallest surface we can make it, and the most reviewed code.       │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │  contextBridge — typed, allow-listed
┌────────────────────────────────┴────────────────────────────────────────┐
│  PRELOAD   contextIsolation · sandbox · no nodeIntegration              │
│  Forwards and returns. Holds no state. Exposes window.keyhold.* only.   │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴──── SEMI-TRUSTED ──────────────────────┐
│  RENDERER (React, npm dependencies, the DOM)                            │
│  Holds the SAFE PROJECTION: titles · usernames · emails · urls · tags · │
│  folders · dates · history summaries · health flags.                    │
│  NEVER passwords, note bodies, security-question answers, TOTP seeds,   │
│  or attachment bytes.                                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

**Decision D13.** The renderer is treated as compromisable, because it runs a large
dependency tree and a DOM. Most Electron password managers decrypt the entire vault into
renderer memory, where one XSS or one bad npm package reaches every secret at once.
Keyhold's renderer _does not have them to leak_.

Search, sort and filter all operate on the safe projection. Deep search — inside notes and
custom-field values — is delegated to the main process over IPC, so those values never
cross the boundary in bulk. Individual secrets are fetched per reveal, per copy, with a
TTL.

**If a feature appears to need secrets in the renderer, the feature design is wrong, not
the architecture.**

---

## 2. Window configuration

Every control is set **explicitly**, never inherited, so that an Electron upgrade changing
a default cannot silently weaken the app.

| Setting                       | Value             | Why                                                                |
| ----------------------------- | ----------------- | ------------------------------------------------------------------ |
| `contextIsolation`            | `true`            | The preload's globals cannot be reached or replaced by page script |
| `sandbox`                     | `true`            | The renderer runs in an OS-level sandbox with no Node              |
| `nodeIntegration`             | `false`           | No `require` in the page                                           |
| `nodeIntegrationInWorker`     | `false`           | A worker would otherwise be a way around the above                 |
| `nodeIntegrationInSubFrames`  | `false`           | So would an iframe                                                 |
| `webSecurity`                 | `true`            | Same-origin policy stays on                                        |
| `allowRunningInsecureContent` | `false`           |                                                                    |
| `experimentalFeatures`        | `false`           | Unreviewed platform surface                                        |
| `webviewTag`                  | `false`           | `<webview>` would bypass every control here                        |
| `spellcheck`                  | `false`           | On some platforms spellcheck ships typed text to a remote service  |
| `devTools`                    | `!app.isPackaged` | And closed on sight if opened in a packaged build                  |

`src/main/security.test.ts` asserts every one of these. Fault injection confirmed it fails
when any is flipped.

---

## 3. Content-Security-Policy

```
default-src 'none';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data:;
media-src 'self' blob:;
connect-src 'none';
object-src 'none';
frame-src 'none';
worker-src 'self' blob:;
form-action 'none';
base-uri 'none';
frame-ancestors 'none';
```

**`default-src 'none'`** — deny by default, allow by exception. Anything not listed is
blocked, including directives added to the platform in future.

**`script-src 'self'` with no `unsafe-inline` and no `unsafe-eval`** is the load-bearing
line: it is what makes an injected `<script>` inert.

**`connect-src 'none'`** — the renderer cannot originate a network request at all, even if
something in the dependency tree tries. **No setting relaxes it**, and the global
kill-switch in §5 deliberately does not touch it. The one opt-in network feature (the HIBP
check) runs in the main process, where both switches apply.

**`style-src` allows `'unsafe-inline'`**, and this is a deliberate, bounded exception:
Vite injects a `<style>` tag, and inline _styles_ cannot execute script. It is a
materially different risk to `script-src 'unsafe-inline'`, not a relaxation of the same
one.

### 3.1 The development relaxation

The policy above is what every build a user can run serves. `npm run dev` serves a second
one, and it is reachable **only** when `app.isPackaged` is false _and_ electron-vite has
handed the process an `ELECTRON_RENDERER_URL` — the same single gate, `devRendererUrl()` in
`src/main/security.ts`, that decides whether the window loads from the dev server at all.
Two directives differ, and nothing else does:

| Directive     | Development                              | Why                                                                                                                                                             |
| ------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `script-src`  | `'self' 'unsafe-inline'`                 | `@vitejs/plugin-react` injects its React Refresh preamble as an inline `<script type="module">`. Blocked, every component module throws and React never mounts. |
| `connect-src` | the dev server's `http` and `ws` origins | The HMR websocket. Derived from the URL electron-vite supplied, not a hardcoded port, because Vite moves on when 5173 is taken.                                 |

`'unsafe-eval'` is not granted in either policy.

**This was a real defect, and the shape of it is worth keeping.** Before the relaxation
existed, `npm run dev` opened a **blank window** — on every machine, for anyone who cloned
the repository. Nothing in the repository could see it: the whole test suite runs in Node,
and `npm run test:smoke` launches the _built_ app from `file:`, where there is no dev server
and therefore no preamble to block. The app was fully verifiable and fully screenshottable
while being impossible to develop in. The guards for both halves — that development permits
what Vite needs, and that a packaged build ignores `ELECTRON_RENDERER_URL` entirely and
serves the policy above unchanged — are in `src/main/security.test.ts`.

---

## 4. Navigation and windows

- **`will-navigate`** — anything outside the app's own pages is cancelled and handed to
  the user's real browser.
- **`setWindowOpenHandler`** — always denies. A window Keyhold did not configure would not
  carry the hardened `webPreferences` above, and would be a hole straight through this
  entire document. `http(s)` URLs are opened externally instead.
- **`will-attach-webview`** — prevented.
- **Permissions** — `setPermissionRequestHandler` and `setPermissionCheckHandler` both
  deny everything, unconditionally. An offline password manager needs no camera,
  microphone, geolocation, notifications, or clipboard-read.
- Applied via `web-contents-created`, so it covers **every** WebContents that will ever
  exist, including one created by code that forgets to call the helper.

---

## 5. The global network kill-switch

`src/main/network-policy.ts`. Hard rule 5 promises the breach check sits behind **two**
switches — its own opt-in, and a machine-scoped master switch that denies the network whatever
any per-feature setting says. This is the second one, and until it was written the rule
described two switches and the code had one (subsystem audit finding N38). Decision D23 carries
the full argument.

**Two switches, ANDed, kill-switch dominant.** `NetworkPolicy.allowsBreachCheck` composes both
in one place, deliberately, rather than leaving a call site to write
`policy.allowsNetwork() && settings.enabled` itself — a second copy of that expression is the
one that forgets a switch.

| Switch                        | Scope                                 | Default |
| ----------------------------- | ------------------------------------- | ------- |
| `Preferences.networkAllowed`  | **The machine.** Never leaves it      | `false` |
| `BreachCheckSettings.enabled` | The vault. Travels inside the `.keep` | `false` |

Neither is redundant. A vault carried to a friend's laptop must not be able to turn that
machine's network on, which is exactly what would happen if the only switch lived in the file.

**It fails closed.** Only the literal boolean `true` enables it. A missing key, `null`, the
string `"true"`, a truncated preferences file or one written by a future build all read as
`false`. The `=== true` comparison is against a value TypeScript already calls a boolean, which
is the point: what reaches it came out of a JSON file a person can edit and a half-finished
write can truncate, and the annotation was erased long before any of that.

**"Off" means the capability is absent, not disabled.** The policy decides whether a transport
is _constructed_. There is no `if (allowed)` inside a request path for a future refactor to
skip, and `NetworkPolicy.observe` exists so anything holding a transport built while the switch
was on is told to drop it — which is what keeps "off" meaning _no transport exists_ rather than
_a transport that promises not to_.

**It does not gate `shell.openExternal`.** Handing a URL to the user's own browser makes the
request _as the user_; Keyhold is not the one talking to the network, and a switch that silently
broke every documentation link would teach people to leave it on. That is why the setting is
worded "let Keyhold make network requests" rather than "go offline". It also does not touch the
CSP in §3, which is unconditional.

**The policy has no caller yet.** `Preferences.networkAllowed` is persisted, validated at the
IPC boundary and carried in the settings snapshot; `NetworkPolicy` itself is constructed only by
its own tests, because nothing constructs a breach transport for it to gate. Wiring the breach
check is now a matter of using this rather than of inventing it. See
[`../05-Features/07-Breach-Check.md`](../05-Features/07-Breach-Check.md) §7.

---

## 6. Paths from outside are checked for naming local storage, not for being absolute

`src/shared/model/local-path.ts`, and it is a security check rather than a formatting one.

On Windows, touching a path is not a local operation. `\\attacker.example\share\x.keep` is a
perfectly ordinary absolute path — no URL scheme, no `..` segment, a `.keep` extension — and the
moment anything calls `stat` on it the OS opens an SMB connection to a host the attacker named
and, by default, performs an NTLMv2 handshake with the logged-in user's credentials. That is an
outbound connection from an app whose hard rule 5 is zero network by default, a credential
disclosure, and a synchronous hang in the main process before any window exists — none of which
requires the file to exist or the user to do more than double-click a `.lnk` someone sent them.
(Subsystem audit finding N1; decision D25.)

So the check is an **allow-list of shapes that name this machine's own storage**: a Windows
drive letter followed by a separator, or a single POSIX `/` — and explicitly **not** a doubled
one, because `//host/share/x.keep` is both a valid POSIX path and the forward-slash spelling of
a UNC share, and the validator at the IPC boundary does not know which OS the string came from.
A deny-list of the known-bad shapes would be one Windows path syntax away from being wrong
again.

Two places ask, and rule 8 says they ask one function: `src/main/shell/file-open-request.ts`
for paths the OS hands over (a double-click, a drag, an `argv` entry) and
`src/shared/ipc/validation.ts` for paths the renderer hands back after a dialog the main
process opened. Both were letting a UNC path through. It is a regex rather than `node:path`
because the module compiles into the renderer's project and must stay free of Node built-ins.

---

## 7. Single-instance lock

Two Keyhold processes could hold the same vault file open and race each other's atomic
writes — a data-loss bug (goal G1). Rather than solving that race, it is made unreachable:
the second launch hands its arguments to the first and exits.

---

## 8. Lint as a structural guard

Rules are not only style here; two of them enforce the architecture:

**In `src/renderer/**`**, importing `electron`, `node:*`, `fs`, `path`, `crypto`, `os`,
`child_process`, or `@main/*` is a **hard error**. The renderer has no Node access by
construction, so such an import means someone tried to widen that hole — and the lint
message says so, with the correct alternative.

**Project-wide**, `Math.random()` is banned. It is not a CSPRNG, there is no legitimate use
for it here, and a lint error is a better mechanism than remembering.

---

## 9. The preload contract

`src/preload/index.ts` is the narrowest and most security-critical surface in the app.

1. **Every exposed member is enumerated by hand.** Never expose `ipcRenderer`, never expose
   a function that takes a channel name from the caller, and never construct the surface
   dynamically.
2. **It holds no state.** It forwards and returns; that is all.
3. **It refuses to load without `contextIsolation`**, throwing rather than silently
   degrading to an insecure bridge.

The API shape lives in `src/shared/ipc/api.ts` so the renderer's types and the main
process's handlers come from one source rather than two that drift — the "no second list"
rule applied to the most dangerous list in the codebase.

### The preload must be CommonJS

Electron runs sandboxed preload scripts as plain CommonJS with **no ESM context**. An
`.mjs` preload builds cleanly, launches cleanly, and then **silently never runs** —
`window.keyhold` is simply `undefined`, every feature is dead, and there is no error
anywhere.

`npm run test:smoke` exists specifically to catch that class of defect: it launches the
real built app and verifies the bridge is present. Run it after any change to `src/main`,
`src/preload`, or the build config. See decision D20.

---

## 10. Related

- [`00-Cryptography.md`](./00-Cryptography.md) — the key hierarchy and primitives
- [`../00-Overview/03-Threat-Model.md`](../00-Overview/03-Threat-Model.md) — what this does and does not defend against
- [`../11-Development/01-Testing-Policy.md`](../11-Development/01-Testing-Policy.md) — the fault injections performed against these guards
