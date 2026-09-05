// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

/**
 * Dev-server smoke check: does `npm run dev` actually render anything?
 *
 * ## Why this exists, in one paragraph
 *
 * `npm run dev` opened a **blank window** — on every machine, for anyone who cloned the
 * repository — and every gate in this project stayed green the entire time. The renderer's
 * `script-src 'self'` blocked the inline React Refresh preamble `@vitejs/plugin-react`
 * injects, every component module threw `can't detect preamble`, and React never mounted.
 * Nothing could see it: the unit suite runs in Node, and `tools/smoke.mjs` launches the
 * *built* app from `file:`, where there is no dev server and therefore no preamble to block.
 * The application was fully buildable, testable and screenshottable while being impossible
 * to develop in.
 *
 * So the dev server is a **third configuration**, and this is its gate. It is a different
 * origin (`http:` rather than `file:`), a different Content-Security-Policy, a preload
 * bridge attached to a page served over the network stack rather than off disk, and a live
 * websocket. None of that is exercised anywhere else.
 *
 * ## Why a separate script rather than a flag on tools/smoke.mjs
 *
 * The two have opposite lifecycles and it is not worth pretending otherwise. `smoke.mjs`
 * *refuses to run against a stale build* and launches `electron .` directly against `out/`.
 * This one must not build at all — the whole point is to exercise the dev pipeline — and it
 * launches through electron-vite, which owns the Vite server, the rebuilds and the child
 * Electron process. Folding them together would mean a script whose first branch discards
 * the other's central safety check.
 *
 * ## What it asserts, and why each one is here rather than assumed
 *
 * 1. **The page's URL is the dev server.** Proves `ELECTRON_RENDERER_URL` was honoured. If
 *    this is a `file:` URL the run is silently testing the packaged path and proves nothing.
 * 2. **`#root` has children.** The actual defect. React mounting is the single fact this
 *    file exists to establish.
 * 3. **`window.keyhold` is present with its channel groups.** The preload bridge over `http:`
 *    is a different code path from `file:` — a sandboxed-ESM-preload defect has stranded this
 *    bridge before, which is why `smoke.mjs` exists at all.
 * 4. **No Content-Security-Policy violation was logged.** The specific failure, caught by its
 *    own signature rather than only by its effect, so a future tightening says *what* it
 *    broke instead of just that the page is empty.
 * 5. **Vite's HMR websocket connected.** `connect-src` blocked it for as long as the CSP had
 *    `'none'`, and a developer whose edits stop appearing has no error to go on.
 *
 * Fault injection performed, all three run and all three observed:
 *
 * - Removing `'unsafe-inline'` from the development `script-src` in `src/main/security.ts`
 *   fails checks 2 and 4, and check 4 prints the violation verbatim — so the failure names
 *   the preamble rather than only reporting an empty page.
 * - Leaving `connect-src` at `'none'` fails checks 4 and 5, naming the blocked websocket.
 * - Inverting the `app.isPackaged` gate in `devRendererUrl()` fails check 1, naming the
 *   `file:` URL the window loaded instead.
 */

const require = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, '..');

/**
 * Generous, and deliberately so: this budget covers a cold Vite dependency optimisation, two
 * esbuild passes for main and preload, and an Electron launch. A machine doing all three for
 * the first time is not a machine that should fail its gate for being slow.
 */
const HARD_TIMEOUT_MS = 180_000;

/**
 * Not 9222. The default is what every attached debugger, editor extension and stray Chrome
 * reaches for, and a port collision here would surface as "the app never came up" — the exact
 * symptom this check reports for a real failure, which is the worst kind of false positive.
 */
const DEBUG_PORT = 9339;

const checks = [];
let failed = false;

