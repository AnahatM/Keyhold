// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { BACKUP_INFIX, TEMP_SUFFIX } from '../vault/atomic-write.js';
import { surveyVaultFiles, type DirectoryEntry } from './survey.js';
import { buildContainer, truncatedTo } from './test-support.js';

/**
 * When a vault will not open, the answer is almost never "repair it" — it is "there are four
 * other complete copies in this folder, and this one is the newest". These tests are about
 * getting that order right, because the order is the entire product of this module.
 */

const DIRECTORY = 'C:\\Users\\someone\\Documents';
const VAULT = `${DIRECTORY}\\vault.keep`;

const DAY = 86_400_000;
const BASE = 1_700_000_000_000;

function entry(name: string, overrides: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    path: `${DIRECTORY}\\${name}`,
    sizeBytes: 4096,
    modifiedAt: BASE,
    ...overrides,
  };
}

const survey = (entries: readonly DirectoryEntry[]): ReturnType<typeof surveyVaultFiles> =>
  surveyVaultFiles({ vaultPath: VAULT, entries });

const names = (entries: readonly DirectoryEntry[]): readonly string[] =>
  survey(entries).files.map((file) => file.name);

describe('what a filename is', () => {
  it('classifies the vault, its backups, a temp and a legacy backup', () => {
    const result = survey([
      entry('vault.keep'),
      entry(`vault.keep${BACKUP_INFIX}.1`),
      entry(`vault.keep${BACKUP_INFIX}.2`),
      entry(`vault.keep${TEMP_SUFFIX}`),
      entry('vault.keepbak'),
    ]);

    const roles = new Map(result.files.map((file) => [file.name, file.role]));
    expect(roles.get('vault.keep')).toBe('vault');
    expect(roles.get(`vault.keep${BACKUP_INFIX}.1`)).toBe('backup');
    expect(roles.get(`vault.keep${TEMP_SUFFIX}`)).toBe('orphaned-temp');
    expect(roles.get('vault.keepbak')).toBe('legacy-backup');
    expect(result.backupCount).toBe(2);
    expect(result.orphanedTempCount).toBe(1);
  });

  it('matches case-insensitively, because NTFS and APFS do', () => {
    // Treating `Vault.keep.bak.1` as a different file would mean missing a backup on
    // exactly the platforms these files live on.
    const result = survey([entry('VAULT.KEEP'), entry(`Vault.Keep${BACKUP_INFIX}.1`)]);

    expect(result.vaultPresent).toBe(true);
    expect(result.backupCount).toBe(1);
  });

  it('lists a different vault but never ranks it as a copy of this one', () => {
    const result = survey([entry('vault.keep'), entry('work.keep')]);
    const other = result.files.find((file) => file.name === 'work.keep');

    expect(other?.role).toBe('other-vault');
    expect(result.bestCandidate).toBe('vault.keep');
    // It sorts last, after every real candidate.
    expect(result.files.at(-1)?.name).toBe('work.keep');
  });

  it('ignores files that are nothing to do with a vault', () => {
    expect(names([entry('vault.keep'), entry('notes.txt'), entry('photo.jpg')])).toEqual([
      'vault.keep',
    ]);
  });

  it('recognises a quarantined temp and still treats it as a candidate', () => {
    const result = survey([entry('vault.keep.recovered-2026-01-01T00-00-00-000Z')]);
    const quarantined = result.files[0];

    expect(quarantined?.role).toBe('quarantined-temp');
    // Quarantine moved a file out of the way; it did not decide the file was worthless.
    expect(result.bestCandidate).toBe(quarantined?.name);
  });

  it('reports no best candidate when nothing in the listing belongs to this vault', () => {
    const result = survey([entry('work.keep'), entry('readme.md')]);
    expect(result.bestCandidate).toBeNull();
    expect(result.vaultPresent).toBe(false);
  });
});

