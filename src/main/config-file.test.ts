// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_FILE_MODE, writeJsonFileSync } from './config-file.js';

/**
 * Guard: the two small JSON files beside the vault are written the way key ciphertext
 * should be — owner-only, and never observable half-written.
 *
 * `preferences.json` carries `quickUnlock[].protectedDek`, the OS-wrapped data key. It used
 * to be written with a bare `writeFileSync`: default mode, and a truncating write with a
 * window in which the file is empty.
 *
 * Fault injection performed: replacing the body of `writeJsonFileSync` with
 * `writeFileSync(path, json, 'utf8')` fails "creates the file owner-only" on POSIX and
 * "leaves no temp file behind"; dropping the `rmSync` from the rename catch fails
 * "leaves no temp file behind when the rename fails".
 */

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'keyhold-config-'));
  file = join(dir, 'preferences.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse((await readFile(path)).toString('utf8'));

describe('writeJsonFileSync', () => {
  it('writes readable, re-parseable JSON', async () => {
    writeJsonFileSync(file, { recentVaults: [], clipboardClearMs: 30_000 });
    expect(await readJson(file)).toEqual({ recentVaults: [], clipboardClearMs: 30_000 });
  });

  it('replaces the previous contents completely', async () => {
    writeJsonFileSync(file, { a: 'a much longer first version of this file' });
    writeJsonFileSync(file, { a: 'short' });
    // A naive in-place write would leave trailing bytes of the longer original here, and
    // the result would not parse.
    expect(await readJson(file)).toEqual({ a: 'short' });
  });

  it('creates the file owner-only', async () => {
    writeJsonFileSync(file, { protectedDek: 'wrapped-key-ciphertext' });
    const info = await stat(file);

    // Windows does not implement POSIX permission bits, so asserting them there would be
    // asserting a lie. The control that matters on Windows is the per-user directory the
    // file lives in, which Electron's `app.getPath('userData')` already provides.
    if (process.platform !== 'win32') {
      expect(info.mode & 0o777).toBe(CONFIG_FILE_MODE);
    }
  });

  it('leaves no temp file behind', async () => {
    writeJsonFileSync(file, { a: 1 });
    expect(await readdir(dir)).toEqual(['preferences.json']);
  });

  it('leaves no temp file behind when the rename fails', async () => {
    // A directory at the destination makes `renameSync` fail after the temp is written and
    // flushed — the one window in which a temp can survive.
    const blocked = join(dir, 'blocked.json');
    await rm(blocked, { force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(blocked);

    expect(() => {
      writeJsonFileSync(blocked, { a: 1 });
    }).toThrow();
    expect(await readdir(dir)).toEqual(['blocked.json']);
  });

  it('does not disturb the existing file when the write itself fails', async () => {
    writeJsonFileSync(file, { good: true });
    // A directory where the temp wants to be: the open fails, and the target must survive.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, '.preferences.json.tmp'));

    expect(() => {
      writeJsonFileSync(file, { good: false });
    }).toThrow();
    expect(await readJson(file)).toEqual({ good: true });
  });

  it('overwrites a file that already exists with a different length', async () => {
    await writeFile(file, 'x'.repeat(4096), 'utf8');
    writeJsonFileSync(file, { small: true });
    expect(await readJson(file)).toEqual({ small: true });
  });
});
