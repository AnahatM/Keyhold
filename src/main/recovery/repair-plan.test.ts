// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { REPAIR_ACTION_KINDS } from '@shared/model/recovery.js';
import type { Credential, CustomField } from '@shared/model/credential.js';
import {
  emptyVaultDocument,
  type Folder,
  type VaultDocument,
} from '@shared/model/vault-document.js';
import { recordOf } from '../attachments/test-fixtures.js';
import { diagnoseDocument } from './document-diagnosis.js';
import { inspectVaultFile } from './file-inspection.js';
import { planRepairs } from './repair-plan.js';
import { surveyVaultFiles } from './survey.js';
import { FIXTURE_NOW, bodyOffsetOf, buildContainer, chunkId, truncatedTo } from './test-support.js';

/**
 * A plan is a list of **proposals**. The tests that matter most here are the ones asserting
 * what it does *not* do: it never executes, it never implies a salvage that cannot exist, and
 * it never presents a lossy step without naming what is lost.
 */

const DAY = 86_400_000;

function documentWith(
  records: readonly Credential[],
  extra: Partial<Pick<VaultDocument, 'folders' | 'tags'>> = {}
): VaultDocument {
  return { ...emptyVaultDocument(), records: [...records], ...extra };
}

function folder(id: string, parentId: string | null): Folder {
  return { id, name: `Folder ${id}`, parentId, order: 0 };
}

function customField(id: string): CustomField {
  return { id, label: 'Code', type: 'text', value: 'v', hidden: false, order: 0 };
}

const diagnose = (
  document: VaultDocument,
  chunks?: readonly { id: string; byteLength: number }[]
): ReturnType<typeof diagnoseDocument> =>
  diagnoseDocument(
    document,
    chunks === undefined ? { now: FIXTURE_NOW } : { now: FIXTURE_NOW, chunks }
  );

const kinds = (plan: ReturnType<typeof planRepairs>): readonly string[] =>
  plan.actions.map((action) => action.kind);

describe('a vault with nothing wrong', () => {
  it('proposes nothing at all', () => {
    const plan = planRepairs({
      file: inspectVaultFile(buildContainer()),
      diagnosis: diagnose(documentWith([recordOf('r1')])),
    });

    expect(plan.clean).toBe(true);
    expect(plan.actions).toEqual([]);
  });

  it('still states the AEAD rule, because it is true regardless of findings', () => {
    const plan = planRepairs({});
    expect(plan.unrecoverable).toHaveLength(1);
    expect(plan.unrecoverable[0]).toContain('whole plaintext or nothing at all');
  });
});

describe('the order is the plan', () => {
  it('always makes "copy everything aside" step 1 when there is anything to do', () => {
    const plan = planRepairs({
      diagnosis: diagnose(documentWith([recordOf('dup'), recordOf('dup')])),
    });

    // Every step after it is safe only because it happened.
    expect(plan.actions[0]?.kind).toBe('copy-everything-aside');
    expect(plan.actions[0]?.step).toBe(1);
    expect(plan.actions[0]?.reversible).toBe(true);
  });

  it('does not propose a copy when there is nothing to copy it for', () => {
    expect(kinds(planRepairs({}))).not.toContain('copy-everything-aside');
  });

  it('numbers steps contiguously from 1', () => {
    const record: Credential = {
      ...recordOf('r1'),
      fields: { ...recordOf('r1').fields, custom: [customField('d'), customField('d')] },
      meta: { ...recordOf('r1').meta, updatedAt: FIXTURE_NOW + DAY },
    };
    const plan = planRepairs({ diagnosis: diagnose(documentWith([record])) });

    expect(plan.actions.map((action) => action.step)).toEqual(
      plan.actions.map((_, index) => index + 1)
    );
  });

  it('puts read-only alternatives before anything that changes a vault', () => {
    const survey = surveyVaultFiles({
      vaultPath: '/vaults/vault.keep',
      entries: [
        {
          path: '/vaults/vault.keep',
          sizeBytes: 10,
          modifiedAt: 1,
          bytes: truncatedTo(buildContainer(), 40),
        },
        { path: '/vaults/vault.keep.bak.1', sizeBytes: 20, modifiedAt: 2, bytes: buildContainer() },
      ],
    });
    const plan = planRepairs({
      file: inspectVaultFile(truncatedTo(buildContainer(), 40)),
      survey,
      diagnosis: diagnose(documentWith([recordOf('dup'), recordOf('dup')])),
    });

    const openIndex = kinds(plan).indexOf('open-another-copy');
    const changeIndex = kinds(plan).indexOf('reassign-duplicate-record-ids');
    expect(openIndex).toBeGreaterThan(-1);
    expect(openIndex).toBeLessThan(changeIndex);
  });

  it('puts the steps that lose something last', () => {
    const record: Credential = {
      ...recordOf('r1'),
      history: {
        enabled: true,
        maxVersions: null,
        versions: [
          {
            versionNumber: 2,
            savedAt: FIXTURE_NOW,
            changedFields: ['title'],
            snapshot: { title: 'a' },
            origin: { action: 'update' },
          },
          {
            versionNumber: 1,
            savedAt: FIXTURE_NOW,
            changedFields: ['title'],
            snapshot: { title: 'b' },
            origin: { action: 'update' },
          },
        ],
      },
    };
    const document = documentWith([record], { folders: [folder('a', 'b'), folder('b', 'a')] });
    const plan = planRepairs({ diagnosis: diagnose(document) });

    const list = kinds(plan);
    expect(list.indexOf('reparent-broken-folders')).toBeLessThan(
      list.indexOf('clear-invalid-history')
    );
  });
});

