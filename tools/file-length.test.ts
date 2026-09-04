// SPDX-License-Identifier: GPL-3.0-or-later
import { globSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard: no file grows past the point where it stops being single-purpose.
 *
 * `CLAUDE.md` ends its conventions with "files stay short and single-purpose — split by
 * concern before a file becomes unpleasant to edit", and until now nothing measured it. A
 * sentence like that decays in exactly one direction: every individual addition to a long
 * file is small and reasonable, nobody is ever the person who made it long, and the file is
 * eventually 1,700 lines. This is the ratchet.
 *
 * ## What is counted, and why it is not `wc -l`
 *
 * **Code lines: non-blank, non-comment.** That choice was made from the measurement, not
 * from taste. The comment share of this repo's largest files runs from 21% to 58% —
 * `src/shared/model/import-plan.ts` is 774 physical lines of which 327 are code, and
 * `src/shared/ipc/api.ts` and `src/main/sync/vault-watcher.ts` are both almost exactly half
 * prose. Counting physical lines would have put eleven files on the list below whose only
 * fault is being thoroughly explained, and would have left a standing incentive to delete
 * the long headers that are the most useful thing in those files. A rule that pays for a
 * split by charging for documentation is the wrong rule.
 *
 * ## Where the ceiling came from
 *
 * Measured with the counter below over all 728 files it scans, at the time of writing:
 *
 * ```
 *   p50  106      over 400 code lines   36 files
 *   p75  196      over 500 code lines   16 files
 *   p90  310      over 600 code lines    8 files
 *   p95  399      over 700 code lines    5 files
 *   p97  473
 *   p99  664
 * ```
 *
 * **500** sits at roughly the 97.8th percentile: it is where this repo's own habit already
 * stops, so the guard ratchets the tail rather than demanding the codebase be reorganised.
 * It is also, independently, about the size at which a file stops fitting in a reader's head
 * — which is the thing the rule is actually about.
 *
 * The distribution is continuous, so no ceiling anywhere has comfortable headroom: four
 * files sit within fifteen code lines of 500 (`properties.test.ts` and `file-inspection.ts`
 * at 488, `onepassword-1pux.ts` at 486, `settings.css` at 485). They will trip this on their
 * next substantial edit. **That is the ratchet working, not a bug in it** — a file at 488
 * code lines is already one that wants splitting, and the moment someone is about to make it
 * bigger is exactly the moment to say so.
 *
 * Fault injection performed, three defects:
 *
 *  1. Appending twenty lines of `const padN = N;` to `src/main/recovery/file-inspection.ts`
 *     (488 code lines, one of the four sitting just under the ceiling) failed the sweep with
 *     `src/main/recovery/file-inspection.ts  508 code lines`.
 *  2. Appending **sixty** lines of `// padding comment N` to the same file — a bigger change
 *     by every measure `wc -l` knows about — did **not** fail it. That is the comment
 *     discount behaving as designed, and it is the half of this guard most likely to be
 *     silently broken by a future edit to `countCodeLines`, so it is worth having seen.
 *  3. Stubbing the allow-listed `src/main/sync/merge-record.ts` down to ten lines failed the
 *     anti-rot test: "is now 9 code lines and no longer needs its exemption — delete the
 *     entry". The first attempt at this file guessed at a target file's size instead of
 *     measuring it, and injection 1 passed against a 129-line file — which is exactly the
 *     "injection that fails nothing" this policy exists to catch.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** Code lines, not physical lines. See the header for why, and for where 500 came from. */
const CEILING = 500;

/**
 * Files entitled to be longer than the ceiling, with the reason.
 *
 * Two kinds of entry live here and they are labelled differently on purpose. Some files are
 * long because the thing they describe is long, and splitting them would make the codebase
 * worse — those say so. Others are long because nobody has split them yet — those say
 * **debt**, and say what the split would be. An allow-list that only ever contained
 * justifications would be a place for bad news to go and die.
 */
const ALLOWED: readonly { readonly path: string; readonly why: string }[] = [
  {
    path: 'src/main/generator/wordlist.ts',
    why: 'data, not code: the EFF large wordlist, 7,776 words, one per line. There is nothing to split — it is a single array whose length is itself asserted, because 7776 = 6^5 is what lets a passphrase state its entropy as a fact',
  },
  {
    path: 'src/main/ipc/register.ts',
    why: 'the one IPC registration table. Splitting it produces a second list of channels, and hard rule 8 ("no second list") outranks this one on the most dangerous list in the codebase — one channel, one validator, one handler, one place a reviewer has to look',
  },
  {
    path: 'src/main/vault/vault-service.ts',
    why: '**debt.** One class holding the open-vault state behind `#` private fields, which TypeScript will not share across files, so the concerns inside it (records, attachments, history, health) cannot be moved out as functions without restructuring into collaborating objects that pass the state explicitly. Real constraint, not a justification: this is the file most in need of that work',
  },
  {
    path: 'src/main/smoke.ts',
    why: 'a linear launch probe: a list of independent checks that must run in one real app launch, in order, in one process. Length tracks the number of features that have to be reachable, and each check is a few lines sitting next to the sequencing it depends on',
  },
  {
    path: 'src/renderer/src/vault/vault-screens.css',
    why: 'the three full-window screens (welcome, create, unlock) over one shared panel skeleton. Splitting per screen duplicates the skeleton; extracting the skeleton leaves three files none of which can be read on its own',
  },
  {
    path: 'src/renderer/src/sync/sync.css',
    why: 'the merge conflict resolver — one screen with a large number of states (per-side selection, four field kinds, warnings, the long-column layout rules), none of which is reusable anywhere else',
  },
  {
    path: 'src/renderer/src/import/import.css',
    why: 'the import wizard, whose steps (indicator, facts, choices, tables, folders, duplicate groups, warnings, undo) are one flow with shared type and spacing rules; the sections are already marked and none is used outside the wizard',
  },
  {
    path: 'src/shared/theme/keeptheme.ts',
    why: '**debt.** One file carrying four concerns of the `.keeptheme` format: colour normalisation, contrast evaluation, the escape-floor admission policy, and serialise/parse. The split that would help is lifting `evaluatePaletteContrast` / `evaluateEscapeFloor` / `admitPalette` into a policy module, leaving a reader and a writer behind',
  },
  {
    path: 'src/main/sync/merge-record.ts',
    why: 'the per-field merge rules for one record, which is one decision table: tombstone precedence, per-field resolution, and what counts as a genuine conflict. Splitting the table separates rules that only make sense read against each other',
  },
  {
    path: 'src/renderer/src/vault/CredentialEditor.tsx',
    why: '**debt.** One component function of roughly 470 lines. The convention is one component per file, which is why it has not been split, but the field rows (custom fields, URLs, tags, the per-field reveal) are extractable as their own components in this directory',
  },
  {
    path: 'src/main/import-service/import-service.test.ts',
    why: 'the import transaction end to end — preview/commit parity, the three duplicate answers, folder placeholders, undo and its refusal. Length is the count of properties defended, and each runs the real parser over a real fixture',
  },
  {
    path: 'src/main/health/rules.test.ts',
    why: "one describe per health rule's boundary conditions. Length is the rule count; splitting it would scatter a single registry's tests across files that each test one entry of it",
  },
  {
    path: 'src/main/sync/vault-watcher.test.ts',
    why: 'the watcher is almost entirely a negative specification — every way it could cry wolf gets a test, because a watcher that fires on our own save trains the user to dismiss the one that matters. Length is the count of false-positive sources',
  },
  {
    path: 'src/main/sync/merge-record.test.ts',
    why: 'the conflict matrix, both directions, with and without an ancestor. A partial matrix is not a matrix, so the case count is set by the rules being tested rather than by the file',
  },
  {
    path: 'src/main/import/onepassword-1pux.test.ts',
    why: 'builds its ZIP fixtures inline rather than committing binary blobs, deliberately, so that every byte of a `.1pux` — including the malformed one — is visible beside the assertion using it. The fixture construction is most of the file',
  },
  {
    path: 'src/main/organisation/folder-ops.test.ts',
    why: 'the tree invariants — no cycles, no orphans, no gaps in the ordering — tested hardest exactly where the wrong behaviour is invisible: a move that detaches a subtree, a delete that leaves records pointing nowhere',
  },
];

function files(): readonly string[] {
  return [
    ...globSync('src/**/*.{ts,tsx,css}', { cwd: ROOT }),
    ...globSync('tools/**/*.{ts,js,mjs}', { cwd: ROOT }),
  ]
    .map((match) => join(ROOT, match))
    .sort();
}

function asRepoPath(file: string): string {
  return relative(ROOT, file).split(sep).join('/');
}

/**
 * Non-blank, non-comment lines.
 *
 * A deliberately simple scanner, and the same one `/* … *\/` block syntax covers TypeScript
 * and CSS alike. It can be fooled — a `/*` inside a string literal opens a block it never
 * closes on the same line — but only ever into skipping lines it should have counted, never
 * into counting lines it should not. So it can miss a file that is genuinely too long; it
 * cannot fail a file that is fine. That is the safe direction for a build-breaking rule.
 */
function countCodeLines(text: string): number {
  let count = 0;
  let inBlock = false;

  for (const raw of text.split('\n')) {
    const line = raw.trim();

    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line === '' || line.startsWith('//')) continue;
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    count += 1;
  }

  return count;
}

