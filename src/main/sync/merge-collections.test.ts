// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { AuditPrivacyLevel } from '@shared/model/credential.js';
import type { ConflictChoice } from '@shared/model/sync.js';
import { DEFAULT_VAULT_SETTINGS, type VaultSettings } from '@shared/model/vault-document.js';
import {
  SETTING_POLICY,
  lessRevealing,
  mergeFolders,
  mergeSettings,
  mergeTagPalette,
  repairFolderTree,
} from './merge-collections.js';
import { folder, paletteTag, record } from './test-fixtures.js';

/**
 * Folders, the tag palette, vault settings, and the repair pass that keeps the folder tree
 * renderable afterwards.
 *
 * None of these has a tombstone, which is the fact every rule here follows from: a folder that
 * vanished from one side might have been deleted or might never have arrived, and only the
 * ancestor can tell the two apart. So an ancestor deletes and absence alone never does.
 */

const NO_RESOLUTIONS = new Map<string, ConflictChoice>();

function resolutions(entries: Record<string, ConflictChoice>): ReadonlyMap<string, ConflictChoice> {
  return new Map(Object.entries(entries));
}

// ── Folders ──────────────────────────────────────────────────────────────────

describe('folders', () => {
  const work = folder('f1', 'Work');
  const personal = folder('f2', 'Personal');

  it('honours a deletion the other side did not touch', () => {
    const merged = mergeFolders([work], [work], [], NO_RESOLUTIONS);
    expect(merged.items).toEqual([]);
  });

  it('keeps a folder deleted on one side and renamed on the other, and says so', () => {
    // Renaming is evidence someone is still using it. Deleting a folder again is one click;
    // a filing system that rearranges itself behind you is not recoverable by clicking.
    const renamed = { ...work, name: 'Employer' };
    const merged = mergeFolders([work], [renamed], [], NO_RESOLUTIONS);
    expect(merged.items).toEqual([renamed]);
    expect(merged.notes.map((note) => note.kind)).toContain('folder-kept-unmatched');
  });

  it('unions with no ancestor, because absence proves nothing', () => {
    const merged = mergeFolders(null, [work], [personal], NO_RESOLUTIONS);
    expect(merged.items.map((entry) => entry.id).sort()).toEqual(['f1', 'f2']);
    expect(merged.notes.map((note) => note.kind)).toContain('folder-added');
  });

  it('reports an arrival even when our side was untouched and theirs was taken wholesale', () => {
    // The short-circuit that returns their collection unchanged must not also skip the report.
    const merged = mergeFolders([work], [work], [work, personal], NO_RESOLUTIONS);
    expect(merged.items).toEqual([work, personal]);
    const added = merged.notes.find((note) => note.kind === 'folder-added');
    expect(added?.targetId).toBe('f2');
  });

  it('raises a conflict when both sides renamed the same folder differently', () => {
    const merged = mergeFolders(
      [work],
      [{ ...work, name: 'Employer' }],
      [{ ...work, name: 'Day job' }],
      NO_RESOLUTIONS
    );
    const conflict = merged.conflicts[0];
    expect(conflict?.id).toBe('folder:f1:name');
    expect(conflict?.kind).toBe('folder');
    expect(conflict?.resolution).toBe('unresolved');
    expect(merged.items[0]?.name).toBe('Employer');
  });

  it('applies a resolution to a folder property', () => {
    const merged = mergeFolders(
      [work],
      [{ ...work, name: 'Employer' }],
      [{ ...work, name: 'Day job' }],
      resolutions({ 'folder:f1:name': 'theirs' })
    );
    expect(merged.items[0]?.name).toBe('Day job');
    expect(merged.conflicts[0]?.resolution).toBe('user');
  });

  it('ignores a stale resolution for a property only one side changed', () => {
    // Same hazard as a record field: an answer collected when the two sides disagreed must not
    // be replayed onto a property that has since settled, or it undoes an edit nobody was
    // asked about. Both folders have to move for the collection to be combined at all —
    // otherwise the "we did not touch this" short-circuit takes their list wholesale and the
    // per-property code is never reached, which would make this test prove nothing.
    const merged = mergeFolders(
      [work, personal],
      [work, { ...personal, name: 'Home' }],
      [{ ...work, name: 'Employer' }, personal],
      resolutions({ 'folder:f1:name': 'ours' })
    );
    expect(merged.conflicts).toEqual([]);
    expect(merged.items.find((entry) => entry.id === 'f1')?.name).toBe('Employer');
    expect(merged.items.find((entry) => entry.id === 'f2')?.name).toBe('Home');
  });

  it('merges different properties of the same folder without asking', () => {
    const merged = mergeFolders(
      [work],
      [{ ...work, name: 'Employer' }],
      [{ ...work, order: 4 }],
      NO_RESOLUTIONS
    );
    expect(merged.conflicts).toEqual([]);
    expect(merged.items[0]).toEqual({ ...work, name: 'Employer', order: 4 });
  });
});

