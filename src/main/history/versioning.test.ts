// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ChangeOrigin, Credential, VersionedField } from '@shared/model/credential.js';
import { VERSIONED_FIELDS } from '@shared/model/credential.js';
import { DEFAULT_VAULT_SETTINGS } from '@shared/model/vault-document.js';
import { applyPatch, buildCredential, type OpsContext } from '../vault/credential-ops.js';
import {
  appendVersion,
  assertValidHistory,
  comparePoints,
  currentValues,
  diffVersion,
  historicSecret,
  pruneVersions,
  resolveState,
  restoreField,
  restoreVersion,
  versionedChanges,
} from './versioning.js';

/**
 * Versioning.
 *
 * The whole of Keyhold's headline feature is pure, so all of it is testable without a key,
 * a file or a clock. The tests below are organised around the three properties the feature
 * actually rests on:
 *
 *  1. **A version is only written when something versioned changed** — otherwise a timeline
 *     fills with entries nobody made.
 *  2. **Every surviving version can be restored**, including after pruning. This is the
 *     property that decides whether backward deltas were the right call, so it is asserted
 *     directly rather than inferred from the implementation.
 *  3. **A restore is itself recorded.** The one operation that rewrites a record must not
 *     be the one operation the audit trail cannot see.
 */

let clock = 1_700_000_000_000;
let nextId = 0;

const context = (): OpsContext => ({
  newId: () => `id-${++nextId}`,
  now: () => (clock += 1_000),
  settings: DEFAULT_VAULT_SETTINGS,
});

const origin = (action: ChangeOrigin['action'] = 'update'): ChangeOrigin => ({
  action,
  deviceName: 'TEST-BOX',
  platform: 'Windows',
});

const base = (): Credential =>
  buildCredential({ title: 'Mail', password: 'p0', username: 'u0' }, context());

/** One edit: patch, then append the version it produced. The service's exact composition. */
function edit(
  credential: Credential,
  patch: Parameters<typeof applyPatch>[1],
  action: ChangeOrigin['action'] = 'update'
): Credential {
  const { credential: updated, changedFields } = applyPatch(credential, patch, context());
  return appendVersion(updated, credential, changedFields, origin(action));
}

describe('versionedChanges', () => {
  it('keeps only the fields history records', () => {
    expect(versionedChanges(['password', 'title', 'historyEnabled'])).toEqual([
      'password',
      'title',
    ]);
  });

  it('drops a name that is not a versioned field at all', () => {
    // Guards against a future change-detection name silently becoming a history entry with
    // no snapshot behind it.
    expect(versionedChanges(['nonsense'])).toEqual([]);
  });
});

describe('appendVersion', () => {
  it('records the previous values, not the new ones', () => {
    const after = edit(base(), { fields: { password: 'p1' } });
    const version = after.history.versions[0];

    expect(version?.changedFields).toEqual(['password']);
    expect(version?.snapshot).toEqual({ password: 'p0' });
    expect(after.fields.password).toBe('p1');
  });

  it('stamps the version with the record own updatedAt, not a second clock read', () => {
    const after = edit(base(), { title: 'Email' });
    expect(after.history.versions[0]?.savedAt).toBe(after.meta.updatedAt);
  });

  it('records the origin it was given', () => {
    const after = edit(base(), { title: 'Email' });
    expect(after.history.versions[0]?.origin).toEqual({
      action: 'update',
      deviceName: 'TEST-BOX',
      platform: 'Windows',
    });
  });

  it('writes nothing when history is disabled for the record', () => {
    const disabled = { ...base(), history: { ...base().history, enabled: false } };
    expect(edit(disabled, { fields: { password: 'p1' } }).history.versions).toEqual([]);
  });

  it('writes nothing when only a non-versioned field changed', () => {
    // Toggling history is a real change that must be saved — but a version documenting
    // that history was switched on has nothing to show and nothing to restore.
    const after = edit(base(), { history: { enabled: false } });
    expect(after.history.enabled).toBe(false);
    expect(after.history.versions).toEqual([]);
  });

  it('numbers versions from one, ascending', () => {
    let record = base();
    record = edit(record, { fields: { password: 'p1' } });
    record = edit(record, { fields: { password: 'p2' } });
    record = edit(record, { fields: { password: 'p3' } });
    expect(record.history.versions.map((v) => v.versionNumber)).toEqual([1, 2, 3]);
  });

  it('stores only the changed fields, not a whole copy of the record', () => {
    // The reason the model stores deltas at all: a full copy per edit duplicates every
    // unchanged secret once per save, forever.
    const after = edit(base(), { title: 'Email' });
    expect(Object.keys(after.history.versions[0]?.snapshot ?? {})).toEqual(['title']);
  });
});

