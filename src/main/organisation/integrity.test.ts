// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { importFolderId } from '@shared/model/import.js';
import {
  emptyVaultDocument,
  type Folder,
  type Tag,
  type VaultDocument,
} from '@shared/model/vault-document.js';
import { ORGANISATION_ISSUE_KINDS, checkOrganisation, isOrganisationSound } from './integrity.js';
import type { OrganisationIssueKind } from './integrity.js';
import { addRecord, credential } from './test-support.js';

/**
 * Organisation integrity.
 *
 * Every state below is what a vault actually looks like after a merge, a partial restore,
 * or an import that committed records before its folders — not a hypothetical. The point of
 * the module is that it **reports and does not repair**, so the tests assert both halves:
 * the issue fires, and the document comes back untouched.
 */

const folder = (id: string, name: string, parentId: string | null = null): Folder => ({
  id,
  name,
  parentId,
  order: 0,
});

const tag = (id: string, name: string): Tag => ({ id, name, colour: 'text-muted' });

const kinds = (document: VaultDocument): readonly OrganisationIssueKind[] =>
  checkOrganisation(document).map((issue) => issue.kind);

describe('a healthy document', () => {
  it('reports nothing', () => {
    let document: VaultDocument = {
      ...emptyVaultDocument(),
      folders: [folder('a', 'Work'), folder('b', 'Clients', 'a')],
      tags: [tag('t1', 'Work')],
    };
    document = addRecord(document, credential('one', { folderId: 'b', tags: ['Work'] }));
    document = addRecord(document, credential('two', { folderId: null }));

    expect(checkOrganisation(document)).toEqual([]);
    expect(isOrganisationSound(document)).toBe(true);
  });
});

