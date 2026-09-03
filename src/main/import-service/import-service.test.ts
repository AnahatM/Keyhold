// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ImportProgress, ImportSource } from '@shared/model/import-plan.js';
import { IMPORT_SAMPLE_SIZE } from '@shared/model/import-plan.js';
import { folderPathsById } from '../organisation/folder-tree.js';
import { ImportService } from './import-service.js';
import { IMPORT_ERROR_CODES, ImportServiceError } from './errors.js';
import {
  bitwardenCsv,
  fakePicker,
  FakeVault,
  textFile,
  type BitwardenRow,
} from './test-support.js';
import type { PickedImportFile } from './source-store.js';

/**
 * The import transaction, tested end to end without a vault file.
 *
 * Every case here runs the **real parser** over a **real Bitwarden CSV** and the real
 * `buildCredential`, `findOrCreateFolderPaths` and `applyPatch`. The only thing that is fake
 * is the vault's storage, which is why these run in milliseconds rather than needing a
 * master password and an Argon2 derivation each — see `FakeVault` in `test-support.ts`.
 *
 * The properties being defended, in the order they appear:
 *
 *  1. The preview and the commit are the same parse.
 *  2. Duplicates are grouped by the shared rule, and each of the three answers does what it
 *     says. The default answer adds nothing.
 *  3. `import-folder:` placeholders become real folders, ancestors and all.
 *  4. Undo removes exactly what the commit created, and refuses once the vault has moved.
 *  5. Discard leaves no source, no plan, and no readable bytes.
 *  6. No password out of the file reaches a preview, a warning, an error or a result.
 */

interface Harness {
  readonly service: ImportService;
  readonly vault: FakeVault;
  readonly progress: ImportProgress[];
  readonly picked: PickedImportFile[];
}

function harnessFor(csv: string, vault: FakeVault = new FakeVault()): Harness {
  const progress: ImportProgress[] = [];
  const picked: PickedImportFile[] = [];
  let handles = 0;

  const service = new ImportService({
    vault: vault.access,
    picker: fakePicker(() => {
      const file = textFile('export.csv', csv);
      picked.push(file);
      return file;
    }),
    onProgress: (event) => progress.push(event),
    newId: () => `h${(handles += 1)}`,
  });

  return { service, vault, progress, picked };
}

async function chooseFile(harness: Harness): Promise<ImportSource> {
  const source = await harness.service.chooseFile();
  expect(source).not.toBeNull();
  return source!;
}

const ROWS: readonly BitwardenRow[] = [
  { name: 'GitHub', uri: 'https://github.com', username: 'octocat', password: 'hunter2-github' },
  { name: 'Bank', uri: 'https://bank.example', username: 'alice', password: 'hunter2-bank' },
  { name: 'Forum', uri: 'https://forum.example', username: 'alice', password: 'hunter2-forum' },
];

function titlesIn(vault: FakeVault): string[] {
  return vault.document.records.map((record) => record.title).sort();
}

// ── 1. One parse, two uses ───────────────────────────────────────────────────

