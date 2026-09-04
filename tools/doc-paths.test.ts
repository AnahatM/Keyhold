// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard: a repo path cited in the documentation is a repo path that exists.
 *
 * The cheapest kind of documentation rot and the most misleading, because a path reads as
 * verified in a way prose does not. A sentence that is out of date is obviously somebody's
 * opinion from a while ago; `src/main/menu.ts` looks like a fact, and a reader who cannot find
 * it concludes they are lost rather than that the doc is.
 *
 * It has already happened here more than once. The roadmap named `docs/10-Sync-And-Transfer/`
 * for a folder that landed at `07-`; `docs/_INDEX.md` pointed at a `13-Appendix/` that was never
 * created; and deleting `tools/limit-parity.test.ts` in the same pass that made it pointless
 * left three documents describing it in the present tense.
 *
 * **Absence is sometimes the point**, which is why this has an allow-list rather than a rule.
 * An audit finding whose whole subject is "this document points at a path that does not exist"
 * has to be able to write that path down. So does a fix note that says the path it originally
 * proposed was the wrong one. Every entry below carries the reason it is exempt, and an entry
 * that stops being true fails the vacuity check underneath.
 *
 * `docs/superpowers/` is excluded entirely: it is frozen history, and a spec that named a file
 * later renamed is a record of what was true when it was written, not a defect.
 *
 * Fault injection performed: changing `docs/07-Sync-And-Merge/01-The-Merge-Flow.md`'s reference
 * to `src/renderer/src/sync/MergeFlow.tsx` to `src/renderer/src/sync/MergeFlowX.tsx` fails this
 * test naming that file and that document; removing an allow-list entry whose path is genuinely
 * absent fails it too, which is what keeps the list honest.
 */

const ROOT = resolve(import.meta.dirname, '..');

/** Prefixes that make a backticked string a claim about this repository. */
const REPO_ROOTS = ['src/', 'docs/', 'tools/', 'tests/', 'build/', 'resources/'];

/** Root-level files worth checking by name, since they carry no directory prefix. */
const ROOT_FILES = new Set([
  'CLAUDE.md',
  'MANUAL-BACKLOG.md',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'package.json',
  'electron-builder.yml',
  'electron.vite.config.ts',
]);

/**
 * Paths the documentation names on purpose despite their absence.
 *
 * Keep the reason with the entry. A bare list of exemptions becomes a list of things nobody
 * remembers deciding, and then the guard is a formality.
 */
const DELIBERATELY_ABSENT: Readonly<Record<string, string>> = {
  'docs/10-Sync-And-Transfer/':
    'The number the sync docs were originally planned under. The roadmap names it to explain ' +
    'why they are at 07- instead.',
  'docs/13-Appendix/':
    'Reserved for the audit findings and never created, because 13-Packaging had taken the ' +
    'number. docs/_INDEX.md and 13-Packaging/_INDEX.md both name it to say so and to tell the ' +
    'next reader to repoint rather than create it.',
  'docs/13-Appendix/03-Doc-Audit-Findings.md':
    'The specific page that was planned under that folder. Named by finding F10, whose subject ' +
    'is precisely that it does not exist.',
  'src/main/breach/index.ts':
    'A barrel the subsystem audit notes is absent, as part of describing how the module is ' +
    'reached instead.',
  'src/main/menu.ts':
    'Split into src/main/shell/menu-*.ts. Finding F13 names the old path to record that a ' +
    'document describing it as current is wrong.',
  'src/shared/crypto/':
    'Never existed; crypto is main-only. Finding F9 exists to say that two documents pointed ' +
    'at it.',
  'tools/limit-parity.test.ts':
    'Deleted along with the duplication it guarded. Findings S13 and S14 name it to record ' +
    'what was removed and why.',
  'tools/no-network.test.ts':
    'The path a fix note originally proposed. The scan was widened in place instead and lives ' +
    'at src/main/breach/no-network.test.ts; the finding names both to say so.',
};

