// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_INFIX } from '../vault/atomic-write.js';
import { diagnoseVault } from './diagnose.js';

/**
 * The folder walk behind "Diagnose a vault".
 *
 * This runs when somebody's vault will not open, which sets the standard for every decision in
 * it: **the report must arrive**. Every branch below is a way the walk could have thrown, or
 * quietly returned less than it could have, at the exact moment the user is already in trouble
 * and has no other tool to reach for.
 *
 * Three properties:
 *
 *  1. **A vault that cannot be read is a finding, not a crash.** The report still arrives and
 *     `file` is `null`, rather than the call throwing out of the IPC handler.
 *  2. **Directories beside the vault are skipped**, not read as containers. An `attachments/`
 *     or a `.git/` next to the vault is the realistic case.
 *  3. **The survey ranks the real neighbours.** Backups reach `survey.files` and a best
 *     candidate is named, which is the whole point of surveying the folder at all.
 *
 * ## What is deliberately not claimed
 *
 * The module reads the vault **before** listing the folder, so a folder that cannot be listed
 * does not cost the user the inspection of the file they asked about. **That ordering is not
 * observable from outside**, and this file does not pretend to defend it: every arrangement
 * that breaks the listing on a real filesystem — a missing directory, a parent that is a file
 * — breaks the read too, so both orderings produce the same `file: null`. Fault injection
 * confirmed it, and the confirmation is why this paragraph exists rather than a comfortable
 * claim of coverage.
 *
 * The 256 MB size cap is likewise unexercised. The smallest file that would trip it is 256 MB,
 * and writing one on every test run costs far more than the branch is worth.
 *
 * The report's *contents* — that it names no password, no record title and no folder path —
 * are the subject of the recovery builder's own tests.
 *
 * ## Fault injection performed, three defects
 *
 *  1. The `isFile()` filter removed, so directories are surveyed as files — failed
 *     `ignores directories beside the vault`.
 *  2. The `readdir` block made to throw — failed `surveys the files beside the vault`, with
 *     `survey` null.
 *  3. The vault read made dependent on the folder listing succeeding first — **failed
 *     nothing**. That is the finding recorded above, not a pass.
 */

let folder: string;
let vaultPath: string;

const NOW = Date.UTC(2026, 2, 4, 5, 6, 7);

/**
 * A rolling backup's real path.
 *
 * Built from `BACKUP_INFIX` rather than written out, because the first version of this file
 * invented `.keepbak` from memory — a name nothing in the codebase uses. Every backup
 * assertion then read zero, and the tests failed for a reason that had nothing to do with the
 * code under test. A fixture that guesses at a convention is testing the guess.
 */
const backup = (index: number): string => `${vaultPath}${BACKUP_INFIX}.${String(index)}`;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'keyhold-diagnose-'));
  vaultPath = join(folder, 'personal.keep');
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('diagnosing a vault file', () => {
  it('produces a report even when the vault does not exist at all', async () => {
    // The honest worst case: the path is wrong, or the file is gone. A tool for "my vault will
    // not open" that throws when the vault is missing has failed at its one job.
    const report = await diagnoseVault({ vaultPath, generatedAt: NOW });

    expect(report.generatedAt).toBe(NOW);
    // Not inspected, and it says so — rather than an empty inspection that reads like a clean
    // one, which is the same failure `unknown` exists to prevent in the breach check.
    expect(report.file).toBeNull();
  });

  it('inspects a file that is not a vault, rather than refusing it', async () => {
    // A renamed text file is a real case: a sync client mangled the extension, or somebody
    // saved over it. The inspection has to run and report what it found — that is how the
    // user learns the file is not what they think it is.
    await writeFile(vaultPath, 'this is a text file somebody renamed');
    const report = await diagnoseVault({ vaultPath, generatedAt: NOW });

    expect(report.file).not.toBeNull();
    expect(report.findings.length).toBeGreaterThan(0);
  });

  it('surveys the files beside the vault, and ranks them', async () => {
    await writeFile(vaultPath, 'not really a container');
    await writeFile(backup(1), 'a backup');
    await writeFile(backup(2), 'an older backup');

    const report = await diagnoseVault({ vaultPath, generatedAt: NOW });

    expect(report.survey).not.toBeNull();
    expect(report.survey?.vaultPresent).toBe(true);
    expect(report.survey?.backupCount).toBe(2);
    // Ranked, not merely listed. Naming the best copy is the answer somebody in trouble needs;
    // a list of filenames they already had is not.
    expect(report.survey?.bestCandidate).not.toBeNull();
  });

  it('ignores directories beside the vault rather than reading them', async () => {
    // Without the `isFile()` filter, `readFile` is called on a directory and fails with
    // EISDIR — and a directory named like a backup would be ranked as a recovery candidate.
    await writeFile(vaultPath, 'not really a container');
    await writeFile(backup(1), 'a real backup');
    await mkdir(backup(2));
    await mkdir(join(folder, 'attachments'));

    const report = await diagnoseVault({ vaultPath, generatedAt: NOW });
    const names = report.survey?.files.map((file) => file.name) ?? [];

    expect(names).not.toContain('attachments');
    expect(names).not.toContain(`personal.keep${BACKUP_INFIX}.2`);
    expect(report.survey?.backupCount).toBe(1);
  });

  it('reports on the folder when the vault path names nothing on disk', async () => {
    // The path is wrong but the folder is real — a rename, or a file moved out from under the
    // app. The neighbours are still surveyed, which is how the report can point at the copy
    // that does exist rather than shrugging.
    await writeFile(backup(1), 'a backup');

    const report = await diagnoseVault({ vaultPath, generatedAt: NOW });

    expect(report.file).toBeNull();
    expect(report.survey?.vaultPresent).toBe(false);
    expect(report.survey?.backupCount).toBe(1);
  });

  it('does not fall over on an empty file', async () => {
    await writeFile(vaultPath, '');
    const report = await diagnoseVault({ vaultPath, generatedAt: NOW });
    expect(report.findings.length).toBeGreaterThan(0);
  });

  it('stamps the report with the clock it was given', async () => {
    // `generatedAt` is a parameter rather than a `Date.now()` inside, which is what lets the
    // saved file and the screen agree about when the report was taken.
    await writeFile(vaultPath, 'not really a container');
    const report = await diagnoseVault({ vaultPath, generatedAt: 1234 });
    expect(report.generatedAt).toBe(1234);
  });
});

describe('the document half', () => {
  it('is skipped when no vault is open, rather than invented', async () => {
    await writeFile(vaultPath, 'not really a container');

    // `document: null` is the normal case — diagnosing a vault you cannot unlock is the main
    // reason this feature exists, and there is no decrypted document to check then.
    const closed = await diagnoseVault({ vaultPath, generatedAt: NOW, document: null });
    const absent = await diagnoseVault({ vaultPath, generatedAt: NOW });

    expect(closed.diagnosis).toBeNull();
    expect(JSON.stringify(closed)).toBe(JSON.stringify(absent));
  });
});
