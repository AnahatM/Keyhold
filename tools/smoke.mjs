// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

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

/**
 * Refuse to run against a stale build.
 *
 * This check exists because of a real mistake: a fault injection was made, `npm run build`
 * failed its typecheck, and the smoke test ran happily against the PREVIOUS build and
 * reported a pass. A smoke test that silently tests code you are not looking at is worse
 * than no smoke test, because it produces confident wrong answers.
 */
function newestMtime(directory) {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

const sourceTouched = Math.max(
  newestMtime(resolve('src')),
  statSync(resolve('package.json')).mtimeMs
);
const buildTouched = newestMtime(resolve('out'));
if (sourceTouched > buildTouched) {
  console.error(
    'The build in out/ is older than src/. Run `npm run build` — a smoke test against a stale build proves nothing.'
  );
  process.exit(1);
}

const electronBinary = require('electron');

// `--shots <dir>` captures the named README views; `--shot <path>` captures one frame at
// the end of the run.
const shotsIndex = process.argv.indexOf('--shots');
const shotsDir = shotsIndex === -1 ? undefined : process.argv[shotsIndex + 1];

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
    ...(shotsDir === undefined ? {} : { KEYHOLD_SMOKE_SHOTS: shotsDir }),
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

  // Every `SMOKE-CHECK <name> <boolean>` the app emits is an assertion, and a run that
  // printed one saying `false` did not pass however cheerfully it ended.
  //
  // This was found the hard way: `palette-opens-on-its-shortcut false` was on stdout, in
  // plain sight, on a run that reported "Smoke test passed." Nothing read the value. A
  // check nobody reads is not a check -- it is a line of output that makes a broken feature
  // look tested, which is worse than not testing it, because it stops anyone looking.
  const failed = [...output.matchAll(/^SMOKE-CHECK (\S+) (\S+)$/gm)].filter(
    ([, , value]) => value !== 'true'
  );

  if (failed.length > 0) {
    console.error(`\nSmoke test failed. ${failed.length} check(s) did not pass:`);
    for (const [, name, value] of failed) console.error(`  ${name} -> ${value}`);
    process.exit(1);
  }

  if (output.includes('SMOKE-PASS')) {
    const total = [...output.matchAll(/^SMOKE-CHECK /gm)].length;
    console.log(`\nSmoke test passed (${total} check(s)).`);
    process.exit(0);
  }

  console.error(`\nSmoke test failed (exit code ${code}). Expected a SMOKE-PASS marker on stdout.`);
  process.exit(1);
});
