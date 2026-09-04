// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MIRROR_SETTINGS,
  mirrorDestinationProblem,
  mirrorNameFor,
  mirrorVault,
} from './mirror-backup.js';

/**
 * The off-machine copy.
 *
 * Two properties carry the weight here, and neither of them is the happy path.
 *
 *  - **No message this module produces may contain a path.** The destination is a network
 *    share or an external drive; its path names a server and very often a person. That
 *    string is rendered on the settings screen and written into the session activity log,
 *    which puts it one screenshot away from being public. Node puts the full path into every
 *    filesystem error it raises, so the only thing standing between those two facts is
 *    `describe()` in the module under test — and until this file existed nothing asserted it.
 *  - **A failed copy never destroys the last good one.** The write goes to a temp name and is
 *    renamed over the previous copy, so an unplugged drive leaves the previous mirror where
 *    it was rather than a truncated file where the user's only spare copy used to be.
 *
 * Every failure below is driven for real — a missing file, a folder where a file belongs —
 * rather than by mocking `fs`. A mocked error object carries whatever `code` the test felt
 * like giving it, which would prove nothing about the strings Node actually produces.
 *
 * ## Fault injection performed, two defects
 *
 *  1. `describe()`'s `ENOENT` branch returning `error.message` instead of its sentence —
 *     failed with the raw Node message, temp path and all, on the missing-vault case.
 *  2. Its final fallthrough doing the same — failed on the destination-under-a-file case.
 *
 * Both are the change somebody makes while debugging and forgets to take back out.
 */

let dir: string;
let vaultPath: string;
let destination: string;

/** Any separator at all. The point is that no message is ever built out of a path. */
const PATH_SHAPED = /[\\/]/;

/**
 * An instant, and the step between copies.
 *
 * `mirrorNameFor` stamps to the minute deliberately, so saves within one minute collapse onto
 * a single file. Tests that want distinct copies have to step by whole minutes.
 */
const AT = Date.UTC(2026, 0, 2, 3, 4);
const MINUTE = 60_000;

const listMirrors = async (): Promise<string[]> => (await readdir(destination)).sort();

const nameAt = (minutes: number): string => mirrorNameFor(vaultPath, AT + minutes * MINUTE);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'keyhold-mirror-'));
  vaultPath = join(dir, 'personal.keep');
  destination = join(dir, 'elsewhere');
  await writeFile(vaultPath, 'sealed-container-bytes');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the name a copy takes', () => {
  it('stamps the local date and minute onto the vault filename', () => {
    expect(mirrorNameFor('/anywhere/personal.keep', AT)).toMatch(
      /^personal\.keep\.\d{8}-\d{4}\.mirror$/
    );
  });

  it('gives two saves in the same minute one name, so the second replaces the first', () => {
    // Intentional: a mirror is the newest copy, not an audit trail. Asserted because the
    // alternative — a unique name per save — fills a network share without bound.
    expect(mirrorNameFor(vaultPath, AT)).toBe(mirrorNameFor(vaultPath, AT + 59_000));
    expect(mirrorNameFor(vaultPath, AT)).not.toBe(mirrorNameFor(vaultPath, AT + MINUTE));
  });

  it('sorts lexically in chronological order, which is what makes the prune correct', () => {
    // `prune` sorts by name rather than reading mtimes off a network share. That shortcut is
    // only correct while this holds, and it silently stops holding if the stamp is reordered.
    const names = [0, 1, 60, 24 * 60, 400 * 24 * 60].map(nameAt);
    expect([...names].sort()).toEqual(names);
  });
});

describe('writing the copy', () => {
  it('is off unless a folder was chosen', async () => {
    expect(DEFAULT_MIRROR_SETTINGS.directory).toBeNull();

    for (const directory of [null, '']) {
      const result = await mirrorVault({ vaultPath, settings: { directory, keep: 3 }, at: AT });
      expect(result.status).toBe('disabled');
      expect(result.fileName).toBeNull();
      expect(result.problem).toBeNull();
    }
  });

  it('creates the folder and copies the bytes verbatim', async () => {
    const result = await mirrorVault({
      vaultPath,
      settings: { directory: destination, keep: 3 },
      at: AT,
    });

    expect(result.status).toBe('written');
    expect(result.fileName).toBe(nameAt(0));
    expect(await readFile(join(destination, result.fileName ?? ''), 'utf8')).toBe(
      'sealed-container-bytes'
    );
  });

  it('reports a basename and never a path, even on success', async () => {
    const result = await mirrorVault({
      vaultPath,
      settings: { directory: destination, keep: 3 },
      at: AT,
    });

    // The name is shown beside a destination the user chose themselves; the *path* is the
    // part that must not travel with it into the activity log.
    expect(result.fileName).not.toMatch(PATH_SHAPED);
  });

  it('leaves no temp file behind', async () => {
    await mirrorVault({ vaultPath, settings: { directory: destination, keep: 3 }, at: AT });
    expect((await listMirrors()).some((name) => name.endsWith('.mirrortmp'))).toBe(false);
  });

  it('overwrites a stale temp left by an interrupted earlier run', async () => {
    await mkdir(destination, { recursive: true });
    await writeFile(
      `${join(destination, nameAt(0))}.mirrortmp`,
      'half a file from a drive that was pulled out'
    );

    const result = await mirrorVault({
      vaultPath,
      settings: { directory: destination, keep: 3 },
      at: AT,
    });

    expect(result.status).toBe('written');
    expect(await listMirrors()).toEqual([nameAt(0)]);
  });
});

