// SPDX-License-Identifier: GPL-3.0-or-later
import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RecoveryReport } from '@shared/model/recovery.js';
import type { VaultDocument } from '@shared/model/vault-document.js';
import { readVaultFile } from '../vault/atomic-write.js';
import { diagnoseDocument } from './document-diagnosis.js';
import { inspectVaultFile } from './file-inspection.js';
import { buildRecoveryReport } from './report.js';
import { surveyVaultFiles, type DirectoryEntry } from './survey.js';

/**
 * The one function that runs a diagnosis, and the only thing in `recovery/` that touches disk.
 *
 * Everything else here is pure — `inspectVaultFile` takes bytes, `surveyVaultFiles` takes a
 * listing, `diagnoseDocument` takes a document — which is why they were all finished, all
 * tested and reachable from nothing. There was no function that read a folder and called them,
 * so there was nothing an IPC handler could invoke. This is that function.
 *
 * **It is the answer to "my vault will not open".** The container is read without a password,
 * so it works on a vault nobody can unlock; the folder beside it is surveyed and ranked, so
 * the report can say which backup is the newest intact one; and the document is diagnosed only
 * when one happens to be open, because that check needs decrypted contents.
 *
 * ## Reading the neighbours' bytes is a deliberate cost
 *
 * Every candidate file is read in full so its header and framing can be examined. That turns
 * "8 MB, modified Tuesday" into "generation 214, header intact, container complete", which is
 * the difference between a guess and an answer — and this runs when somebody is already in
 * trouble, where being slow matters far less than being vague. Files past
 * `MAX_SURVEYED_BYTES` are listed without their bytes rather than skipped: a 4 GB file in the
 * folder is not a vault, and reading it to find that out would hang the dialog.
 */

/**
 * Past this, a file is listed but not read. No Keyhold vault approaches it.
 *
 * Exported for the test, which asserts both sides of the branch. The alternative is the test
 * writing `256 * 1024 * 1024` itself, which is the second copy of a number hard rule 8 exists
 * to prevent — and the copy that would silently stop matching if this were ever tuned.
 */
export const MAX_SURVEYED_BYTES = 256 * 1024 * 1024;

export interface DiagnoseInput {
  readonly vaultPath: string;
  readonly generatedAt: number;
  /** The open document, when there is one. Absent means the document checks are skipped. */
  readonly document?: VaultDocument | null | undefined;
}

export async function diagnoseVault(input: DiagnoseInput): Promise<RecoveryReport> {
  const folder = dirname(input.vaultPath);

  // Read the vault itself first and separately: it is the subject, and a folder that cannot
  // be listed must not stop the one file the user actually asked about from being inspected.
  let ownBytes: Uint8Array | null = null;
  try {
    ownBytes = await readVaultFile(input.vaultPath);
  } catch {
    // Left null. `buildRecoveryReport` says "not inspected — no bytes were supplied", which
    // is the honest line: a file that cannot be read is itself the finding.
  }

  const entries: DirectoryEntry[] = [];
  try {
    for (const name of await readdir(folder)) {
      const path = join(folder, name);
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        entries.push({
          path,
          sizeBytes: info.size,
          modifiedAt: info.mtimeMs,
          ...(info.size <= MAX_SURVEYED_BYTES
            ? { bytes: path === input.vaultPath && ownBytes !== null ? ownBytes : await read(path) }
            : {}),
        });
      } catch {
        // One unreadable neighbour — a lock file, a permissions oddity — must not lose the
        // rest of the listing. Skipped silently: it is not the file being diagnosed.
      }
    }
  } catch {
    // No listing. The report says the folder was not surveyed, which is true and useful.
  }

  return buildRecoveryReport({
    vaultPath: input.vaultPath,
    generatedAt: input.generatedAt,
    file: ownBytes === null ? null : inspectVaultFile(ownBytes),
    survey: entries.length === 0 ? null : surveyVaultFiles({ vaultPath: input.vaultPath, entries }),
    diagnosis:
      input.document == null ? null : diagnoseDocument(input.document, { now: input.generatedAt }),
  });
}

async function read(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readVaultFile(path);
  } catch {
    return undefined;
  }
}
