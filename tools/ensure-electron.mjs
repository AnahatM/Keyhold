// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * Fetch the Electron binary that `npm run dev` needs.
 *
 * Electron stopped shipping a `postinstall` hook. Its published `package.json` has no
 * `scripts` field at all any more, so `npm install` unpacks the JavaScript half of the
 * package — `index.js`, `cli.js`, the type definitions — and never downloads
 * `dist/electron.exe`. Nothing warns. The failure lands later, on the first
 * `npm run dev`, as a bare
 *
 *     Error: Electron uninstall
 *
 * thrown from inside electron-vite, which says nothing about what is actually missing
 * or how to get it.
 *
 * This is not a broken machine and it is not a bad clone: a fresh `git clone` plus
 * `npm install` reproduces it every time, on every platform. `npm run package` is
 * unaffected, because electron-builder downloads its own copy into a separate cache —
 * so the app can package perfectly while the dev server cannot start at all, which is
 * exactly the sort of split that sends you looking in the wrong place.
 *
 * So the repo fetches it explicitly, as a `postinstall` of its own. Running this is
 * what makes `git clone && npm install && npm run dev` sufficient on a machine that
 * has never seen the project.
 *
 * `electron/install.js` is safe to re-run: it exits early when `dist/version` already
 * matches, picks the right build for the host platform and arch, and reuses the shared
 * `~/.cache/electron` download, so the first run on a second machine is usually a cache
 * hit rather than a download.
 *
 * This does not weaken the zero-network rule (hard rule 5), which governs what the
 * shipped application does at runtime. This runs at install time, on a developer's
 * machine, and fetches the same way `npm install` itself just did.
 */

if (process.env.KEYHOLD_SKIP_ELECTRON_DOWNLOAD === '1') {
  console.log('KEYHOLD_SKIP_ELECTRON_DOWNLOAD=1 — skipping the Electron binary.');
  console.log('`npm run dev` will fail until you run `npm run ensure:electron`.');
  process.exit(0);
}

const require = createRequire(import.meta.url);

let installer;
try {
  installer = require.resolve('electron/install.js');
} catch {
  // Dependencies are not installed yet, or Electron is gone. Neither is this script's
  // problem to solve, and neither should fail an install.
  console.log('Electron is not installed here — nothing to fetch.');
  process.exit(0);
}

const result = spawnSync(process.execPath, [installer], { stdio: 'inherit' });

if (result.error || result.status !== 0) {
  console.error('');
  console.error('Could not fetch the Electron binary.');
  console.error('`npm run dev` needs it; `npm test` and `npm run lint` do not.');
  console.error('This is usually no network, a proxy, or a firewall.');
  console.error('Retry with `npm run ensure:electron` once you are online.');
  process.exit(result.status === null ? 1 : result.status);
}
