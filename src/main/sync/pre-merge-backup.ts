// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { VaultDocument } from '@shared/model/vault-document.js';
import { randomBytes } from '../crypto/random.js';
import { readPreamble } from '../format/container.js';
import { readVaultFile, writeVaultFileAtomically } from '../vault/atomic-write.js';
import { mergeDocuments, type MergeOptions, type MergeOutcome } from './merge-document.js';

/**
 * The mandatory pre-merge backup — and the reason a merge cannot be run without one.
 *
 * A merge is the most dangerous thing this app does. Every other destructive operation
 * touches one record, or a folder, or a setting; a merge rewrites the whole vault from two
 * inputs, and if it gets it wrong the user's own copy has already been overwritten by the
 * answer. Hard rule 6 says never lose data, and this file is that rule applied to the one
 * operation where a mistake is not recoverable from anything the app already keeps.
 *
 * ## Why the rolling backups are not this, even though they are most of it
 *
 * `writeVaultFileAtomically` copies the live vault to `<vault>.bak.1` before every save, and
 * a merge ends in a save — so the pre-merge state *is* captured, for a while. That covers
 * more than it looks like it does, and it is why this file is small and composes that one
 * rather than starting a second backup system beside it. Two backup mechanisms would be
 * twice the code and half the confidence about which one saved you.
 *
 * Three things it genuinely does not cover, and this file adds exactly those:
 *
 *  1. **It rotates.** Five ordinary saves after a merge and the pre-merge copy is gone —
 *     and the save immediately *following* a merge is the one that starts pushing it out.
 *     A backup that the next few saves delete is not a backup of the merge.
 *  2. **It is unnamed.** `.bak.1` is a slot, not a record. Nothing on disk says "this is
 *     what your vault looked like before the merge on the 3rd", so nothing can tell the
 *     user which file to reach for.
 *  3. **It happens only if the merge reaches the write.** The rotation is a side effect of
 *     saving. It is not a precondition of merging, and nothing can make a side effect
 *     mandatory.
 *
 * So what is added here is the small missing thing: a **named, dated, verified copy that
 * rotation never touches**, taken before the merge rather than during the save after it.
 *
 * ## The shape: the receipt cannot be forged and the merge cannot be reached around it
 *
 * A function that takes a backup, with a comment asking callers to call it first, is a
 * convention. Conventions are what this codebase keeps finding broken. So:
 *
 *  - `PreMergeBackup` has a **private constructor** and a `#`-private field. The private
 *    field is not secrecy — it is nominality: TypeScript will not assign a hand-written
 *    object literal to a class that has one, so a receipt cannot be *typed into existence*.
 *  - The only code that can mint one is `PreMergeBackup.runMerge`, which mints it **after**
 *    the copy is on disk, flushed, read back and verified.
 *  - `runMerge` hands the caller a `MergeSession`, and `session.merge` **is**
 *    `mergeDocuments` — the same function, not a second front door, with its precondition
 *    attached. The session object is only ever constructed by `runMerge`.
 *
 * What that makes impossible: obtaining a `PreMergeBackup`, or a `MergeSession`, without a
 * verified backup existing on disk first. Any future step that wants proof — the write, the
 * base-snapshot store — takes a `PreMergeBackup` parameter and is thereby unreachable to a
 * caller that skipped this.
 *
 * What it does not make impossible, stated plainly rather than overclaimed: importing
 * `mergeDocuments` from `./merge-document.js` directly, or writing `as unknown as
 * PreMergeBackup`. Both are deliberate acts visible in a diff — this closes *forgetting*,
 * not *lying*. `src/main/sync/index.ts` is the front door precisely so that reaching past it
 * reads as an unusual import in review.
 *
 * ## Fail closed
 *
 * Every failure path throws `PreMergeBackupError` **before** the session callback is
 * reached, so the merge does not run. No space, no permission, a read-only cloud folder, a
 * vault that will not read: the answer is the same, and the message says nothing has been
 * changed, because nothing has.
 *
 * ## Verified, not merely written
 *
 * The one thing worse than no backup is believing you have one. `writeVaultFileAtomically`
 * returning is not evidence: a cloud placeholder, a full disk that reported success on a
 * buffered write, or a truncated copy all return. So the bytes are read back off the disk
 * and must match the source digest exactly, and must still parse as a KEEP preamble. Only
 * then does a receipt exist.
 */

