// SPDX-License-Identifier: GPL-3.0-or-later
import { copyFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app, type BrowserWindow } from 'electron';
import { EVENTS } from '@shared/ipc/api.js';
import { notifySessionChanged } from './ipc/register.js';

/**
 * Headless-ish launch smoke check, enabled only by `KEYHOLD_SMOKE=1`.
 *
 * This exists because a whole class of Electron defects is invisible to the build and
 * to unit tests, and only appears when the app actually starts. The one that motivated
 * it: a sandboxed preload emitted as ESM builds cleanly, launches cleanly, and simply
 * never runs — leaving `window.keyhold` undefined and every feature dead, with no error
 * anywhere. Nothing short of a real launch catches that.
 *
 * It verifies four things and quits:
 *   1. the app reaches `ready` and creates a window
 *   2. the renderer finishes loading without a crash
 *   3. the preload bridge is actually present on `window`
 *   4. a real IPC round-trip works end to end — bridge → ipcRenderer → a registered
 *      ipcMain handler → a structured result. Unit tests exercise the handler function;
 *      only this catches a handler that was never registered, a channel name that drifted
 *      between the contract and the preload, or a payload that fails to serialise.
 *
 * Never active in a normal run. CI calls it in Phase 18.
 */

const SMOKE_TIMEOUT_MS = 20_000;

/**
 * Writes one marker line to stdout.
 *
 * One helper rather than a `process.stdout.write` at each site: the CI job greps for these
 * exact markers, and a missing newline silently merges two of them into one unmatchable
 * line.
 */
function emit(line: string): void {
  process.stdout.write(line + '\n');
}

/**
 * Whether this launch is a smoke run.
 *
 * Two conditions, not one. The environment variable is the request; `!app.isPackaged` is
 * what stops a shipped binary from honouring it. A dev affordance that survives into a
 * release is a lever, and this particular lever is loaded: with `KEYHOLD_SMOKE_VAULT` also
 * set, the run calls `vault.create` against that path under a passphrase printed in this
 * file's own source — so anyone who can set an environment variable for the Keyhold process
 * could rotate a real vault into `.bak.1` and replace it with an empty one they know the
 * password to. Goal G1 says never lose a credential; this is the cheapest place to honour it.
 *
 * Costs nothing: `tools/smoke.mjs` launches `electron .`, where `isPackaged` is false.
 */
export function isSmokeRun(): boolean {
  return !app.isPackaged && process.env.KEYHOLD_SMOKE === '1';
}

/**
 * Captures one named view into the directory given by `KEYHOLD_SMOKE_SHOTS`.
 *
 * Generated rather than hand-made, so a README screenshot cannot quietly stop matching the
 * app it claims to show: regenerating them is one command, and the seeded vault the run
 * builds is deterministic.
 */
/**
 * Polls a renderer expression until it is truthy, or gives up.
 *
 * Replaces `await sleep(300); assert(...)`, which is the shape every flaky UI check has. A
 * fixed wait encodes an assumption about how fast the machine is, and it is always tuned on
 * the fast one: three checks here passed on a developer laptop for weeks and failed on the
 * first CI runner that ever reached them, because a runner is slower and 300ms was not enough
 * for a React render plus an IPC round trip.
 *
 * Polling is strictly better in both directions. It returns as soon as the condition holds, so
 * the common case is *faster* than the sleep it replaces, and it waits far longer than anyone
 * would dare hardcode before declaring failure.
 *
 * Returns the last value seen either way, so a caller can report what it actually got rather
 * than only that it timed out.
 *
 * **The expression is re-run on every tick, so it must be safe to run twice.** A probe that
 * types into a box, clicks something, or otherwise changes the page is being replayed from a
 * different starting state each time, and the second run is not the one that was reasoned
 * about. Where a probe must act, have it return a distinct string per outcome rather than
 * `false`: a string is truthy, so it settles on the first attempt and reports what happened
 * instead of silently retrying. That is not a style preference — a stateful probe returning
 * `false` cost a debugging round here.
 */
async function waitFor(
  window: BrowserWindow,
  expression: string,
  { timeoutMs = 8_000, everyMs = 100 }: { timeoutMs?: number; everyMs?: number } = {}
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    // Swallowed per attempt: the thing being waited for often does not exist yet, and a
    // selector on a missing node throwing is the normal shape of "not ready".
    const seen: unknown = await window.webContents
      .executeJavaScript(expression, true)
      .catch(() => undefined);
    if (seen !== undefined && seen !== false && seen !== null) return seen;
    if (Date.now() >= deadline) return seen;
    await new Promise<void>((resolve) => setTimeout(resolve, everyMs));
  }
}

/**
 * Says what is actually on screen, as one grepable line.
 *
 * Emitted unconditionally at the points other checks depend on, rather than only on failure. A
 * run on a machine nobody can look at is the only evidence there will ever be, and "four checks
 * said false" is not evidence — it is the absence of it. Two CI rounds were spent guessing at a
 * cause this line would have named in the first.
 *
 * Cheap enough to leave in: one `executeJavaScript` returning a short string.
 */
async function noteScreen(window: BrowserWindow, label: string): Promise<void> {
  // Note the doubled backslash in the whitespace regex below. The probe is a template
  // literal, and a single backslash-s in one is not a valid escape, so JS collapses it to a
  // bare s before the renderer sees it — the first version stripped every letter s from the
  // page text. Comments inside the literal must also avoid backticks, which end it.

  const seen: unknown = await window.webContents
    .executeJavaScript(
      `JSON.stringify({
         screen: document.querySelector('.kh-screen__title')?.textContent ?? 'shell',
         width: window.innerWidth,
         sidebar: document.querySelector('.kh-shell__sidebar') !== null,
         list: document.querySelector('.kh-shell__list') !== null,
         detail: document.querySelector('.kh-shell__detail') !== null,
         banner: document.querySelector('.kh-shell__banner') !== null,
         selected: document.querySelector('.kh-detail') !== null,
         overview: document.querySelector('.kh-vault-facts') !== null,
         rows: document.querySelectorAll('.kh-row').length,
         // What is actually mounted, when none of the above is. Without this a note that says
         // "no panes" is still a note that does not say what the user would be looking at.
         roots: [...document.querySelectorAll('#root > *, #root > * > *')]
           .slice(0, 6)
           .map((element) => element.tagName + '.' + String(element.className).slice(0, 40)),
         text: (document.body.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 160),
       })`,
      true
    )
    .catch(() => '"unreadable"');
  emit(`SMOKE-NOTE ${label} ${String(seen)}`);
}

/**
 * Captures a named view, and **asserts it is the view the name claims**.
 *
 * `subject` is a CSS selector that must match at the instant of capture. It is not optional
 * decoration — it is the guard, and it exists because four named screenshots were found
 * showing the same wrong screen.
 *
 * ## The failure it catches
 *
 * A shot is a `capturePage()` of whatever happens to be on screen. Nothing about the name
 * reaches the renderer, so a probe that navigates and does not navigate back silently
 * repoints every capture after it. That is exactly what happened: the diagnostics check
 * opens the "Diagnose a vault" tool view, nothing closed it, and `16-totp`, `12`, `03` and
 * `04` were all captured there — four files claiming to be a one-time code, a comparison, a
 * field-level diff and the editor, and all four byte-identical pictures of the diagnostics
 * screen. `03` was on the README under the caption "What one edit changed, field by field".
 *
 * A screenshot is the one artefact in this repo that no test could read, so it is the one
 * place a false claim could survive indefinitely. This makes the claim checkable: the shot
 * is still written either way — a picture of the wrong screen is evidence, and deleting it
 * would hide what went wrong — but the run fails and names the file.
 *
 * The check is emitted **before** the capture attempt, so a shot that could not be taken at
 * all and a shot of the wrong screen are two distinct failures rather than one silence.
 */
async function captureNamedShot(
  window: BrowserWindow,
  name: string,
  subject: string
): Promise<void> {
  const directory = process.env.KEYHOLD_SMOKE_SHOTS;
  if (directory === undefined || directory === '') return;

  const showing: unknown = await window.webContents
    .executeJavaScript(`document.querySelector(${JSON.stringify(subject)}) !== null`, true)
    .catch(() => 'unreadable');
  emit(`SMOKE-CHECK shot-${name.toLowerCase()}-shows-its-subject ${String(showing === true)}`);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const image = await window.capturePage();
      if (!image.isEmpty()) {
        await writeFile(join(directory, `${name}.png`), image.toPNG());
        emit(`SMOKE-SHOT ${name}`);
        return;
      }
    } catch {
      // Same reasoning as `captureIfRequested`: the compositor may not have produced a
      // frame yet, and retrying briefly is more honest than a sleep tuned to one machine.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
}

async function captureIfRequested(window: BrowserWindow): Promise<void> {
  const target = process.env.KEYHOLD_SMOKE_SHOT;
  if (target === undefined || target === '') return;

  // `capturePage` fails with UnknownVizError if the compositor has not produced a frame
  // yet, and "did-finish-load" fires before the first paint. Retrying briefly is more
  // honest than a fixed sleep long enough to always work on the slowest machine.
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const image = await window.capturePage();
      if (!image.isEmpty()) {
        await writeFile(target, image.toPNG());
        emit(`SMOKE-SHOT ${target}`);
        return;
      }
    } catch {
      // Fall through to the wait and try again.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }

  emit('SMOKE-SHOT-FAILED the window produced no frame to capture');
}