// ── The tag palette ──────────────────────────────────────────────────────────

describe('the tag palette', () => {
  const blue = paletteTag('t1', 'work', '--kh-tag-blue');

  it('raises a conflict when two devices gave one tag two colours', () => {
    const merged = mergeTagPalette(
      [blue],
      [{ ...blue, colour: '--kh-tag-green' }],
      [{ ...blue, colour: '--kh-tag-red' }],
      NO_RESOLUTIONS
    );
    expect(merged.conflicts[0]?.id).toBe('tag:t1:colour');
    expect(merged.conflicts[0]?.kind).toBe('tag');
  });

  it('keeps definitions added on either side', () => {
    const merged = mergeTagPalette(
      [blue],
      [blue, paletteTag('t2', 'email')],
      [blue, paletteTag('t3', '2fa')],
      NO_RESOLUTIONS
    );
    expect(merged.items.map((entry) => entry.id).sort()).toEqual(['t1', 't2', 't3']);
    expect(merged.conflicts).toEqual([]);
  });
});

// ── Referential repair ───────────────────────────────────────────────────────

describe('repairing the folder tree', () => {
  const work = folder('f1', 'Work');
  const nested = folder('f2', 'Invoices', 'f1');

  it('resurrects a folder that a surviving record still lives in', () => {
    const filed = record({ id: 'a', folderId: 'f1' });
    const repaired = repairFolderTree([], [filed], [work]);

    expect(repaired.folders).toEqual([work]);
    expect(repaired.records[0]?.folderId).toBe('f1');
    expect(repaired.notes.map((note) => note.kind)).toContain('folder-resurrected');
  });

  it('resurrects the same definition whichever order the pool was built in', () => {
    // The pool is the ancestor's folders plus both sides', concatenated, so one id can arrive
    // three times with three names. "Last one wins" would make the answer depend on which
    // document was passed first — a silent asymmetry the commutativity property would catch
    // only by luck, because it needs a folder deleted on both sides to show up at all.
    const filed = record({ id: 'a', folderId: 'f1' });
    const renamed = folder('f1', 'Employer');
    const forwards = repairFolderTree([], [filed], [work, renamed]);
    const backwards = repairFolderTree([], [filed], [renamed, work]);
    expect(forwards.folders).toEqual(backwards.folders);
  });

  it('unfiles a record whose folder exists nowhere at all', () => {
    const filed = record({ id: 'a', folderId: 'gone' });
    const repaired = repairFolderTree([], [filed], []);

    expect(repaired.records[0]?.folderId).toBeNull();
    expect(repaired.notes.map((note) => note.kind)).toContain('record-unfiled');
  });

  it('moves a folder to the root when its parent did not survive', () => {
    const repaired = repairFolderTree([nested], [], []);
    expect(repaired.folders[0]?.parentId).toBeNull();
    expect(repaired.notes.map((note) => note.kind)).toContain('folder-reparented');
  });

  it('breaks a cycle two devices could each reasonably have created', () => {
    const a = folder('fa', 'A', 'fb');
    const b = folder('fb', 'B', 'fa');
    const repaired = repairFolderTree([a, b], [], []);

    expect(repaired.notes.map((note) => note.kind)).toContain('folder-cycle-broken');
    expect(repaired.folders.filter((entry) => entry.parentId === null)).toHaveLength(1);
    // Every folder must now reach the root in a finite number of steps, which is the only
    // property a renderer walking parents actually depends on.
    const parents = new Map(repaired.folders.map((entry) => [entry.id, entry.parentId]));
    for (const entry of repaired.folders) {
      let steps = 0;
      let current = entry.parentId;
      while (current !== null && steps <= repaired.folders.length) {
        current = parents.get(current) ?? null;
        steps += 1;
      }
      expect(steps).toBeLessThanOrEqual(repaired.folders.length);
    }
  });

  it('cuts the same link whichever direction the merge ran in', () => {
    const a = folder('fa', 'A', 'fb');
    const b = folder('fb', 'B', 'fa');
    expect(repairFolderTree([a, b], [], []).folders).toEqual(
      repairFolderTree([b, a], [], [])
        .folders.slice()
        .sort((x, y) => (x.id < y.id ? -1 : 1))
    );
  });
});

