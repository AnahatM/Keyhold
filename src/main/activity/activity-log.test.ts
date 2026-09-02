// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_KINDS,
  ACTIVITY_LEVEL_DETAIL,
  ACTIVITY_LOG_CAPACITY,
  type ActivityEntry,
} from '@shared/model/activity.js';
import { AUDIT_PRIVACY_LEVELS, type SecretRef } from '@shared/model/credential.js';
import { ActivityLog } from './activity-log.js';

/**
 * The log's job is to be honest about what happened without becoming a second copy of the
 * vault. Four properties carry that, and each has a test that fails when it stops holding:
 * the ring is bounded and does not lie about it, locking wipes it, the privacy level gates
 * the same fields it gates in `ChangeOrigin`, and no entry can hold a value.
 *
 * Time is injected rather than slept on, for the same reason as in `secret-broker.test.ts`.
 */

function fakeClock(start = 1_700_000_000_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const password = (id: string): SecretRef => ({ kind: 'password', credentialId: id });

describe('the ring is bounded, at the boundary', () => {
  it('holds everything up to one below the cap', () => {
    const log = new ActivityLog({ capacity: 4 });
    for (let index = 0; index < 3; index += 1) log.record({ kind: 'reveal' });

    expect(log.size).toBe(3);
    expect(log.droppedCount).toBe(0);
  });

  it('holds exactly the cap without dropping anything', () => {
    const log = new ActivityLog({ capacity: 4 });
    for (let index = 0; index < 4; index += 1) log.record({ kind: 'reveal' });

    expect(log.size).toBe(4);
    expect(log.droppedCount).toBe(0);
    expect(log.entries().map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
  });

  it('drops exactly one entry at cap + 1, and it is the oldest', () => {
    const log = new ActivityLog({ capacity: 4 });
    for (let index = 0; index < 5; index += 1) log.record({ kind: 'reveal' });

    expect(log.size).toBe(4);
    expect(log.droppedCount).toBe(1);
    expect(log.entries().map((entry) => entry.seq)).toEqual([2, 3, 4, 5]);
  });

  it('stays at the cap and keeps its order after wrapping twice', () => {
    const log = new ActivityLog({ capacity: 4 });
    for (let index = 0; index < 11; index += 1) log.record({ kind: 'reveal' });

    expect(log.size).toBe(4);
    expect(log.droppedCount).toBe(7);
    // Ascending and contiguous — a ring whose head index drifts produces neither.
    expect(log.entries().map((entry) => entry.seq)).toEqual([8, 9, 10, 11]);
  });

  it('never returns a hole, however many times it has wrapped', () => {
    const log = new ActivityLog({ capacity: 3 });
    for (let index = 0; index < 20; index += 1) log.record({ kind: 'copy' });

    expect(log.entries()).toHaveLength(3);
    for (const entry of log.entries()) expect(entry).toBeDefined();
  });

  it('counts every action in the totals even after the entries are gone', () => {
    // The whole point of a separate total. The workload that overflows the buffer is a bulk
    // harvest, which is the workload where an under-reported count would matter most.
    const log = new ActivityLog({ capacity: 4 });
    for (let index = 0; index < 50; index += 1) log.record({ kind: 'reveal' });

    const snapshot = log.snapshot();
    expect(snapshot.entries).toHaveLength(4);
    expect(snapshot.totals.reveal).toBe(50);
    expect(snapshot.droppedCount).toBe(46);
  });

  it('refuses a capacity that would silently record nothing', () => {
    expect(() => new ActivityLog({ capacity: 0 })).toThrow(RangeError);
    expect(() => new ActivityLog({ capacity: -1 })).toThrow(RangeError);
    expect(() => new ActivityLog({ capacity: 2.5 })).toThrow(RangeError);
  });

  it('defaults to the documented capacity', () => {
    expect(new ActivityLog().capacity).toBe(ACTIVITY_LOG_CAPACITY);
  });
});

describe('cleared on lock', () => {
  it('drops every entry, every total, and the start time', () => {
    const log = new ActivityLog({ capacity: 8 });
    log.record({ kind: 'unlock' });
    log.record({ kind: 'reveal', subjectId: 'a' });
    log.record({ kind: 'copy', subjectId: 'a' });

    log.clear();

    const snapshot = log.snapshot();
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.startedAt).toBeNull();
    expect(snapshot.droppedCount).toBe(0);
    for (const kind of ACTIVITY_KINDS) expect(snapshot.totals[kind]).toBe(0);
  });

  it('leaves nothing reachable — a cleared log that filled up stays empty', () => {
    const log = new ActivityLog({ capacity: 3 });
    for (let index = 0; index < 9; index += 1) log.record({ kind: 'reveal', subjectId: 'a' });

    log.clear();
    expect(log.entries()).toEqual([]);
    expect(log.size).toBe(0);
  });

  it('keeps counting seq across a clear, so two sessions cannot collide on a key', () => {
    const log = new ActivityLog({ capacity: 4 });
    log.record({ kind: 'unlock' });
    log.record({ kind: 'reveal' });
    log.clear();

    expect(log.record({ kind: 'unlock' }).seq).toBe(3);
  });

  it('starts recording again cleanly after a clear', () => {
    const clock = fakeClock();
    const log = new ActivityLog({ capacity: 4, now: clock.now });
    log.record({ kind: 'unlock' });
    log.clear();

    clock.advance(5_000);
    log.record({ kind: 'unlock' });

    expect(log.snapshot().startedAt).toBe(1_700_000_005_000);
  });
});

describe('the audit privacy level governs the log too', () => {
  /**
   * A sweep over the levels rather than a case each, the same shape as `origin.test.ts`:
   * every level records an entry carrying both detail fields, and the assertion is that the
   * fields present are exactly the ones the level permits. A new level with no entry in
   * `ACTIVITY_LEVEL_DETAIL` is a compile error; a new level that leaks is this failing.
   */
  for (const level of AUDIT_PRIVACY_LEVELS) {
    it(`records only the permitted detail fields at "${level}"`, () => {
      const log = new ActivityLog({ privacyLevel: level });
      log.record({ kind: 'reveal', subjectId: 'cred-1', vaultLabel: 'Personal' });

      const [entry] = log.entries();
      const permitted = new Set<string>(ACTIVITY_LEVEL_DETAIL[level]);

      expect('subjectId' in (entry ?? {})).toBe(permitted.has('subjectId'));
      expect('vaultLabel' in (entry ?? {})).toBe(permitted.has('vaultLabel'));
    });
  }

  it('records nothing identifying at "none" — not even as an explicit undefined', () => {
    const log = new ActivityLog({ privacyLevel: 'none' });
    log.record({ kind: 'copy', subjectId: 'cred-1', vaultLabel: 'Personal' });

    const [entry] = log.entries();
    // `in`, not `=== undefined`: an explicitly-undefined key survives a structured clone
    // across IPC as a present key, which is the difference `exactOptionalPropertyTypes` is
    // about and the difference a JSON round trip erases.
    expect(entry === undefined ? [] : Object.keys(entry)).toEqual(['seq', 'at', 'kind']);
  });

  it('still records what happened at "none" — a history with no verbs is not a history', () => {
    const log = new ActivityLog({ privacyLevel: 'none' });
    log.record({ kind: 'lock', lockReason: 'idle' });
    log.record({ kind: 'reveal', secretKind: 'password', subjectId: 'cred-1' });
    log.record({ kind: 'import', count: 42 });

    const entries = log.entries();
    expect(entries[0]?.lockReason).toBe('idle');
    expect(entries[1]?.secretKind).toBe('password');
    expect(entries[1]?.subjectId).toBeUndefined();
    expect(entries[2]?.count).toBe(42);
  });

  it('applies a level change to the next entry, and does not rewrite the last one', () => {
    const log = new ActivityLog({ privacyLevel: 'device' });
    log.record({ kind: 'reveal', subjectId: 'cred-1' });

    log.setPrivacyLevel('none');
    log.record({ kind: 'reveal', subjectId: 'cred-2' });

    expect(log.entries()[0]?.subjectId).toBe('cred-1');
    expect(log.entries()[1]?.subjectId).toBeUndefined();
  });
});

describe('no entry can carry a value', () => {
  /**
   * The property test, with a planted marker.
   *
   * Every string that reaches the log in this test is the marker, so if any of them survives
   * anywhere in a serialised entry — as a subject, a label, a kind, a nested field a future
   * change adds — the assertion fails. Asserting over `JSON.stringify` rather than over named
   * fields is deliberate: a field added later is covered without anyone remembering to
   * extend this test, which is the only kind of guard that survives contact with a codebase.
   */
  const MARKER = 'correct-horse-battery-staple-MARKER';

  it('copies no field it was not asked for, even at the most permissive level', () => {
    // The fault this catches is the obvious implementation: `{ ...input, seq, at }`. That
    // spread works perfectly today and starts leaking the moment any caller — a future
    // feature, a merged branch, a mistake — puts a value on the object it hands over. The
    // log allow-lists fields instead, and this is what says so.
    const hostile = {
      kind: 'reveal',
      subjectId: 'cred-1',
      vaultLabel: 'Personal',
      secretKind: 'password',
      // Not part of `ActivityInput`. A spread would carry it straight through.
      revealedValue: MARKER,
      notes: MARKER,
    } as unknown as Parameters<ActivityLog['record']>[0];

    const log = new ActivityLog({ capacity: 16, privacyLevel: 'full' });
    log.record(hostile);

    expect(JSON.stringify(log.snapshot())).not.toContain(MARKER);
  });

  it('drops an identifying string at "none" rather than storing it anywhere', () => {
    // The same property from the other side: here the marker arrives in fields the log
    // genuinely accepts, at the level that forbids them. Removing the privacy gate fails
    // this while leaving the test above passing.
    const log = new ActivityLog({ capacity: 16, privacyLevel: 'none' });
    log.record({ kind: 'reveal', subjectId: MARKER, vaultLabel: MARKER });

    expect(JSON.stringify(log.snapshot())).not.toContain(MARKER);
  });

  it('has no field a value could be assigned to without a type error', () => {
    // The structural half of the same claim, stated where a reviewer will see it: an entry
    // has these keys and no others. A field named `value`, `password`, `secret` or `text`
    // appearing here would fail this and should fail review.
    const log = new ActivityLog({ privacyLevel: 'full' });
    log.record({
      kind: 'reveal',
      subjectId: 'cred-1',
      vaultLabel: 'Personal',
      count: 1,
      secretKind: 'password',
      lockReason: 'idle',
      unlockMethod: 'password',
    });

    const entry: ActivityEntry | undefined = log.entries()[0];
    expect(new Set(Object.keys(entry ?? {}))).toEqual(
      new Set([
        'seq',
        'at',
        'kind',
        'subjectId',
        'vaultLabel',
        'count',
        'secretKind',
        'lockReason',
        'unlockMethod',
      ])
    );
  });

  it('records the kind of a secret, never anything about its content', () => {
    const log = new ActivityLog({ privacyLevel: 'full' });
    const ref = password('cred-1');
    log.record({ kind: 'reveal', subjectId: ref.credentialId, secretKind: ref.kind });

    const [entry] = log.entries();
    expect(entry?.secretKind).toBe('password');
    expect(entry?.subjectId).toBe('cred-1');
  });
});

describe('the clock is injected, and the log uses it', () => {
  it('stamps entries with the injected clock rather than the wall clock', () => {
    const clock = fakeClock();
    const log = new ActivityLog({ now: clock.now });

    log.record({ kind: 'unlock' });
    clock.advance(90_000);
    log.record({ kind: 'lock', lockReason: 'idle' });

    expect(log.entries().map((entry) => entry.at)).toEqual([1_700_000_000_000, 1_700_000_090_000]);
  });

  it('reports the first entry as the start of the session, not the latest', () => {
    const clock = fakeClock();
    const log = new ActivityLog({ now: clock.now });

    log.record({ kind: 'unlock' });
    clock.advance(60_000);
    log.record({ kind: 'reveal' });

    expect(log.snapshot().startedAt).toBe(1_700_000_000_000);
  });
});

describe('a snapshot is a copy', () => {
  it('does not change when the log carries on recording', () => {
    const log = new ActivityLog({ capacity: 8 });
    log.record({ kind: 'unlock' });
    const snapshot = log.snapshot();

    log.record({ kind: 'reveal' });

    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.totals.reveal).toBe(0);
  });
});