describe('pruneVersions', () => {
  const versions = [1, 2, 3, 4, 5].map((n) => ({
    versionNumber: n,
    savedAt: n,
    changedFields: ['title'] as VersionedField[],
    snapshot: { title: `t${n}` },
    origin: { action: 'update' as const },
  }));

  it('keeps everything when the cap is null', () => {
    expect(pruneVersions(versions, null)).toHaveLength(5);
  });

  it('drops the oldest first', () => {
    expect(pruneVersions(versions, 2).map((v) => v.versionNumber)).toEqual([4, 5]);
  });

  it('keeps none at a cap of zero', () => {
    expect(pruneVersions(versions, 0)).toEqual([]);
  });

  it('never renumbers what survives', () => {
    // An exported timeline, a bug report quoting "version 4", and a selection held by the
    // UI all keep meaning something.
    expect(pruneVersions(versions, 2)[0]?.versionNumber).toBe(4);
  });

  it('prunes as versions are appended, not only on demand', () => {
    let record: Credential = { ...base(), history: { ...base().history, maxVersions: 2 } };
    for (const password of ['p1', 'p2', 'p3', 'p4']) {
      record = edit(record, { fields: { password } });
    }
    expect(record.history.versions.map((v) => v.versionNumber)).toEqual([3, 4]);
  });
});

describe('resolveState', () => {
  it('reconstructs the state before a change', () => {
    let record = base();
    record = edit(record, { fields: { password: 'p1' } });
    record = edit(record, { fields: { password: 'p2' } });

    expect(resolveState(record, 1)?.password).toBe('p0');
    expect(resolveState(record, 2)?.password).toBe('p1');
    expect(resolveState(record, 'current')?.password).toBe('p2');
  });

  it('reconstructs a field the target version never touched', () => {
    // A version stores only what changed, so the username is recovered by *not* finding it
    // in any snapshot on the way back. Reading `snapshot.username` directly would return
    // nothing and a UI would show "empty" — a lie about the record's past.
    let record = base();
    record = edit(record, { fields: { username: 'u1' } });
    record = edit(record, { fields: { password: 'p1' } });

    expect(resolveState(record, 2)?.username).toBe('u1');
    expect(resolveState(record, 1)?.username).toBe('u0');
  });

  it('returns null for a version that is not there', () => {
    // Not a partial reconstruction: a half-resolved record offered as a restore target
    // would quietly write the wrong values.
    expect(resolveState(base(), 7)).toBeNull();
  });

  it('still resolves every surviving version after pruning', () => {
    // The property that decides whether backward deltas were the right choice. Forward
    // deltas would need the pruned base and would resolve to nothing here.
    let record: Credential = { ...base(), history: { ...base().history, maxVersions: 2 } };
    for (const password of ['p1', 'p2', 'p3']) {
      record = edit(record, { fields: { password } });
    }

    expect(record.history.versions.map((v) => v.versionNumber)).toEqual([2, 3]);
    for (const version of record.history.versions) {
      expect(resolveState(record, version.versionNumber)).not.toBeNull();
    }
    expect(resolveState(record, 2)?.password).toBe('p1');
    expect(resolveState(record, 3)?.password).toBe('p2');
  });

  it('resolves every versioned field, not just the ones that ever changed', () => {
    const state = resolveState(edit(base(), { title: 'Email' }), 1);
    expect(Object.keys(state ?? {}).sort()).toEqual([...VERSIONED_FIELDS].sort());
  });
});