// ── Settings ─────────────────────────────────────────────────────────────────

function withSetting<K extends keyof VaultSettings>(
  key: K,
  value: VaultSettings[K]
): VaultSettings {
  return { ...DEFAULT_VAULT_SETTINGS, [key]: value };
}

type SettingValue = VaultSettings[keyof VaultSettings];

interface PolicyCase {
  readonly ours: VaultSettings;
  readonly theirs: VaultSettings;
  /** Reads the one setting under test back out, so no case needs a cast to compare it. */
  readonly read: (settings: VaultSettings) => SettingValue;
  readonly expected: SettingValue;
}

/**
 * `health`, `attachments` and `breachCheck` are excluded, and for the same reason: all three
 * are **compound**,
 * and `PolicyCase` describes a scalar settling toward one side. They are reconciled field by
 * field with no conflict entry, which is a different claim and is asserted separately.
 *
 * One case per remaining entry in `SETTING_POLICY`, typed so that adding a setting without deciding what
 * a merge does with it is a **compile error** here as well as in the table itself.
 *
 * Every case is run two-way. That is not laziness: `historyEnabledByDefault` is a boolean, and
 * a boolean cannot conflict when there is an ancestor — one side matching the base means one
 * side simply did not move. Without an ancestor every difference is a conflict, so this is the
 * only shape in which every policy is reachable at once.
 */
const POLICY_CASES: Readonly<
  Record<Exclude<keyof typeof SETTING_POLICY, 'health' | 'attachments' | 'breachCheck'>, PolicyCase>
> = {
  // Off wins: recording old passwords is a privacy decision, and the quieter answer cannot
  // surprise someone who was not asked.
  historyEnabledByDefault: {
    ours: withSetting('historyEnabledByDefault', true),
    theirs: withSetting('historyEnabledByDefault', false),
    read: (settings) => settings.historyEnabledByDefault,
    expected: false,
  },
  // Off wins, and this one has a second reason on top of the privacy argument: the setting
  // governs what *this* merge writes, so resolving it toward "record" would let a merge decide
  // to record itself on the strength of a preference the other device holds.
  historyRecordsMerges: {
    ours: withSetting('historyRecordsMerges', true),
    theirs: withSetting('historyRecordsMerges', false),
    read: (settings) => settings.historyRecordsMerges,
    expected: false,
  },
  // `null` is unlimited, so it is the larger cap. Keeping more history destroys nothing.
  historyMaxVersions: {
    ours: withSetting('historyMaxVersions', 10),
    theirs: withSetting('historyMaxVersions', null),
    read: (settings) => settings.historyMaxVersions,
    expected: null,
  },
  // The less revealing audit level: capture is irreversible and the vault file travels.
  auditPrivacyLevel: {
    ours: withSetting('auditPrivacyLevel', 'full'),
    theirs: withSetting('auditPrivacyLevel', 'device'),
    read: (settings) => settings.auditPrivacyLevel,
    expected: 'device',
  },
  // The earlier warning: being told sooner is a nag, being told later is a gap.
  passwordAgeWarningDays: {
    ours: withSetting('passwordAgeWarningDays', 365),
    theirs: withSetting('passwordAgeWarningDays', 90),
    read: (settings) => settings.passwordAgeWarningDays,
    expected: 90,
  },
  // The longer retention (`null` never purges): trash that survives can still be restored.
  trashRetentionDays: {
    ours: withSetting('trashRetentionDays', 30),
    theirs: withSetting('trashRetentionDays', null),
    read: (settings) => settings.trashRetentionDays,
    expected: null,
  },
};

/**
 * `health` is deliberately absent from the table above.
 *
 * Every other setting is a scalar that `settle` either takes from one side or reports as a
 * conflict, and this table exists so that adding one without deciding which is a compile
 * error. `health` is compound and is reconciled field by field, so it has no single "ours or
 * theirs" answer to assert here — the `Exclude` names it rather than letting it be forgotten,
 * and the tests directly below cover it.
 */