describe('each check fires on its own defect', () => {
  it('record-missing-folder: a record filed under a folder that is gone', () => {
    let document: VaultDocument = { ...emptyVaultDocument(), folders: [folder('a', 'Work')] };
    document = addRecord(document, credential('orphan', { folderId: 'vanished' }));
    document = addRecord(document, credential('also', { folderId: 'vanished' }));

    const issues = checkOrganisation(document);
    expect(issues.map((issue) => issue.kind)).toEqual(['record-missing-folder']);
    // Grouped by the missing folder, so the UI can offer one decision rather than two.
    expect(issues[0]?.folderIds).toEqual(['vanished']);
    expect(issues[0]?.recordIds).toHaveLength(2);
  });

  it('folder-missing-parent: a subtree detached from every root', () => {
    const document: VaultDocument = {
      ...emptyVaultDocument(),
      folders: [folder('a', 'Work', 'gone'), folder('b', 'Clients', 'a')],
    };
    const issues = checkOrganisation(document);
    expect(issues.map((issue) => issue.kind)).toEqual(['folder-missing-parent']);
    expect(issues[0]?.folderIds).toEqual(['a']);
  });

  it('folder-cycle: two folders that are each other’s parent', () => {
    const document: VaultDocument = {
      ...emptyVaultDocument(),
      folders: [folder('a', 'A', 'b'), folder('b', 'B', 'a')],
    };
    const issues = checkOrganisation(document);
    expect(issues.map((issue) => issue.kind)).toEqual(['folder-cycle']);
    // Reported once for the loop, not once per member.
    expect(issues[0]?.folderIds).toEqual(['a', 'b']);
  });

  it('folder-cycle: a long loop, reported once whichever member is reached first', () => {
    const document: VaultDocument = {
      ...emptyVaultDocument(),
      folders: [
        folder('a', 'A', 'd'),
        folder('b', 'B', 'a'),
        folder('c', 'C', 'b'),
        folder('d', 'D', 'c'),
      ],
    };
    const issues = checkOrganisation(document);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.folderIds).toEqual(['a', 'b', 'c', 'd']);
  });

  it('folder-cycle: names the loop, not the folders that merely point into it', () => {
    // N19's neighbour. The walk's `seen` set held the whole path, so `f0` — healthy, and
    // simply parented under a folder that happens to be in a loop — was counted as a member
    // and the same loop was reported twice, once per distinct path into it.
    const document: VaultDocument = {
      ...emptyVaultDocument(),
      folders: [folder('f0', 'Tail', 'f1'), folder('f1', 'One', 'f2'), folder('f2', 'Two', 'f1')],
    };
    const issues = checkOrganisation(document);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.folderIds).toEqual(['f1', 'f2']);
    expect(issues[0]?.message).toContain('2 folders');
  });

  it('does not hang on a cycle', () => {
    // A malformed vault must render badly, never hang with the UI thread inside the walk.
    const folders: Folder[] = [];
    for (let index = 0; index < 200; index += 1) {
      folders.push(folder(`f${index}`, `F${index}`, `f${(index + 1) % 200}`));
    }
    const document: VaultDocument = { ...emptyVaultDocument(), folders };
    expect(kinds(document)).toEqual(['folder-cycle']);
  });

  it('record-missing-tag: a name on a record the vault does not declare', () => {
    let document: VaultDocument = { ...emptyVaultDocument(), tags: [tag('t1', 'Work')] };
    document = addRecord(document, credential('one', { tags: ['Work', 'Imported'] }));

    const issues = checkOrganisation(document);
    expect(issues.map((issue) => issue.kind)).toEqual(['record-missing-tag']);
    expect(issues[0]?.name).toBe('imported');
  });

  it('duplicate-folder-name: two siblings sharing a name', () => {
    const document: VaultDocument = {
      ...emptyVaultDocument(),
      folders: [
        folder('a', 'Work'),
        { ...folder('b', 'work'), order: 1 },
        // A different parent is not a conflict.
        folder('c', 'Work', 'a'),
      ],
    };
    const issues = checkOrganisation(document);
    expect(issues.map((issue) => issue.kind)).toEqual(['duplicate-folder-name']);
    expect(issues[0]?.folderIds).toEqual(['a', 'b']);
  });

  it('duplicate-tag-name: two entries that fold to one name', () => {
    // What a merge of two vaults trivially produces: each device created `Work`
    // independently, with its own id and colour, and neither is wrong.
    const document: VaultDocument = {
      ...emptyVaultDocument(),
      tags: [tag('t1', 'Work'), tag('t2', 'WORK')],
    };
    const issues = checkOrganisation(document);
    expect(issues.map((issue) => issue.kind)).toEqual(['duplicate-tag-name']);
    expect(issues[0]?.tagIds).toEqual(['t1', 't2']);
  });

  it('import-placeholder-folder: a commit stage that never resolved its folders', () => {
    let document = emptyVaultDocument();
    document = addRecord(
      document,
      credential('imported', { folderId: importFolderId('Work/Clients') })
    );

    const issues = checkOrganisation(document);
    // Reported as its own cause, not counted twice as a missing folder — one bug must not
    // look like two.
    expect(issues.map((issue) => issue.kind)).toEqual(['import-placeholder-folder']);
    expect(issues[0]?.folderIds).toEqual(['import-folder:Work/Clients']);
  });

  it('has a test for every declared kind', () => {
    // The registry and its coverage stay in step: a kind added without a case here fails.
    const covered = new Set<string>([
      'record-missing-folder',
      'folder-missing-parent',
      'folder-cycle',
      'record-missing-tag',
      'duplicate-folder-name',
      'duplicate-tag-name',
      'import-placeholder-folder',
    ]);
    expect([...ORGANISATION_ISSUE_KINDS].sort()).toEqual([...covered].sort());
  });
});

describe('reporting, not repairing', () => {
  it('leaves the document exactly as it found it', () => {
    let document: VaultDocument = {
      ...emptyVaultDocument(),
      folders: [folder('a', 'A', 'b'), folder('b', 'B', 'a'), folder('c', 'C', 'gone')],
      tags: [tag('t1', 'Work'), tag('t2', 'work')],
    };
    document = addRecord(document, credential('one', { folderId: 'nope', tags: ['Stray'] }));
    const snapshot = structuredClone(document);

    expect(checkOrganisation(document).length).toBeGreaterThan(0);
    // Repairing is one line and destroys the only evidence of which of three causes it was.
    expect(document).toEqual(snapshot);
  });

  it('is stable across runs, so two reports on an unchanged vault are comparable', () => {
    const document: VaultDocument = {
      ...emptyVaultDocument(),
      folders: [folder('a', 'A', 'b'), folder('b', 'B', 'a'), folder('c', 'C', 'gone')],
      tags: [tag('t1', 'Work'), tag('t2', 'work')],
    };
    expect(checkOrganisation(document)).toEqual(checkOrganisation(document));
  });
});

