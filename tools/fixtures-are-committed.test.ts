// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard: every test fixture on this machine is a test fixture in the repository.
 *
 * The failure this exists for is invisible locally **by construction**, which is what makes it
 * worth a test of its own. A fixture that is present on disk and absent from git passes every
 * run on the machine that created it and fails on every clone — so the developer sees green,
 * CI sees red, and nothing in the working tree explains the difference.
 *
 * It happened: `.gitignore` refuses `*.csv` and re-included fixtures with
 * a negation of the `tests / star-star / fixtures / star.csv` shape — which requires a
 * `fixtures` directory whose *direct* child is the
 * file. The real layout is `tests/fixtures/<area>/<file>`, so the negation matched nothing and
 * ten import fixtures were never committed. Every import parser test passed here and failed on
 * the first CI run after the remote existed.
 *
 * The blanket ignore is right and stays: a bare `.csv` or `.keep` rule is how a real export or
 * vault gets committed by accident, and that is a far worse outcome than a broken build. What
 * this adds is the other half — noticing when the exception meant to permit the fixtures has
 * stopped permitting them.
 *
 * Shelling out to `git` rather than parsing `.gitignore`: the pattern language has enough
 * corners (directory precedence, negation order, `**` semantics) that a reimplementation would
 * be the second list, and it is git's answer that decides what a clone gets. The check skips
 * where git cannot answer — an unpacked tarball, a sandbox without the binary — because a guard
 * that fails for want of a tool teaches people to ignore it.
 *
 * Fault injection performed: restoring the old star-star negation pattern fails this test
 * naming all ten CSV fixtures; deleting the negations entirely fails it naming every fixture.
 */

const ROOT = resolve(import.meta.dirname, '..');
const FIXTURE_ROOT = join(ROOT, 'tests', 'fixtures');

function filesUnder(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(path);
    }
  };
  walk(directory);
  return found;
}

const asRepoPath = (absolute: string): string =>
  absolute.slice(ROOT.length + 1).split(sep).join('/');

/** What git believes is in the repository under the fixture tree, or `null` if it cannot say. */
function trackedFixtures(): ReadonlySet<string> | null {
  try {
    const output = execFileSync('git', ['ls-files', '--', 'tests/fixtures'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set(output.split('\n').filter((line) => line !== ''));
  } catch {
    return null;
  }
}

describe('test fixtures', () => {
  const tracked = trackedFixtures();
  const onDisk = filesUnder(FIXTURE_ROOT).map(asRepoPath);

  it('there are fixtures to check, so the sweep cannot pass vacuously', () => {
    expect(onDisk.length).toBeGreaterThan(5);
  });

  it.runIf(tracked !== null)('are all committed, or CI runs against files it does not have', () => {
    const missing = onDisk.filter((path) => !tracked?.has(path)).sort();

    expect(
      missing,
      'These exist here and not in the repository, so every test that reads one passes ' +
        'locally and fails on a clone. Check the negation patterns in .gitignore — and ' +
        'check the file really is synthetic before committing it.'
    ).toEqual([]);
  });
});