/** A document whose health settings differ from the defaults in exactly the named fields. */
function withHealth(patch: Partial<VaultSettings['health']>): VaultSettings {
  return {
    ...DEFAULT_VAULT_SETTINGS,
    health: { ...DEFAULT_VAULT_SETTINGS.health, ...patch },
  };
}

describe('health settings merge field by field, toward more warning', () => {
  it('keeps a rule enabled if either side had it enabled', () => {
    const ours = withHealth({
      enabledRules: { ...DEFAULT_VAULT_SETTINGS.health.enabledRules, reused: false },
    });
    const theirs = withHealth({
      enabledRules: { ...DEFAULT_VAULT_SETTINGS.health.enabledRules, weak: false },
    });

    const merged = mergeSettings(null, ours, theirs, new Map()).settings.health.enabledRules;
    // Neither side's disabling wins: a merge that silenced a warning the other device was
    // giving would be the one direction with a cost a user cannot see.
    expect(merged.reused).toBe(true);
    expect(merged.weak).toBe(true);
  });

  it('takes the longer expiry warning', () => {
    const merged = mergeSettings(
      null,
      withHealth({ expiringWithinDays: 7 }),
      withHealth({ expiringWithinDays: 30 }),
      new Map()
    );
    expect(merged.settings.health.expiringWithinDays).toBe(30);
  });

  it('asks the user nothing, because every field has a costless answer', () => {
    const merged = mergeSettings(
      null,
      withHealth({ weakEntropyBits: 60 }),
      withHealth({ weakEntropyBits: 80 }),
      new Map()
    );
    // Not reported at all, and that is the point: a conflict entry exists so a resolver can
    // offer a user one value or the other, and there is no version of that question here.
    // Every field has an answer that cannot cost them anything.
    expect(merged.conflicts.filter((conflict) => conflict.targetId === 'health')).toEqual([]);
  });
});

describe('every setting resolves by a policy the table names', () => {
  it('has a policy for every setting in the model', () => {
    expect(Object.keys(SETTING_POLICY).sort()).toEqual(Object.keys(DEFAULT_VAULT_SETTINGS).sort());
  });

  for (const [key, testCase] of Object.entries(POLICY_CASES)) {
    const setting = key as keyof VaultSettings;

    it(`${key} resolves toward ${SETTING_POLICY[setting]}, in both directions`, () => {
      const forwards = mergeSettings(null, testCase.ours, testCase.theirs, NO_RESOLUTIONS);
      const backwards = mergeSettings(null, testCase.theirs, testCase.ours, NO_RESOLUTIONS);

      expect(testCase.read(forwards.settings)).toEqual(testCase.expected);
      expect(testCase.read(backwards.settings)).toEqual(testCase.expected);
      expect(forwards.conflicts.find((conflict) => conflict.targetId === key)?.resolution).toBe(
        'policy'
      );
    });
  }

  it('never blocks the merge on a settings disagreement', () => {
    const merged = mergeSettings(
      null,
      withSetting('passwordAgeWarningDays', 365),
      withSetting('passwordAgeWarningDays', 90),
      NO_RESOLUTIONS
    );
    expect(merged.conflicts.every((conflict) => conflict.resolution === 'policy')).toBe(true);
  });

  it('lets a user override a policy', () => {
    const merged = mergeSettings(
      null,
      withSetting('passwordAgeWarningDays', 365),
      withSetting('passwordAgeWarningDays', 90),
      resolutions({ 'setting:passwordAgeWarningDays': 'ours' })
    );
    expect(merged.settings.passwordAgeWarningDays).toBe(365);
    expect(merged.conflicts[0]?.resolution).toBe('user');
  });

  it('takes a one-sided change as an edit, not a disagreement', () => {
    const base = withSetting('passwordAgeWarningDays', 365);
    const theirs = withSetting('passwordAgeWarningDays', 90);
    const merged = mergeSettings(base, base, theirs, NO_RESOLUTIONS);
    expect(merged.settings.passwordAgeWarningDays).toBe(90);
    expect(merged.conflicts).toEqual([]);
  });
});

describe('lessRevealing', () => {
  it('orders the audit levels from least to most revealing', () => {
    const pairs: readonly (readonly [AuditPrivacyLevel, AuditPrivacyLevel])[] = [
      ['none', 'full'],
      ['device', 'network'],
      ['network', 'full'],
    ];
    for (const [quieter, louder] of pairs) {
      expect(lessRevealing(quieter, louder)).toBe(quieter);
      expect(lessRevealing(louder, quieter)).toBe(quieter);
    }
  });
});