/**
 * What sits between the vault's own name and the timestamp.
 *
 * Exported because this module is the authority on what a pre-merge backup is called, and
 * two other files legitimately need to recognise one: `recovery/survey.ts` when it lists the
 * copies sitting next to a vault, and the failed-attempt wipe in `session/session-controller.ts`
 * by way of `listVaultCopyPaths`. Neither should restate the pattern — that is hard rule 8,
 * and `QUARANTINE_INFIX` in `atomic-write.ts` is exported for exactly the same reason.
 */
export const PRE_MERGE_INFIX = '.pre-merge-';

/**
 * How many pre-merge backups to keep. `0` keeps every one.
 *
 * The default is keep-everything, which is the answer hard rule 6 gives when the alternative
 * is deleting a complete copy of someone's vault on a schedule they did not ask for. It is a
 * `retain` on the request rather than a constant here because hard rule 7 says a behaviour is
 * a setting when it is written, not later: a user with a small cloud quota sets a number, and
 * nothing about this file changes.
 */
export const DEFAULT_PRE_MERGE_RETAIN = 0;

/** How many times a colliding filename is regenerated before giving up. */
const NAME_ATTEMPTS = 8;

/** Bytes of randomness in the filename's tail. See `backupFileName`. */
const NAME_TOKEN_BYTES = 4;

export type PreMergeBackupFailure =
  /** The vault could not be read, so there was nothing to copy. */
  | 'vault-unreadable'
  /** The copy could not be written: no space, no permission, no such folder. */
  | 'backup-write-failed'
  /** The copy was written but did not read back as an identical, readable vault. */
  | 'backup-unverifiable';

/**
 * Why the merge did not run.
 *
 * Carries a basename and never a directory, following `recovery/survey.ts`: an error gets
 * logged, screenshotted and pasted into an issue, and a home directory is a person's real
 * name often enough to matter. The caller already knows the folder — it supplied it.
 */
export class PreMergeBackupError extends Error {
  readonly code: PreMergeBackupFailure;
  /** The backup file this was about, basename only. `null` before a name was chosen. */
  readonly fileName: string | null;

  constructor(
    code: PreMergeBackupFailure,
    message: string,
    options: { cause?: unknown; fileName?: string | null } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PreMergeBackupError';
    this.code = code;
    this.fileName = options.fileName ?? null;
  }
}

/** The two filesystem operations, injectable so a test can make them fail on purpose. */
export interface PreMergeBackupIo {
  readonly readBytes: (path: string) => Promise<Uint8Array>;
  readonly writeBackup: (path: string, bytes: Uint8Array) => Promise<void>;
}

export interface PreMergeBackupRequest {
  /** The vault about to be merged. Its bytes **on disk** are what gets copied. */
  readonly vaultPath: string;
  /**
   * Where the backup goes. Defaults to the vault's own folder.
   *
   * Beside the vault is the default because the user has to be able to find it without being
   * told a path they will not remember, and because a `.keep` next to a `.keep` opens with
   * the same master password by double-clicking it. A cloud folder will sync it, which costs
   * an upload and is the correct trade: a backup the user cannot find is not one.
   */
  readonly directory?: string | undefined;
  /** How many to keep. See `DEFAULT_PRE_MERGE_RETAIN`. */
  readonly retain?: number | undefined;
  /** Injected clock. Milliseconds since the epoch. */
  readonly now?: (() => number) | undefined;
  /**
   * Test seam. Production callers omit it.
   *
   * A caller that injects an io which lies about writing has defeated the guard on purpose,
   * exactly as `as unknown as PreMergeBackup` would. This closes forgetting, not sabotage.
   */
  readonly io?: Partial<PreMergeBackupIo> | undefined;
}

/** A merge that may proceed, because a verified backup exists. */
export interface MergeSession {
  readonly backup: PreMergeBackup;
  /**
   * `mergeDocuments`, unchanged, reachable only from inside a session.
   *
   * The resolver loop calls this repeatedly — merge, show conflicts, merge again with
   * `resolutions` — and that is why the backup is bound to the *session* rather than to a
   * single call. One merge is one backup, however many times the engine is run inside it.
   */
  readonly merge: (
    base: VaultDocument | null,
    ours: VaultDocument,
    theirs: VaultDocument,
    options: MergeOptions
  ) => MergeOutcome;
}

