// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard: the Argon2 worker is in `asarUnpack`, and its path still matches the code that
 * launches it.
 *
 * ## The failure this exists to catch, which nothing else could
 *
 * `src/main/crypto/kdf-runner.ts` starts the Argon2 worker from a **runtime path** —
 * `new Worker(join(import.meta.dirname, 'kdf-worker.js'))` — not from an import. Inside an
 * asar archive that only works because electron-builder marked the file `unpacked`, which
 * makes Electron's loader redirect the path to `app.asar.unpacked/`. Drop the `asarUnpack`
 * entry, or rename the worker, and the archive is still valid, the app still builds, still
 * launches, and still shows the unlock screen — and can never derive a key.
 *
 * **`npm run build`, `npm test` and `npm run test:smoke` would all stay green**, because none
 * of them runs against an asar. The first sign would be a user saying their password does not
 * work. That is the whole reason this file is worth its twenty lines: it is the only check in
 * the repository that looks at the two halves of this arrangement together.
 *
 * It is a **structural** check, not proof. Only launching a packaged build proves the path
 * resolves — that is `MANUAL-BACKLOG.md` M-PKG, and this does not replace it. What it does is
 * make the regression impossible to introduce silently between now and then.
 *
 * Fault injections performed: the `asarUnpack` list emptied — "the worker is unpacked" failed.
 * The worker renamed in `kdf-runner.ts` without touching the config — "the config names the
 * file the code actually launches" failed, which is the half a config-only test would miss.
 */

const ROOT = resolve(import.meta.dirname, '..');

const read = (file: string): string => readFileSync(resolve(ROOT, file), 'utf8');

/**
 * The `asarUnpack` entries, read out of the YAML by hand.
 *
 * No YAML parser, deliberately: this is a flat list of strings under one key, the file is
 * ours, and adding a dependency to read four lines of our own configuration would be a poor
 * trade in a project whose pitch is that it ships almost nothing.
 */
function asarUnpackEntries(): string[] {
  const yaml = read('electron-builder.yml');
  const section = /^asarUnpack:\n((?:\s+-\s+.+\n)+)/m.exec(yaml);
  if (section === null) return [];
  return [...(section[1] ?? '').matchAll(/^\s+-\s+(.+?)\s*$/gm)].map((match) => match[1] ?? '');
}

describe('the Argon2 worker survives being packed into an asar', () => {
  it('is listed in asarUnpack', () => {
    expect(
      asarUnpackEntries(),
      'without this the packaged app launches and can never derive a key'
    ).toContain('out/main/kdf-worker.js');
  });

  it('the config names the file the code actually launches', () => {
    // The half that matters and that a config-only test cannot see. `kdf-runner.ts` builds
    // the path at runtime from a bare filename, so renaming the worker breaks the mapping
    // while leaving both files individually correct.
    const runner = read('src/main/crypto/kdf-runner.ts');
    const launched = /join\(import\.meta\.dirname,\s*'([^']+)'\)/.exec(runner);

    expect(launched, 'kdf-runner.ts no longer builds the worker path this way').not.toBeNull();

    const filename = launched?.[1] ?? '';
    expect(
      asarUnpackEntries().some((entry) => entry.endsWith(`/${filename}`)),
      `kdf-runner.ts launches "${filename}", which asarUnpack does not cover`
    ).toBe(true);
  });

  it('the worker is built to the path the config names', () => {
    // electron-vite writes `out/main/`, and the entry is relative to the project root. A
    // build-output move would leave the entry pointing at nothing, silently.
    const entry = asarUnpackEntries().find((candidate) => candidate.includes('kdf-worker'));
    expect(entry).toMatch(/^out\/main\//);
  });
});