function markdownFilesUnder(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      // Frozen history: a spec naming a file that was later renamed is a record, not a defect.
      if (entry.isDirectory()) {
        if (entry.name !== 'superpowers') walk(join(current, entry.name));
      } else if (entry.name.endsWith('.md')) {
        found.push(join(current, entry.name));
      }
    }
  };
  walk(directory);
  return found;
}

/**
 * Whether a backticked string is claiming to be a path in this repository.
 *
 * Conservative on purpose. Most backticks hold a symbol — `mergeDocuments`, `VaultSettings` —
 * and a guard that guessed would spend its life being wrong about identifiers. Anything with
 * whitespace, punctuation that does not belong in a path, or a glob is left alone; a glob in
 * particular is a pattern rather than a claim that one file exists.
 */
function looksLikeRepoPath(text: string): boolean {
  if (text === '' || /[\s()[\]{}<>,;:!?"']/.test(text)) return false;
  if (text.includes('*')) return false;
  if (REPO_ROOTS.some((root) => text.startsWith(root))) return true;
  return ROOT_FILES.has(text);
}

interface Citation {
  readonly path: string;
  readonly document: string;
  readonly line: number;
}

function citationsIn(file: string): Citation[] {
  const relative = file
    .slice(ROOT.length + 1)
    .split(sep)
    .join('/');
  const found: Citation[] = [];

  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      for (const match of line.matchAll(/`([^`\n]+)`/g)) {
        // Trailing sentence punctuation is part of the prose, not of the path.
        const candidate = (match[1] ?? '').trim().replace(/[.,;:]+$/, '');
        if (looksLikeRepoPath(candidate)) {
          found.push({ path: candidate, document: relative, line: index + 1 });
        }
      }
    });

  return found;
}

const CITATIONS: readonly Citation[] = [
  ...markdownFilesUnder(resolve(ROOT, 'docs')),
  resolve(ROOT, 'CLAUDE.md'),
  resolve(ROOT, 'MANUAL-BACKLOG.md'),
].flatMap((file) => citationsIn(file));

const exists = (path: string): boolean => existsSync(resolve(ROOT, path.replace(/\/$/, '')));

describe('paths cited in the documentation', () => {
  it('has something to check, so the sweep cannot pass vacuously', () => {
    // A regex that stopped matching, or a walk that found no files, would otherwise read as a
    // clean sweep. The threshold is deliberately far below the real count.
    expect(CITATIONS.length).toBeGreaterThan(100);
  });

  it('all exist, unless deliberately absent for a stated reason', () => {
    const broken = CITATIONS.filter(
      (citation) => !(citation.path in DELIBERATELY_ABSENT) && !exists(citation.path)
    ).map((citation) => `${citation.document}:${citation.line} → ${citation.path}`);

    expect(
      [...new Set(broken)].sort(),
      'A path in a doc reads as a verified fact. If the absence is deliberate, add it to ' +
        'DELIBERATELY_ABSENT with the reason.'
    ).toEqual([]);
  });

  it('exempts nothing that is actually present', () => {
    // The half that keeps the allow-list honest: an entry whose path comes back has stopped
    // being an exemption and is now a way to miss the next rename of that file.
    const resurrected = Object.keys(DELIBERATELY_ABSENT).filter((path) => exists(path));
    expect(resurrected, 'These exist now — remove them from DELIBERATELY_ABSENT.').toEqual([]);
  });

  it('exempts nothing the documentation has stopped citing', () => {
    // The other half. An exemption for a path nobody mentions any more is a stale note that
    // will quietly cover a future citation of the same name.
    const cited = new Set(CITATIONS.map((citation) => citation.path));
    const unused = Object.keys(DELIBERATELY_ABSENT).filter((path) => !cited.has(path));
    expect(unused, 'Nothing cites these any more — remove them from DELIBERATELY_ABSENT.').toEqual(
      []
    );
  });

  it('gives every exemption a reason someone can act on', () => {
    for (const [path, reason] of Object.entries(DELIBERATELY_ABSENT)) {
      expect(reason.length, `${path} needs a real reason, not a placeholder`).toBeGreaterThan(40);
    }
  });
});
