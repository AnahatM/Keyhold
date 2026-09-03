// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, type BrowserWindow } from 'electron';
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
async function captureNamedShot(window: BrowserWindow, name: string): Promise<void> {
  const directory = process.env.KEYHOLD_SMOKE_SHOTS;
  if (directory === undefined || directory === '') return;

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
        await new Promise<void>((resolve) => setTimeout(resolve, 400));

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
        await captureNamedShot(window, 'Keyhold-Screenshot-01');

        // Open the record that has history, and expand its newest change — by clicking the
        // real controls rather than through a test-only hook on `window`. A backdoor would
        // be production code that exists for the harness, and it would not prove the list
        // row and the disclosure button work.
        await window.webContents.executeJavaScript(
          `(() => {
            const row = [...document.querySelectorAll('.kh-row')].find((element) =>
              element.textContent?.includes('GitHub')
            );
            row?.click();
            return row !== undefined;
          })()`,
          true
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        await captureNamedShot(window, 'Keyhold-Screenshot-02');

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
        emit(`SMOKE-CHECK palette-opens-on-its-shortcut ${String(paletteOpen === true)}`);
        await captureNamedShot(window, 'Keyhold-Screenshot-05');
        await window.webContents.executeJavaScript(
          `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
          true
        );
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
        await captureNamedShot(window, 'Keyhold-Screenshot-03');

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
        await captureNamedShot(window, 'Keyhold-Screenshot-04');

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