function finish(ok: boolean, detail: string): void {
  // Deliberately stdout, not a logger: the CI job greps for these exact markers.
  emit(`${ok ? 'SMOKE-PASS' : 'SMOKE-FAIL'} ${detail}`);
  app.exit(ok ? 0 : 1);
}

export function runSmokeCheck(window: BrowserWindow): void {
  const timer = setTimeout(() => {
    finish(false, 'timed out before the renderer finished loading');
  }, SMOKE_TIMEOUT_MS);

  // A renderer exception used to reach this harness as nothing at all: the component that
  // threw simply did not render, every check that looked for it read `false`, and the
  // report named eight unrelated-looking failures with no cause among them. Forwarding the
  // console turns that into one line naming the file and the error.
  //
  // `once` everywhere else in this function, but `on` here — the interesting case is a
  // render loop throwing repeatedly, and only the first of those would be the one seen.
  window.webContents.on('console-message', (details) => {
    if (details.level !== 'error' && details.level !== 'warning') return;
    // One line each: the harness's output is grepped, so a message with newlines in it
    // would arrive looking like several unattributed lines of its own.
    const message = details.message.replace(/\s+/g, ' ').trim();
    emit(`SMOKE-CONSOLE ${details.level} ${message} (${details.sourceId}:${details.lineNumber})`);
  });

  window.webContents.once('render-process-gone', (_event, details) => {
    clearTimeout(timer);
    finish(false, `renderer process gone: ${details.reason}`);
  });

  window.webContents.once('did-fail-load', (_event, code, description) => {
    clearTimeout(timer);
    finish(false, `renderer failed to load: ${code} ${description}`);
  });

  window.webContents.once('did-finish-load', () => {
    clearTimeout(timer);
    // Probes the bridge, then makes a real call. `vault.summary()` is chosen because it is
    // safe with nothing open — it must answer `{ ok: true, value: null }`.
    //
    // With KEYHOLD_SMOKE_VAULT set, it goes further and drives a full create → lock →
    // unlock cycle against a real file. That is the only check that exercises the whole
    // stack the way a user does: renderer → preload → IPC → session → Argon2 worker →
    // container → disk, and back. Every layer is unit-tested; nothing but this proves they
    // are wired to each other.
    const vaultPath = process.env.KEYHOLD_SMOKE_VAULT;
    const probe =
      vaultPath === undefined || vaultPath === ''
        ? `
      (async () => {
        if (typeof window.keyhold !== 'object') return { stage: 'bridge', ok: false };
        const result = await window.keyhold.vault.summary();
        return { stage: 'ipc', ok: result.ok === true && result.value === null, result };
      })()
    `
        : `
      (async () => {
        if (typeof window.keyhold !== 'object') return { stage: 'bridge', ok: false };
        const path = ${JSON.stringify(vaultPath)};
        const password = 'a-smoke-test-master-passphrase';
        const steps = [];

        // Every Argon2 report this run produces, collected from the first derivation onward.
        //
        // The chain being checked is runner -> session -> composition root -> preload ->
        // renderer, and every link in it fails silently: a bar that is never told anything
        // simply does not appear, which looks identical to a fast machine. The unit tests
        // cover the prediction and the emitting; only this covers the wiring between them.
        const kdfReports = [];
        const stopKdf = window.keyhold.app.onKdfProgress((progress) => {
          kdfReports.push(progress);
        });

        const created = await window.keyhold.vault.create(path, password);
        steps.push(['create', created.ok]);
        if (!created.ok) return { stage: 'cycle', ok: false, steps, detail: created.message };

        const locked = await window.keyhold.vault.lock();
        steps.push(['lock', locked.ok]);

        const afterLock = await window.keyhold.vault.summary();
        steps.push(['locked-summary-null', afterLock.ok === true && afterLock.value === null]);

        const wrong = await window.keyhold.vault.unlock(path, 'not-the-password');
        steps.push(['wrong-password-rejected', wrong.ok === false && wrong.code === 'WRONG_PASSWORD']);

        const reopened = await window.keyhold.vault.unlock(path, password);
        steps.push(['unlock', reopened.ok]);

        stopKdf();
        steps.push(['kdf-progress-reaches-the-renderer', kdfReports.length > 0]);
        steps.push([
          'kdf-progress-never-claims-to-be-finished',
          kdfReports.every(
            (report) =>
              typeof report.fraction === 'number' && report.fraction >= 0 && report.fraction < 1
          ),
        ]);
        if (!reopened.ok) return { stage: 'cycle', ok: false, steps, detail: reopened.message };

        // Auto-lock off for the rest of the run, and said out loud rather than done quietly.
        //
        // Idle time is measured by the OS across the whole machine, not by this app, so a
        // run on a computer nobody is touching crosses the ten-minute default partway
        // through and locks the vault mid-check. That is auto-lock working exactly as
        // designed; it just makes every UI check after it read false for a reason that has
        // nothing to do with what the check is about. It cost eight failing checks and a
        // long hunt to establish that once.
        //
        // Disarmed through the real settings channel, so the disabling itself is a check:
        // if that path breaks, this fails here instead of silently leaving auto-lock armed.
        // The policy keeps its own unit tests in auto-lock.test.ts (no backticks: this whole
        // block lives inside a template literal, and one would end it) — this run is about the
        // UI, and a test that cannot survive its own idle timer proves nothing about either.
        const noAutoLock = await window.keyhold.settings.updateMachine({
          autoLock: {
            idleMinutes: null,
            lockOnSleep: false,
            lockOnScreenLock: false,
            lockOnMinimise: false,
            lockOnBlur: false,
          },
        });
        steps.push([
          'auto-lock-held-off',
          noAutoLock.ok === true && noAutoLock.value.machine.autoLock.idleMinutes === null,
        ]);

        const list = await window.keyhold.credentials.list();
        steps.push(['list-empty', list.ok === true && list.value.length === 0]);

        // Full CRUD against a real vault: create, read back a secret, edit, duplicate,
        // trash, restore, purge. Every layer is unit-tested; only this proves they are
        // wired to each other through the bridge.
        const made = await window.keyhold.credentials.create({
          title: 'Smoke Test Account',
          username: 'someone',
          email: 'someone@example.com',
          password: 'a-secret-value-9182',
          urls: ['https://example.com'],
          notes: 'a note that must never appear in a projection',
          tags: ['smoke', 'test'],
        });
        steps.push(['create-record', made.ok]);

        // Seeded here rather than later, because the list loads once when the screen mounts:
        // a record created after that is in the vault and not in the DOM. Its own assertion
        // is further down, once there is a UI to look at.
        const withTotp = await window.keyhold.credentials.create({
          title: 'Smoke TOTP',
          username: 'alice',
          custom: [
            {
              id: 'smoke-otp',
              label: 'Authenticator',
              type: 'otp-secret',
              value: 'otpauth://totp/Smoke:alice?secret=JBSWY3DPEHPK3PXP&issuer=Smoke',
              hidden: false,
              order: 0,
            },
          ],
        });
        steps.push(['create-record-with-a-one-time-password', withTotp.ok]);

        // A record that is not a login. The type discriminator was carried for the life of
        // the project with one legal value; this proves the widened one survives create,
        // validation and the read back, which is the half a unit test cannot see.
        const card = await window.keyhold.credentials.create({
          title: 'Smoke Card',
          type: 'card',
          custom: [
            { id: 'c1', label: 'Number', type: 'password', value: '4111111111111111', hidden: false, order: 0 },
            { id: 'c2', label: 'Security code', type: 'pin', value: '123', hidden: false, order: 1 },
          ],
        });
        steps.push(['create-a-record-that-is-not-a-login', card.ok && card.value.type === 'card']);
        steps.push([
          'a-cards-number-does-not-cross-in-the-projection',
          card.ok === true && !JSON.stringify(card.value).includes('4111111111111111'),
        ]);

        const badType = await window.keyhold.credentials.create({
          title: 'Bad type',
          type: 'not-a-real-type',
        });
        steps.push(['an-unknown-record-type-is-refused', badType.ok === false]);

        // The channel, before any UI is involved. Six digits and a deadline in the future is
        // the whole contract; the seed must not come back, and does not — the projection has
        // no field for it.
        const totpChannel = withTotp.ok
          ? await window.keyhold.totp.code(withTotp.value.id, 'smoke-otp')
          : null;
        steps.push([
          'totp-channel-answers-with-a-code',
          totpChannel !== null &&
            totpChannel.ok === true &&
            totpChannel.value !== null &&
            // An explicit 0-9 class rather than a backslash one, and NO BACKTICKS in this
            // comment: the whole probe is a template literal. A lone backslash is eaten
            // before the renderer sees it, so the regex silently became /^d{6}$/ and matched
            // nothing -- it failed exactly that way once. A backtick ends the literal
            // outright, which it also did. The DOM probe below spells its class out too.
            /^[0-9]{6}$/.test(totpChannel.value.secretCode) &&
            totpChannel.value.expiresAt > Date.now(),
        ]);
        steps.push([
          'totp-channel-does-not-return-the-seed',
          totpChannel !== null &&
            totpChannel.ok === true &&
            !JSON.stringify(totpChannel.value).includes('JBSWY3DPEHPK3PXP'),
        ]);
        if (!made.ok) return { stage: 'cycle', ok: false, steps, detail: made.message };

        const id = made.value.id;

        // The attachment preview channel, on an id that does not exist. Cannot attach a real
        // file from here — that needs an OS dialog — but the refusal path is the one worth
        // proving unattended: it must answer ok-with-a-null-value rather than throwing, and
        // must not take a broker grant for a record it could not find. No backticks in this
        // comment on purpose -- the whole probe is a template literal, and one would end it.
        const noSuchPreview = await window.keyhold.attachments.preview(id, 'f'.repeat(32));
        steps.push([
          'attachment-preview-refuses-unknown',
          noSuchPreview.ok === true && noSuchPreview.value === null,
        ]);

        // THE boundary check, made against the live IPC surface rather than a unit test:
        // nothing the list returns may contain the password or the note.
        const after = await window.keyhold.credentials.list();
        const serialised = JSON.stringify(after);
        steps.push(['projection-has-no-password', !serialised.includes('a-secret-value-9182')]);
        steps.push(['projection-has-no-notes', !serialised.includes('must never appear')]);
        steps.push(['projection-has-title', serialised.includes('Smoke Test Account')]);

        const revealed = await window.keyhold.credentials.revealSecret({
          kind: 'password',
          credentialId: id,
        });
        steps.push(['reveal-password', revealed.ok === true && revealed.value === 'a-secret-value-9182']);

        const deep = await window.keyhold.credentials.deepSearch('must never appear');
        steps.push(['deep-search-finds-note', deep.ok === true && deep.value.includes(id)]);
        steps.push(['deep-search-returns-ids-only', deep.ok === true && !JSON.stringify(deep.value).includes('must never')]);

        const edited = await window.keyhold.credentials.update(id, { title: 'Renamed' });
        steps.push(['update', edited.ok === true && edited.value !== null && edited.value.changedFields.includes('title')]);

        const noop = await window.keyhold.credentials.update(id, { title: 'Renamed' });
        steps.push(['noop-update-reports-no-change', noop.ok === true && noop.value !== null && noop.value.changedFields.length === 0]);

        // ── history ────────────────────────────────────────────────────────
        //
        // The record has now been created and edited twice (one of them a no-op), so it has
        // exactly one version. These checks run against the live IPC surface rather than the
        // engine, because the thing worth guarding here is the BOUNDARY: a diff that carries
        // an old password is a leak no unit test of a pure function would notice.

        // A password change, specifically, so the leak guard below has something to catch.
        // Asserting "no old password in the diff" against a diff that contains no password
        // at all is a guard that cannot fail, which is worse than no guard.
        await window.keyhold.credentials.update(id, { password: 'rotated-value-4471' });

        const afterEdit = await window.keyhold.credentials.get(id);
        const versions = afterEdit.ok && afterEdit.value !== null ? afterEdit.value.history : [];
        steps.push(['history-records-the-edit', versions.length === 2]);
        steps.push([
          'history-names-the-changed-field',
          versions[0]?.changedFields.includes('title') === true,
        ]);
        steps.push([
          'history-carries-the-device-origin',
          typeof versions[0]?.origin.deviceName === 'string' &&
            versions[0].origin.deviceName.length > 0,
        ]);
        steps.push([
          'history-omits-the-network-at-the-default-privacy-level',
          versions[0]?.origin.networkName === undefined,
        ]);

        const diff = await window.keyhold.history.diff(id, 1);
        steps.push([
          'history-diff-shows-the-old-title',
          diff.ok === true &&
            diff.value !== null &&
            diff.value.some(
              (entry) =>
                entry.field === 'title' &&
                entry.before.kind === 'value' &&
                entry.before.value === 'Smoke Test Account'
            ),
        ]);

        const passwordDiff = await window.keyhold.history.diff(id, 2);
        steps.push([
          'history-diff-reports-a-password-change-as-a-length',
          passwordDiff.ok === true &&
            passwordDiff.value !== null &&
            passwordDiff.value.some(
              (entry) =>
                entry.field === 'password' &&
                entry.before.kind === 'secret' &&
                entry.before.length === 'a-secret-value-9182'.length
            ),
        ]);
        steps.push([
          'history-diff-has-no-secret-value',
          diff.ok === true &&
            passwordDiff.ok === true &&
            !JSON.stringify([diff.value, passwordDiff.value]).includes('a-secret-value-9182'),
        ]);

        // The old password is still reachable — deliberately, through the broker, one
        // version at a time — so the guard above is about the *diff*, not about the value
        // being unrecoverable.
        const oldPassword = await window.keyhold.credentials.revealSecret({
          kind: 'historic-password',
          credentialId: id,
          versionNumber: 2,
        });
        steps.push([
          'historic-password-reveals-through-the-broker',
          oldPassword.ok === true && oldPassword.value === 'a-secret-value-9182',
        ]);

        const restoredTitle = await window.keyhold.history.restoreVersion(id, 1);
        steps.push([
          'history-restore-puts-the-title-back',
          restoredTitle.ok === true &&
            restoredTitle.value !== null &&
            restoredTitle.value.projection.title === 'Smoke Test Account',
        ]);
        steps.push([
          'history-restore-is-itself-versioned',
          restoredTitle.ok === true &&
            restoredTitle.value !== null &&
            restoredTitle.value.projection.history.some((v) => v.origin.action === 'restore'),
        ]);

        const cleared = await window.keyhold.history.clear(id);
        steps.push(['history-clear', cleared.ok === true && cleared.value === true]);

        // ── generator ──────────────────────────────────────────────────────

        const generated = await window.keyhold.generator.generate({ mode: 'random', length: 24 });
        steps.push([
          'generator-produces-the-requested-length',
          generated.ok === true && generated.value.password.length === 24,
        ]);
        steps.push([
          'generator-reports-entropy',
          generated.ok === true && generated.value.entropyBits > 100,
        ]);

        const twice = await window.keyhold.generator.generate({ mode: 'random', length: 24 });
        steps.push([
          'generator-does-not-repeat-itself',
          generated.ok === true && twice.ok === true && generated.value.password !== twice.value.password,
        ]);

        const impossible = await window.keyhold.generator.generate({
          mode: 'random',
          length: 12,
          lowercase: true,
          uppercase: false,
          digits: false,
          symbols: false,
          excludeCharacters: 'abcdefghijklmnopqrstuvwxyz',
        });
        steps.push([
          'generator-refuses-an-impossible-configuration',
          impossible.ok === false && impossible.code === 'INVALID_REQUEST',
        ]);
        steps.push([
          'generator-error-does-not-echo-the-exclusion-back',
          impossible.ok === true || !impossible.message.includes('abcdefghij'),
        ]);

        const bounds = await window.keyhold.generator.limits();
        steps.push([
          'generator-limits-cross-the-contract',
          bounds.ok === true && bounds.value.limits.randomLength.min === 8,
        ]);

        // ── settings ───────────────────────────────────────────────────────

        const settings = await window.keyhold.settings.read();
        steps.push([
          'settings-read',
          settings.ok === true && settings.value.vault !== null,
        ]);
        steps.push([
          'settings-separates-machine-from-vault',
          settings.ok === true && settings.value.machine.autoLock !== undefined,
        ]);

        // A patch is a patch: sending one field must not reset the rest. This is the bug
        // that presents as the app forgetting your choices, and it is silent.
        const before = settings.ok ? settings.value.vault : null;
        const patched = await window.keyhold.settings.updateVault({ trashRetentionDays: 90 });
        steps.push([
          'settings-patch-applies-the-field-it-names',
          patched.ok === true && patched.value.vault?.trashRetentionDays === 90,
        ]);
        steps.push([
          'settings-patch-leaves-every-other-field-alone',
          patched.ok === true &&
            before !== null &&
            patched.value.vault?.auditPrivacyLevel === before.auditPrivacyLevel &&
            patched.value.vault?.historyMaxVersions === before.historyMaxVersions,
        ]);

        // Rejected rather than clamped: a clamp turns "the renderer sent nonsense" into "the
        // setting quietly became something the user did not choose".
        const outOfRange = await window.keyhold.settings.updateVault({ trashRetentionDays: 99999 });
        steps.push([
          'settings-refuses-an-out-of-range-value',
          outOfRange.ok === false && outOfRange.code === 'INVALID_REQUEST',
        ]);

        const badLevel = await window.keyhold.settings.updateVault({ auditPrivacyLevel: 'evil' });
        steps.push([
          'settings-refuses-an-unknown-audit-privacy-level',
          badLevel.ok === false,
        ]);

        // ── folders and tags ───────────────────────────────────────────────

        const emptyOrg = await window.keyhold.organisation.list();
        steps.push([
          'organisation-starts-empty',
          emptyOrg.ok === true && emptyOrg.value.folders.length === 0,
        ]);

        const parent = await window.keyhold.organisation.createFolder('Work', null);
        steps.push([
          'folder-create',
          parent.ok === true && parent.value.folders.some((f) => f.name === 'Work'),
        ]);

        const parentId = parent.ok
          ? (parent.value.folders.find((f) => f.name === 'Work')?.id ?? '')
          : '';
        const child = await window.keyhold.organisation.createFolder('Clients', parentId);
        steps.push(['folder-create-nested', child.ok === true && child.value.folders.length === 2]);

        const childId = child.ok
          ? (child.value.folders.find((f) => f.name === 'Clients')?.id ?? '')
          : '';

        // The guard that matters: a move that would nest a folder inside its own descendant
        // must be refused, not silently ignored. A drag that appears to do nothing is a bug
        // report nobody can write.
        const cycle = await window.keyhold.organisation.moveFolder(parentId, childId);
        steps.push([
          'folder-move-refuses-a-cycle',
          cycle.ok === false && cycle.recoverable === true,
        ]);
        steps.push([
          'folder-cycle-error-names-the-rule-not-the-name',
          cycle.ok === true || !cycle.message.includes('Work'),
        ]);

        const renamedFolder = await window.keyhold.organisation.renameFolder(childId, 'Customers');
        steps.push([
          'folder-rename',
          renamedFolder.ok === true &&
            renamedFolder.value.folders.some((f) => f.name === 'Customers'),
        ]);

        const tagged = await window.keyhold.organisation.createTag('urgent', 'accent');
        steps.push(['tag-create', tagged.ok === true && tagged.value.tags.length === 1]);

        const tagId = tagged.ok ? (tagged.value.tags[0]?.id ?? '') : '';

        // Put the tag on a record, then rename it. The rewrite of every record carrying the
        // tag is the half of a tag rename that classically gets missed.
        const taggedRecord = await window.keyhold.credentials.create({
          title: 'Tagged',
          tags: ['urgent'],
        });
        const renamedTag = await window.keyhold.organisation.renameTag(tagId, 'critical');
        steps.push([
          'tag-rename',
          renamedTag.ok === true && renamedTag.value.snapshot.tags[0]?.name === 'critical',
        ]);

        const afterRename = taggedRecord.ok
          ? await window.keyhold.credentials.get(taggedRecord.value.id)
          : null;
        steps.push([
          'tag-rename-rewrites-the-records-carrying-it',
          afterRename !== null &&
            afterRename.ok === true &&
            afterRename.value !== null &&
            afterRename.value.tags.includes('critical'),
        ]);

        const badColour = await window.keyhold.organisation.setTagColour(tagId, '#ff0000');
        steps.push([
          'tag-colour-refuses-a-raw-colour',
          badColour.ok === false,
        ]);

        const deletedFolder = await window.keyhold.organisation.deleteFolder(parentId, 'unfile');
        steps.push(['folder-delete', deletedFolder.ok === true]);

        const deletedTag = await window.keyhold.organisation.deleteTag(tagId);
        steps.push([
          'tag-delete-reports-the-records-it-touched',
          deletedTag.ok === true && deletedTag.value.affectedRecords === 1,
        ]);

        if (taggedRecord.ok) await window.keyhold.credentials.purge(taggedRecord.value.id);

        // ── health ─────────────────────────────────────────────────────────

        const report = await window.keyhold.health.analyse();
        steps.push(['health-scores-the-vault', report.ok === true && report.value.score >= 0]);
        steps.push([
          'health-report-has-no-secret-value',
          report.ok === true && !JSON.stringify(report.value).includes('a-secret-value-9182'),
        ]);

        const copied = await window.keyhold.credentials.duplicate(id);
        steps.push(['duplicate', copied.ok === true && copied.value !== null && copied.value.id !== id]);

        const trashed = await window.keyhold.credentials.trash(id);
        steps.push(['trash', trashed.ok === true && trashed.value === true]);

        const live = await window.keyhold.credentials.list();
        steps.push(['trashed-hidden-by-default', live.ok === true && !live.value.some((c) => c.id === id)]);

        const withTrash = await window.keyhold.credentials.list({ includeTrashed: true });
        steps.push(['trashed-visible-on-request', withTrash.ok === true && withTrash.value.some((c) => c.id === id)]);

        const restored = await window.keyhold.credentials.restore(id);
        steps.push(['restore', restored.ok === true && restored.value === true]);

        const purged = await window.keyhold.credentials.purge(id);
        steps.push(['purge', purged.ok === true && purged.value === true]);

        // The duplicate is a separate record and outlives its original. Cleaning it up
        // keeps the seeded demo vault below honest about what it contains.
        if (copied.ok && copied.value !== null) {
          await window.keyhold.credentials.purge(copied.value.id);
        }

        // Leave a few realistic records behind, so a screenshot taken after this run shows
        // the populated UI rather than an empty state. Also the seed for Phase 19's README
        // screenshots, which should be reproducible rather than hand-made.
        for (const seed of [
          { title: 'GitHub', username: 'anahat', urls: ['https://github.com'], tags: ['dev'] },
          { title: 'Cloudflare', email: 'a@example.com', urls: ['https://dash.cloudflare.com'], tags: ['dev', 'infra'] },
          { title: 'Namecheap', username: 'anahat', urls: ['https://namecheap.com'], tags: ['infra'] },
          { title: 'Steam', username: 'anahat', urls: ['https://store.steampowered.com'], tags: ['personal'] },
          { title: 'Vercel', email: 'a@example.com', urls: ['https://vercel.com'], tags: ['dev'] },
        ]) {
          await window.keyhold.credentials.create({
            ...seed,
            password: 'a-generated-looking-password-here',
            notes: 'Recovery codes live here.',
          });
        }

        // Give one seeded record a real edit history, and select it — so a screenshot taken
        // after this run shows the timeline rather than an empty state, and so the audit
        // trail's own rendering is exercised rather than only its data path.
        const seeded = await window.keyhold.credentials.list();
        const showcase = seeded.ok ? seeded.value.find((c) => c.title === 'GitHub') : undefined;
        if (showcase !== undefined) {
          await window.keyhold.credentials.update(showcase.id, { password: 'first-rotation' });
          await window.keyhold.credentials.update(showcase.id, {
            username: 'anahat-mudgal',
            email: 'a@example.com',
          });
          await window.keyhold.credentials.update(showcase.id, { password: 'second-rotation' });
          await window.keyhold.credentials.update(showcase.id, { tags: ['dev', 'work'] });
        }

        await window.keyhold.vault.save();

        return {
          stage: 'cycle',
          ok: steps.every((s) => s[1] === true),
          steps,
          showcaseId: showcase?.id ?? null,
        };
      })()
    `;

    window.webContents
      .executeJavaScript(probe, true)
      .then(async (outcome: unknown) => {
        // The probe drove the session from outside the renderer's own event flow, so the
        // UI still shows whatever it mounted with. Firing the real notification is both
        // what makes a screenshot show the opened vault AND a genuine exercise of the
        // path auto-lock depends on — the one case where main changes state and the
        // renderer has to find out.
        notifySessionChanged(window);

        // Waited for, not slept through. This is the one transition the whole rest of the run
        // stands on: the probe drove the session over IPC, so the renderer knows nothing until
        // this notification lands, refetches and re-renders.
        //
        // It was 400ms, which is plenty on a developer machine and was not enough on a CI
        // runner — and the failure had no shape. The vault screen simply was not up, so every
        // check that looks inside it found nothing, four of them reported false, and none of
        // them said why. Waiting for the rows to exist makes the dependency explicit and the
        // failure, if it ever comes back, a timeout on this line rather than a mystery further
        // down.
        // First run shows the setup flow, over the whole window.
        //
        // On a developer machine it never appears — that profile went through it long ago — and
        // on every CI runner the profile is fresh, so it always does. It covered the app for the
        // entire run, and every check that looks inside the vault screen found nothing.
        //
        // The check meant to catch this looked for `.kh-onboarding`. The class is `.kh-onb`. So
        // it asked whether a class that exists nowhere was absent, which is always true, and it
        // passed on both machines for the same wrong reason.
        //
        // Dismissed rather than suppressed: skipping is a path a real person takes, so driving
        // it here covers it instead of arranging for it not to happen.
        const onboardingHandled = await waitFor(
          window,
          `(() => {
             if (document.querySelector('.kh-onb') === null) return 'not-shown';
             const skip = [...document.querySelectorAll('.kh-onb button')]
               .find((element) => element.textContent?.trim() === 'Skip setup');
             if (!skip) return false;
             skip.click();
             return 'skipped';
           })()`,
          { timeoutMs: 15_000 }
        );
        emit(`SMOKE-NOTE onboarding-path ${String(onboardingHandled)}`);
        emit(
          `SMOKE-CHECK onboarding-handled-before-the-vault-checks ${String(
            onboardingHandled === 'skipped' || onboardingHandled === 'not-shown'
          )}`
        );

        const listReady = await waitFor(
          window,
          `document.querySelector('.kh-onb') === null &&
             document.querySelectorAll('.kh-row').length > 0 ? 'rows' : false`,
          { timeoutMs: 20_000 }
        );
        emit(
          `SMOKE-CHECK vault-screen-renders-after-the-session-changes ${String(listReady === 'rows')}`
        );

        const report = outcome as {
          stage?: string;
          ok?: boolean;
          result?: unknown;
          steps?: unknown;
          detail?: unknown;
          showcaseId?: string | null;
        };

        // ── README screenshots, captured from the real app ──────────────────
        //
        // `--shots <dir>` walks a few named views and captures each. Generated rather than
        // hand-made, so a screenshot in the README can never quietly stop matching the app
        // it claims to show — regenerating them is one command.
        await captureNamedShot(window, 'Keyhold-Screenshot-01', '.kh-vault-facts');

        // The cloud-folder notice. The harness puts the smoke vault inside a folder called
        // `Dropbox` precisely so this has something to find — a notice nothing renders looks
        // identical to one that correctly decided not to appear, and that is the failure this
        // whole session keeps turning up.
        const cloudNotice: unknown = await window.webContents.executeJavaScript(
          `(() => {
            const element = document.querySelector('.kh-cloud-notice');
            if (!element) return 'missing';
            const text = element.textContent ?? '';
            if (!text.includes('Dropbox')) return 'unnamed';
            // The remedy has to be named, or the notice is only something to worry about.
            if (!text.includes('Merge another copy of this vault')) return 'no-remedy';
            return 'shown';
          })()`,
          true
        );
        // Ctrl+F and Ctrl+B, both registered in the shortcut table and the palette since they
        // were written, and both wired to nothing until now. Driven through the real key
        // events, because a handler that exists and is never reached is the failure here.
        const shortcuts = await waitFor(
          window,
          `(async () => {
             const fire = (key) => document.dispatchEvent(
               new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true })
             );

             const sidebarBefore = document.querySelector('.kh-shell__sidebar') !== null;
             fire('b');
             await new Promise((done) => setTimeout(done, 300));
             const sidebarAfter = document.querySelector('.kh-shell__sidebar') !== null;
             fire('b');
             await new Promise((done) => setTimeout(done, 300));

             const box = document.querySelector('.kh-list__search input');
             if (!box) return 'no-search-box';
             box.blur();
             fire('f');
             await new Promise((done) => setTimeout(done, 300));
             const focused = document.activeElement === box;

             if (sidebarBefore === sidebarAfter) return 'ctrl-b-did-nothing';
             if (!focused) return 'ctrl-f-did-nothing';
             return 'both';
           })()`
        );
        emit(`SMOKE-NOTE vault-shortcuts ${String(shortcuts)}`);
        emit(`SMOKE-CHECK vault-shortcuts-do-something ${String(shortcuts === 'both')}`);

        // The query help. Both halves had existed in the parser and neither was ever shown:
        // the diagnostics, so a typo looked like an empty vault rather than a misread query,
        // and the prefix list, which `QUERY_FIELDS` says in its own comment it exists for.
        // The window, not just the input. `element.focus()` in a window the OS has not
        // focused updates `document.activeElement` and **does not fire a focus event** —
        // Chromium only delivers those to a focused document. So the box was the active
        // element, React's `searchFocused` was still false, and `QueryHelp` rendered nothing.
        // The check read as a broken feature for as long as it took to print `activeElement`
        // beside the result; the app was fine and the harness was lying. Every check that
        // depends on a focus *event* rather than on active-element state needs this line.
        window.focus();

        const queryHelp = await waitFor(
          window,
          `(async () => {
             const box = document.querySelector('.kh-list__search input');
             if (!box) return false;
             const setValue = Object.getOwnPropertyDescriptor(
               window.HTMLInputElement.prototype, 'value'
             ).set;

             // Two probes, because they are two different queries. A partial prefix has
             // completions and no diagnostic; an unterminated quote has a diagnostic and no
             // completions, since the broken token matches no prefix. Demanding both from one
             // query was the first version of this check, and it failed for that reason rather
             // than because anything was wrong.
             box.focus();
             setValue.call(box, 'tit');
             box.dispatchEvent(new Event('input', { bubbles: true }));
             await new Promise((done) => setTimeout(done, 400));
             const offered = document.querySelector('.kh-query-help__suggestion') !== null;

             // A query the parser recovers from and reports on. Silence here is the failure
             // this check exists for: a misread query looking like an empty vault.
             setValue.call(box, 'tit "unterminated');
             box.dispatchEvent(new Event('input', { bubbles: true }));
             await new Promise((done) => setTimeout(done, 400));
             const help = document.querySelector('.kh-query-help');
             const said = (help?.textContent ?? '').toLowerCase().includes('quote');

             // The failure carries its own evidence. A run nobody watches is the only record
             // there will ever be, and "no-suggestions" alone cost a build round-trip to
             // turn into "the document was not focused" — which the next three words say.
             const why =
               ' active=' + (document.activeElement?.className || '') +
               ' isBox=' + (document.activeElement === box) +
               ' focusedDoc=' + document.hasFocus();

             if (!offered) return 'no-suggestions' + why;
             if (!said) return 'no-diagnostic' + why;
             return 'both';
           })()`
        );
        emit(`SMOKE-NOTE query-help-said ${String(queryHelp)}`);
        emit(`SMOKE-CHECK query-help-explains-and-suggests ${String(queryHelp === 'both')}`);

        // The box put back, so the list is unfiltered for everything after this.
        await window.webContents.executeJavaScript(
          `(() => {
             const box = document.querySelector('.kh-list__search input');
             const setValue = Object.getOwnPropertyDescriptor(
               window.HTMLInputElement.prototype, 'value'
             ).set;
             setValue.call(box, '');
             box.dispatchEvent(new Event('input', { bubbles: true }));
             box.blur();
             return true;
           })()`,
          true
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 400));

        // The sort control, which had an engine with eight keys and no way to choose one.
        // Driven, not just found: picking a key must actually reorder the list, and a control
        // that renders but changes nothing is the failure this whole session keeps meeting.
        const sorted = await waitFor(
          window,
          `(() => {
             const select = document.querySelector('#kh-sort-key');
             if (!select) return false;
             const before = [...document.querySelectorAll('.kh-row')].map((r) => r.textContent);
             if (before.length < 2) return false;
             // Name Z-A: the exact reverse of the default, so the check cannot pass on a list
             // that happens to already be in the chosen order.
             select.value = 'title';
             select.dispatchEvent(new Event('change', { bubbles: true }));
             return JSON.stringify(before);
           })()`
        );

        await window.webContents.executeJavaScript(
          `(() => {
            const flip = [...document.querySelectorAll('.kh-sort button')][0];
            flip?.click();
            return flip !== undefined;
          })()`,
          true
        );

        // Compared against what the list was before the flip, embedded as a literal so the
        // poll can return as soon as the order genuinely differs rather than after a fixed wait.
        const reordered = await waitFor(
          window,
          `(() => {
             const now = JSON.stringify(
               [...document.querySelectorAll('.kh-row')].map((r) => r.textContent)
             );
             return now !== ${JSON.stringify(String(sorted))} ? now : false;
           })()`
        );
        emit(
          `SMOKE-CHECK sort-control-reorders-the-list ${String(
            typeof sorted === 'string' && typeof reordered === 'string' && sorted !== reordered
          )}`
        );

        await noteScreen(window, 'before-cloud-notice');
        emit(
          `SMOKE-CHECK cloud-folder-notice-names-the-provider ${String(cloudNotice === 'shown')}`
        );
        await captureNamedShot(window, 'Keyhold-Screenshot-11', '.kh-cloud-notice');

        // A real conflicted copy, beside the real vault, found through the real channel.
        //
        // Copied from the vault file itself, which makes it exactly what a sync client would
        // leave: same `vaultId`, same generation, a name the client invented. That is what lets
        // this check the parts a unit test cannot — that the scan reads the plaintext header of
        // a genuine container, and that the vault id it compares against matches.
        //
        // Written here rather than by the harness because the vault's path is only known on
        // this side, and nothing about it may cross the bridge.
        const conflictedCopyName = "smoke (Anahat's conflicted copy 2026-09-03).keep";
        // Narrowed here rather than relied on: this whole block only runs on the vault path,
        // but the binding is `string | undefined` at this scope and a cast would be a claim
        // rather than a check.
        const openVaultPath = vaultPath ?? '';
        if (openVaultPath !== '') {
          await copyFile(openVaultPath, join(dirname(openVaultPath), conflictedCopyName));
        }

        const candidates: unknown = await window.webContents.executeJavaScript(
          `(async () => {
             const result = await window.keyhold.sync.candidates();
             if (!result.ok) return 'failed: ' + result.code;
             const found = result.value;
             if (found.length !== 1) return 'wrong count: ' + found.length;
             const only = found[0];
             if (!only.fileName.includes('conflicted copy')) return 'wrong file';
             // Every field comes from the plaintext header, with no key involved.
             if (typeof only.generation !== 'number') return 'no generation';
             if (typeof only.recordCount !== 'number') return 'no record count';
             // And the property the whole design rests on: no path reaches the renderer.
             if (JSON.stringify(found).includes('keyhold-smoke')) return 'a path leaked';
             return 'listed';
           })()`,
          true
        );
        emit(
          `SMOKE-CHECK conflicted-copy-listed-without-a-path ${String(candidates === 'listed')}`
        );

        // Open the record that has history, and expand its newest change — by clicking the
        // real controls rather than through a test-only hook on `window`. A backdoor would
        // be production code that exists for the harness, and it would not prove the list
        // row and the disclosure button work.
        // Clicking a row that is not there yet succeeds silently — `row?.click()` on
        // `undefined` does nothing and returns. That is how the detail pane stayed empty for
        // the rest of a CI run with no error anywhere.
        await waitFor(
          window,
          `(() => {
            const row = [...document.querySelectorAll('.kh-row')].find((element) =>
              element.textContent?.includes('GitHub')
            );
            if (!row) return false;
            row.click();
            return 'clicked';
          })()`
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 250));

        // The attachments panel. Four channels were registered and the detail pane showed a
        // count and nothing else, so a user could neither attach a file nor get one back out.
        // Asserted on the empty state, because that is what a record with no attachments must
        // show — a panel that only appears once something is attached is a panel nobody can
        // use to attach the first thing.
        // Polled rather than slept on: the panel appears after a click, a store update and a
        // render, and how long that takes is a property of the machine.
        const attachments = await waitFor(
          window,
          `(() => {
            const panel = document.querySelector('.kh-attachments');
            if (!panel) return false;
            const button = [...panel.querySelectorAll('button')]
              .find((element) => element.textContent?.includes('Attach a file'));
            return button ? 'ready' : false;
          })()`
        );
        // The layout mode, asserted before anything that depends on it.
        //
        // `AppShell` shows the detail pane only when a record is selected below 900px, so a
        // narrow window makes several checks below fail for a reason none of them mentions.
        // That is exactly what happened on a CI runner with a 1024-wide display. Checking the
        // width turns four confusing failures into one that names the cause.
        const wideEnough: unknown = await window.webContents.executeJavaScript(
          `JSON.stringify({ inner: window.innerWidth, narrow: window.innerWidth < 900 })`,
          true
        );
        emit(
          `SMOKE-CHECK layout-is-the-wide-three-pane ${String(wideEnough).includes('"narrow":false')}`
        );
        emit(`SMOKE-NOTE viewport ${String(wideEnough)}`);

        await noteScreen(window, 'before-attachments');
        emit(`SMOKE-CHECK attachments-panel-usable ${String(attachments === 'ready')}`);

        await captureNamedShot(window, 'Keyhold-Screenshot-02', '.kh-detail');

        // The command palette, opened by its real shortcut rather than by calling into the
        // store. A palette that opens when a test asks it to but not when Ctrl+K is pressed
        // is a palette nobody can use, and only the key path proves the gate, the listener
        // and the registry all agree.
        await window.webContents.executeJavaScript(
          `(() => {
            const key = new KeyboardEvent('keydown', {
              key: 'k',
              ctrlKey: true,
              metaKey: false,
              bubbles: true,
            });
            document.dispatchEvent(key);
            return true;
          })()`,
          true
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        // Typed, not inferred: `executeJavaScript` returns `any`, and letting that flow into
        // a boolean check means the assertion below would pass on a string, a number, or an
        // exception object — a guard that cannot fail.
        const paletteOpen: unknown = await window.webContents.executeJavaScript(
          `document.querySelector('[role="combobox"], .kh-palette') !== null`,
          true
        );
        // The first-run flow, which spans the whole window when it shows.
        //
        // Checked because every other check below would pass or fail for the wrong reason if
        // it were on screen, and because both directions are bad: a returning user handed a
        // tour, or a new user who never sees one. At this point the probe has created and
        // unlocked a real vault, so this machine is emphatically a returning one.
        // `.kh-onb`, which is the class the component actually renders. This asked about
        // `.kh-onboarding` until now — a class that exists nowhere — so it was asking whether
        // nothing was absent, and answering yes, on every machine and every run.
        //
        // It still earns its place: by this point setup has been skipped and a vault is open,
        // so the flow reappearing would mean the "seen it" state did not stick, which is a real
        // bug and one a user would meet on their second launch rather than their first.
        const onboarding: unknown = await window.webContents.executeJavaScript(
          `document.querySelector('.kh-onb') !== null`,
          true
        );
        emit(`SMOKE-CHECK onboarding-stays-gone-once-past-it ${String(onboarding === false)}`);

        // The external-change banner, driven by pushing the event the watcher pushes.
        //
        // Sent from here rather than by touching the file, because the watcher is deliberately
        // hard to fool: it decides from the plaintext header and brackets this app's own
        // writes, so provoking a genuine report inside a smoke run means racing a debounce.
        // What is being checked is the half that was missing anyway — the event reached the
        // renderer, something rendered, and the right buttons were chosen. The decision itself
        // has its own tests over every combination of the flags.
        window.webContents.send(EVENTS.vaultChangedExternally, {
          knownGeneration: 1,
          currentGeneration: 2,
          differentVault: false,
          wentBackwards: false,
        });
        // The event crosses IPC and React re-renders; both are the machine's business.
        const banner = await waitFor(
          window,
          `(() => {
            const element = document.querySelector('.kh-external-change');
            if (!element) return false;
            const text = element.textContent ?? '';
            // Nothing was edited in this run, so reloading loses nothing and must be offered.
            if (!text.includes('Reload from disk')) return false;
            if (!text.includes('Merge the two copies')) return false;
            return 'offered';
          })()`
        );
        await noteScreen(window, 'before-banner');
        emit(`SMOKE-CHECK external-change-banner-offers-a-reload ${String(banner === 'offered')}`);
        await captureNamedShot(window, 'Keyhold-Screenshot-10', '.kh-external-change');

        // Dismissed again, so it does not sit over every screenshot after this point.
        await window.webContents.executeJavaScript(
          `(() => {
            const button = [...document.querySelectorAll('.kh-external-change button')]
              .find((element) => element.textContent === 'Dismiss');
            button?.click();
            return button !== undefined;
          })()`,
          true
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        const bannerGone: unknown = await window.webContents.executeJavaScript(
          `document.querySelector('.kh-external-change') === null`,
          true
        );
        emit(`SMOKE-CHECK external-change-banner-dismisses ${String(bannerGone === true)}`);

        emit(`SMOKE-CHECK palette-opens-on-its-shortcut ${String(paletteOpen === true)}`);

        // (moved: see the shell-stays-put check after the settings view, which needs a long page)
        await captureNamedShot(window, 'Keyhold-Screenshot-05', '.kh-palette__list');
        // At `document.activeElement`, not at `document`.
        //
        // This used to dispatch on `document`, which cannot work and never did: a DOM event
        // dispatched on the document propagates *up* to the window, never down into the
        // tree, so a handler on the palette's own `<dialog>` element never saw it. The
        // palette stayed open for the rest of the run — visible in every screenshot after
        // this point, obscuring the very views they were capturing — and nothing noticed,
        // because nothing asserted it had closed.
        //
        // That is the third guard in this file found asserting nothing. The lesson is the
        // same each time: dispatch where the real event would land, then check the result.
        await window.webContents.executeJavaScript(
          `(document.activeElement ?? document.body).dispatchEvent(
             new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
          true
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        const paletteClosed: unknown = await window.webContents.executeJavaScript(
          `document.querySelector('.kh-palette') === null`,
          true
        );
        emit(`SMOKE-CHECK palette-closes-on-escape ${String(paletteClosed === true)}`);

        // The palette lists the tool views, and the rows are generated from the same table
        // the sidebar reads. Checked through the real palette rather than against the
        // registry, because the registry having an entry and the palette rendering a row
        // are two different claims — and the second is the one a user experiences.
        await window.webContents.executeJavaScript(
          `document.dispatchEvent(
             new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`,
          true
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        const toolRows: unknown = await window.webContents.executeJavaScript(
          `(() => {
            const text = document.querySelector('.kh-palette__list')?.textContent ?? '';
            return ['Generate a password', 'Vault health', 'Settings', 'Help']
              .every((title) => text.includes(title));
          })()`,
          true
        );
        emit(`SMOKE-CHECK palette-lists-every-tool-view ${String(toolRows === true)}`);

        // The three whole-vault flows, found the way a person would: by picking the row out of
        // the palette. Each of them was finished and bound to a live channel and rendered by
        // nothing at all, so a check that the way in *exists* is worth more here than anything
        // about their internals. The merge row is the newest and was the last to be reachable.
        const transferRows: unknown = await window.webContents.executeJavaScript(
          `(() => {
            const text = document.querySelector('.kh-palette__list')?.textContent ?? '';
            return text.includes('Import from another password manager')
              && text.includes('Export this vault')
              && text.includes('Merge another copy of this vault');
          })()`,
          true
        );
        emit(`SMOKE-CHECK palette-offers-every-transfer ${String(transferRows === true)}`);

        // ── The import wizard's second route in ──────────────────────────────
        //
        // A `.keep` or `.keepx` needs a passphrase, so it cannot go through the same button
        // as a CSV (D30) — it is a disclosure on the file step. Opened here rather than
        // asserted in a unit test because the failure worth catching is reachability: the
        // route existed in the gateway, the channel and the service, and would have been a
        // feature nobody could find if the disclosure had not been rendered.
        //
        // Nothing is typed into the passphrase field and no dialog is opened. The check is
        // that the way in is on screen, which is the part that keeps going missing.
        await window.webContents.executeJavaScript(
          `(() => {
            // A palette row is a div[role=option] driven by mousedown, not a button — the
            // first version of this check called .click() and silently did nothing, which is
            // the same class of mistake it was written to catch.
            const row = [...document.querySelectorAll('.kh-palette__row')].find(
              (element) => element.textContent?.includes('Import from another password manager')
            );
            row?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            return row !== undefined;
          })()`,
          true
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 400));

        const vaultRoute: unknown = await window.webContents.executeJavaScript(
          `(() => {
            const wizard = document.body.textContent ?? '';
            if (!wizard.includes('Bring a vault in from somewhere else')) return 'no-wizard';

            const toggle = [...document.querySelectorAll('button')].find(
              (element) => element.textContent?.trim() === 'Open a .keep or .keepx'
            );
            if (toggle === undefined) return 'no-disclosure';
            toggle.click();
            return 'opened';
          })()`,
          true
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 300));

        // The field, and that it is a password field rather than a text one — a passphrase
        // box that renders its contents is a passphrase on somebody's screen recording.
        const passphraseField: unknown = await window.webContents.executeJavaScript(
          `(() => {
            const inputs = [...document.querySelectorAll('.kh-import-vault input')];
            return inputs.length === 1 && inputs[0].type === 'password';
          })()`,
          true
        );

        emit(
          `SMOKE-CHECK import-offers-a-keyhold-vault ${String(vaultRoute === 'opened' && passphraseField === true)}`
        );
        await captureNamedShot(window, 'Keyhold-Screenshot-16', '.kh-import-vault');

        // Out of the wizard, so the screens after this are not taken behind a modal.
        await window.webContents.executeJavaScript(
          `(document.activeElement ?? document.body).dispatchEvent(
             new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
          true
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 300));

        await window.webContents.executeJavaScript(
          `(document.activeElement ?? document.body).dispatchEvent(
             new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
          true
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        await window.webContents.executeJavaScript(
          `(document.activeElement ?? document.body).dispatchEvent(
             new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
          true
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        await window.webContents.executeJavaScript(
          `(() => {
            const button = [...document.querySelectorAll('.kh-timeline button')].find(
              (element) => element.textContent === 'Show changes'
            );
            button?.click();
            // Bring the timeline into view. A screenshot of a feature that is below the
            // fold proves the page rendered, not that the feature did.
            document.querySelector('.kh-timeline')?.scrollIntoView({ block: 'center' });
            return button !== undefined;
          })()`,
          true
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        // Comparing two points, which had a channel and no caller for its whole life.
        //
        // Driven through the real control rather than the store: the panel is collapsed by
        // default, so a check that only called `history.compare` would pass on a button nobody
        // can find. Opening it is the half that was missing.
        await window.webContents.executeJavaScript(
          `(() => {
             const toggle = [...document.querySelectorAll('.kh-compare button')]
               .find((element) => element.textContent === 'Compare two versions');
             if (!toggle) return 'no-toggle';
             toggle.click();
             // Opened here; the panel's own appearance is polled for by the caller, because a
             // fixed wait inside the probe is the same assumption in a smaller box.
             return 'opened';
           })()`,
          true
        );

        const compared = await waitFor(
          window,
          `(() => {
             const panel = document.querySelector('.kh-compare__panel');
             if (!panel) return false;
             // Two pickers, and both must list the live state as well as the versions.
             const selects = [...panel.querySelectorAll('select')];
             if (selects.length !== 2) return false;
             const options = [...selects[0].options].map((option) => option.value);
             if (!options.includes('current')) return false;
             if (options.length < 2) return false;

             const text = panel.textContent ?? '';
             if (text.includes('has no answer')) return false;
             return 'compared';
           })()`
        );
        emit(`SMOKE-CHECK history-compare-is-reachable ${String(compared === 'compared')}`);
        await noteScreen(window, 'before-compare');

        // Captured here, while the comparison is actually open on the record it belongs to.
        //
        // It used to be captured after the one-time-code probe, which selects a *different*
        // record — unmounting the panel — and after the diagnostics probe, which covers the
        // window entirely. The file therefore showed neither a comparison nor the record it
        // compared. `shot-…-shows-its-subject` is what found that, on its first run.
        await captureNamedShot(window, 'Keyhold-Screenshot-12', '.kh-compare__panel');

        // Closed again, so it does not sit over the detail shot.
        await window.webContents.executeJavaScript(
          `(() => {
            const hide = [...document.querySelectorAll('.kh-compare button')]
              .find((element) => element.textContent === 'Hide comparison');
            hide?.click();
            return hide !== undefined;
          })()`,
          true
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        await captureNamedShot(window, 'Keyhold-Screenshot-03', '.kh-detail');
        // The history export button, which has a channel behind it and is easy to ship
        // unreachable. Not clicked: it opens a native save dialog, which would hang the run.
        // Presence is the half that fails silently; the file's contents have their own tests,
        // including the planted-secret sweep.
        const exportButton = await waitFor(
          window,
          `[...document.querySelectorAll('.kh-detail button')]
             .some((element) => element.textContent === 'Export history') ? 'offered' : false`
        );
        emit(`SMOKE-CHECK history-export-is-offered ${String(exportButton === 'offered')}`);

        // ── The one-time code, on screen ────────────────────────────────────
        //
        // The channel is asserted above; this is the half that was missing for two phases.
        // The engine was finished, correct and rendered by nothing, and every test passed the
        // whole time — so the only check that would have noticed is one that selects a record
        // with an `otp-secret` field and looks for six digits in the detail pane.
        const totpCode = await waitFor(
          window,
          `(async () => {
             const row = [...document.querySelectorAll('.kh-row')]
               .find((element) => element.textContent?.includes('Smoke TOTP'));
             if (!row) return 'row-missing';
             row.click();
             await new Promise((done) => setTimeout(done, 500));

             const shown = document.querySelector('.kh-totp__code');
             if (!shown) return 'field-not-rendered';
             const digits = (shown.textContent || '').replace(/[^0-9]/g, '');
             return digits.length === 6 ? 'six-digits' : 'no-code';
           })()`
        );
        emit(`SMOKE-NOTE totp-said ${String(totpCode)}`);
        emit(`SMOKE-CHECK totp-code-is-rendered ${String(totpCode === 'six-digits')}`);

        // Captured **here**, while the code is on screen, and not after the diagnostics check
        // below — which opens a tool view over the whole window and never closes it. That
        // ordering is what produced four byte-identical files claiming to be four different
        // screens; see `captureNamedShot`. "Six digits are in the DOM" and "this looks like a
        // usable authenticator field" are different claims, and only the first can be
        // asserted from here, which is why the shot is worth taking at all.
        await captureNamedShot(window, 'Keyhold-Screenshot-16-totp', '.kh-totp__code');

        // ── The diagnostics report, end to end ──────────────────────────────
        //
        // src/main/recovery/ was finished, tested and reachable from nothing: every piece is
        // a pure function over bytes, a listing or a document, and nothing read a folder and
        // called them. This runs the real channel against the real smoke vault and asks the
        // screen for a rendered report -- the only check that would notice it going back.
        const diagnosed = await waitFor(
          window,
          `(async () => {
             const row = [...document.querySelectorAll('.kh-tools-nav .kh-sidebar__item')]
               .find((element) => element.textContent?.includes('Diagnose a vault'));
             if (!row) return 'no-tool-row';
             row.click();
             await new Promise((done) => setTimeout(done, 300));

             const button = [...document.querySelectorAll('.kh-diagnostics button')]
               .find((element) => element.textContent?.includes('Diagnose this vault'));
             if (!button) return 'no-button';
             button.click();
             await new Promise((done) => setTimeout(done, 1500));

             const text = document.querySelector('.kh-diagnostics')?.textContent || '';
             if (text.includes('Nothing diagnosed yet')) return 'no-report';
             return text.includes('What was checked') ? 'reported' : 'unexpected';
           })()`
        );
        emit(`SMOKE-NOTE diagnostics-said ${String(diagnosed)}`);
        emit(`SMOKE-CHECK diagnostics-report-is-rendered ${String(diagnosed === 'reported')}`);
        // A distinct name: the tool-view loop below captures the same screen in its empty
        // state, and shared names meant the later shot silently replaced this one — a
        // screenshot claiming to be a rendered report and showing 'Nothing diagnosed yet'.
        await captureNamedShot(
          window,
          'Keyhold-Screenshot-18-diagnostics-report',
          '.kh-diagnostics__block'
        );

        // Back to the vault before anything else is captured.
        //
        // The diagnostics probe above opened a tool view, which covers the entire window, and
        // nothing here closed it. Every capture that followed — the one-time code, the
        // comparison, the diff and the editor — was therefore a picture of this screen under
        // somebody else's name. Escape is what a user would press, and it is what the
        // tool-view teardown at the end of this run asserts works.
        await window.webContents.executeJavaScript(
          `(document.activeElement ?? document.querySelector('.kh-tool__title'))?.dispatchEvent(
             new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
          true
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        const backOnTheVault: unknown = await window.webContents.executeJavaScript(
          `document.querySelector('.kh-shell__main') === null && document.querySelector('.kh-detail') !== null`,
          true
        );
        emit(`SMOKE-CHECK diagnostics-hands-the-vault-back ${String(backOnTheVault === true)}`);

        // The editor, which is the screen the custom-field system actually shows.
        //
        // NOT a theme switch: appearance is applied as CSS custom properties on the root
        // element rather than through a `data-theme` selector, so setting an attribute here
        // changed nothing and produced a byte-identical duplicate of the shot above — a
        // screenshot claiming to be something it was not.
        await window.webContents.executeJavaScript(
          `(() => {
            const edit = [...document.querySelectorAll('.kh-detail button')].find(
              (element) => element.textContent === 'Edit'
            );
            edit?.click();
            return edit !== undefined;
          })()`,
          true
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
        await captureNamedShot(window, 'Keyhold-Screenshot-04', '.kh-editor');

        // ── The tool views ──────────────────────────────────────────────────
        //
        // Opened by clicking the real sidebar row, not by poking the store. Three separate
        // things have to agree for a tool to render anything — the row, the registry, and
        // the shell's tool mode — and only the click path proves all three. One row and one
        // screenshot per tool view, because the whole reason these exist is that finished
        // screens had no way in, and a regression here puts them back where they were.
        //
        // The list is written out rather than derived from `TOOL_VIEWS`, which lives in the
        // renderer and cannot be imported here. That is a real seam, and the guard against it
        // is `palette-lists-every-tool-view` above, which counts the palette's rows against
        // the registry — so a tool view added without a line here is caught there rather than
        // slipping through both.
        for (const [label, name] of [
          ['Generate a password', 'Keyhold-Screenshot-06'],
          ['Vault health', 'Keyhold-Screenshot-07'],
          ['Settings', 'Keyhold-Screenshot-08'],
          ['Help', 'Keyhold-Screenshot-09'],
          ['Session activity', 'Keyhold-Screenshot-13'],
          ['Diagnose a vault', 'Keyhold-Screenshot-17-diagnostics'],
          ['What’s new', 'Keyhold-Screenshot-14'],
          ['About', 'Keyhold-Screenshot-15'],
        ] as const) {
          const opened: unknown = await window.webContents.executeJavaScript(
            `(() => {
              const row = [...document.querySelectorAll('.kh-tools-nav .kh-sidebar__item')]
                .find((element) => element.textContent?.includes(${JSON.stringify(label)}));
              row?.click();
              return row !== undefined;
            })()`,
            true
          );
          await new Promise<void>((resolve) => setTimeout(resolve, 400));
          // Typed, not inferred. `executeJavaScript` returns `any`, and letting that flow
          // into a boolean check gives an assertion that passes on a string, a number or an
          // exception object — a check that cannot fail.
          const rendered: unknown = await window.webContents.executeJavaScript(
            `document.querySelector('.kh-shell__main .kh-tool__title')?.textContent ?? null`,
            true
          );
          emit(
            `SMOKE-CHECK ${name.toLowerCase()}-opens ${String(opened === true && typeof rendered === 'string' && rendered.length > 0)}`
          );

          // The network kill-switch has to be *reachable*, which is the whole finding: it was
          // built, persisted, IPC-writable and in the settings payload, and no control
          // rendered it — so the only way to turn it on was to hand-edit `preferences.json`.
          //
          // This checks **reachability**, and the `off` half is weaker than it looks: this
          // process reads a real preferences file, so it reports what is *stored*, not what
          // the default is. Flipping `DEFAULT_PREFERENCES.networkAllowed` to `true` does not
          // fail this check, and that was measured rather than assumed. The default is
          // guarded where it can be — `network-policy.test.ts`, which fails two ways on
          // exactly that injection. Saying so here so nobody reads this line as covering it.
          if (label === 'Settings') {
            const killSwitch: unknown = await window.webContents.executeJavaScript(
              `(() => {
                const label = [...document.querySelectorAll('label, .kh-setting')]
                  .find((element) => element.textContent?.includes('Let Keyhold make network requests'));
                if (!label) return 'missing';
                const box = label.querySelector('input[type="checkbox"]')
                  ?? label.parentElement?.querySelector('input[type="checkbox"]');
                if (!box) return 'no-control';
                return box.checked ? 'on' : 'off';
              })()`,
              true
            );
            emit(`SMOKE-CHECK network-kill-switch-present-and-off ${String(killSwitch === 'off')}`);

            // The screen-capture switch, checked the same way and for the same reason: a
            // setting nothing renders is a setting nobody can change. Its default runs the
            // other way from the kill-switch above -- it is ON -- and the same caveat applies
            // about what this can and cannot prove: it reports what is stored, not what the
            // default is, and the default is guarded in `preferences.test.ts`.
            const capture: unknown = await window.webContents.executeJavaScript(
              `(() => {
                const label = [...document.querySelectorAll('label, .kh-setting')]
                  .find((element) => element.textContent?.includes('Hide this window from screenshots'));
                if (!label) return 'missing';
                const box = label.querySelector('input[type="checkbox"]')
                  ?? label.parentElement?.querySelector('input[type="checkbox"]');
                if (!box) return 'no-control';
                return box.checked ? 'on' : 'off';
              })()`,
              true
            );
            emit(`SMOKE-CHECK screen-capture-switch-present-and-on ${String(capture === 'on')}`);

            // Scrolled to Security & session before the shot. Appearance is the top of this
            // screen and the theme picker is already shown elsewhere; the security block is
            // the part that is actually Keyhold's argument — auto-lock, quick unlock, and
            // the network kill-switch — so it is what the screenshot should be of.
            await window.webContents.executeJavaScript(
              `(() => {
                const target = document.getElementById('kh-settings-security');
                const pane = document.querySelector('.kh-tool__body');
                if (!target || !pane) return false;
                // The pane's own scrollTop, not scrollIntoView: that walks up every ancestor
                // and would scroll whatever else happens to be scrollable on the way.
                pane.scrollTop = target.offsetTop - pane.offsetTop;
                return true;
              })()`,
              true
            );
            await new Promise<void>((resolve) => setTimeout(resolve, 250));

            // The shell itself must never move. A desktop app whose chrome can slide off the
            // top of the window has no way to put it back: there is no scrollbar on the
            // shell for anyone to drag.
            //
            // Checked here rather than on the vault screen because it needs a page long
            // enough to scroll, and asserted by *doing the thing that broke it* — a
            // `scrollIntoView` deep inside a pane, which walks up every ancestor looking for
            // something scrollable. `overflow: hidden` on `body` does not stop that: it
            // creates a scroll container and only refuses the *user*. `overflow: clip`
            // creates none, which is the fix and is what this proves.
            const shellHeld: unknown = await window.webContents.executeJavaScript(
              `(() => {
                const shell = document.querySelector('.kh-shell');
                if (!shell) return false;
                const before = shell.getBoundingClientRect().top;
                const h = document.documentElement;
                document.getElementById('kh-settings-security')?.scrollIntoView({ block: 'center' });
                // Both halves: the chrome did not move, and the document has no room to move
                // it. The second is the one that catches the cause rather than a symptom.
                return shell.getBoundingClientRect().top === before
                  && h.scrollHeight === h.clientHeight;
              })()`,
              true
            );
            emit(`SMOKE-CHECK shell-chrome-stays-put ${String(shellHeld === true)}`);
          }

          // The breach panel, which is the reason this whole block of checks exists.
          //
          // `BreachSection` was finished, tested six ways and mounted nowhere for months, and
          // every one of those tests passed the entire time — because no test of a component
          // can see that nothing renders it. It is still one `undefined` away from going back
          // there: `HealthDashboard` renders it only when a caller passes `onOpenSettings`, so
          // dropping that prop makes the panel disappear with nothing failing anywhere.
          //
          // Two assertions, and the second is not decoration. The panel must be **present**,
          // and it must be **inert**: no report on screen means nothing ran on mount, which is
          // the promise the feature is built around. Every other panel in this app fetches
          // when it appears; if this one ever did, opening the health screen would be a
          // network request the user did not ask for, and it would show up here as a result
          // rendered by nobody.
          if (label === 'Vault health') {
            const breach: unknown = await window.webContents.executeJavaScript(
              `(() => {
                const panel = document.querySelector('.kh-breach');
                if (!panel) return 'missing';
                // Exactly one way forward, whichever state the two switches are in: the
                // button that starts a check, or the one that takes you to the switch that
                // is off. A panel with neither is a dead end wearing an explanation.
                const actions = panel.querySelectorAll('button').length;
                if (actions === 0) return 'no-way-in';
                if (panel.querySelector('.kh-breach__result')) return 'ran-on-its-own';
                // An error is the other shape a run on mount takes here: with the network
                // switch off, a sweep nobody asked for is refused rather than reported, so
                // the only trace it leaves on screen is this paragraph.
                if (panel.querySelector('.kh-breach__error')) return 'tried-on-its-own';
                return 'present-and-idle';
              })()`,
              true
            );
            emit(
              `SMOKE-CHECK breach-panel-reachable-and-idle ${String(breach === 'present-and-idle')}`
            );
          }

          await captureNamedShot(window, name, '.kh-shell__main .kh-tool__title');
        }

        // Escape closes it. Dispatched at the focused element, which after opening a tool is
        // its heading — the same place a real keystroke would land, and inside the container
        // that handles it. A Modal open inside a tool would take it first, which is the
        // behaviour we want and the reason this is not dispatched at the document.
        await window.webContents.executeJavaScript(
          `(document.activeElement ?? document.querySelector('.kh-tool__title'))?.dispatchEvent(
             new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
          true
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        const closed: unknown = await window.webContents.executeJavaScript(
          `document.querySelector('.kh-shell__main') === null`,
          true
        );
        emit(`SMOKE-CHECK tool-view-closes-on-escape ${String(closed === true)}`);

        await captureIfRequested(window);

        if (report.stage === 'bridge') {
          finish(
            false,
            'preload bridge missing (window.keyhold is not an object) — check that the preload is CommonJS; a sandboxed preload cannot be ESM'
          );
          return;
        }
        if (report.ok !== true) {
          // Name the checks that actually failed. A guard reporting "something went wrong"
          // costs as much time as no guard — the point of running twenty is knowing which
          // one broke.
          const steps = Array.isArray(report.steps) ? (report.steps as [string, boolean][]) : [];
          const failed = steps.filter(([, ok]) => !ok).map(([name]) => name);

          finish(
            false,
            failed.length > 0
              ? `failed checks: ${failed.join(', ')}`
              : `stage "${String(report.stage)}": ${JSON.stringify(report.detail ?? report.result)}`
          );
          return;
        }
        const detail =
          report.stage === 'cycle'
            ? `window, renderer, bridge, and ${String((report.steps as unknown[] | undefined)?.length ?? 0)} checks covering create -> lock -> unlock and full CRUD against a real vault file`
            : 'window created, renderer loaded, preload bridge present, IPC round-trip OK';
        finish(true, detail);
      })
      .catch((error: unknown) => {
        finish(false, `smoke probe threw: ${String(error)}`);
      });
  });
}
