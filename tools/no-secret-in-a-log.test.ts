// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard: nothing named like a secret is handed to a log or an error.
 *
 * Hard rule 1 is "no secret in a log, an error message, a URL, or a crash report — ever", and
 * until now the only thing enforcing it was care. The import parsers have a real leak
 * property over their own fixtures, which is excellent and covers one subsystem; everywhere
 * else the rule was a sentence in `CLAUDE.md`.
 *
 * ## What it actually checks, and what it cannot
 *
 * It is a **naming** check, not a taint analysis. It fails a `console.*` call or a thrown
 * `Error` whose arguments mention an identifier that this codebase's own convention marks as
 * holding secret material — `secret`, `password`, `passphrase`, `dek`, `kek`, `plaintext`.
 *
 * That convention is written down in `CLAUDE.md` ("anything holding secret material carries
 * `secret` / `Secret` / `SecretString` in its name, so a reviewer can see at a glance where
 * secrets flow"), and this guard is what makes it pay for itself: the naming rule exists so a
 * human can see the flow, and a machine can use exactly the same signal.
 *
 * **It cannot catch a secret in a variable that is not named like one.** A leak through
 * `const v = record.fields.password; console.log(v)` sails past. That is a real limit and the
 * reason to say it out loud rather than let this test imply a guarantee it does not give: it
 * raises the cost of the *easy* mistake, which is the common one, and it does not replace
 * reading the diff.
 *
 * ## String literals are stripped before matching, and that is the whole design
 *
 * The first version flagged five lines on its first run and every one was the *word* inside a
 * message — `'a parcel requires a passphrase'`, `'ref.kind is not a known secret kind'`. A
 * guard that needs five exemptions on the day it is written is too blunt to keep, and the
 * exemptions would have been the part that rotted.
 *
 * So quoted strings are removed from a line before it is tested. What is left is identifiers,
 * which is exactly what the naming convention marks. `console.log(secretPassphrase)` fails;
 * `throw new Error('needs a passphrase')` does not, because saying the word is not leaking
 * the value.
 *
 * ## Why `error.message` is allowed
 *
 * Logging a caught error is how this app reports failure, and its messages are written by
 * `toFailure` and the crypto layer, both of which are already careful. Banning the word
 * "error" near a console call would fail every legitimate handler in the codebase and be
 * turned off within a day.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/**
 * The words this codebase uses to mark secret material.
 *
 * Matched case-insensitively on an identifier boundary, so `secretPassphrase` and
 * `contentSecret` both hit and `secretariat` would not — not that it appears.
 */
const SECRET_WORDS = ['secret', 'password', 'passphrase', 'plaintext', '\\bdek\\b', '\\bkek\\b'];

/** A call that puts its arguments somewhere a human or a file will see them. */
const SINKS =
  /\b(console\.(log|warn|error|info|debug|trace)|new Error|throw new [A-Za-z]*Error)\s*\(/;

const SECRETISH = new RegExp(SECRET_WORDS.join('|'), 'i');

/**
 * A line with its quoted strings blanked out.
 *
 * Template literals keep their `${...}` holes, because that is where an identifier reaches a
 * message — `` `failed for ${secretPassphrase}` `` is a leak and must still be caught, while
 * the prose around it must not be.
 */
function withoutStringLiterals(line: string): string {
  return (
    line
      // A template keeps only what is inside its `${…}` holes and loses the prose around
      // them. Blanking the whole literal was the obvious first attempt and it was wrong in
      // the direction that matters: it removed the holes too, so an interpolated secret
      // became invisible to the sweep. The unit test below exists because that mistake looks
      // exactly like a working guard.
      .replace(/`([^`]*)`/g, (_whole, body: string) => {
        const holes = [...body.matchAll(/\$\{([^}]*)\}/g)].map((match) => match[1] ?? '');
        return `\`${holes.join(' ')}\``;
      })
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
  );
}

function sourceFiles(): readonly string[] {
  return globSync('src/**/*.{ts,tsx}', { cwd: ROOT })
    .map((match) => join(ROOT, match))
    .filter((path) => !path.includes('.test.'))
    .sort();
}

describe('the no-secret-in-a-log rule', () => {
  it('nothing named like a secret is passed to a log or an error', () => {
    const violations: string[] = [];

    for (const file of sourceFiles()) {
      const where = relative(ROOT, file).split(sep).join('/');

      for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
          continue;
        }
        if (!SINKS.test(line)) continue;
        if (!SECRETISH.test(withoutStringLiterals(line))) continue;

        violations.push(`${where}:${String(index + 1)}  ${trimmed.slice(0, 90)}`);
      }
    }

    expect(
      violations,
      'hard rule 1: a secret must never reach a log, an error message, a URL or a crash report'
    ).toEqual([]);
  });

  it('has something to catch, so the sweep cannot pass by finding nothing', () => {
    // The control. A regex that matched nothing at all — a renamed sink, a bad escape —
    // would make the test above pass forever while checking nothing, which is the failure
    // mode of every grep-based guard.
    const sinkCount = sourceFiles()
      .flatMap((file) => readFileSync(file, 'utf8').split('\n'))
      .filter((line) => SINKS.test(line)).length;

    expect(sinkCount, 'no log or throw sites found — the sink pattern is wrong').toBeGreaterThan(
      20
    );
  });

  it('strips a quoted word without stripping an interpolated one', () => {
    // The two halves of the design, asserted directly rather than inferred from the sweep
    // passing. A `withoutStringLiterals` that blanked everything — including the `${…}`
    // holes — would make the sweep pass forever while checking nothing, and that is a much
    // easier mistake to make than it looks.
    expect(SECRETISH.test(withoutStringLiterals("throw new Error('needs a passphrase')"))).toBe(
      false
    );
    expect(SECRETISH.test(withoutStringLiterals('console.log(secretPassphrase)'))).toBe(true);
    expect(
      SECRETISH.test(withoutStringLiterals('console.log(`failed for ${secretPassphrase}`)'))
    ).toBe(true);
  });
});
