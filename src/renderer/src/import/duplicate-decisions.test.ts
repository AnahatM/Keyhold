// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  countNewRecords,
  DEFAULT_DUPLICATE_ACTION,
  groupImportDuplicates,
  IMPORT_DUPLICATE_ACTIONS,
  importMatchHost,
  importMatchKey,
  previewRecord,
  type ImportDuplicateAction,
  type ImportDuplicateGroup,
  type ImportRecordPreview,
} from '@shared/model/import-plan.js';
import {
  decisionFor,
  defaultDecisions,
  DUPLICATE_ACTION_COPY,
  mergeReplacesPassword,
  MERGE_EFFECT_COPY,
  recordsToAdd,
  summariseDecisions,
} from './duplicate-decisions.js';
import { FakeImportGateway } from './fake-gateway.js';
import {
  EXISTING_RECORDS,
  MERGE_FIELDS,
  plantedRecords,
  plantedScenario,
  vaultAfterImporting,
} from './test-fixtures.js';

/**
 * Deduplication — the wizard's whole job.
 *
 * The promise being tested is one sentence: **a user who imports the same file twice must
 * not end up with two of everything.** Everything below is either that property stated
 * directly, or one of the rules it rests on.
 *
 * The matcher is exercised through `previewRecord`, so what is asserted is the behaviour of
 * the real projection over real parsed records — not of a hand-written preview object shaped
 * to agree with it.
 */

function project(records = plantedRecords()): readonly ImportRecordPreview[] {
  return records.map((record, index) => previewRecord(record, index));
}

function groupsFor(
  existing = EXISTING_RECORDS,
  records = plantedRecords()
): readonly ImportDuplicateGroup[] {
  return groupImportDuplicates(
    project(records),
    existing,
    (match) => MERGE_FIELDS[match.credentialId] ?? []
  );
}

function allSet(
  groups: readonly ImportDuplicateGroup[],
  action: ImportDuplicateAction
): Readonly<Record<string, ImportDuplicateAction>> {
  return Object.fromEntries(groups.map((group) => [group.key, action]));
}

describe('the match rule', () => {
  it('ignores case, padding and www., which are the differences that are not differences', () => {
    const [first, , , second] = project();
    expect(importMatchKey(first!)).toBe(importMatchKey(second!));
  });

  it('keeps genuinely different accounts apart', () => {
    const [google, github, netflix] = project();
    const keys = new Set([google, github, netflix].map((record) => importMatchKey(record!)));
    expect(keys.size).toBe(3);
  });

  it('does not collapse two accounts that merely share a site', () => {
    const records = project([
      { title: 'Google', username: 'alice', urls: ['https://google.com'] },
      { title: 'Google', username: 'bob', urls: ['https://google.com'] },
    ]);
    expect(importMatchKey(records[0]!)).not.toBe(importMatchKey(records[1]!));
  });

  it('does not collapse two accounts that merely share a login', () => {
    const records = project([
      { title: 'Google', username: 'alice', urls: ['https://google.com'] },
      { title: 'GitHub', username: 'alice', urls: ['https://github.com'] },
    ]);
    expect(importMatchKey(records[0]!)).not.toBe(importMatchKey(records[1]!));
  });

  it('reads an android app login by its package name, not its signing hash', () => {
    // The hash varies per build, so matching the whole string would make the same app login
    // unique to whichever product exported it.
    expect(importMatchHost('android://abc123==@com.example.app')).toBe('com.example.app');
    expect(importMatchHost('android://zzz999==@com.example.app')).toBe('com.example.app');
  });

  it('degrades to a title-only key rather than making every bare row unique', () => {
    const records = project([{ title: 'Router' }, { title: 'router' }]);
    expect(importMatchKey(records[0]!)).toBe(importMatchKey(records[1]!));
  });
});

describe('grouping', () => {
  it('groups the file against itself and against the vault', () => {
    const groups = groupsFor();

    // Google is a within-file cluster: two rows, nothing in the vault.
    const withinFile = groups.find((group) => group.existing === null);
    expect(withinFile?.incoming).toHaveLength(2);

    // GitHub matched a record already in the vault.
    const againstVault = groups.find((group) => group.existing !== null);
    expect(againstVault?.existing?.credentialId).toBe('cred-github');
    expect(againstVault?.incoming).toHaveLength(1);
  });

  it('does not list a record that matched nothing as a group of one', () => {
    const groups = groupsFor();
    const netflix = groups.find((group) => group.matchedOn.title === 'netflix');
    expect(netflix).toBeUndefined();
    expect(countNewRecords(project(), groups)).toBe(1);
  });

  it('carries the merge effects the main process supplied, and nothing else', () => {
    const groups = groupsFor();
    const github = groups.find((group) => group.existing !== null);
    expect(mergeReplacesPassword(github!)).toBe(true);

    // The renderer passes no callback and therefore gets no merge effects — it has no
    // password to compare against and must not appear to.
    const rendererSide = groupImportDuplicates(project(), EXISTING_RECORDS);
    for (const group of rendererSide) expect(group.mergeableFields).toEqual([]);
  });
});