describe('diffVersion and comparePoints', () => {
  it('diffs one entry against the state that replaced it', () => {
    let record = base();
    record = edit(record, { fields: { password: 'p1' }, title: 'Email' });
    record = edit(record, { fields: { password: 'p2' } });

    expect(diffVersion(record, 1)).toEqual([
      { field: 'title', before: 'Mail', after: 'Email', isSecret: false },
      { field: 'password', before: 'p0', after: 'p1', isSecret: true },
    ]);
  });

  it('diffs the newest entry against the live record', () => {
    const record = edit(base(), { fields: { password: 'p1' } });
    expect(diffVersion(record, 1)).toEqual([
      { field: 'password', before: 'p0', after: 'p1', isSecret: true },
    ]);
  });

  it('marks secret fields so a caller knows not to log them', () => {
    const record = edit(base(), { fields: { notes: 'n1' } });
    expect(diffVersion(record, 1)?.[0]?.isSecret).toBe(true);
  });

  it('compares arrays structurally rather than by reference', () => {
    // `urls` is a fresh array on every patch, so reference equality would report a change
    // on every single edit.
    const record = edit(base(), { fields: { urls: ['https://a.example'] } });
    expect(comparePoints(record, 1, 'current')?.map((d) => d.field)).toEqual(['urls']);

    const untouched = edit(record, { title: 'Email' });
    expect(comparePoints(untouched, 2, 'current')?.map((d) => d.field)).toEqual(['title']);
  });

  it('returns diffs in a stable field order', () => {
    let record = base();
    record = edit(record, { fields: { password: 'p1', email: 'e1', username: 'u1' } });
    expect(comparePoints(record, 1, 'current')?.map((d) => d.field)).toEqual([
      'username',
      'email',
      'password',
    ]);
  });

  it('returns null when either point is unknown', () => {
    const record = edit(base(), { title: 'Email' });
    expect(comparePoints(record, 9, 'current')).toBeNull();
    expect(comparePoints(record, 'current', 9)).toBeNull();
  });
});

describe('restoreVersion', () => {
  it('puts every field back to the state before that change', () => {
    let record = base();
    record = edit(record, { fields: { password: 'p1' }, title: 'Email' });

    const result = restoreVersion(record, 1, origin('restore'), context());
    expect(result?.credential.fields.password).toBe('p0');
    expect(result?.credential.title).toBe('Mail');
  });

  it('records the restore as a change of its own', () => {
    let record = base();
    record = edit(record, { fields: { password: 'p1' } });

    const result = restoreVersion(record, 1, origin('restore'), context());
    const versions = result?.credential.history.versions ?? [];
    expect(versions).toHaveLength(2);
    expect(versions[1]?.origin.action).toBe('restore');
    // The restore's own version snapshots what it replaced, so it can itself be undone.
    expect(versions[1]?.snapshot).toEqual({ password: 'p1' });
  });

  it('is itself restorable — undoing a restore', () => {
    let record = base();
    record = edit(record, { fields: { password: 'p1' } });
    const restored = restoreVersion(record, 1, origin('restore'), context())?.credential;
    expect(restored?.fields.password).toBe('p0');

    const undone = restoreVersion(restored!, 2, origin('restore'), context());
    expect(undone?.credential.fields.password).toBe('p1');
  });

  it('changes nothing, and writes no version, when the record is already in that state', () => {
    let record = base();
    record = edit(record, { fields: { password: 'p1' } });
    record = restoreVersion(record, 1, origin('restore'), context())!.credential;

    const again = restoreVersion(record, 1, origin('restore'), context());
    expect(again?.changedFields).toEqual([]);
    expect(again?.credential.history.versions).toHaveLength(2);
  });

  it('returns null for an unknown version', () => {
    expect(restoreVersion(base(), 4, origin('restore'), context())).toBeNull();
  });

  it('validates the restored record like any other edit', () => {
    // A version from a corrupt file must not bypass the record's invariants by arriving
    // through the history door. 500 characters is past the 400-character title cap.
    const record = edit(base(), { title: 'Email' });
    const corrupt: Credential = {
      ...record,
      history: {
        ...record.history,
        versions: [{ ...record.history.versions[0]!, snapshot: { title: 'x'.repeat(500) } }],
      },
    };
    expect(() => {
      restoreVersion(corrupt, 1, origin('restore'), context());
    }).toThrow();
  });
});

