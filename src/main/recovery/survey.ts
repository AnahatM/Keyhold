// SPDX-License-Identifier: GPL-3.0-or-later
import { basename } from 'node:path';
import type {
  FileHeaderState,
  SurveyedFile,
  SurveyedFileRole,
  VaultFileSurvey,
} from '@shared/model/recovery.js';
import { BACKUP_INFIX, QUARANTINE_INFIX, TEMP_SUFFIX } from '../vault/atomic-write.js';
import { PRE_MERGE_INFIX } from '../sync/pre-merge-backup.js';
import { inspectVaultFile } from './file-inspection.js';
import { formatCount } from './text.js';

/**
 * Every copy of a vault that is sitting next to it, ranked by which is most likely to be the
 * best one.
 *
 * When a vault will not open, the answer is almost never "repair it" — it is "there are four
 * other complete copies of this file in the same folder, and this one is the newest". The
 * write path already puts them there: five rolling backups, plus whatever an interrupted
 * write left behind. This function's whole job is to lay them out in the order worth trying.
 *
 * ## It does no I/O
 *
 * The caller lists the directory and hands the entries in, optionally with each file's bytes.
 * That is not squeamishness about `readdir`: it is what lets the ranking be tested against
 * twenty combinations of size, age, generation and damage without a temp directory, and it
 * keeps the one module that talks about damaged files from being able to touch one.
 *
 * ## The `.tmp` is never deleted, and the report says why
 *
 * `atomic-write.ts` surfaces an orphaned temp rather than removing it, because it may be a
 * truncated fragment or it may be the newest complete copy of the vault and **nothing can
 * tell which without the master password**. That rule is honoured here and, more importantly,
 * explained here: a file the app refuses to clean up looks like a bug unless the user is told
 * what it is. Every temp entry carries that explanation as a standing note.
 *
 * ## There are no paths in the output
 *
 * `SurveyedFile` carries a basename and no directory. The caller supplied the listing, so it
 * can rejoin on the name; the survey structurally cannot leak a home directory — which is a
 * person's real name often enough to matter — into a report meant to be pasted into a public
 * issue tracker.
 */

/** The legacy single-backup extension, per `docs/04-Vault-Format/00-KEEP-Format-Spec.md` §11. */
const LEGACY_BACKUP_EXTENSION = '.keepbak';

const VAULT_EXTENSION = '.keep';

/** One entry from the directory listing the caller performed. */
export interface DirectoryEntry {
  /** Full path. Used only to derive a basename; never repeated into a report. */
  readonly path: string;
  readonly sizeBytes: number;
  /** Epoch milliseconds. */
  readonly modifiedAt: number;
  /**
   * The file's bytes, when the caller already has them.
   *
   * Optional because reading five backups to draw a list is wasteful, and because the ranking
   * is still useful without them. Supplying them is what upgrades a row from "8 MB, modified
   * Tuesday" to "generation 214, header intact, container complete" — which is the difference
   * between a guess and an answer.
   */
  readonly bytes?: Uint8Array | undefined;
}

export interface SurveyInput {
  /** The vault the survey is about. Only its basename is used. */
  readonly vaultPath: string;
  readonly entries: readonly DirectoryEntry[];
}

/** Where each role sorts when nothing better separates two files. */
const ROLE_ORDER: Readonly<Record<SurveyedFileRole, number>> = {
  vault: 0,
  'orphaned-temp': 1,
  backup: 2,
  // Above the two salvage roles and below an ordinary backup. It is a verified, complete
  // copy — read back and digest-matched when it was written, which no other file here can
  // claim — but it is older than the rolling backups by construction, and `generation`
  // already carries age. This order only breaks a tie between files of the same generation,
  // and there the deliberate copy should win over a quarantined temp.
  'pre-merge-backup': 3,
  'quarantined-temp': 4,
  'legacy-backup': 5,
  'other-vault': 6,
};

/** Everything except a file belonging to a different vault is a candidate copy of this one. */
function isCandidate(role: SurveyedFileRole): boolean {
  return role !== 'other-vault';
}

