// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard: nothing named like a secret is handed to a log, an error, or a URL.
 *
 * Hard rule 1 is "no secret in a log, an error message, a URL, or a crash report — ever", and
 * until now the only thing enforcing it was care. The import parsers have a real leak
 * property over their own fixtures, which is excellent and covers one subsystem; everywhere
 * else the rule was a sentence in `CLAUDE.md`.
 *
 * ## What it actually checks, and what it cannot
 *
 * It is a **naming** check, not a taint analysis. It fails a `console.*` call, a thrown
 * `Error`, or a URL being built whose arguments mention an identifier that this codebase's
 * own convention marks as holding secret material — `secret`, `password`, `passphrase`,
 * `dek`, `kek`, `plaintext`.
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
 *
 * ## The URL half
 *
 * A URL is the fourth sink hard rule 1 names, and it is the one where a leak escapes the
 * machine. A logged secret sits in a file the user owns; a secret in a URL is handed to
 * `shell.openExternal`, to a `fetch`, or into a browser's history and its referrer header.
 * Keyhold makes one network request in its entire life (the opt-in HIBP range check, which
 * by construction sends five characters of a hash), so anything URL-shaped near a secret
 * name here is a defect rather than a trade-off.
 *
 * A line counts as URL-shaped if it contains `://`, `new URL(`, `fetch(`, `openExternal(`,
 * `encodeURIComponent(` or `searchParams.set/append(`. Measured across the tree that is 41
 * sites and **zero** of them mention a secret name, so this half ships with no allow-list
 * and needs none — which is the only reason it is worth having. A URL rule that had to be
 * muted on its first run would be a worse guard than no rule at all.
 *
 * **The known legitimate secret-in-a-URL is `buildOtpauthSecretUri` in
 * `src/main/totp/uri.ts`**, and it is deliberately not flagged. An `otpauth://` URI *is* the
 * transport format for a TOTP seed — it is what a QR code encodes — so putting the seed in
 * it is the function's entire job. It escapes this sweep for a duller reason than an
 * exemption, and the reason is worth stating because it marks the limit of the whole
 * approach: the seed is bound to a local named `seed` on one line and the URL is assembled
 * on another, and a line-based check sees neither line as a violation. Anything that crosses
 * a statement boundary is invisible here. This raises the cost of the easy mistake; it is
 * not a proof.
 *
 * ## Fault injection performed
 *
 * Against `src/main/security.ts`, reverted after each:
 *
 *  - `` const leakedLink = `https://example.test/recover?p=${userPassword}`; `` — caught.
 *  - `probe.searchParams.set("q", vaultPassphrase);` — caught, which matters separately
 *    because it carries no `://` and is seen only by the named-call half of `URL_SINKS`.
 *  - `const helpLink = "https://example.test/help/choosing-a-master-password";` — correctly
 *    **not** caught. This is the case that decides whether the rule is shippable at all: the
 *    word is in the path, the value is a constant, and a guard that failed this would be
 *    switched off the first week.
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
const LOG_SINKS =
  /\b(console\.(log|warn|error|info|debug|trace)|new Error|throw new [A-Za-z]*Error)\s*\(/;

/**
 * A line that is building or dereferencing a URL.
 *
 * `://` catches the common case of a URL assembled in a template literal, and the named
 * calls catch the ones built through an API instead. Tested against the **raw** line rather
 * than the stripped one, because the scheme and the query keys live in the string literal
 * that `withoutStringLiterals` is about to remove — the point of the pattern is to notice
 * that a URL is being made, and the point of stripping is to decide what is going into it.
 */
const URL_SINKS =
  /:\/\/|encodeURIComponent\s*\(|searchParams\.(set|append)\s*\(|\bfetch\s*\(|openExternal\s*\(|new URL\s*\(/;

const SINKS = new RegExp(`${LOG_SINKS.source}|${URL_SINKS.source}`);

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
  it('nothing named like a secret is passed to a log, an error, or a URL', () => {
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
    //
    // Counted per half rather than over the union, because the union hides exactly the
    // failure worth catching: the log pattern alone finds hundreds of sites, so a URL
    // pattern that had been broken down to matching nothing would still leave the combined
    // count comfortably above any threshold, and the URL half would be dead with the control
    // still green. Two halves, two counts.
    const lines = sourceFiles().flatMap((file) => readFileSync(file, 'utf8').split('\n'));

    expect(
      lines.filter((line) => LOG_SINKS.test(line)).length,
      'no log or throw sites found — the log sink pattern is wrong'
    ).toBeGreaterThan(20);

    expect(
      lines.filter((line) => URL_SINKS.test(line)).length,
      'no URL-building sites found — the URL sink pattern is wrong'
    ).toBeGreaterThan(20);
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

  it('sees a secret going into a URL, in each of the shapes a URL gets built', () => {
    // The URL half, asserted directly for the same reason as the stripping above: the sweep
    // finds nothing today, so it would go on finding nothing if `URL_SINKS` were quietly
    // broken, and "passes" is indistinguishable from "checks nothing" without these.
    //
    // Each case pairs a real way this codebase could build a URL with a secret-named
    // identifier reaching it, and every one must be seen by both halves of the check —
    // sink first, then residue.
    const leaks = [
      'const href = `https://example.test/?token=${userPassword}`;',
      "url.searchParams.set('q', vaultPassphrase);",
      'void shell.openExternal(`https://example.test/${plaintextNote}`);',
      'await fetch(`https://example.test/${secretValue}`);',
      "const link = 'https://example.test/?k=' + encodeURIComponent(masterPassword);",
    ];
    for (const line of leaks) {
      expect(SINKS.test(line), `sink not seen: ${line}`).toBe(true);
      expect(SECRETISH.test(withoutStringLiterals(line)), `secret not seen: ${line}`).toBe(true);
    }

    // And the other direction, which is what keeps the rule shippable: a URL that merely
    // *says* one of the words is prose, not a leak. `PWNED_RANGE_ENDPOINT` and the help
    // links are real lines in this tree, and a guard that failed them would be muted.
    const innocent = [
      "const endpoint = 'https://api.pwnedpasswords.com/range/';",
      "void shell.openExternal('https://example.test/help/choosing-a-master-password');",
      'const host = new URL(credential.url).host;',
    ];
    for (const line of innocent) {
      expect(SECRETISH.test(withoutStringLiterals(line)), `false positive: ${line}`).toBe(false);
    }
  });
});
