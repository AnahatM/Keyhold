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