describe('preview and commit', () => {
  it('commits exactly the records the preview described', async () => {
    const harness = harnessFor(bitwardenCsv(ROWS));
    const source = await chooseFile(harness);

    const preview = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });

    expect(preview.recordCount).toBe(3);
    expect(preview.newRecordCount).toBe(3);
    expect(preview.duplicates).toEqual([]);
    expect(preview.sample.map((record) => record.title)).toEqual(['GitHub', 'Bank', 'Forum']);

    const result = await harness.service.commit({
      planId: preview.planId,
      duplicateActions: {},
    });

    expect(result.importedCount).toBe(3);
    expect(result.skippedCount).toBe(0);
    expect(result.mergedCount).toBe(0);
    expect(titlesIn(harness.vault)).toEqual(['Bank', 'Forum', 'GitHub']);

    // The preview said how long each password was without ever holding one. That number
    // matching the committed record is the observable form of "same parse, twice".
    for (const projection of preview.sample) {
      const record = harness.vault.document.records.find((r) => r.title === projection.title);
      expect(record?.fields.password.length).toBe(projection.passwordLength);
      expect(record?.fields.username).toBe(projection.username);
    }
  });

  it('commits the parse it was shown, even when the vault moved underneath it', async () => {
    const harness = harnessFor(bitwardenCsv(ROWS));
    const source = await chooseFile(harness);
    const preview = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });

    // Something else writes to the vault between the dry run and the commit.
    harness.vault.seed({ title: 'Unrelated', username: 'someone' });

    const result = await harness.service.commit({ planId: preview.planId, duplicateActions: {} });
    expect(result.importedCount).toBe(3);
    expect(titlesIn(harness.vault)).toEqual(['Bank', 'Forum', 'GitHub', 'Unrelated']);
  });

  it('mints a plan the commit consumes, so the same plan cannot be committed twice', async () => {
    const harness = harnessFor(bitwardenCsv(ROWS));
    const source = await chooseFile(harness);
    const preview = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });

    await harness.service.commit({ planId: preview.planId, duplicateActions: {} });
    await expect(
      harness.service.commit({ planId: preview.planId, duplicateActions: {} })
    ).rejects.toMatchObject({ code: IMPORT_ERROR_CODES.stalePlan });
    expect(harness.vault.document.records).toHaveLength(3);
  });

  it('reports determinate progress through the phases', async () => {
    const harness = harnessFor(bitwardenCsv(ROWS));
    const source = await chooseFile(harness);
    const preview = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });
    await harness.service.commit({ planId: preview.planId, duplicateActions: {} });

    expect([...new Set(harness.progress.map((event) => event.phase))]).toEqual([
      'parsing',
      'matching',
      'writing',
      'saving',
    ]);
    expect(harness.progress.every((event) => event.total > 0)).toBe(true);
    expect(harness.progress.every((event) => event.completed <= event.total)).toBe(true);
  });

  it('refuses a format that needs a mapping without one', async () => {
    const harness = harnessFor(bitwardenCsv(ROWS));
    const source = await chooseFile(harness);
    expect(() =>
      harness.service.preview({
        sourceId: source.sourceId,
        formatId: 'generic-csv',
        sampleSize: IMPORT_SAMPLE_SIZE,
      })
    ).toThrow(ImportServiceError);
  });

  it('detects the format and offers the header row for mapping', async () => {
    const harness = harnessFor(bitwardenCsv(ROWS));
    const source = await chooseFile(harness);

    expect(source.detectedFormatId).toBe('bitwarden-csv');
    expect(source.fileName).toBe('export.csv');
    expect(source.extension).toBe('.csv');
    expect(source.columns).toContain('login_password');
    expect(source.inferredMapping).not.toBeNull();
  });
});

// ── 2. Duplicates ────────────────────────────────────────────────────────────

async function previewAgainstExisting(
  rows: readonly BitwardenRow[] = ROWS.slice(0, 1)
): Promise<{ harness: Harness; planId: string; key: string }> {
  const vault = new FakeVault();
  vault.seed({
    title: 'GitHub',
    username: 'octocat',
    urls: ['https://github.com'],
    password: 'old-password',
  });

  const harness = harnessFor(bitwardenCsv(rows), vault);
  const source = await chooseFile(harness);
  const preview = harness.service.preview({
    sourceId: source.sourceId,
    formatId: 'bitwarden-csv',
    sampleSize: IMPORT_SAMPLE_SIZE,
  });

  expect(preview.duplicates).toHaveLength(1);
  const group = preview.duplicates[0];
  expect(group?.existing?.title).toBe('GitHub');
  return { harness, planId: preview.planId, key: group?.key ?? '' };
}

