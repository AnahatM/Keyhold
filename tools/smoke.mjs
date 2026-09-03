// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

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

/**
 * `--vault <path>` runs the full create -> lock -> unlock cycle against a real file.
 *
 * **Defaulted, not optional**, and that is the fix for a real hole. The cycle is the only
 * check that exercises the whole stack the way a user does -- renderer, preload, IPC,
 * session, Argon2 worker, container, disk, and back -- and it ran only when someone
 * remembered the flag. `npm run test:smoke`, the command `CLAUDE.md` tells every
 * contributor to run before claiming anything is done, was therefore probing a single
 * `vault.summary()` call and printing "Smoke test passed."
 *
 * A check that has to be asked for is a check that stops being run. The full cycle is now
 * what happens by default, into a fresh file under the OS temp directory that is deleted
 * before and after -- and `--no-vault` is the opt-out, for the one case that wants only the
 * bridge probe.
 *
 * The temp path, deliberately: never inside the repo. A `.keep` written into the working
 * tree is exactly the artefact the project rule about `tests/**\/fixtures` exists to keep
 * findable, and a smoke run that leaves one behind is one `git add -A` away from committing
 * a vault file.
 */
const vaultIndex = process.argv.indexOf('--vault');

/**
 * The temp vault lives inside a folder called `Dropbox`.
 *
 * Not decoration: a vault in a synced folder is the arrangement Keyhold's whole multi-device
 * story rests on, and the app shows a notice explaining what it means. Running against a path
 * no provider matches would leave that notice unexercised, and a notice nothing renders looks
 * exactly like a notice that correctly decided not to appear.
 *
 * Nothing else in the run depends on the name, and the negative case — an ordinary path
 * detecting nothing — is covered by the unit tests in `shared/model/cloud-folder.test.ts`,
 * where every provider can be checked on every platform.
 */
const smokeRoot = process.argv.includes('--no-vault')
  ? undefined
  : mkdtempSync(join(tmpdir(), 'keyhold-smoke-'));

const vaultPath =
  smokeRoot === undefined
    ? undefined
    : vaultIndex === -1
      ? join(smokeRoot, 'Dropbox', 'smoke.keep')
      : process.argv[vaultIndex + 1];

if (smokeRoot !== undefined && vaultIndex === -1) {
  mkdirSync(join(smokeRoot, 'Dropbox'), { recursive: true });
}

/**
 * A throwaway profile, so the run starts where a new user starts.
 *
 * Without this the run inherits whatever this machine's Keyhold profile happens to hold —
 * onboarding already seen, preferences already set, a recent-vaults list already populated —
 * and none of that is true on a CI runner or on anybody's first launch. That divergence hid a
 * real failure for several rounds: the first-run setup flow covered the whole window on every
 * runner and never once appeared here, so the checks that look inside the vault screen failed
 * there and passed here for a reason no output mentioned.
 *
 * Fresh every run, and removed with the vault afterwards. It also means the run genuinely
 * exercises first launch, which is the state most users see exactly once and the one least
 * likely to be tried by hand.
 */
const profileDir = mkdtempSync(join(tmpdir(), 'keyhold-smoke-profile-'));

const child = spawn(electronBinary, ['.', `--user-data-dir=${profileDir}`], {
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

/** The temp vault and its directory, gone. Nothing in a smoke run is worth keeping. */
function removeTempVault() {
  // The whole root, not the vault's own parent: the vault now sits one level down inside a
  // `Dropbox` folder, and removing only that would leave the root behind on every run.
  rmSync(profileDir, { recursive: true, force: true });
  if (vaultIndex !== -1 || smokeRoot === undefined) return;
  rmSync(smokeRoot, { recursive: true, force: true });
}

child.on('exit', (code) => {
  clearTimeout(killTimer);
  removeTempVault();

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
    // Two numbers, because there are two kinds of check and conflating them was how the
    // first version of this line came to say "1 check" under a SMOKE-PASS announcing 58.
    // The probe's steps are counted inside the app and reported in the pass detail above;
    // the SMOKE-CHECK lines are the ones this runner can independently verify.
    const verified = [...output.matchAll(/^SMOKE-CHECK /gm)].length;
    console.log(`\nSmoke test passed (${verified} verified here, plus the checks named above).`);
    process.exit(0);
  }

  console.error(`\nSmoke test failed (exit code ${code}). Expected a SMOKE-PASS marker on stdout.`);
  process.exit(1);
});