describe('restoreField', () => {
  it('restores one field and leaves the rest alone', () => {
    let record = base();
    record = edit(record, { fields: { password: 'p1', username: 'u1' }, title: 'Email' });

    const result = restoreField(record, 1, 'password', origin('restore'), context());
    expect(result?.credential.fields.password).toBe('p0');
    expect(result?.credential.fields.username).toBe('u1');
    expect(result?.credential.title).toBe('Email');
    expect(result?.changedFields).toEqual(['password']);
  });

  it('restores a field the target version never itself recorded', () => {
    let record = base();
    record = edit(record, { fields: { username: 'u1' } });
    record = edit(record, { fields: { password: 'p1' } });

    // Version 2 changed only the password, but the username *at that point* was u1.
    const result = restoreField(record, 2, 'username', origin('restore'), context());
    expect(result?.credential.fields.username).toBe('u1');
  });
});

describe('historicSecret', () => {
  it('reads a recorded old value', () => {
    const record = edit(base(), { fields: { password: 'p1' } });
    expect(historicSecret(record, 1, 'password')).toBe('p0');
  });

  it('returns null when that version did not record the field', () => {
    // Deliberately not the same answer as "the value was empty". The caller that needs the
    // value at that point in time uses `resolveState`; conflating the two would let a UI
    // report an old password as blank.
    const record = edit(base(), { title: 'Email' });
    expect(historicSecret(record, 1, 'password')).toBeNull();
  });
});

describe('assertValidHistory', () => {
  const withVersions = (versions: Credential['history']['versions']): Credential => ({
    ...base(),
    history: { enabled: true, maxVersions: null, versions },
  });

  it('accepts a record built by the ordinary path', () => {
    expect(() => {
      assertValidHistory(edit(base(), { title: 'Email' }));
    }).not.toThrow();
  });

  it('rejects version numbers that do not strictly ascend', () => {
    const version = {
      versionNumber: 1,
      savedAt: 1,
      changedFields: ['title'] as VersionedField[],
      snapshot: { title: 'a' },
      origin: { action: 'update' as const },
    };
    expect(() => {
      assertValidHistory(withVersions([version, version]));
    }).toThrow(/ascend/);
  });

  it('rejects a snapshot key the version does not list as changed', () => {
    // A value the timeline would silently apply during a restore without ever showing it
    // in the diff — which is the shape of a data-loss bug that looks like a UI glitch.
    expect(() => {
      assertValidHistory(
        withVersions([
          {
            versionNumber: 1,
            savedAt: 1,
            changedFields: ['title'],
            snapshot: { title: 'a', password: 'leaked' },
            origin: { action: 'update' },
          },
        ])
      );
    }).toThrow(/does not list as changed/);
  });

  it('rejects an unknown field name', () => {
    expect(() => {
      assertValidHistory(
        withVersions([
          {
            versionNumber: 1,
            savedAt: 1,
            changedFields: ['nonsense' as VersionedField],
            snapshot: {},
            origin: { action: 'update' },
          },
        ])
      );
    }).toThrow(/unknown field/);
  });

  it('rejects more versions than the cap allows', () => {
    const record = withVersions([
      {
        versionNumber: 1,
        savedAt: 1,
        changedFields: ['title'],
        snapshot: { title: 'a' },
        origin: { action: 'update' },
      },
    ]);
    expect(() => {
      assertValidHistory({ ...record, history: { ...record.history, maxVersions: 0 } });
    }).toThrow(/exceeds the cap/);
  });
});

describe('currentValues', () => {
  it('covers every versioned field', () => {
    // The link between the record model and the version model. A field added to
    // `VersionedValues` but not read here would be silently unversionable.
    expect(Object.keys(currentValues(base())).sort()).toEqual([...VERSIONED_FIELDS].sort());
  });
});
