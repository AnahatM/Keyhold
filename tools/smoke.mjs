// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/**
 * Launch smoke test: starts the real built app under KEYHOLD_SMOKE=1 and waits for it
 * to report whether the preload bridge came up.
 *
 * Run this after `npm run build`. It is the only check that exercises the actual
 * Electron runtime — the whole reason it exists is that a sandboxed-ESM-preload defect
 * builds cleanly, launches cleanly, and silently leaves `window.keyhold` undefined.
 * See src/main/smoke.ts.
 */

const require = createRequire(import.meta.url);
const HARD_TIMEOUT_MS = 60_000;

if (!existsSync(resolve('out/main/index.js'))) {
  console.error('No build found at out/main/index.js. Run `npm run build` first.');
  process.exit(1);
}

const electronBinary = require('electron');

// `--shot <path>` captures the rendered window to a PNG.
const shotIndex = process.argv.indexOf('--shot');
const shotPath = shotIndex === -1 ? undefined : process.argv[shotIndex + 1];

// `--vault <path>` runs the full create -> lock -> unlock cycle against a real file.
const vaultIndex = process.argv.indexOf('--vault');
const vaultPath = vaultIndex === -1 ? undefined : process.argv[vaultIndex + 1];

const child = spawn(electronBinary, ['.'], {
  env: {
    ...process.env,
    KEYHOLD_SMOKE: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    ...(shotPath === undefined ? {} : { KEYHOLD_SMOKE_SHOT: shotPath }),
    ...(vaultPath === undefined ? {} : { KEYHOLD_SMOKE_VAULT: vaultPath }),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
const capture = (chunk) => {
  const text = String(chunk);
  output += text;
  process.stdout.write(text);
};
child.stdout.on('data', capture);
child.stderr.on('data', capture);

const killTimer = setTimeout(() => {
  console.error('\nSmoke test exceeded the hard timeout; killing the process.');
  child.kill('SIGKILL');
  process.exit(1);
}, HARD_TIMEOUT_MS);

child.on('exit', (code) => {
  clearTimeout(killTimer);

  if (output.includes('SMOKE-PASS')) {
    console.log('\nSmoke test passed.');
    process.exit(0);
  }

  console.error(`\nSmoke test failed (exit code ${code}). Expected a SMOKE-PASS marker on stdout.`);
  process.exit(1);
});