describe('duplicates', () => {
  it('groups an incoming record against the vault on title, identity and host', async () => {
    const { harness, planId } = await previewAgainstExisting();
    expect(planId).not.toBe('');
    expect(harness.vault.document.records).toHaveLength(1);
  });

  it('skips by default, changing nothing', async () => {
    const { harness, planId } = await previewAgainstExisting();

    const result = await harness.service.commit({ planId, duplicateActions: {} });
    expect(result).toMatchObject({ importedCount: 0, skippedCount: 1, mergedCount: 0 });
    expect(harness.vault.document.records).toHaveLength(1);
    expect(harness.vault.document.records[0]?.fields.password).toBe('old-password');
  });

  it('imports anyway when asked, leaving both records', async () => {
    const { harness, planId, key } = await previewAgainstExisting();

    const result = await harness.service.commit({
      planId,
      duplicateActions: { [key]: 'import-anyway' },
    });
    expect(result).toMatchObject({ importedCount: 1, skippedCount: 0, mergedCount: 0 });
    expect(harness.vault.document.records).toHaveLength(2);
  });

  it('merges when asked, replacing the password on the record the vault already had', async () => {
    const { harness, planId, key } = await previewAgainstExisting();

    const result = await harness.service.commit({
      planId,
      duplicateActions: { [key]: 'merge' },
    });
    expect(result).toMatchObject({ importedCount: 0, skippedCount: 0, mergedCount: 1 });
    expect(harness.vault.document.records).toHaveLength(1);
    expect(harness.vault.document.records[0]?.fields.password).toBe('hunter2-github');
    // A merge is an edit, so it leaves a history version like any other edit.
    expect(harness.vault.document.records[0]?.history.versions).toHaveLength(1);
  });

  it('says on the dry run that a merge would replace the password', async () => {
    const vault = new FakeVault();
    vault.seed({
      title: 'GitHub',
      username: 'octocat',
      urls: ['https://github.com'],
      password: 'old-password',
    });
    const harness = harnessFor(bitwardenCsv(ROWS.slice(0, 1)), vault);
    const source = await chooseFile(harness);
    const preview = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });

    expect(preview.duplicates[0]?.mergeableFields).toContainEqual({
      field: 'password',
      effect: 'replaces',
    });
  });

  it('keeps one copy of a row duplicated inside the file, under the default answer', async () => {
    const rows = [ROWS[0]!, ROWS[0]!, ROWS[1]!];
    const harness = harnessFor(bitwardenCsv(rows));
    const source = await chooseFile(harness);
    const preview = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });

    expect(preview.duplicates).toHaveLength(1);
    expect(preview.duplicates[0]?.existing).toBeNull();
    expect(preview.newRecordCount).toBe(1);

    const result = await harness.service.commit({ planId: preview.planId, duplicateActions: {} });
    expect(result).toMatchObject({ importedCount: 2, skippedCount: 1, mergedCount: 0 });
    expect(titlesIn(harness.vault)).toEqual(['Bank', 'GitHub']);
  });

  it('importing the same file twice adds nothing the second time', async () => {
    const csv = bitwardenCsv(ROWS);
    const vault = new FakeVault();

    for (const expected of [3, 0]) {
      const harness = harnessFor(csv, vault);
      const source = await chooseFile(harness);
      const preview = harness.service.preview({
        sourceId: source.sourceId,
        formatId: 'bitwarden-csv',
        sampleSize: IMPORT_SAMPLE_SIZE,
      });
      const result = await harness.service.commit({
        planId: preview.planId,
        duplicateActions: {},
      });
      expect(result.importedCount).toBe(expected);
    }

    expect(vault.document.records).toHaveLength(3);
  });

  it('does not match against a record in the trash', async () => {
    const vault = new FakeVault();
    const record = vault.seed({
      title: 'GitHub',
      username: 'octocat',
      urls: ['https://github.com'],
    });
    vault.document = {
      ...vault.document,
      records: vault.document.records.map((r) => (r.id === record.id ? { ...r, trashedAt: 1 } : r)),
    };

    const harness = harnessFor(bitwardenCsv(ROWS.slice(0, 1)), vault);
    const source = await chooseFile(harness);
    const preview = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });

    expect(preview.duplicates).toEqual([]);
    expect(preview.newRecordCount).toBe(1);
  });

  it('the three counts always account for every record in the file', async () => {
    const rows = [...ROWS, ROWS[0]!];
    const vault = new FakeVault();
    vault.seed({ title: 'Bank', username: 'alice', urls: ['https://bank.example'] });

    const harness = harnessFor(bitwardenCsv(rows), vault);
    const source = await chooseFile(harness);
    const preview = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });

    const actions: Record<string, 'skip' | 'import-anyway' | 'merge'> = {};
    for (const [index, group] of preview.duplicates.entries()) {
      actions[group.key] = index === 0 ? 'merge' : 'import-anyway';
    }

    const result = await harness.service.commit({
      planId: preview.planId,
      duplicateActions: actions,
    });
    expect(result.importedCount + result.skippedCount + result.mergedCount).toBe(
      preview.recordCount
    );
  });

  it('falls back to the safe answer for a decision map that is nonsense', async () => {
    const { harness, planId, key } = await previewAgainstExisting();
    const result = await harness.service.commit({
      planId,
      duplicateActions: { [key]: 'obliterate' } as unknown as Record<string, 'skip'>,
    });
    expect(result.skippedCount).toBe(1);
    expect(harness.vault.document.records).toHaveLength(1);
  });
});