describe('the file-length rule', () => {
  it('no file outside the allow-list exceeds the ceiling', () => {
    const allowed = new Set(ALLOWED.map((entry) => entry.path));
    const scanned = files();

    // The control. A broken glob would make this sweep pass forever while reading nothing,
    // which is the failure mode of every guard that measures a corpus it also selects.
    expect(scanned.length, 'no source files found — the glob is wrong').toBeGreaterThan(500);

    const overLong = scanned
      .map((file) => ({
        path: asRepoPath(file),
        lines: countCodeLines(readFileSync(file, 'utf8')),
      }))
      .filter((file) => !allowed.has(file.path) && file.lines > CEILING)
      .map((file) => `${file.path}  ${String(file.lines)} code lines`);

    expect(
      overLong,
      `over ${String(CEILING)} code lines: split by concern, or add an entry to ALLOWED with a reason`
    ).toEqual([]);
  });

  it('every allow-list entry still points at a file that exists and still exceeds the ceiling', () => {
    // Both halves matter, and the second is the one that is easy to leave out. An entry
    // whose file has since been split still *reads* like a justification, so the next person
    // to make that file long again inherits a standing exemption nobody granted them. The
    // allow-list has to shrink when the codebase improves, or it is not a list of exceptions,
    // it is a list of places the rule does not apply.
    const known = new Map(files().map((file) => [asRepoPath(file), file]));

    for (const entry of ALLOWED) {
      const file = known.get(entry.path);
      expect(file, `${entry.path} is on the allow-list but no longer exists`).toBeDefined();

      const lines = countCodeLines(readFileSync(file ?? '', 'utf8'));
      expect(
        lines,
        `${entry.path} is now ${String(lines)} code lines and no longer needs its exemption — delete the entry. Its stated reason was: ${entry.why}`
      ).toBeGreaterThan(CEILING);
    }
  });

  it('counts code lines rather than physical lines', () => {
    // Asserted directly rather than inferred from the sweep passing. A `countCodeLines` that
    // returned zero — an inverted condition, a block-comment state that never clears — would
    // make the sweep above pass forever while measuring nothing, and it would look exactly
    // like a working guard right up until a 2,000-line file landed.
    const sample = [
      'const a = 1;',
      '',
      '// a line comment',
      '/**',
      ' * a block comment',
      ' */',
      'const b = 2;',
      '/* single-line block */',
      'const c = 3;',
    ].join('\n');

    expect(countCodeLines(sample)).toBe(3);
    expect(countCodeLines('')).toBe(0);
  });
});