describe('cost — N19', () => {
  /**
   * This is the path that made N19 matter: `document-diagnosis.ts` calls `checkOrganisation`
   * synchronously, with no worker under it, against the file you already suspect. Nothing
   * enforces `MAX_FOLDERS` on a merged, restored or hand-edited document — only `createFolder`
   * does — so the input is not bounded by it.
   *
   * **Two fixtures, because there were two independent quadratic terms and one shape does not
   * fail for both.** A wide tree has few distinct parents, so it exercises the per-folder
   * ancestor walk and barely touches the duplicate-name grouping; a chain has one parent per
   * folder and exercises both. Each was fault-injected separately against the exact old code.
   */
  const BUDGET_MS = 250;

  function timed(folders: readonly Folder[]): number {
    const document: VaultDocument = { ...emptyVaultDocument(), folders };
    const started = performance.now();
    expect(checkOrganisation(document)).toEqual([]);
    return performance.now() - started;
  }

  it('sweeps twice MAX_FOLDERS of a wide tree', () => {
    // Measured on the old code at 2,000 folders — the supported maximum — 196 ms, growing
    // fourfold per doubling.
    const folders: Folder[] = [];
    for (let index = 0; index < 4_000; index += 1) {
      folders.push(
        folder(`w${index}`, `W${index}`, index < 20 ? null : `w${Math.floor(index / 20) - 1}`)
      );
    }
    expect(timed(folders)).toBeLessThan(BUDGET_MS);
  });

  it('sweeps a 15,000-deep chain, where every folder is its own parent group', () => {
    // Every folder is the only child of the one above it, so this is the shape that makes
    // the duplicate-name grouping quadratic as well as the ancestor walk — a wide tree has
    // few distinct parents and barely feels that term. Fault-injected at 10,000: 12 ms as
    // written, 448 ms with the per-parent filter and sort restored, 14.3 *seconds* with the
    // per-folder ancestor walk restored. Sized half again beyond that so the margin holds on
    // a loaded runner in both directions. Not a shape `createFolder` can build —
    // `MAX_FOLDER_DEPTH` is 16 — but a merge or a hand-edited export can, and this is the
    // file diagnosis is pointed at.
    const folders: Folder[] = [];
    for (let index = 0; index < 15_000; index += 1) {
      folders.push(folder(`f${index}`, `F${index}`, index === 0 ? null : `f${index - 1}`));
    }
    expect(timed(folders)).toBeLessThan(BUDGET_MS);
  });
});

describe('messages carry no content', () => {
  it('names no folder, tag, or record title', () => {
    // Messages are shown on screen, written to reports, and pasted into bug reports. Names
    // travel in the structured `name` field the caller may choose to render, never in the
    // message text — the same rule ImportWarning already follows.
    let document: VaultDocument = {
      ...emptyVaultDocument(),
      folders: [
        folder('a', 'HouseDeposit'),
        { ...folder('b', 'housedeposit'), order: 1 },
        folder('c', 'Detached', 'gone'),
      ],
      tags: [tag('t1', 'Divorce'), tag('t2', 'DIVORCE')],
    };
    document = addRecord(
      document,
      credential('SwissBankLogin', { folderId: 'vanished', tags: ['Offshore'] })
    );

    const forbidden = [
      'HouseDeposit',
      'housedeposit',
      'Detached',
      'Divorce',
      'DIVORCE',
      'SwissBankLogin',
      'Offshore',
    ];
    const issues = checkOrganisation(document);
    expect(issues.length).toBeGreaterThan(3);
    for (const issue of issues) {
      for (const secretish of forbidden) {
        expect(issue.message.toLowerCase()).not.toContain(secretish.toLowerCase());
      }
    }
  });
});