describe('importing the same file twice', () => {
  it('adds nothing the second time, under the default decision', () => {
    const vault = vaultAfterImporting();
    const groups = groupImportDuplicates(project(), vault);

    // Every row now matches something in the vault, so nothing is "new".
    expect(countNewRecords(project(), groups)).toBe(0);
    expect(recordsToAdd(0, groups, defaultDecisions(groups))).toBe(0);
  });

  it('adds nothing the second time even through the gateway that will run the commit', async () => {
    // The property that actually matters, asserted end to end: the fake runs the real
    // grouping and its own independent commit arithmetic, so agreeing here means the review
    // screen's prediction and the write agree.
    const gateway = new FakeImportGateway(plantedScenario({ existing: vaultAfterImporting() }));
    const preview = await gateway.preview({
      sourceId: 'source-1',
      formatId: 'bitwarden-csv',
      sampleSize: 5,
    });
    const result = await gateway.commit({
      planId: preview.planId,
      duplicateActions: defaultDecisions(preview.duplicates),
    });

    expect(preview.newRecordCount).toBe(0);
    expect(result.importedCount).toBe(0);
    expect(result.skippedCount).toBe(preview.recordCount);
  });

  it('still lands the first copy on the first import, duplicated row and all', async () => {
    // The mirror image, and the failure mode that matters more: a file with a repeated row,
    // imported into an empty vault, must produce the account once — never zero times.
    const gateway = new FakeImportGateway(plantedScenario({ existing: [] }));
    const preview = await gateway.preview({
      sourceId: 'source-1',
      formatId: 'bitwarden-csv',
      sampleSize: 5,
    });
    const result = await gateway.commit({
      planId: preview.planId,
      duplicateActions: defaultDecisions(preview.duplicates),
    });

    // Four rows in the file, three distinct accounts.
    expect(preview.recordCount).toBe(4);
    expect(result.importedCount).toBe(3);
    expect(result.skippedCount).toBe(1);
  });
});

describe('the arithmetic the review screen shows', () => {
  it('predicts exactly what the commit does, for every decision', async () => {
    for (const action of IMPORT_DUPLICATE_ACTIONS) {
      const gateway = new FakeImportGateway(plantedScenario());
      const preview = await gateway.preview({
        sourceId: 'source-1',
        formatId: 'bitwarden-csv',
        sampleSize: 5,
      });
      const decisions = allSet(preview.duplicates, action);

      const predicted = recordsToAdd(preview.newRecordCount, preview.duplicates, decisions);
      const result = await gateway.commit({ planId: preview.planId, duplicateActions: decisions });

      // The headline number on the review step *is* the number of records that appear.
      expect(result.importedCount).toBe(predicted);
    }
  });

  it('counts skips, merges and overrides separately', () => {
    const groups = groupsFor();
    const summary = summariseDecisions(groups, allSet(groups, 'merge'));

    expect(summary.groupCount).toBe(2);
    expect(summary.duplicateRecordCount).toBe(3);
    expect(summary.mergedCount).toBe(2);
    expect(summary.skippedCount).toBe(0);
    expect(summary.overriddenGroupCount).toBe(2);
    expect(summary.replacesAPassword).toBe(true);
  });

  it('reports no password replacement when nothing would be replaced', () => {
    const groups = groupImportDuplicates(project(), EXISTING_RECORDS, () => [
      { field: 'urls', effect: 'adds' },
    ]);
    expect(summariseDecisions(groups, allSet(groups, 'merge')).replacesAPassword).toBe(false);
  });
});

describe('the decision map', () => {
  it('defaults to skip, which is the only answer that cannot go wrong', () => {
    const groups = groupsFor();
    expect(DEFAULT_DUPLICATE_ACTION).toBe('skip');
    for (const group of groups) {
      expect(defaultDecisions(groups)[group.key]).toBe('skip');
      expect(decisionFor({}, group.key)).toBe('skip');
    }
  });

  it('keeps a considered choice across a re-preview', () => {
    const groups = groupsFor();
    const key = groups[0]!.key;
    const kept = defaultDecisions(groups, { [key]: 'merge' });
    expect(kept[key]).toBe('merge');
  });

  it('gives a group that appeared since the last preview the safe default', () => {
    const groups = groupsFor();
    const kept = defaultDecisions(groups, { 'a key from a mapping the user has changed': 'merge' });
    for (const group of groups) expect(kept[group.key]).toBe('skip');
  });

  it('treats an unknown key as the default, so a partial map fails safe', () => {
    const groups = groupsFor();
    expect(recordsToAdd(0, groups, {})).toBe(recordsToAdd(0, groups, allSet(groups, 'skip')));
  });

  it('has words for every action and every merge effect', () => {
    for (const action of IMPORT_DUPLICATE_ACTIONS) {
      expect(DUPLICATE_ACTION_COPY[action].label).not.toBe('');
      expect(DUPLICATE_ACTION_COPY[action].help).not.toBe('');
    }
    for (const effect of ['fills-empty', 'replaces', 'adds', 'unchanged'] as const) {
      expect(MERGE_EFFECT_COPY[effect]).not.toBe('');
    }
  });
});