describe('refusing a destination that protects nothing', () => {
  it('refuses the folder the vault is already in', async () => {
    const result = await mirrorVault({ vaultPath, settings: { directory: dir, keep: 3 }, at: AT });

    expect(result.status).toBe('failed');
    expect(result.fileName).toBeNull();
    expect(result.problem).toBe('the copy is set to the folder the vault is already in');
  });

  it('writes nothing at all when it refuses', async () => {
    const before = (await readdir(dir)).sort();
    await mirrorVault({ vaultPath, settings: { directory: dir, keep: 3 }, at: AT });
    expect((await readdir(dir)).sort()).toEqual(before);
  });
});

describe('failures carry no path', () => {
  /** Every way this can fail, each one produced by really doing it. */
  const failures: readonly { readonly when: string; readonly run: () => Promise<string> }[] = [
    {
      when: 'the destination is under a file rather than a folder',
      run: async () => {
        const blocker = join(dir, 'not-a-folder');
        await writeFile(blocker, 'x');
        return problemFrom(join(blocker, 'inside'));
      },
    },
    {
      when: 'the vault itself has gone',
      run: async () => {
        await rm(vaultPath);
        return problemFrom(destination);
      },
    },
    {
      when: 'the vault path is a folder, so there is nothing to copy',
      run: async () => {
        await rm(vaultPath);
        await mkdir(vaultPath);
        return problemFrom(destination);
      },
    },
    {
      when: 'the destination is the vault folder',
      run: async () => problemFrom(dir),
    },
  ];

  const problemFrom = async (directory: string): Promise<string> => {
    const result = await mirrorVault({ vaultPath, settings: { directory, keep: 3 }, at: AT });
    expect(result.status).toBe('failed');
    expect(result.fileName).toBeNull();
    return result.problem ?? '';
  };

  for (const failure of failures) {
    it(`says something a user can act on when ${failure.when}`, async () => {
      const problem = await failure.run();

      expect(problem.length).toBeGreaterThan(0);
      expect(problem).not.toMatch(PATH_SHAPED);
      expect(problem).not.toContain(dir);
      expect(problem).not.toContain('personal.keep');
      // Node's errors are code-shaped. None of them may reach a screen intact.
      expect(problem).not.toMatch(/E[A-Z]{3,}/);
    });
  }

  it('leaves no temp file behind after a failure', async () => {
    await rm(vaultPath);
    await mirrorVault({ vaultPath, settings: { directory: destination, keep: 3 }, at: AT });
    expect(await listMirrors()).toEqual([]);
  });

  it('leaves the previous good copy exactly where it was', async () => {
    const good = await mirrorVault({
      vaultPath,
      settings: { directory: destination, keep: 3 },
      at: AT,
    });
    await rm(vaultPath);
    await mirrorVault({
      vaultPath,
      settings: { directory: destination, keep: 3 },
      at: AT + MINUTE,
    });

    expect(await listMirrors()).toEqual([good.fileName]);
    expect(await readFile(join(destination, good.fileName ?? ''), 'utf8')).toBe(
      'sealed-container-bytes'
    );
  });
});

describe('pruning', () => {
  const write = async (minutes: number, keep: number): Promise<void> => {
    await mirrorVault({
      vaultPath,
      settings: { directory: destination, keep },
      at: AT + minutes * MINUTE,
    });
  };

  it('keeps the newest `keep` copies and drops the rest', async () => {
    for (const minute of [0, 1, 2, 3, 4]) await write(minute, 3);
    expect(await listMirrors()).toEqual([2, 3, 4].map(nameAt));
  });

  it('keeps only the newest when told to keep one', async () => {
    for (const minute of [0, 1, 2]) await write(minute, 1);
    expect(await listMirrors()).toEqual([nameAt(2)]);
  });

  it('prunes nothing when `keep` is zero, rather than emptying the folder', async () => {
    // The dangerous reading of `keep: 0` is "keep none", which would delete the copy that was
    // just written — a backup feature whose one job is destroying the backup.
    for (const minute of [0, 1]) await write(minute, 0);
    expect(await listMirrors()).toHaveLength(2);
  });

  it('never touches another vault’s copies, or anything that is not a mirror', async () => {
    await mkdir(destination, { recursive: true });
    const bystanders = ['work.keep.20260102-0304.mirror', 'holiday-photo.jpg', 'personal.keep'];
    for (const name of bystanders) await writeFile(join(destination, name), 'not ours to delete');

    for (const minute of [0, 1, 2]) await write(minute, 1);

    for (const name of bystanders) {
      expect(await readFile(join(destination, name), 'utf8')).toBe('not ours to delete');
    }
  });
});

describe('checking a destination before it is saved', () => {
  it('accepts a folder that exists', async () => {
    await mkdir(destination, { recursive: true });
    expect(await mirrorDestinationProblem(destination)).toBeNull();
  });

  it('names the two failures without naming the path', async () => {
    const missing = await mirrorDestinationProblem(join(dir, 'never-existed'));
    const file = await mirrorDestinationProblem(vaultPath);

    expect(missing).not.toBeNull();
    expect(file).not.toBeNull();
    for (const problem of [missing ?? '', file ?? '']) {
      expect(problem).not.toMatch(PATH_SHAPED);
      expect(problem).not.toContain(dir);
    }
  });
});