// ── 3. Folders ───────────────────────────────────────────────────────────────

describe('folders', () => {
  const FOLDER_ROWS: readonly BitwardenRow[] = [
    { folder: 'Work/Clients/Acme', name: 'Acme portal', username: 'a', password: 'p1' },
    { folder: 'Work', name: 'Payroll', username: 'b', password: 'p2' },
    { folder: 'Personal', name: 'Streaming', username: 'c', password: 'p3' },
  ];

  it('creates every missing ancestor and reuses the one the vault already had', async () => {
    const vault = new FakeVault();
    const workId = vault.seedFolder('Work');

    const harness = harnessFor(bitwardenCsv(FOLDER_ROWS), vault);
    const source = await chooseFile(harness);
    const preview = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });

    expect(preview.folders.map((folder) => folder.path)).toEqual([
      'Personal',
      'Work',
      'Work/Clients',
      'Work/Clients/Acme',
    ]);
    expect(preview.folders.map((folder) => folder.willCreate)).toEqual([true, false, true, true]);
    // Counted at the path, not across the subtree: `Work/Clients` holds nothing itself.
    expect(preview.folders.map((folder) => folder.recordCount)).toEqual([1, 1, 0, 1]);

    const result = await harness.service.commit({ planId: preview.planId, duplicateActions: {} });
    expect([...result.createdFolderPaths]).toEqual([
      'Personal',
      'Work/Clients',
      'Work/Clients/Acme',
    ]);

    const paths = folderPathsById(vault.document.folders);
    const byPath = new Map([...paths].map(([id, path]) => [path, id]));
    expect(byPath.get('Work')).toBe(workId);

    const filed = new Map(
      vault.document.records.map((record) => [
        record.title,
        record.folderId === null ? null : (paths.get(record.folderId) ?? '?'),
      ])
    );
    expect(filed.get('Acme portal')).toBe('Work/Clients/Acme');
    expect(filed.get('Payroll')).toBe('Work');
    expect(filed.get('Streaming')).toBe('Personal');
  });

  it('reuses a folder whose name differs only in case, without renaming it', async () => {
    const vault = new FakeVault();
    const workId = vault.seedFolder('Work');

    const harness = harnessFor(
      bitwardenCsv([{ folder: 'work', name: 'Payroll', username: 'b', password: 'p' }]),
      vault
    );
    const source = await chooseFile(harness);
    const preview = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });
    await harness.service.commit({ planId: preview.planId, duplicateActions: {} });

    expect(vault.document.folders).toHaveLength(1);
    expect(vault.document.folders[0]?.name).toBe('Work');
    expect(vault.document.records[0]?.folderId).toBe(workId);
  });

  it('creates no folder for a record the user chose to skip', async () => {
    const vault = new FakeVault();
    vault.seed({ title: 'Payroll', username: 'b', urls: [] });

    const harness = harnessFor(
      bitwardenCsv([{ folder: 'Work/Clients', name: 'Payroll', username: 'b', password: 'p' }]),
      vault
    );
    const source = await chooseFile(harness);
    const preview = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });
    expect(preview.duplicates).toHaveLength(1);

    const result = await harness.service.commit({ planId: preview.planId, duplicateActions: {} });
    expect(result.createdFolderPaths).toEqual([]);
    expect(vault.document.folders).toEqual([]);
  });
});

