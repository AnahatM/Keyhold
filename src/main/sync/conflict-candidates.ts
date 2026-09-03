// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { looksLikeConflictedCopy } from '@shared/model/cloud-folder.js';
import { PRE_MERGE_INFIX } from './pre-merge-backup.js';

/**
 * Finds the copies a sync client left beside the vault, and hands them to the renderer as ids.
 *
 * When two devices both save a vault that a cloud client is syncing, the client does not merge
 * — it picks a winner and writes the loser next to it under a name like
 * `personal (Anahat's conflicted copy 2026-09-03).keep`. Those files hold real edits, they are
 * easy to mistake for clutter, and the usual instinct is to delete them. This is what turns
 * them into something a user can act on.
 *
 * **No path crosses the bridge**, in either direction. Each candidate is described by an
 * opaque id and a filename, and the id is what comes back to start a merge. The renderer never
 * learns where the file is, and cannot name a file of its own choosing to be read — which is
 * the property that makes this safe to expose at all. Same arrangement as a merge plan id.
 *
 * **Everything here is read from the plaintext header**, so no key is needed and a candidate
 * can be described before the user commits to anything. That is what the header being
 * authenticated-but-not-encrypted is *for*; see `docs/04-Vault-Format`.
 */

/** A ceiling on how many files are opened during one scan. */
const MAX_FILES_EXAMINED = 200;

export interface ConflictCandidate {
  /** Opaque, minted here, and the only handle the renderer gets. */
  readonly id: string;
  /** The file's own name. Shown so the user can recognise which copy this is. */
  readonly fileName: string;
  readonly modifiedAt: number;
  readonly recordCount: number;
  /** How many times it has been saved. Higher than ours means it has edits we have not seen. */
  readonly generation: number;
}

/** What the scan needs to know about a file, without knowing how to read one. */
export interface CandidateHeader {
  readonly vaultId: string;
  readonly modifiedAt: number;
  readonly generation: number;
  readonly recordCount: number;
}

export interface ScanOptions {
  /** The open vault's own path. Its directory is scanned; the file itself is skipped. */
  readonly vaultPath: string;
  /** Only a copy of *this* vault is a candidate. A different id is somebody else's file. */
  readonly vaultId: string;
  /**
   * Reads a header without a key.
   *
   * Injected so the scan can be tested without writing real containers, and so this module
   * does not acquire a dependency on the container format it only wants four numbers from.
   */
  readonly readHeader: (path: string) => Promise<CandidateHeader | null>;
  readonly listDirectory?: ((directory: string) => Promise<readonly string[]>) | undefined;
}

/**
 * Whether a filename in the vault's own directory is worth opening.
 *
 * Three exclusions, and each one is a file that would otherwise be offered back to the user as
 * a merge candidate when it is nothing of the sort:
 *
 *  - **the vault itself** — merging a file with itself is a no-op that looks like a real offer;
 *  - **our own pre-merge backups** — they carry `PRE_MERGE_INFIX` and end in `.keep`, so they
 *    match everything else here. They are copies this app made on purpose, and offering one
 *    back would invite undoing a merge by re-merging its own backup;
 *  - **anything that is not a `.keep`** — the rolling `.keep.bak.N` slots and `.keep.tmp`
 *    staging files both live in this directory.
 */
export function isCandidateFileName(fileName: string, vaultFileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (lower === vaultFileName.toLowerCase()) return false;
  if (!lower.endsWith('.keep')) return false;
  if (lower.includes(PRE_MERGE_INFIX)) return false;
  return looksLikeConflictedCopy(fileName);
}

/**
 * A header, or `null` for any reason at all.
 *
 * A `try`/`catch` around the `await` rather than `.catch()` on the returned promise, because
 * the two are not the same: a reader that throws *synchronously* never returns a promise for
 * `.catch` to attach to, and the throw escapes. That is not hypothetical — it is how the
 * injected reader in this module's own tests behaves, and the difference showed up there.
 */
async function readHeaderSafely(
  read: (path: string) => Promise<CandidateHeader | null>,
  path: string
): Promise<CandidateHeader | null> {
  try {
    return await read(path);
  } catch {
    // A directory a sync client is working in holds half-written files and files it has
    // locked. One being unreadable at this instant says nothing about the next.
    return null;
  }
}

/**
 * The candidates beside the open vault, newest first.
 *
 * Failures are swallowed per file rather than aborting the scan. A directory shared with a
 * sync client contains half-written files, files being uploaded, and files the client has
 * locked; one of them being unreadable at this instant says nothing about the next, and a scan
 * that gives up on the first `EBUSY` would find nothing precisely when the client is busiest —
 * which is exactly when a conflicted copy has just appeared.
 */
export async function scanForConflictCandidates(options: ScanOptions): Promise<{
  readonly candidates: readonly ConflictCandidate[];
  readonly paths: Map<string, string>;
}> {
  const directory = dirname(options.vaultPath);
  const vaultFileName = basename(options.vaultPath);
  const list = options.listDirectory ?? ((where: string) => readdir(where));

  let names: readonly string[];
  try {
    names = await list(directory);
  } catch {
    // The vault's own directory being unreadable is not this feature's problem to report: the
    // vault is open, so it was readable a moment ago, and there is nothing useful to say.
    return { candidates: [], paths: new Map() };
  }

  const worthOpening = names
    .filter((name) => isCandidateFileName(name, vaultFileName))
    .slice(0, MAX_FILES_EXAMINED);

  const found: ConflictCandidate[] = [];
  const paths = new Map<string, string>();

  for (const name of worthOpening) {
    const path = join(directory, name);
    const header = await readHeaderSafely(options.readHeader, path);
    if (header === null) continue;

    // A different vault id is somebody else's file that happens to be named like a conflicted
    // copy. Merging it would put two people's credentials behind one master password, and the
    // check costs nothing because the id is in the plaintext header we already read.
    if (header.vaultId !== options.vaultId) continue;

    const id = randomUUID();
    paths.set(id, path);
    found.push({
      id,
      fileName: name,
      modifiedAt: header.modifiedAt,
      recordCount: header.recordCount,
      generation: header.generation,
    });
  }

  // Newest first: the copy most likely to hold the edits somebody is missing is the one written
  // most recently. Ties broken by name so the order is stable across scans rather than being
  // whatever the filesystem returned.
  found.sort((a, b) => b.modifiedAt - a.modifiedAt || a.fileName.localeCompare(b.fileName));

  return { candidates: found, paths };
}
