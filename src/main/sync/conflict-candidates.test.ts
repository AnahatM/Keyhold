// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { looksLikeConflictedCopy } from '@shared/model/cloud-folder.js';
import { PRE_MERGE_INFIX } from './pre-merge-backup.js';
import {
  isCandidateFileName,
  scanForConflictCandidates,
  type CandidateHeader,
} from './conflict-candidates.js';

/**
 * Finding the copies a sync client left behind.
 *
 * The exclusions carry the weight here. Offering the wrong file back as a merge candidate is
 * not a cosmetic error: a pre-merge backup is a complete, openable copy of this vault from
 * before the last merge, and merging one back in is how somebody undoes a merge without
 * realising they are doing it. A file with a different `vaultId` is somebody else's vault
 * entirely, and merging that puts two people's credentials behind one master password.
 *
 * The other property being held is that **no path leaves this module**. The renderer gets an
 * id and a filename; the map from id to path stays here. Without that, a channel that starts a
 * merge from a candidate would be a channel that reads any file the renderer names.
 *
 * Fault injection performed:
 *  1. Removing the `PRE_MERGE_INFIX` exclusion — fails "never offers a pre-merge backup of a
 *     vault whose own name looks conflicted". It failed **nothing** on the first pass: a backup
 *     of a plainly-named vault matches no conflict pattern anyway, so the exclusion was dead
 *     against every case written. It stops being dead the moment somebody opens a conflicted
 *     copy as their vault, which is an ordinary thing to do — and that case is now the test.
 *  2. Removing the `vaultId` comparison — fails "ignores a copy of a different vault".
 *  3. Removing the `endsWith('.keep')` check — fails "ignores the rolling backups and the
 *     staging file".
 *  4. Making the per-file `catch` rethrow — fails "one unreadable file does not end the scan".
 *  5. Sorting oldest-first — fails "lists the newest copy first".
 */

const VAULT_ID = 'vault-1';
const VAULT_PATH = '/home/a/Dropbox/personal.keep';

const header = (overrides: Partial<CandidateHeader> = {}): CandidateHeader => ({
  vaultId: VAULT_ID,
  modifiedAt: 1_700_000_000_000,
  generation: 7,
  recordCount: 12,
  ...overrides,
});

/** A scan over a made-up directory, with headers supplied per filename. */
async function scan(
  names: readonly string[],
  headers: Readonly<Record<string, CandidateHeader | null>> = {}
): ReturnType<typeof scanForConflictCandidates> {
  return scanForConflictCandidates({
    vaultPath: VAULT_PATH,
    vaultId: VAULT_ID,
    listDirectory: () => Promise.resolve(names),
    readHeader: (path) => {
      const name = path.split(/[\\/]/).pop() ?? '';
      return Promise.resolve(headers[name] ?? header());
    },
  });
}

describe('which filenames are worth opening', () => {
  const vaultFile = 'personal.keep';

  it('accepts what the real clients write', () => {
    expect(
      isCandidateFileName("personal (Anahat's conflicted copy 2026-09-03).keep", vaultFile)
    ).toBe(true);
    expect(
      isCandidateFileName('personal.sync-conflict-20260903-120000-ABCDEFG.keep', vaultFile)
    ).toBe(true);
  });

  it('never offers the vault back to itself', () => {
    expect(isCandidateFileName('personal.keep', vaultFile)).toBe(false);
    expect(isCandidateFileName('PERSONAL.KEEP', vaultFile)).toBe(false);
  });

  it('never offers one of our own pre-merge backups', () => {
    // A pre-merge backup is a complete, openable copy of this vault from *before* the last
    // merge — and it ends in `.keep` and sits in this directory like everything else. Offering
    // one back is how somebody undoes a merge by merging its own backup, without ever seeing
    // that that is what they did.
    const backup = `personal.keep${PRE_MERGE_INFIX}2026-09-03-a1b2c3.keep`;
    expect(isCandidateFileName(backup, vaultFile)).toBe(false);
  });

  it('never offers a pre-merge backup of a vault whose own name looks conflicted', () => {
    // This is the case that makes the `PRE_MERGE_INFIX` exclusion load-bearing, and it was
    // found by injection: removing that line failed nothing, because a backup of `personal`
    // does not match any conflict pattern to begin with.
    //
    // It becomes reachable the moment somebody opens a conflicted copy *as* their vault, which
    // is a perfectly ordinary thing to do — recover the newer side, keep working. Its backups
    // then inherit the conflict wording, match the pattern, and would be offered back as
    // candidates: merging one would silently undo the merge that created it.
    const conflictedVault = "personal (Anahat's conflicted copy 2026-09-03).keep";
    const backup = `${conflictedVault}${PRE_MERGE_INFIX}2026-09-04-a1b2c3.keep`;

    // The pattern does match it — which is the whole reason the exclusion has to be there.
    expect(looksLikeConflictedCopy(backup)).toBe(true);
    expect(isCandidateFileName(backup, conflictedVault)).toBe(false);
  });

  it('ignores the rolling backups and the staging file', () => {
    expect(isCandidateFileName('personal.keep.bak.1', vaultFile)).toBe(false);
    expect(isCandidateFileName('personal.keep.tmp', vaultFile)).toBe(false);
    expect(isCandidateFileName('notes (conflicted copy 2026-09-03).txt', vaultFile)).toBe(false);
  });

  it('ignores an ordinary second vault, which is not a conflicted copy', () => {
    // A person with two vaults in one folder is not in a conflict; nothing should suggest
    // merging their work vault into their personal one.
    expect(isCandidateFileName('work.keep', vaultFile)).toBe(false);
  });
});