describe('the order', () => {
  it('puts a structurally sound file above a damaged one, whatever their dates say', () => {
    const good = buildContainer({ header: { generation: 10 } });
    const broken = truncatedTo(buildContainer({ header: { generation: 99 } }), 200);

    const result = survey([
      entry('vault.keep', { bytes: broken, modifiedAt: BASE + DAY }),
      entry(`vault.keep${BACKUP_INFIX}.1`, { bytes: good, modifiedAt: BASE }),
    ]);

    expect(result.bestCandidate).toBe(`vault.keep${BACKUP_INFIX}.1`);
  });

  it('prefers the higher generation over the newer mtime', () => {
    // `mtime` is set by whatever last touched the file — a cloud client, a backup tool, a
    // copy. `generation` is written by Keyhold and increments once per save. When they
    // disagree, the counter is the one that is about the vault's contents.
    const older = buildContainer({ header: { generation: 300 } });
    const newer = buildContainer({ header: { generation: 12 } });

    const result = survey([
      entry('vault.keep', { bytes: newer, modifiedAt: BASE + 10 * DAY }),
      entry(`vault.keep${BACKUP_INFIX}.1`, { bytes: older, modifiedAt: BASE }),
    ]);

    expect(result.bestCandidate).toBe(`vault.keep${BACKUP_INFIX}.1`);
    expect(result.files[0]?.generation).toBe(300);
  });

  it('ranks an uninspected file between a sound one and a damaged one', () => {
    // "Not looked at" is a better bet than "looked at and found broken", and a worse bet
    // than "looked at and found whole". Anything else would send the user to a file already
    // known to be truncated.
    const result = survey([
      entry(`vault.keep${BACKUP_INFIX}.1`, { bytes: truncatedTo(buildContainer(), 50) }),
      entry(`vault.keep${BACKUP_INFIX}.2`),
      entry(`vault.keep${BACKUP_INFIX}.3`, { bytes: buildContainer() }),
    ]);

    expect(result.files.map((file) => file.name)).toEqual([
      `vault.keep${BACKUP_INFIX}.3`,
      `vault.keep${BACKUP_INFIX}.2`,
      `vault.keep${BACKUP_INFIX}.1`,
    ]);
  });

  it('falls back to mtime, then size, and is total so two runs agree', () => {
    const entries = [
      entry(`vault.keep${BACKUP_INFIX}.2`, { modifiedAt: BASE, sizeBytes: 100 }),
      entry(`vault.keep${BACKUP_INFIX}.1`, { modifiedAt: BASE, sizeBytes: 900 }),
      entry(`vault.keep${BACKUP_INFIX}.3`, { modifiedAt: BASE + DAY, sizeBytes: 10 }),
    ];

    const first = names(entries);
    const shuffled = names([...entries].reverse());

    expect(first[0]).toBe(`vault.keep${BACKUP_INFIX}.3`);
    expect(first[1]).toBe(`vault.keep${BACKUP_INFIX}.1`);
    // A total order is what makes two reports comparable.
    expect(shuffled).toEqual(first);
  });

  it('numbers the ranks from 1, contiguously', () => {
    const result = survey([
      entry('vault.keep'),
      entry(`vault.keep${BACKUP_INFIX}.1`),
      entry('work.keep'),
    ]);
    expect(result.files.map((file) => file.rank)).toEqual([1, 2, 3]);
  });
});

describe('what each row says', () => {
  it('states generation, header state and container state when the bytes were supplied', () => {
    const result = survey([entry('vault.keep', { bytes: buildContainer() })]);
    const row = result.files[0];

    expect(row?.headerState).toBe('intact');
    expect(row?.structurallyIntact).toBe(true);
    expect(row?.ranking).toContain('generation 214');
    expect(row?.ranking).toContain('header intact');
    expect(row?.ranking).toContain('container complete');
  });

  it('says plainly that a file was not inspected rather than guessing', () => {
    const row = survey([entry('vault.keep')]).files[0];

    expect(row?.headerState).toBe('unknown');
    expect(row?.structurallyIntact).toBeNull();
    expect(row?.generation).toBeNull();
    expect(row?.ranking).toContain('contents not inspected');
  });

  it('marks a file whose header will not parse as damaged', () => {
    const row = survey([entry('vault.keep', { bytes: truncatedTo(buildContainer(), 30) })])
      .files[0];

    expect(row?.headerState).toBe('damaged');
    expect(row?.ranking).toContain('header unreadable');
  });

  it('carries the standing "do not delete the temp" note on every temp row', () => {
    const row = survey([entry(`vault.keep${TEMP_SUFFIX}`)]).files[0];

    // A file the app refuses to clean up looks like a bug unless the user is told what it
    // is — and nothing can tell whether it is a fragment or the newest copy without the
    // master password.
    expect(row?.note).toContain('do not remove it');
    expect(row?.note).toContain('without the master password');
  });

  it('leaves the vault and its backups without a note, because there is nothing to caveat', () => {
    const result = survey([entry('vault.keep'), entry(`vault.keep${BACKUP_INFIX}.1`)]);
    expect(result.files.every((file) => file.note === null)).toBe(true);
  });
});

describe('what a survey may never contain', () => {
  it('carries basenames and has no path field at all', () => {
    const result = survey([entry('vault.keep'), entry(`vault.keep${BACKUP_INFIX}.1`)]);

    // A home directory is a person's real name often enough to matter, and this output is
    // written to be pasted into a public issue tracker.
    expect(JSON.stringify(result)).not.toContain('someone');
    expect(JSON.stringify(result)).not.toContain('Documents');
    for (const file of result.files) {
      expect(Object.keys(file)).not.toContain('path');
      expect(file.name).not.toContain('\\');
      expect(file.name).not.toContain('/');
    }
  });

  it('does no I/O and does not read a clock', () => {
    // A pure function of its input: the same entries twice give byte-identical output.
    const entries = [entry('vault.keep', { bytes: buildContainer() })];
    expect(survey(entries)).toEqual(survey(entries));
  });
});