// ── 4. Undo ──────────────────────────────────────────────────────────────────

describe('undo', () => {
  it('removes exactly what the commit created, and nothing else', async () => {
    const vault = new FakeVault();
    const untouched = vault.seed({ title: 'Kept', username: 'me', password: 'keep-me' });
    const keptFolder = vault.seedFolder('Existing');
    const before = structuredClone(vault.document.records);

    const harness = harnessFor(
      bitwardenCsv([
        { folder: 'Imported/Deep', name: 'One', username: 'x', password: 'p1' },
        { folder: 'Imported/Deep', name: 'Two', username: 'y', password: 'p2' },
      ]),
      vault
    );
    const source = await chooseFile(harness);
    const preview = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });
    const result = await harness.service.commit({ planId: preview.planId, duplicateActions: {} });
    expect(result.undoable).toBe(true);
    expect(vault.document.records).toHaveLength(3);

    const undone = await harness.service.undo({
      batchId: result.batchId,
      expectedVaultGeneration: result.vaultGeneration,
    });

    expect(undone).toMatchObject({ undone: true, removedCount: 2, restoredCount: 0 });
    expect([...undone.removedFolderPaths]).toEqual(['Imported', 'Imported/Deep']);
    expect(vault.document.records).toEqual(before);
    expect(vault.document.records[0]?.id).toBe(untouched.id);
    expect(vault.document.folders.map((folder) => folder.id)).toEqual([keptFolder]);
  });

  it("refuses when the caller's own view of the vault is out of date", async () => {
    const harness = harnessFor(bitwardenCsv(ROWS));
    const source = await chooseFile(harness);
    const preview = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });
    const result = await harness.service.commit({ planId: preview.planId, duplicateActions: {} });

    // The vault has not moved; the *caller* is holding a stale number. That is what
    // `ImportUndoRequest.expectedVaultGeneration` is for, and it has to be checked
    // independently of the batch's own recorded generation — a renderer asking to undo
    // something other than what it thinks it is undoing is exactly the request to refuse.
    await expect(
      harness.service.undo({
        batchId: result.batchId,
        expectedVaultGeneration: result.vaultGeneration - 1,
      })
    ).rejects.toMatchObject({ code: IMPORT_ERROR_CODES.staleUndo });
    expect(harness.vault.document.records).toHaveLength(3);
  });

  it('puts a merged record back exactly as it was', async () => {
    const { harness, planId, key } = await previewAgainstExisting();
    const before = structuredClone(harness.vault.document.records[0]);

    const result = await harness.service.commit({
      planId,
      duplicateActions: { [key]: 'merge' },
    });
    expect(harness.vault.document.records[0]?.fields.password).toBe('hunter2-github');

    const undone = await harness.service.undo({
      batchId: result.batchId,
      expectedVaultGeneration: result.vaultGeneration,
    });

    expect(undone).toMatchObject({ undone: true, removedCount: 0, restoredCount: 1 });
    expect(harness.vault.document.records[0]).toEqual(before);
  });

  it('refuses once the vault has been saved again', async () => {
    const harness = harnessFor(bitwardenCsv(ROWS));
    const source = await chooseFile(harness);
    const preview = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });
    const result = await harness.service.commit({ planId: preview.planId, duplicateActions: {} });

    harness.vault.generation += 1;

    await expect(
      harness.service.undo({
        batchId: result.batchId,
        expectedVaultGeneration: result.vaultGeneration,
      })
    ).rejects.toMatchObject({ code: IMPORT_ERROR_CODES.staleUndo });
    expect(harness.vault.document.records).toHaveLength(3);
  });

  it('refuses while an unsaved edit is outstanding, even at the right generation', async () => {
    const harness = harnessFor(bitwardenCsv(ROWS));
    const source = await chooseFile(harness);
    const preview = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });
    const result = await harness.service.commit({ planId: preview.planId, duplicateActions: {} });

    // The generation moves only on a save, so an edit that has not been saved is invisible
    // to a generation-only check — and is exactly the edit an undo would silently destroy.
    harness.vault.dirty = true;

    await expect(
      harness.service.undo({
        batchId: result.batchId,
        expectedVaultGeneration: result.vaultGeneration,
      })
    ).rejects.toMatchObject({ code: IMPORT_ERROR_CODES.staleUndo });
    expect(harness.vault.document.records).toHaveLength(3);
  });

  it('cannot be run twice', async () => {
    const harness = harnessFor(bitwardenCsv(ROWS));
    const source = await chooseFile(harness);
    const preview = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });
    const result = await harness.service.commit({ planId: preview.planId, duplicateActions: {} });

    const undone = await harness.service.undo({
      batchId: result.batchId,
      expectedVaultGeneration: result.vaultGeneration,
    });
    await expect(
      harness.service.undo({
        batchId: result.batchId,
        expectedVaultGeneration: undone.removedCount + result.vaultGeneration,
      })
    ).rejects.toMatchObject({ code: IMPORT_ERROR_CODES.staleUndo });
  });

  it('survives the wizard discarding its file first', async () => {
    const harness = harnessFor(bitwardenCsv(ROWS));
    const source = await chooseFile(harness);
    const preview = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });
    const result = await harness.service.commit({ planId: preview.planId, duplicateActions: {} });

    harness.service.discard(source.sourceId);

    const undone = await harness.service.undo({
      batchId: result.batchId,
      expectedVaultGeneration: result.vaultGeneration,
    });
    expect(undone.removedCount).toBe(3);
    expect(harness.vault.document.records).toEqual([]);
  });
});

