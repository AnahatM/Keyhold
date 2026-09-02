// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFile } from 'node:fs/promises';
import { app, type BrowserWindow } from 'electron';

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

export function isSmokeRun(): boolean {
  return process.env.KEYHOLD_SMOKE === '1';
}

/**
 * Captures the window to a PNG when `KEYHOLD_SMOKE_SHOT` names a path.
 *
 * Two uses, both real: verifying during development that the UI actually renders as
 * intended rather than merely compiling, and generating README screenshots reproducibly
 * in Phase 19 instead of by hand.
 */
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
        if (!reopened.ok) return { stage: 'cycle', ok: false, steps, detail: reopened.message };

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
        if (!made.ok) return { stage: 'cycle', ok: false, steps, detail: made.message };

        const id = made.value.id;

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

        await window.keyhold.vault.save();

        return { stage: 'cycle', ok: steps.every((s) => s[1] === true), steps };
      })()
    `;

    window.webContents
      .executeJavaScript(probe, true)
      .then(async (outcome: unknown) => {
        const report = outcome as {
          stage?: string;
          ok?: boolean;
          result?: unknown;
          steps?: unknown;
          detail?: unknown;
        };
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