export interface MergeSessionResult<T> {
  /** Where the backup is, so the caller can tell the user in the merge report. */
  readonly backup: PreMergeBackup;
  readonly result: T;
}

/**
 * Proof that a verified copy of the vault exists on disk.
 *
 * Instances come from `runMerge` and nowhere else: the constructor is private, and the
 * `#digest` field makes the type nominal, so no object literal can stand in for one. That is
 * the whole mechanism — everything downstream that demands this type is unreachable without
 * having taken the backup.
 */
export class PreMergeBackup {
  /** The vault this is a copy of. */
  readonly vaultPath: string;
  /** Full path of the backup — the thing the user is told. */
  readonly path: string;
  /** Just the filename, for a message that must not carry a directory. */
  readonly fileName: string;
  /** When it was taken, ISO 8601, from the injected clock. */
  readonly takenAt: string;
  readonly sizeBytes: number;
  /** The vault's generation counter at the moment of the copy. */
  readonly generation: number;

  /**
   * SHA-256 of the bytes, verified by reading the file back.
   *
   * Private not for secrecy — it is a digest of ciphertext — but because a `#`-private field
   * is what makes this class nominal. Without one, `const forged: PreMergeBackup = { ... }`
   * type-checks, and the receipt means nothing. The getter below is the intended access; the
   * privacy is load-bearing and the test pins it with `@ts-expect-error`.
   */
  readonly #digest: string;

  private constructor(fields: {
    vaultPath: string;
    path: string;
    takenAt: string;
    sizeBytes: number;
    generation: number;
    digest: string;
  }) {
    this.vaultPath = fields.vaultPath;
    this.path = fields.path;
    this.fileName = basename(fields.path);
    this.takenAt = fields.takenAt;
    this.sizeBytes = fields.sizeBytes;
    this.generation = fields.generation;
    this.#digest = fields.digest;
  }

  get digest(): string {
    return this.#digest;
  }

  /**
   * Takes the backup, verifies it, and only then runs the merge.
   *
   * The single entry point. `#take` throws rather than returning a failure, so the `await`
   * on the line before the callback is what makes this fail closed: there is no branch in
   * which `session` is reached without a receipt, because there is no branch at all.
   */
  static async runMerge<T>(
    request: PreMergeBackupRequest,
    session: (session: MergeSession) => T | Promise<T>
  ): Promise<MergeSessionResult<T>> {
    const backup = await PreMergeBackup.#take(request);
    const result = await session({ backup, merge: mergeDocuments });
    return { backup, result };
  }

  static async #take(request: PreMergeBackupRequest): Promise<PreMergeBackup> {
    const io: PreMergeBackupIo = {
      readBytes: readVaultFile,
      writeBackup: writeBackupFile,
      ...request.io,
    };
    const clock = request.now ?? Date.now;
    const directory = request.directory ?? dirname(request.vaultPath);

    let source: Uint8Array;
    try {
      source = await io.readBytes(request.vaultPath);
    } catch (cause) {
      throw new PreMergeBackupError(
        'vault-unreadable',
        'The merge did not run: Keyhold could not read the vault to copy it first. Nothing has been changed.',
        { cause }
      );
    }

    const takenAt = new Date(clock()).toISOString();
    const path = await uniqueBackupPath(request.vaultPath, directory, takenAt);
    const fileName = basename(path);

    try {
      await io.writeBackup(path, source);
    } catch (cause) {
      throw new PreMergeBackupError(
        'backup-write-failed',
        'The merge did not run: the pre-merge backup could not be written. The folder may be read-only, full, or unavailable. Nothing has been changed.',
        { cause, fileName }
      );
    }

    const { sizeBytes, generation } = await verify(path, source, io, fileName);

    // Housekeeping, after the new backup is verified and never before it — pruning first
    // would mean a crash left the user with fewer copies and no new one. Failures here are
    // swallowed: a tidy folder is not worth refusing a merge that has a good backup.
    await prune(request.vaultPath, directory, request.retain ?? DEFAULT_PRE_MERGE_RETAIN, path);

    return new PreMergeBackup({
      vaultPath: request.vaultPath,
      path,
      takenAt,
      sizeBytes,
      generation,
      digest: digestOf(source),
    });
  }
}

