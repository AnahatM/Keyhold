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
something in the dependency tree tries. The one opt-in network feature (the HIBP check)
runs in the main process, where it can be gated by a setting and a global kill-switch.

**`style-src` allows `'unsafe-inline'`**, and this is a deliberate, bounded exception:
Vite injects a `<style>` tag, and inline _styles_ cannot execute script. It is a
materially different risk to `script-src 'unsafe-inline'`, not a relaxation of the same
one.

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

## 5. Single-instance lock

Two Keyhold processes could hold the same vault file open and race each other's atomic
writes — a data-loss bug (goal G1). Rather than solving that race, it is made unreachable:
the second launch hands its arguments to the first and exits.

---

## 6. Lint as a structural guard

Rules are not only style here; two of them enforce the architecture:

**In `src/renderer/**`**, importing `electron`, `node:*`, `fs`, `path`, `crypto`, `os`,
`child_process`, or `@main/*` is a **hard error**. The renderer has no Node access by
construction, so such an import means someone tried to widen that hole — and the lint
message says so, with the correct alternative.

**Project-wide**, `Math.random()` is banned. It is not a CSPRNG, there is no legitimate use
for it here, and a lint error is a better mechanism than remembering.

---

## 7. The preload contract

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

## 8. Related

- [`00-Cryptography.md`](./00-Cryptography.md) — the key hierarchy and primitives
- [`../00-Overview/03-Threat-Model.md`](../00-Overview/03-Threat-Model.md) — what this does and does not defend against
- [`../11-Development/01-Testing-Policy.md`](../11-Development/01-Testing-Policy.md) — the fault injections performed against these guards