describe('the scan', () => {
  const conflicted = "personal (Anahat's conflicted copy 2026-09-03).keep";
  const older = 'personal.sync-conflict-20260101-090000-AAAAAAA.keep';

  it('describes a candidate from its plaintext header, without a key', async () => {
    const { candidates } = await scan(['personal.keep', conflicted], {
      [conflicted]: header({ generation: 9, recordCount: 41, modifiedAt: 1_700_000_500_000 }),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.fileName).toBe(conflicted);
    expect(candidates[0]?.generation).toBe(9);
    expect(candidates[0]?.recordCount).toBe(41);
  });

  it('hands out an id and keeps the path to itself', async () => {
    const { candidates, paths } = await scan(['personal.keep', conflicted]);

    const id = candidates[0]?.id ?? '';
    expect(id).not.toBe('');
    // Nothing in what the renderer receives is a path — that is what makes a channel taking a
    // candidate id safe, where one taking a filename would read any file it was given.
    expect(JSON.stringify(candidates)).not.toContain('/home/a/Dropbox');
    expect(paths.get(id)).toContain(conflicted);
  });

  it('ignores a copy of a different vault', async () => {
    // Named exactly like a conflicted copy, and it is somebody else's vault. Merging it would
    // put two people's credentials behind one master password.
    const { candidates } = await scan(['personal.keep', conflicted], {
      [conflicted]: header({ vaultId: 'a-completely-different-vault' }),
    });
    expect(candidates).toEqual([]);
  });

  it('lists the newest copy first', async () => {
    const { candidates } = await scan(['personal.keep', older, conflicted], {
      [older]: header({ modifiedAt: 1_600_000_000_000 }),
      [conflicted]: header({ modifiedAt: 1_700_000_000_000 }),
    });
    expect(candidates.map((candidate) => candidate.fileName)).toEqual([conflicted, older]);
  });

  it('one unreadable file does not end the scan', async () => {
    // A directory a sync client is working in contains half-written files and files it has
    // locked. Giving up on the first failure would find nothing exactly when the client is
    // busiest — which is when a conflicted copy has just appeared.
    const { candidates } = await scanForConflictCandidates({
      vaultPath: VAULT_PATH,
      vaultId: VAULT_ID,
      listDirectory: () => Promise.resolve(['personal.keep', older, conflicted]),
      readHeader: (path) => {
        if (path.includes('sync-conflict')) throw new Error('EBUSY');
        return Promise.resolve(header());
      },
    });
    expect(candidates.map((candidate) => candidate.fileName)).toEqual([conflicted]);
  });

  it('says nothing when the directory cannot be read at all', async () => {
    const { candidates } = await scanForConflictCandidates({
      vaultPath: VAULT_PATH,
      vaultId: VAULT_ID,
      listDirectory: () => Promise.reject(new Error('EACCES')),
      readHeader: () => Promise.resolve(header()),
    });
    expect(candidates).toEqual([]);
  });

  it('finds nothing in an ordinary folder, which is the usual answer', async () => {
    const { candidates } = await scan(['personal.keep', 'work.keep', 'personal.keep.bak.1']);
    expect(candidates).toEqual([]);
  });
});