describe('honesty about the price', () => {
  it('names what is lost on every step that is not reversible', () => {
    const record: Credential = {
      ...recordOf('r1'),
      fields: { ...recordOf('r1').fields, custom: [customField('d'), customField('d')] },
    };
    const plan = planRepairs({
      diagnosis: diagnose(documentWith([record, recordOf('x'), recordOf('x')])),
    });

    // A user who agrees to a repair without being told the price has not agreed to anything.
    for (const action of plan.actions) {
      if (!action.reversible) expect(action.cannotRecover).not.toBeNull();
    }
    expect(plan.actions.length).toBeGreaterThan(1);
  });

  it('warns that clearing history deletes every previous value', () => {
    const record: Credential = {
      ...recordOf('r1'),
      history: {
        enabled: true,
        maxVersions: null,
        versions: [
          {
            versionNumber: 1,
            savedAt: FIXTURE_NOW,
            changedFields: ['title'],
            snapshot: { title: 'a', password: 'x' },
            origin: { action: 'update' },
          },
        ],
      },
    };
    const action = planRepairs({ diagnosis: diagnose(documentWith([record])) }).actions.find(
      (candidate) => candidate.kind === 'clear-invalid-history'
    );

    expect(action?.reversible).toBe(false);
    expect(action?.cannotRecover).toContain('Old passwords');
  });

  it('tells the user to search the backups before detaching an attachment', () => {
    const record: Credential = {
      ...recordOf('r1'),
      attachments: [
        {
          id: chunkId('a'),
          name: 'p.pdf',
          mime: 'application/pdf',
          size: 10,
          sha256: 'f'.repeat(64),
          addedAt: FIXTURE_NOW,
        },
      ],
    };
    const action = planRepairs({ diagnosis: diagnose(documentWith([record]), []) }).actions.find(
      (candidate) => candidate.kind === 'detach-missing-attachments'
    );

    // The name and digest are exactly what would let someone recognise the file in a
    // backup, and detaching throws them away.
    expect(action?.cannotRecover).toContain('Search the backups before doing this, not after');
  });

  it('never claims a truncated body can be salvaged', () => {
    // Cut inside the body specifically — the offset is derived from the container rather
    // than guessed, so this stays a body truncation if the header ever changes length.
    const whole = buildContainer();
    const plan = planRepairs({
      file: inspectVaultFile(truncatedTo(whole, bodyOffsetOf(whole) + 4)),
    });

    const text = plan.unrecoverable.join(' ');
    expect(text).toContain('cannot be reconstructed from this file');
    expect(text).not.toMatch(/partial (recovery|decryption) is possible/i);
    // No action anywhere pretends to rebuild the bytes.
    expect(kinds(plan)).not.toContain('reassign-duplicate-record-ids');
  });

  it('says a missing header means the right password will not help', () => {
    const plan = planRepairs({ file: inspectVaultFile(truncatedTo(buildContainer(), 30)) });
    expect(plan.unrecoverable.join(' ')).toContain(
      'cannot derive a key that the file does not describe'
    );
  });

  it('marks removing unreferenced chunks last, and says why', () => {
    const plan = planRepairs({
      diagnosis: diagnose(documentWith([recordOf('r1')]), [{ id: chunkId('b'), byteLength: 20 }]),
    });
    const last = plan.actions.at(-1);

    expect(last?.kind).toBe('remove-unreferenced-chunks');
    expect(last?.cannotRecover).toContain('only copy');
  });
});