// ── 5. Discard ───────────────────────────────────────────────────────────────

describe('discard', () => {
  it('zeroes the bytes and leaves no source or plan behind', async () => {
    const harness = harnessFor(bitwardenCsv(ROWS));
    const source = await chooseFile(harness);
    const preview = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });

    const bytes = harness.picked[0]?.bytes;
    expect(bytes?.some((byte) => byte !== 0)).toBe(true);

    harness.service.discard(source.sourceId);

    expect(harness.service.heldSourceCount).toBe(0);
    expect(bytes?.every((byte) => byte === 0)).toBe(true);

    expect(() =>
      harness.service.preview({
        sourceId: source.sourceId,
        formatId: 'bitwarden-csv',
        sampleSize: IMPORT_SAMPLE_SIZE,
      })
    ).toThrow(ImportServiceError);
    await expect(
      harness.service.commit({ planId: preview.planId, duplicateActions: {} })
    ).rejects.toMatchObject({ code: IMPORT_ERROR_CODES.stalePlan });
    expect(harness.vault.document.records).toEqual([]);
  });

  it('is safe to call twice, and for a source that was never held', async () => {
    const harness = harnessFor(bitwardenCsv(ROWS));
    const source = await chooseFile(harness);

    harness.service.discard(source.sourceId);
    harness.service.discard(source.sourceId);
    harness.service.discard('never-existed');
    expect(harness.service.heldSourceCount).toBe(0);
  });

  it('drops everything, batches included, when the vault closes', async () => {
    const harness = harnessFor(bitwardenCsv(ROWS));
    const source = await chooseFile(harness);
    const preview = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });
    const result = await harness.service.commit({ planId: preview.planId, duplicateActions: {} });

    harness.service.discardAll();

    await expect(
      harness.service.undo({
        batchId: result.batchId,
        expectedVaultGeneration: result.vaultGeneration,
      })
    ).rejects.toMatchObject({ code: IMPORT_ERROR_CODES.staleUndo });
  });

  it('supersedes a plan rather than keeping a second parse of the same file', async () => {
    const harness = harnessFor(bitwardenCsv(ROWS));
    const source = await chooseFile(harness);

    const first = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });
    const second = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });
    expect(first.planId).not.toBe(second.planId);

    await expect(
      harness.service.commit({ planId: first.planId, duplicateActions: {} })
    ).rejects.toMatchObject({ code: IMPORT_ERROR_CODES.stalePlan });
    const result = await harness.service.commit({ planId: second.planId, duplicateActions: {} });
    expect(result.importedCount).toBe(3);
  });
});

// ── 6. No secret crosses ─────────────────────────────────────────────────────