interface Classified {
  readonly role: SurveyedFileRole;
  readonly backupIndex: number | null;
}

/**
 * What a filename is, relative to the vault being surveyed.
 *
 * Case-insensitive throughout: NTFS and the default APFS configuration both are, so treating
 * `Vault.keep.bak.1` and `vault.keep.bak.1` as different files would mean the survey missed a
 * backup on exactly the platforms most of these files live on.
 */
function classify(name: string, vaultName: string): Classified | null {
  const lower = name.toLowerCase();
  const vault = vaultName.toLowerCase();

  if (lower === vault) return { role: 'vault', backupIndex: null };
  if (lower === `${vault}${TEMP_SUFFIX}`) return { role: 'orphaned-temp', backupIndex: null };

  const backup = new RegExp(
    `^${escapeForRegExp(vault)}${escapeForRegExp(BACKUP_INFIX)}\\.(\\d+)$`
  ).exec(lower);
  if (backup !== null) {
    const index = Number.parseInt(backup[1] ?? '', 10);
    if (Number.isInteger(index) && index >= 1) return { role: 'backup', backupIndex: index };
  }

  if (lower.startsWith(`${vault}${QUARANTINE_INFIX}`)) {
    return { role: 'quarantined-temp', backupIndex: null };
  }

  // Before the `.keep` catch-all below, and that order is the whole fix: a pre-merge backup
  // ends in the vault extension, so it used to fall through and be classified `other-vault`
  // — listed, but never ranked as a copy of *this* vault. It is the copy a user most wants
  // after a merge went wrong, and the survey was quietly steering them away from it.
  if (lower.startsWith(`${vault}${PRE_MERGE_INFIX}`)) {
    return { role: 'pre-merge-backup', backupIndex: null };
  }
  if (lower.endsWith(LEGACY_BACKUP_EXTENSION)) return { role: 'legacy-backup', backupIndex: null };

  // Anything else that is recognisably vault-shaped is listed rather than dropped, so a user
  // renaming a copy to `vault-old.keep` still sees it — but it is never ranked as a copy of
  // *this* vault, because it is not one.
  if (lower.endsWith(VAULT_EXTENSION) || lower.endsWith(`${VAULT_EXTENSION}${TEMP_SUFFIX}`)) {
    return { role: 'other-vault', backupIndex: null };
  }
  return null;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TEMP_NOTE =
  'Kept, never deleted. This is what an interrupted save leaves behind. It may be a truncated fragment, or it may be the newest complete copy of the vault — nothing can tell which without the master password, and guessing wrong in one direction loses data while guessing wrong in the other resurrects a broken file. Move it aside if it is in the way; do not remove it.';

const QUARANTINE_NOTE =
  'A temp file that has already been moved aside. Quarantine got it out of the way; it did not decide the file was worthless, so it is still ranked as a candidate copy.';

const PRE_MERGE_NOTE =
  'The copy taken automatically just before a merge, and the one to reach for if a merge went wrong. It was read back and checked against its own digest when it was written, which no other file here can claim. It opens with the same master password as the vault.';

const OTHER_VAULT_NOTE =
  'A different vault in the same folder. Listed so it is not mistaken for a copy of this one, and never ranked as one.';

function noteFor(role: SurveyedFileRole): string | null {
  switch (role) {
    case 'orphaned-temp':
      return TEMP_NOTE;
    case 'quarantined-temp':
      return QUARANTINE_NOTE;
    case 'pre-merge-backup':
      return PRE_MERGE_NOTE;
    case 'other-vault':
      return OTHER_VAULT_NOTE;
    case 'vault':
    case 'backup':
    case 'legacy-backup':
      return null;
  }
}

interface Examined {
  readonly generation: number | null;
  readonly headerState: FileHeaderState;
  readonly structurallyIntact: boolean | null;
}

function examine(bytes: Uint8Array | undefined): Examined {
  if (bytes === undefined) {
    return { generation: null, headerState: 'unknown', structurallyIntact: null };
  }
  const inspection = inspectVaultFile(bytes);
  return {
    generation: inspection.header?.generation ?? null,
    headerState: inspection.header === null ? 'damaged' : 'intact',
    structurallyIntact: inspection.structurallyIntact,
  };
}

/** The facts behind a file's position, in one line, with no editorialising. */
function rankingSentence(file: Omit<SurveyedFile, 'rank' | 'ranking'>): string {
  const parts: string[] = [];

  parts.push(
    file.generation === null ? 'generation unknown' : `generation ${formatCount(file.generation)}`
  );

  switch (file.headerState) {
    case 'intact':
      parts.push('header intact');
      break;
    case 'damaged':
      parts.push('header unreadable');
      break;
    case 'unknown':
      parts.push('contents not inspected');
      break;
  }

  if (file.structurallyIntact === true) parts.push('container complete');
  if (file.structurallyIntact === false) parts.push('container incomplete');

  parts.push(`${formatCount(file.sizeBytes)} bytes`);
  parts.push(`modified ${new Date(file.modifiedAt).toISOString()}`);
  return parts.join('; ');
}

/**
 * Order: known-good before unknown before known-damaged, then the highest generation, then
 * the newest, then the largest.
 *
 * Generation outranks modification time deliberately. `mtime` is set by whatever last touched
 * the file — a cloud client, a backup tool, a copy — while `generation` is written by Keyhold
 * itself and increments once per save. When they disagree, the counter is the one that is
 * about the vault's contents rather than about the filesystem.
 *
 * Every tier ends in a comparison on the name, so the order is total: two identical-looking
 * backups sort the same way on every run, which is what makes two reports comparable.
 */
function compareCandidates(
  a: Omit<SurveyedFile, 'rank' | 'ranking'>,
  b: Omit<SurveyedFile, 'rank' | 'ranking'>
): number {
  const candidacy = Number(!isCandidate(a.role)) - Number(!isCandidate(b.role));
  if (candidacy !== 0) return candidacy;

  const soundness = soundnessTier(a.structurallyIntact) - soundnessTier(b.structurallyIntact);
  if (soundness !== 0) return soundness;

  if (a.generation !== b.generation) {
    if (a.generation === null) return 1;
    if (b.generation === null) return -1;
    return b.generation - a.generation;
  }

  if (a.modifiedAt !== b.modifiedAt) return b.modifiedAt - a.modifiedAt;
  if (a.sizeBytes !== b.sizeBytes) return b.sizeBytes - a.sizeBytes;

  const role = ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
  if (role !== 0) return role;

  const backupIndex = (a.backupIndex ?? 0) - (b.backupIndex ?? 0);
  if (backupIndex !== 0) return backupIndex;

  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function soundnessTier(intact: boolean | null): number {
  if (intact === true) return 0;
  if (intact === null) return 1;
  return 2;
}

/** Surveys one directory's worth of files for one vault. Pure: no filesystem, no clock. */
export function surveyVaultFiles(input: SurveyInput): VaultFileSurvey {
  const vaultName = basename(input.vaultPath);

  const unranked: Omit<SurveyedFile, 'rank' | 'ranking'>[] = [];
  for (const entry of input.entries) {
    const name = basename(entry.path);
    const classified = classify(name, vaultName);
    if (classified === null) continue;

    const examined = examine(entry.bytes);
    unranked.push({
      name,
      role: classified.role,
      backupIndex: classified.backupIndex,
      sizeBytes: entry.sizeBytes,
      modifiedAt: entry.modifiedAt,
      generation: examined.generation,
      headerState: examined.headerState,
      structurallyIntact: examined.structurallyIntact,
      note: noteFor(classified.role),
    });
  }

  const files = [...unranked].sort(compareCandidates).map((file, index) => ({
    ...file,
    rank: index + 1,
    ranking: rankingSentence(file),
  }));

  const best = files.find((file) => isCandidate(file.role));
  return {
    vaultName,
    vaultPresent: files.some((file) => file.role === 'vault'),
    files,
    bestCandidate: best?.name ?? null,
    backupCount: files.filter((file) => file.role === 'backup').length,
    orphanedTempCount: files.filter((file) => file.role === 'orphaned-temp').length,
  };
}