/** One pre-merge backup found on disk. */
export interface PreMergeBackupFile {
  readonly path: string;
  readonly fileName: string;
  /** Parsed out of the filename. `null` if the name was edited into an unreadable shape. */
  readonly takenAt: string | null;
  readonly sizeBytes: number;
  readonly modifiedAt: Date;
}

/**
 * Whether a path is a pre-merge backup of this vault.
 *
 * Case-insensitive, for the same reason `atomic-write.ts` and `recovery/survey.ts` are:
 * NTFS and the default APFS configuration both are, so matching case-sensitively would miss
 * `Vault.keep.pre-merge-...` on exactly the platforms these files live on.
 *
 * Compares basenames only. The callers that need this — a directory listing, a wipe — are
 * already working within one folder.
 */
export function isPreMergeBackupPath(vaultPath: string, candidatePath: string): boolean {
  const prefix = `${basename(vaultPath)}${PRE_MERGE_INFIX}`.toLowerCase();
  const suffix = extname(vaultPath).toLowerCase();
  const name = basename(candidatePath).toLowerCase();

  return (
    name.startsWith(prefix) && name.endsWith(suffix) && name.length > prefix.length + suffix.length
  );
}

/**
 * Every pre-merge backup of a vault, newest first.
 *
 * Ordered by the timestamp in the name rather than by mtime, because a cloud client that
 * re-downloads a file rewrites its mtime and would otherwise reorder history. Anything whose
 * name will not parse sorts last on mtime — it is still a copy of the vault, and dropping it
 * from the list would hide a file the user might need.
 */
export async function listPreMergeBackups(
  vaultPath: string,
  options: { directory?: string | undefined } = {}
): Promise<PreMergeBackupFile[]> {
  const directory = options.directory ?? dirname(vaultPath);

  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    // An unreadable folder is not an error worth throwing at a caller who is asking what is
    // in it — the honest answer is "nothing I can see".
    return [];
  }

  const found: PreMergeBackupFile[] = [];
  for (const entry of entries) {
    if (!isPreMergeBackupPath(vaultPath, entry)) continue;
    const path = join(directory, entry);
    try {
      const info = await stat(path);
      found.push({
        path,
        fileName: entry,
        takenAt: takenAtFromName(vaultPath, entry),
        sizeBytes: info.size,
        modifiedAt: info.mtime,
      });
    } catch {
      // Vanished between readdir and stat. Not worth surfacing.
    }
  }

  return found.sort((a, b) => {
    if (a.takenAt !== null && b.takenAt !== null) return b.takenAt.localeCompare(a.takenAt);
    if (a.takenAt !== null) return -1;
    if (b.takenAt !== null) return 1;
    return b.modifiedAt.getTime() - a.modifiedAt.getTime();
  });
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * The default writer: the vault's own atomic write, aimed at the backup path.
 *
 * Composed rather than reimplemented. This is the sequence hard rule 6 depends on —
 * tmp → fsync → rename → fsync the directory — and a second copy of it here would be a
 * second thing to get right. `backupCount: 0` because a rolling backup *of a backup* is
 * clutter, and because the backup path is fresh every time so there is nothing to rotate.
 *
 * Its temp file is `<backup>.tmp`, which is deliberately not `<vault>.keep.tmp`: an
 * interrupted pre-merge copy must never be mistaken by `findOrphanedTemp` for an interrupted
 * save of the vault itself.
 */
async function writeBackupFile(path: string, bytes: Uint8Array): Promise<void> {
  await writeVaultFileAtomically(path, bytes, { backupCount: 0 });
}

/**
 * Reads the backup off the disk and proves it is the vault.
 *
 * Two checks, and both earn their place. The digest catches a truncated or partial write —
 * the failure a full disk produces, and the one that most looks like success. `readPreamble`
 * catches the case where the bytes round-tripped perfectly but were never a vault to begin
 * with: a backup of a corrupt file is not a backup anyone can restore from, and reporting it
 * as one is the failure this whole module exists to prevent.
 */
