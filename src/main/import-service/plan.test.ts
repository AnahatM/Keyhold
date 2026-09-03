// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { previewRecord, type ImportRecordPreview } from '@shared/model/import-plan.js';
import { importFolderId } from '@shared/model/import.js';
import { collectFolderPaths, MAX_IMPORT_SAMPLE_SIZE, planFolders } from './plan.js';
import { emptyDocument } from './test-support.js';

/**
 * The two pieces of the dry run that are worth testing away from the service.
 *
 * `collectFolderPaths` in particular: it recomputes the folder list from the records' own
 * placeholders rather than trusting `ImportResult.folders`, and today every parser's
 * `FolderSet` already expands ancestors — so the service-level tests cannot tell the
 * defensive version from a naive one. This is the case that can: a declared list with the
 * ancestors missing, as a twelfth parser written next year could plausibly emit. The stage
 * that creates real folders in somebody's vault should not be relying on a promise it is
 * cheap to re-derive.
 */

function projection(folderPath: string | null, index = 0): ImportRecordPreview {
  return previewRecord(
    {
      title: `Record ${index}`,
      ...(folderPath === null ? {} : { folderId: importFolderId(folderPath) }),
    },
    index
  );
}

describe('collectFolderPaths', () => {
  it('expands ancestors the declared list left out', () => {
    expect(collectFolderPaths(['Work/Clients/Acme'], [])).toEqual([
      'Work',
      'Work/Clients',
      'Work/Clients/Acme',
    ]);
  });

  it('expands ancestors of a path only a record mentions', () => {
    expect(collectFolderPaths([], [projection('A/B/C')])).toEqual(['A', 'A/B', 'A/B/C']);
  });

  it('unions the two sources, deduplicates, and lists parents before children', () => {
    expect(
      collectFolderPaths(['Work', 'Personal'], [projection('Work/Clients'), projection('Work', 1)])
    ).toEqual(['Personal', 'Work', 'Work/Clients']);
  });

  it('ignores a record that is filed nowhere', () => {
    expect(collectFolderPaths([], [projection(null)])).toEqual([]);
  });
});

describe('planFolders', () => {
  it('counts the records filed at a path, not the ones in its subtree', () => {
    const projections = [projection('Work/Clients'), projection('Work/Clients', 1)];
    const paths = collectFolderPaths([], projections);

    expect(planFolders(emptyDocument(), paths, projections)).toEqual([
      { path: 'Work', willCreate: true, recordCount: 0 },
      { path: 'Work/Clients', willCreate: true, recordCount: 2 },
    ]);
  });
});

describe('the sample cap', () => {
  it('is a real number, well under what an export contains', () => {
    expect(MAX_IMPORT_SAMPLE_SIZE).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_IMPORT_SAMPLE_SIZE)).toBe(true);
  });
});