describe('what a plan proposes for each finding', () => {
  it('offers a better copy when the survey ranks one above the vault', () => {
    const survey = surveyVaultFiles({
      vaultPath: '/v/vault.keep',
      entries: [
        {
          path: '/v/vault.keep',
          sizeBytes: 1,
          modifiedAt: 1,
          bytes: truncatedTo(buildContainer(), 40),
        },
        { path: '/v/vault.keep.bak.1', sizeBytes: 2, modifiedAt: 2, bytes: buildContainer() },
      ],
    });
    const action = planRepairs({
      survey,
      file: inspectVaultFile(truncatedTo(buildContainer(), 40)),
    }).actions.find((candidate) => candidate.kind === 'open-another-copy');

    expect(action?.subjects).toEqual(['vault.keep.bak.1']);
    expect(action?.changes).toContain('Nothing');
    // Even a read-only step has a price worth stating.
    expect(action?.cannotRecover).toContain('Compare the generation numbers');
  });

  it('proposes quarantining an orphaned temp without reading or deleting it', () => {
    const survey = surveyVaultFiles({
      vaultPath: '/v/vault.keep',
      entries: [{ path: '/v/vault.keep.tmp', sizeBytes: 9, modifiedAt: 1 }],
    });
    const action = planRepairs({ survey }).actions.find(
      (candidate) => candidate.kind === 'quarantine-orphaned-temp'
    );

    expect(action?.changes).toContain('Nothing is deleted');
    expect(action?.requiresUnlock).toBe(false);
  });

  it('proposes updating Keyhold rather than saving over a newer format', () => {
    const future = buildContainer();
    const bumped = Uint8Array.from(future);
    new DataView(bumped.buffer, bumped.byteOffset).setUint16(8, 99, true);

    const action = planRepairs({ file: inspectVaultFile(bumped) }).actions.find(
      (candidate) => candidate.kind === 'update-keyhold'
    );
    expect(action?.changes).toContain('Do not save over it');
  });

  it('offers to reparent folders in a cycle and to un-file orphaned records', () => {
    const record: Credential = { ...recordOf('r1'), folderId: 'ghost' };
    const document = documentWith([record], { folders: [folder('a', 'b'), folder('b', 'a')] });
    const list = kinds(planRepairs({ diagnosis: diagnose(document) }));

    expect(list).toContain('reparent-broken-folders');
    expect(list).toContain('clear-missing-folder-references');
  });

  it('every kind it can emit is declared in the shared list', () => {
    // The registry is the single source of truth; a kind invented here would be a finding
    // the renderer has no label for.
    const record: Credential = {
      ...recordOf('r1'),
      fields: { ...recordOf('r1').fields, custom: [customField('d'), customField('d')] },
      meta: { ...recordOf('r1').meta, updatedAt: FIXTURE_NOW + DAY },
    };
    const plan = planRepairs({
      file: inspectVaultFile(truncatedTo(buildContainer(), 300)),
      diagnosis: diagnose(documentWith([record]), []),
    });

    for (const action of plan.actions) {
      expect(REPAIR_ACTION_KINDS).toContain(action.kind);
    }
  });
});

describe('a plan changes nothing', () => {
  it('leaves the document and the inspection untouched', () => {
    const document = documentWith([recordOf('dup'), recordOf('dup')]);
    const before = structuredClone(document);
    const diagnosis = diagnose(document);
    const diagnosisBefore = structuredClone(diagnosis);

    planRepairs({ diagnosis });

    expect(document).toEqual(before);
    expect(diagnosis).toEqual(diagnosisBefore);
  });

  it('is deterministic — the same inputs produce the same plan', () => {
    const diagnosis = diagnose(documentWith([recordOf('dup'), recordOf('dup')]));
    expect(planRepairs({ diagnosis })).toEqual(planRepairs({ diagnosis }));
  });

  it('accepts an entirely empty input rather than requiring every analysis to have run', () => {
    expect(() => planRepairs({})).not.toThrow();
    expect(planRepairs({ file: null, survey: null, diagnosis: null }).clean).toBe(true);
  });
});