async function verify(
  path: string,
  source: Uint8Array,
  io: PreMergeBackupIo,
  fileName: string
): Promise<{ sizeBytes: number; generation: number }> {
  const unverifiable = (cause?: unknown): PreMergeBackupError =>
    new PreMergeBackupError(
      'backup-unverifiable',
      'The merge did not run: the pre-merge backup did not read back as an identical, readable vault, so it cannot be trusted. Nothing has been changed.',
      { cause, fileName }
    );

  let readBack: Uint8Array;
  try {
    readBack = await io.readBytes(path);
  } catch (cause) {
    throw unverifiable(cause);
  }

  if (digestOf(readBack) !== digestOf(source)) throw unverifiable();

  try {
    return { sizeBytes: readBack.length, generation: readPreamble(readBack).header.generation };
  } catch (cause) {
    throw unverifiable(cause);
  }
}

/**
 * SHA-256 of a file's bytes, hex.
 *
 * Deliberately not `bodyDigest` from `format/header.ts`: that one is defined as covering the
 * plaintext body and nothing else, and borrowing it here would quietly give one named concept
 * two meanings. This is a whole-file checksum for a copy, which is a different question.
 */
function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * `personal.keep.pre-merge-2026-09-03T01-44-12-908Z-9f3c1a2b.keep`
 *
 * Four properties, each deliberate:
 *
 *  - It **starts with the vault's own filename**, so it sorts next to it in any file browser
 *    and is obviously a copy of that vault rather than a stray.
 *  - It **says what it is and when**, to the millisecond, in the same stamp format
 *    `quarantineOrphanedTemp` already uses — a user can be told "the one from just before
 *    the merge on the 3rd" and find it.
 *  - It **ends with the vault's own extension**, so the file association opens it in Keyhold
 *    and the same master password unlocks it. Restoring is out of scope; being able to open
 *    the thing is not.
 *  - It carries a **random tail**. Two merges in the same millisecond, or a clock that went
 *    backwards over a DST change, would otherwise produce one name and the second copy would
 *    silently overwrite the first — which is losing a backup, the one thing this file cannot
 *    do. A random tail is race-free where a check-then-write is not.
 */
function backupFileName(vaultPath: string, takenAt: string): string {
  const stamp = takenAt.replace(/[:.]/g, '-');
  const token = Buffer.from(randomBytes(NAME_TOKEN_BYTES)).toString('hex');
  return `${basename(vaultPath)}${PRE_MERGE_INFIX}${stamp}-${token}${extname(vaultPath)}`;
}

/** The inverse of `backupFileName`'s stamp, for `listPreMergeBackups`. */
function takenAtFromName(vaultPath: string, fileName: string): string | null {
  const prefix = `${basename(vaultPath)}${PRE_MERGE_INFIX}`;
  const middle = fileName.slice(prefix.length, fileName.length - extname(vaultPath).length);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[0-9a-f]+$/.exec(middle);
  if (match === null) return null;
  return `${match[1] ?? ''}T${match[2] ?? ''}:${match[3] ?? ''}:${match[4] ?? ''}.${match[5] ?? ''}Z`;
}

/**
 * A path nothing is using.
 *
 * The random tail makes a collision vanishingly unlikely; this makes it *impossible* for the
 * names this process generates, at the cost of one `stat`. The residual race — two processes
 * drawing the same four random bytes in the same millisecond — is the only remaining case,
 * and it is not one worth a lock file.
 */
async function uniqueBackupPath(
  vaultPath: string,
  directory: string,
  takenAt: string
): Promise<string> {
  let candidate = join(directory, backupFileName(vaultPath, takenAt));
  for (let attempt = 1; attempt < NAME_ATTEMPTS; attempt += 1) {
    if (!(await exists(candidate))) return candidate;
    candidate = join(directory, backupFileName(vaultPath, takenAt));
  }
  return candidate;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Deletes all but the newest `retain` backups. Never the one just taken, never anything else. */
async function prune(
  vaultPath: string,
  directory: string,
  retain: number,
  keepPath: string
): Promise<void> {
  if (!Number.isFinite(retain) || retain <= 0) return;

  try {
    const existing = await listPreMergeBackups(vaultPath, { directory });
    for (const file of existing.slice(Math.floor(retain))) {
      // The newest is the one just taken, so it is already outside the slice. Checked anyway:
      // this is the only line in this file that deletes a copy of someone's vault.
      if (file.path === keepPath) continue;
      await rm(file.path, { force: true });
    }
  } catch {
    // Housekeeping never fails a merge that has a verified backup.
  }
}