function check(name, ok, detail) {
  checks.push({ name, ok });
  console.log(`DEV-SMOKE-CHECK ${name} ${String(ok)}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failed = true;
}

function note(name, value) {
  console.log(`DEV-SMOKE-NOTE ${name} ${value}`);
}

// ── The dev server ───────────────────────────────────────────────────────────

/**
 * Resolved through `package.json` rather than by naming the bin path directly.
 *
 * `require.resolve('electron-vite/bin/electron-vite.js')` throws `ERR_PACKAGE_PATH_NOT_EXPORTED`:
 * the package publishes an `exports` map, and a subpath it does not list is unreachable even
 * though the file is right there on disk. Resolving `package.json` — which `exports` does
 * expose — gives the package root, and the bin path hangs off that. Hardcoding
 * `node_modules/electron-vite/...` from the repository root would work today and break under
 * any hoisting layout that is not npm's.
 */
const electronVite = join(
  dirname(require.resolve('electron-vite/package.json')),
  'bin',
  'electron-vite.js'
);

/**
 * `--` matters. Everything after it is forwarded to Electron rather than parsed by
 * electron-vite, which is how the child process gets its debugging port. Without it
 * electron-vite rejects the flag as its own and exits before anything starts.
 */
const child = spawn(
  process.execPath,
  [electronVite, 'dev', '--', `--remote-debugging-port=${String(DEBUG_PORT)}`],
  {
    cwd: ROOT,
    // Piped, then forwarded below — see `forward`.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  }
);

// Forwarded rather than inherited so that a failure here still shows electron-vite's own
// output — a build error in the main process looks identical to "the app never started"
// unless the reason is on screen next to the verdict.
const forward = (chunk) => process.stdout.write(String(chunk));
child.stdout.on('data', forward);
child.stderr.on('data', forward);

/**
 * Kills the whole tree, not just the launcher.
 *
 * `child.kill()` reaches the Node process running electron-vite and leaves the Electron it
 * spawned running — with a window on screen, holding the debugging port, so the *next* run
 * attaches to the previous run's app and reports a pass for code it never loaded. On Windows
 * `taskkill /T` is the only reliable way to take the tree; elsewhere the process group is.
 */
function killTree() {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

function finish(code) {
  killTree();
  process.exit(code);
}

const killTimer = setTimeout(() => {
  console.error(`\nDEV-SMOKE-FAIL the dev server did not come up within ${HARD_TIMEOUT_MS}ms.`);
  finish(1);
}, HARD_TIMEOUT_MS);

child.on('exit', (code) => {
  // Only interesting if it happens before the checks have run; a clean exit after the kill
  // above is the normal end of a successful run.
  if (checks.length === 0) {
    clearTimeout(killTimer);
    console.error(`\nDEV-SMOKE-FAIL electron-vite exited early with code ${String(code)}.`);
    finish(1);
  }
});

// ── Attaching ────────────────────────────────────────────────────────────────

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for a debuggable page whose URL is the dev server.
 *
 * Polls rather than sleeps: the time between "Vite is listening" and "Electron has a page"
 * varies by an order of magnitude between a warm and a cold dependency cache, and a fixed
 * sleep would be either flaky or slow. It also filters by URL — Electron exposes more than
 * one target, and attaching to the wrong one produces confusing emptiness.
 */
async function findRendererTarget(deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(DEBUG_PORT)}/json/list`);
      const targets = await response.json();
      // Any real page, not only an `http:` one. An earlier draft filtered for the dev
      // server's own URL, which meant the most interesting failure — the window loading
      // from `file:` because the dev URL was not honoured — produced a 180-second timeout
      // and the message "no page appeared", instead of the check that says exactly that.
      // Measured: the injection now fails in seconds, naming the URL it actually got.
      const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools:'));
      if (page !== undefined) return page;
    } catch {
      // Not listening yet. Expected for the first several seconds.
    }
    await wait(400);
  }
  return null;
}

/** A minimal CDP client. One connection, request/response by id, plus events. */
function connect(url) {
  const ws = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    if (message.method !== undefined) events.push(message);
  };
  const ready = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const send = (method, params) =>
    new Promise((res) => {
      const id = ++nextId;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ready, send, events, close: () => ws.close() };
}

const deadline = Date.now() + HARD_TIMEOUT_MS - 15_000;
const target = await findRendererTarget(deadline);

if (target === null) {
  clearTimeout(killTimer);
  console.error('\nDEV-SMOKE-FAIL no dev-server page appeared on the debugging port.');
  finish(1);
}

const cdp = connect(target.webSocketDebuggerUrl);
await cdp.ready;

/**
 * `Log.enable` before anything else. A Content-Security-Policy violation arrives as a `Log`
 * entry, not a console API call, and the domain only reports entries from the moment it is
 * enabled — so this has to be armed before the page is prodded. Entries already emitted
 * during load are replayed on enable, which is what makes the ordering survivable at all.
 */
await cdp.send('Log.enable', {});
await cdp.send('Runtime.enable', {});

// A short settle: React mounts a frame or two after the document is interactive, and the
// HMR socket reports its connection shortly after that.
await wait(2500);

// ── The assertions ───────────────────────────────────────────────────────────

const evaluate = async (expression) => {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.result?.result?.value;
};

note('page-url', target.url);
const servedByDevServer = /^http:\/\/localhost:\d+/.test(target.url);
check(
  'renderer-is-served-by-the-dev-server',
  servedByDevServer,
  servedByDevServer
    ? undefined
    : `the window loaded ${target.url} — ELECTRON_RENDERER_URL was not honoured, so this run would have tested the packaged path`
);

const rootChildren = await evaluate("document.getElementById('root')?.childElementCount ?? -1");
note('root-child-count', String(rootChildren));
check(
  'react-mounted-into-the-root-element',
  typeof rootChildren === 'number' && rootChildren > 0,
  rootChildren === 0 ? 'the root element is empty — this is the blank window' : undefined
);

const bridgeGroups = await evaluate('Object.keys(window.keyhold ?? {}).length');
note('bridge-group-count', String(bridgeGroups));
check('preload-bridge-is-attached-over-http', typeof bridgeGroups === 'number' && bridgeGroups > 0);

const logText = cdp.events
  .filter((event) => event.method === 'Log.entryAdded')
  .map((event) => String(event.params?.entry?.text ?? ''))
  .join('\n');

const cspViolation = logText
  .split('\n')
  .find((line) => /content security policy/i.test(line) && /violat|blocked/i.test(line));
check(
  'no-content-security-policy-violation',
  cspViolation === undefined,
  cspViolation === undefined ? undefined : cspViolation.slice(0, 160)
);

const consoleText = cdp.events
  .filter((event) => event.method === 'Runtime.consoleAPICalled')
  .flatMap((event) => (event.params?.args ?? []).map((arg) => String(arg.value ?? '')))
  .join('\n');
const hmrConnected = /\[vite\] connected/.test(`${consoleText}\n${logText}`);
check('vite-hmr-socket-connected', hmrConnected);

// ── Verdict ──────────────────────────────────────────────────────────────────

clearTimeout(killTimer);
cdp.close();

if (failed) {
  console.error(
    `\nDEV-SMOKE-FAIL ${String(checks.filter((c) => !c.ok).length)} of ${String(checks.length)} checks failed. ` +
      '`npm run dev` does not work, whatever the rest of the gate says.'
  );
  finish(1);
}

console.log(`\nDEV-SMOKE-PASS ${String(checks.length)} checks — the dev server renders the app.`);
finish(0);
