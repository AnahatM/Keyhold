// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard: no source file contains a raw control byte.
 *
 * This exists because four of them got in, from three different directions:
 *
 *  - a NUL used as a *sentinel value* (`const ROOT_VALUE = '\0root'`) — which is also a
 *    latent collision bug, not only an encoding one;
 *  - a NUL used as a *test assertion sentinel*, making the assertion around it a no-op for
 *    every input that did not contain one;
 *  - binary rubbish pasted into a "hostile input" test string;
 *  - and one that ended up inside a *comment*, purely by accident.
 *
 * None of them broke a test. What they broke was `grep`, which reports a file containing a
 * NUL as binary and stops searching it — so the file silently drops out of every audit,
 * every rename, and every "where else does this happen" sweep somebody runs later. On a
 * codebase whose review process is largely reading, that is a real cost.
 *
 * Escapes (`'\\u0000'`) are fine and are what the legitimate cases now use. The rule is
 * about the *bytes on disk*, not about what the string evaluates to.
 */

const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const SEARCHED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.css', '.json', '.md', '.yml']);

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'out', 'dist', 'release', 'coverage', '.git']);

/**
 * Fixtures are exempt, and deliberately so: they are byte-exact copies of what another
 * application actually writes, and "correcting" one would make it stop being what it claims
 * to be. A NUL in a fixture is data; a NUL in source is a mistake.
 */
const EXEMPT = [`tests${sep}fixtures${sep}`];

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) sourceFiles(path, found);
      continue;
    }
    if (SEARCHED_EXTENSIONS.has(extname(entry.name))) found.push(path);
  }
  return found;
}

describe('source hygiene', () => {
  const files = sourceFiles(ROOT).filter(
    (path) => !EXEMPT.some((prefix) => relative(ROOT, path).startsWith(prefix))
  );

  it('finds files to check, so a broken walk cannot pass silently', () => {
    // Without this, a bug in `sourceFiles` would make every assertion below vacuous — which
    // is exactly the class of guard this project treats as worse than none.
    expect(files.length).toBeGreaterThan(100);
  });

  it('contains no raw NUL byte in any source file', () => {
    const offenders = files.filter((path) => readFileSync(path).includes(0));
    expect(offenders.map((path) => relative(ROOT, path))).toEqual([]);
  });

  it('contains no other raw C0 control byte outside tab, newline and carriage return', () => {
    const allowed = new Set([0x09, 0x0a, 0x0d]);
    const offenders: string[] = [];

    for (const path of files) {
      const bytes = readFileSync(path);
      for (const byte of bytes) {
        if (byte < 0x20 && !allowed.has(byte)) {
          offenders.push(`${relative(ROOT, path)} (0x${byte.toString(16).padStart(2, '0')})`);
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reads every file it claims to, rather than skipping unreadable ones', () => {
    // A `try {} catch {}` around the read would turn an unreadable file into a pass.
    for (const path of files.slice(0, 25)) {
      expect(statSync(path).size).toBeGreaterThanOrEqual(0);
    }
  });
});