/**
 * A corpus of records whose secrets are unmistakable.
 *
 * Deterministic — `Math.random` is banned project-wide and would make a failure here
 * unreproducible, which is the one thing a leak test must never be. The passwords carry the
 * characters that break naive escaping (quotes, commas, newlines, non-ASCII) because those
 * are the ones a serialiser is most likely to mangle into something that survives a naive
 * `includes` check.
 */
const SECRET_FRAGMENTS = ['"', ',', '\n', '\\', 'é', '<b>', '${x}', '%s', ' '] as const;

function corpus(): { rows: BitwardenRow[]; secrets: string[] } {
  const rows: BitwardenRow[] = [];
  const secrets: string[] = [];

  for (const [index, fragment] of SECRET_FRAGMENTS.entries()) {
    const password = `PWD${index}${fragment}zzz${index}`;
    const note = `NOTE${index}${fragment}zzz${index}`;
    const hidden = `HIDDEN${index}${fragment}zzz${index}`;
    secrets.push(password, note, hidden);
    rows.push({
      name: `Site ${index}`,
      uri: `https://site${index}.example`,
      username: `user${index}`,
      password,
      notes: note,
      fields: `password: ${hidden}`,
    });
  }
  return { rows, secrets };
}

describe('the safe projection', () => {
  it('never lets a parsed secret reach a preview, a warning, a result or an error', async () => {
    const { rows, secrets } = corpus();
    const harness = harnessFor(bitwardenCsv(rows));
    const source = await chooseFile(harness);

    const seen: unknown[] = [source];

    const preview = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: rows.length,
    });
    seen.push(preview);

    // The error paths too: a message built from a parse failure is the classic way a
    // fragment of the file escapes.
    try {
      harness.service.preview({
        sourceId: 'not-a-source',
        formatId: 'bitwarden-csv',
        sampleSize: 5,
      });
    } catch (error) {
      seen.push(serialiseError(error));
    }
    try {
      harness.service.preview({
        sourceId: source.sourceId,
        formatId: 'bitwarden-json',
        sampleSize: 5,
      });
    } catch (error) {
      seen.push(serialiseError(error));
    }

    const result = await harness.service.commit({ planId: preview.planId, duplicateActions: {} });
    seen.push(result);

    try {
      await harness.service.commit({ planId: preview.planId, duplicateActions: {} });
    } catch (error) {
      seen.push(serialiseError(error));
    }

    // Compared in their **JSON-escaped** form, not raw. A password containing a quote or a
    // newline appears in serialised output as `\"` and `\n`, so a raw `toContain` would miss
    // a leak of exactly the values most likely to be mishandled — and would pass while
    // leaking them.
    const escaped = (value: string): string => JSON.stringify(value).slice(1, -1);

    // The test would pass vacuously if the parse had failed, so prove the secrets were
    // genuinely there to leak.
    const vaultText = JSON.stringify(harness.vault.document);
    for (const secret of secrets) expect(vaultText).toContain(escaped(secret));

    const crossed = JSON.stringify(seen);
    for (const secret of secrets) {
      expect(crossed).not.toContain(escaped(secret));
      expect(crossed).not.toContain(secret);
    }
  });

  it('names the position of a record the vault refused, and nothing out of it', async () => {
    const longTitle = `T${'o'.repeat(500)}`;
    const harness = harnessFor(
      bitwardenCsv([
        { name: 'Fine', username: 'a', password: 'p1' },
        { name: longTitle, username: 'b', password: 'secret-of-the-long-one' },
      ])
    );
    const source = await chooseFile(harness);
    const preview = harness.service.preview({
      sourceId: source.sourceId,
      formatId: 'bitwarden-csv',
      sampleSize: IMPORT_SAMPLE_SIZE,
    });

    const result = await harness.service.commit({ planId: preview.planId, duplicateActions: {} });

    expect(result.importedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.warnings).toHaveLength(1);
    const message = result.warnings[0]?.message ?? '';
    expect(message).toContain('Record 2');
    expect(message).not.toContain(longTitle);
    expect(message).not.toContain('secret-of-the-long-one');
  });
});

function serialiseError(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { value: String(error) };
}
