// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  isCustomFieldValueSecret,
  type Credential,
  type CustomField,
  type SecurityQuestion,
} from '@shared/model/credential.js';
import type { MergeNoteKind, MergeReport } from '@shared/model/sync.js';
import { DEFAULT_VAULT_SETTINGS, type VaultDocument } from '@shared/model/vault-document.js';
import { assertValidHistory } from '../history/versioning.js';
import { mergeDocuments } from './merge-document.js';
import {
  DAY,
  MERGE_OPTIONS,
  NOW,
  attachment,
  customField,
  doc,
  edited,
  folder,
  paletteTag,
  question,
  record,
  version,
} from './test-fixtures.js';

/**
 * The properties that have to hold for *every* pair of documents, not just the ones someone
 * thought to write a case for.
 *
 * A merge engine is tested case by case and shipped, and then the case nobody wrote is the one
 * that runs on a real vault at two in the morning. These five properties are the net under
 * that, and each is here because breaking it is silent:
 *
 *   1. **No record is ever lost.** Goal G1. A record on either side is in the result.
 *   2. **A tombstone is never overruled.** The merged record is live only when both sides were
 *      live, or when the ancestor proves one side restored it.
 *   3. **No secret reaches the report.** Every secret string in either document is planted and
 *      then hunted for in the serialised report. This is decision D13 as an executable test
 *      rather than a convention someone has to remember.
 *   4. **`merge(x, x) === x`.** A sync with a device that has nothing new must be a no-op — not
 *      a structurally-similar rebuild that renumbers history and marks a hundred records
 *      updated.
 *   5. **`merge(a, b)` agrees with `merge(b, a)`.** A skewed clock, a different sync direction
 *      or a different button pressed first must not change the answer. The exceptions are
 *      named and justified below rather than quietly excluded.
 */

// ── The scenario table ───────────────────────────────────────────────────────

interface Scenario {
  readonly name: string;
  readonly base: VaultDocument | null;
  readonly ours: VaultDocument;
  readonly theirs: VaultDocument;
}

const gmail = record({ id: 'r1', title: 'Gmail', password: 'shared-old', tags: ['work'] });
const bank = record({
  id: 'r2',
  title: 'Bank',
  username: 'acct',
  custom: [customField('c1', 'Sort code', '00-11')],
});
const filed = record({ id: 'r3', title: 'Filed', folderId: 'f1' });
const work = folder('f1', 'Work');

/**
 * Version numbers deliberately start at 5, not 1.
 *
 * Retention pruning drops the oldest entries and **never renumbers** what is left, so a real
 * timeline's numbers have gaps in it and do not start at one. Fixtures numbered 1, 2, 3 would
 * let a merge that renumbers everything on every sync pass `merge(x, x) === x` by coincidence —
 * and that bug invalidates every version number a user has written down or a bug report quotes.
 */
const withHistory = record({
  id: 'r4',
  title: 'Historied',
  versions: [version({ versionNumber: 5, savedAt: NOW - 30 * DAY, snapshot: { title: 'Older' } })],
});

/**
 * Every side of every scenario is **internally consistent** — every `folderId` a record uses
 * exists in that same document's folder list. That is not a convenience: property 4 asserts
 * `merge(x, x)` returns `x` byte for byte, and a document that already needed repairing would
 * come back repaired and fail for a reason that has nothing to do with merging.
 */
const SCENARIOS: readonly Scenario[] = [
  {
    name: 'two devices editing different fields',
    base: doc({ records: [gmail, bank] }),
    ours: doc({ records: [edited(gmail, { title: 'Google Mail' }), bank] }),
    theirs: doc({ records: [edited(gmail, { password: 'rotated' }), bank] }),
  },
  {
    name: 'two devices editing the same field',
    base: doc({ records: [gmail] }),
    ours: doc({ records: [edited(gmail, { password: 'mine' })] }),
    theirs: doc({ records: [edited(gmail, { password: 'yours' })] }),
  },
  {
    name: 'trashed here, edited there',
    base: doc({ records: [gmail] }),
    ours: doc({ records: [edited(gmail, { trashedAt: NOW - DAY })] }),
    theirs: doc({ records: [edited(gmail, { title: 'Renamed' })] }),
  },
  {
    name: 'trashed there, edited here',
    base: doc({ records: [gmail] }),
    ours: doc({ records: [edited(gmail, { title: 'Renamed' })] }),
    theirs: doc({ records: [edited(gmail, { trashedAt: NOW - DAY })] }),
  },
  {
    name: 'a record on one side only, with an ancestor',
    base: doc({ records: [gmail, bank] }),
    ours: doc({ records: [gmail] }),
    theirs: doc({ records: [gmail, bank] }),
  },
  {
    name: 'independent creation of the same id',
    base: doc(),
    ours: doc({ records: [record({ id: 'new', title: 'Mine' })] }),
    theirs: doc({ records: [record({ id: 'new', title: 'Theirs' })] }),
  },
  {
    name: 'no ancestor at all',
    base: null,
    ours: doc({ records: [gmail, bank] }),
    theirs: doc({ records: [edited(gmail, { username: 'other' })] }),
  },
  {
    name: 'keyed lists growing on both sides',
    base: doc({ records: [bank] }),
    ours: doc({
      records: [
        edited(bank, {
          custom: [
            customField('c1', 'Sort code', '00-11'),
            customField('c2', 'PIN', '1234', { type: 'pin' }),
          ],
          securityQuestions: [question('q1', 'Pet?', 'Rex')],
        }),
      ],
    }),
    theirs: doc({
      records: [
        edited(bank, {
          custom: [customField('c1', 'Sort code', '00-11'), customField('c3', 'IBAN', 'GB00')],
          securityQuestions: [question('q2', 'City?', 'Leeds')],
        }),
      ],
    }),
  },
  {
    name: 'tags diverging on both sides',
    base: doc({ records: [gmail], tags: [paletteTag('t1', 'work')] }),
    ours: doc({
      records: [edited(gmail, { tags: ['work', 'email'] })],
      tags: [paletteTag('t1', 'work')],
    }),
    theirs: doc({
      records: [edited(gmail, { tags: ['2fa'] })],
      tags: [paletteTag('t1', 'work'), paletteTag('t2', '2fa')],
    }),
  },
  {
    name: 'a folder deleted on one side, still in use on the other',
    base: doc({ records: [filed], folders: [work] }),
    ours: doc({ records: [edited(filed, { folderId: null })], folders: [] }),
    theirs: doc({ records: [filed], folders: [work] }),
  },
  {
    name: 'settings pulling in opposite directions',
    base: null,
    ours: doc({
      settings: { ...DEFAULT_VAULT_SETTINGS, passwordAgeWarningDays: 365, trashRetentionDays: 30 },
    }),
    theirs: doc({
      settings: { ...DEFAULT_VAULT_SETTINGS, passwordAgeWarningDays: 90, trashRetentionDays: null },
    }),
  },
  {
    name: 'timelines diverging on both sides',
    base: doc({ records: [withHistory] }),
    ours: doc({
      records: [
        edited(withHistory, {
          title: 'Ours',
          versions: [
            version({ versionNumber: 5, savedAt: NOW - 30 * DAY, snapshot: { title: 'Older' } }),
            version({ versionNumber: 6, savedAt: NOW - 3 * DAY, snapshot: { title: 'Historied' } }),
          ],
        }),
      ],
    }),
    theirs: doc({
      records: [
        edited(withHistory, {
          username: 'theirs',
          versions: [
            version({ versionNumber: 5, savedAt: NOW - 30 * DAY, snapshot: { title: 'Older' } }),
            version({ versionNumber: 6, savedAt: NOW - 2 * DAY, snapshot: { username: 'user' } }),
          ],
        }),
      ],
    }),
  },
  {
    name: 'attachments arriving from the other side',
    base: doc({ records: [gmail] }),
    ours: doc({ records: [gmail] }),
    theirs: doc({ records: [edited(gmail, { attachments: [attachment('aaaa')] })] }),
  },
  {
    name: 'both empty',
    base: doc(),
    ours: doc(),
    theirs: doc(),
  },
  {
    name: 'one side empty',
    base: null,
    ours: doc(),
    theirs: doc({ records: [gmail, bank] }),
  },
];

// ── 1. No record is ever lost ────────────────────────────────────────────────

describe('no record on either side is ever lost', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, () => {
      const merged = mergeDocuments(scenario.base, scenario.ours, scenario.theirs, MERGE_OPTIONS);
      const survivors = new Set(merged.document.records.map((entry) => entry.id));

      for (const entry of [...scenario.ours.records, ...scenario.theirs.records]) {
        expect(survivors.has(entry.id)).toBe(true);
      }
    });
  }

  it('drops a record only when both sides agree it is gone', () => {
    // The single exception, and it needs an ancestor to prove the agreement. Absence on one
    // side alone is never enough — see the header of `merge-document.ts`.
    const base = doc({ records: [gmail, bank] });
    const both = doc({ records: [gmail] });
    const merged = mergeDocuments(base, both, both, MERGE_OPTIONS);
    expect(merged.document.records.map((entry) => entry.id)).toEqual(['r1']);
  });
});

describe('every merged record still satisfies the model invariants', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, () => {
      const merged = mergeDocuments(scenario.base, scenario.ours, scenario.theirs, MERGE_OPTIONS);
      for (const entry of merged.document.records) assertValidHistory(entry);
    });
  }
});

// ── 2. A tombstone is never overruled ────────────────────────────────────────

describe('the tombstone matrix', () => {
  const T1 = NOW - 5 * DAY;
  const T2 = NOW - DAY;
  const SIDES: readonly (number | null)[] = [null, T1, T2];
  const ANCESTORS: readonly {
    readonly name: string;
    readonly trashedAt: number | null | 'none';
  }[] = [
    { name: 'no ancestor', trashedAt: 'none' },
    { name: 'ancestor live', trashedAt: null },
    { name: `ancestor trashed at T1`, trashedAt: T1 },
  ];

  const subject = record({ id: 'a', title: 'Subject' });

  for (const ancestor of ANCESTORS) {
    for (const ours of SIDES) {
      for (const theirs of SIDES) {
        it(`${ancestor.name}: ours=${String(ours)} theirs=${String(theirs)}`, () => {
          const base =
            ancestor.trashedAt === 'none'
              ? null
              : doc({ records: [edited(subject, { trashedAt: ancestor.trashedAt })] });
          const oursDoc = doc({ records: [edited(subject, { trashedAt: ours })] });
          const theirsDoc = doc({ records: [edited(subject, { trashedAt: theirs })] });

          // The merged record may be live for exactly two reasons, and no others: nobody
          // deleted it, or the ancestor was already trashed and one side restored it while the
          // other left the tombstone exactly as it found it. Anything else that comes back live
          // is a resurrection.
          const bothLive = ours === null && theirs === null;
          const ancestorTombstone = ancestor.trashedAt === 'none' ? null : ancestor.trashedAt;
          const restored =
            ancestorTombstone !== null &&
            ((ours === null && theirs === ancestorTombstone) ||
              (theirs === null && ours === ancestorTombstone));

          const forwards = mergeDocuments(base, oursDoc, theirsDoc, MERGE_OPTIONS);
          const backwards = mergeDocuments(base, theirsDoc, oursDoc, MERGE_OPTIONS);

          expect(forwards.document.records[0]?.trashedAt === null).toBe(bothLive || restored);
          expect(backwards.document.records[0]?.trashedAt === null).toBe(bothLive || restored);
          // And the record itself is never dropped, whichever way it went.
          expect(forwards.document.records).toHaveLength(1);
        });
      }
    }
  }

  it('keeps the later of two tombstones, so retention purges no sooner than intended', () => {
    const oursDoc = doc({ records: [edited(subject, { trashedAt: T1 })] });
    const theirsDoc = doc({ records: [edited(subject, { trashedAt: T2 })] });
    expect(
      mergeDocuments(null, oursDoc, theirsDoc, MERGE_OPTIONS).document.records[0]?.trashedAt
    ).toBe(T2);
    expect(
      mergeDocuments(null, theirsDoc, oursDoc, MERGE_OPTIONS).document.records[0]?.trashedAt
    ).toBe(T2);
  });
});

// ── 3. No secret reaches the report ──────────────────────────────────────────

/** Every string in a document that decision D13 says must never cross the bridge. */
function collectSecrets(document: VaultDocument): string[] {
  const secrets: string[] = [];

  const fromQuestions = (questions: readonly SecurityQuestion[]): void => {
    for (const entry of questions) secrets.push(entry.answer);
  };
  const fromCustom = (fields: readonly CustomField[]): void => {
    for (const entry of fields) {
      if (isCustomFieldValueSecret(entry)) secrets.push(entry.value);
    }
  };

  for (const entry of document.records) {
    secrets.push(entry.fields.password, entry.fields.notes);
    fromQuestions(entry.fields.securityQuestions);
    fromCustom(entry.fields.custom);

    // A snapshot holds *old* secrets, which are exactly as sensitive as current ones and are
    // the half a projector is most likely to forget.
    for (const historic of entry.history.versions) {
      const { snapshot } = historic;
      if (snapshot.password !== undefined) secrets.push(snapshot.password);
      if (snapshot.notes !== undefined) secrets.push(snapshot.notes);
      if (snapshot.securityQuestions !== undefined) fromQuestions(snapshot.securityQuestions);
      if (snapshot.custom !== undefined) fromCustom(snapshot.custom);
    }
  }

  // Short strings would produce false positives against ids and tokens without proving
  // anything; every planted marker below is long.
  return secrets.filter((secret) => secret.length >= 4);
}

const MARKER = 'KH-LEAK-MARKER';

function markedRecord(side: string): Credential {
  return record({
    id: 'marked',
    title: `Marked ${side}`,
    password: `${MARKER}-PASSWORD-${side}`,
    notes: `${MARKER}-NOTES-${side}`,
    securityQuestions: [question('q1', 'First pet?', `${MARKER}-ANSWER-${side}`)],
    custom: [
      customField('c1', 'PIN', `${MARKER}-PIN-${side}`, { type: 'pin' }),
      customField('c2', 'Hidden', `${MARKER}-HIDDEN-${side}`, { hidden: true }),
      // Deliberately not secret. Its value is *supposed* to cross — a resolver has to render
      // "Account number: 4471" — so it carries no marker and proves the test is not simply
      // asserting that nothing at all gets through.
      customField('c3', 'Account', '4471'),
    ],
    versions: [
      version({
        versionNumber: 1,
        savedAt: NOW - 40 * DAY,
        snapshot: { password: `${MARKER}-HISTORIC-${side}` },
      }),
    ],
  });
}

describe('no secret ever reaches the merge report', () => {
  const base = doc({ records: [markedRecord('BASE')] });
  const ours = doc({ records: [markedRecord('OURS')] });
  const theirs = doc({ records: [markedRecord('THEIRS')] });

  it('not one of the planted markers, in either direction', () => {
    for (const [left, right] of [
      [ours, theirs],
      [theirs, ours],
    ] as const) {
      const merged = mergeDocuments(base, left, right, MERGE_OPTIONS);
      const serialised = JSON.stringify(merged.report);

      expect(serialised).not.toContain(MARKER);
      // Non-vacuity: the secrets genuinely conflicted, so the report had every opportunity.
      expect(merged.report.conflicts.length).toBeGreaterThan(0);
      expect(serialised).toContain('"kind":"secret"');
      // …and they really are in the merged document, so nothing was "kept safe" by dropping it.
      expect(JSON.stringify(merged.document)).toContain(MARKER);
    }
  });

  it('reports the length of a secret, which is a fact about it rather than the thing itself', () => {
    const merged = mergeDocuments(base, ours, theirs, MERGE_OPTIONS);
    const password = merged.report.conflicts.find((conflict) => conflict.field === 'password');
    expect(password?.ours).toEqual({ kind: 'secret', length: `${MARKER}-PASSWORD-OURS`.length });
    expect(password?.theirs).toEqual({
      kind: 'secret',
      length: `${MARKER}-PASSWORD-THEIRS`.length,
    });
  });

  it('lets a non-secret custom value through, so a resolver can actually show it', () => {
    const withValue = doc({
      records: [
        edited(markedRecord('OURS'), { custom: [customField('c3', 'Account', 'VISIBLE-4471')] }),
      ],
    });
    const merged = mergeDocuments(base, withValue, theirs, MERGE_OPTIONS);
    expect(JSON.stringify(merged.report)).toContain('VISIBLE-4471');
  });

  for (const scenario of SCENARIOS) {
    it(`holds for every secret in: ${scenario.name}`, () => {
      const merged = mergeDocuments(scenario.base, scenario.ours, scenario.theirs, MERGE_OPTIONS);
      const serialised = JSON.stringify(merged.report);
      const secrets = [
        ...collectSecrets(scenario.ours),
        ...collectSecrets(scenario.theirs),
        ...(scenario.base === null ? [] : collectSecrets(scenario.base)),
      ];
      for (const secret of secrets) expect(serialised).not.toContain(secret);
    });
  }
});

// ── 4. merge(x, x) === x ─────────────────────────────────────────────────────

describe('merging a document with itself changes nothing', () => {
  for (const scenario of SCENARIOS) {
    for (const [label, side] of [
      ['ours', scenario.ours],
      ['theirs', scenario.theirs],
    ] as const) {
      it(`${scenario.name} — ${label}`, () => {
        const merged = mergeDocuments(scenario.base, side, side, MERGE_OPTIONS);
        expect(merged.document).toEqual(side);
        expect(merged.report.conflicts).toEqual([]);
        expect(merged.report.requiresResolution).toBe(false);
        expect(merged.report.counts.updated).toBe(0);
        expect(merged.report.counts.added).toBe(0);
      });
    }
  }

  it('leaves an untouched timeline’s numbering alone when only one side edited', () => {
    // The document-level `merge(x, x)` above is satisfied by the record merge's early return,
    // so it never reaches the history code. This case does: our copy is the ancestor and only
    // the other side moved, so the merged timeline must be *theirs, unchanged* — gaps and all.
    const base = doc({ records: [withHistory] });
    const theirs = doc({
      records: [
        edited(withHistory, {
          title: 'Theirs',
          versions: [
            version({ versionNumber: 5, savedAt: NOW - 30 * DAY, snapshot: { title: 'Older' } }),
            version({ versionNumber: 9, savedAt: NOW - 2 * DAY, snapshot: { title: 'Historied' } }),
          ],
        }),
      ],
    });

    const merged = mergeDocuments(base, base, theirs, MERGE_OPTIONS);
    expect(
      merged.document.records[0]?.history.versions.map((entry) => entry.versionNumber)
    ).toEqual([5, 9]);
    expect(merged.report.notes.map((note) => note.kind)).not.toContain('history-renumbered');
  });

  it('is still a no-op when a merge origin would otherwise write a version', () => {
    // The audit trail must not fill with "merged" entries every time a device syncs with one
    // that had nothing to say.
    const merged = mergeDocuments(
      doc({ records: [gmail] }),
      doc({ records: [gmail] }),
      doc({ records: [gmail] }),
      {
        ...MERGE_OPTIONS,
        mergeOrigin: {
          action: 'merge',
          deviceName: 'laptop',
          platform: 'test',
          appVersion: '0.0.0',
        },
      }
    );
    expect(merged.document.records[0]?.history.versions).toEqual([]);
  });
});

// ── 5. merge(a, b) agrees with merge(b, a) ───────────────────────────────────

/**
 * Notes that are statements about *our* copy rather than about the merge.
 *
 * `record-added`, `folder-added`, `tag-added` and `attachment-needed` all mean "this arrived
 * from the other side" or "this is a chunk we do not hold", so swapping the arguments changes
 * which of them are true — correctly. Everything else describes what happened to the data and
 * must be identical in both directions.
 */
const PERSPECTIVE_NOTES: readonly MergeNoteKind[] = [
  'record-added',
  'folder-added',
  'tag-added',
  'attachment-needed',
];

function symmetricNotes(report: MergeReport): string[] {
  return report.notes
    .filter((note) => !PERSPECTIVE_NOTES.includes(note.kind))
    .map((note) => `${note.kind}:${note.targetId ?? ''}:${String(note.count)}`)
    .sort();
}

describe('the merge is commutative', () => {
  for (const scenario of SCENARIOS) {
    const forwards = (): MergeReport =>
      mergeDocuments(scenario.base, scenario.ours, scenario.theirs, MERGE_OPTIONS).report;
    const backwards = (): MergeReport =>
      mergeDocuments(scenario.base, scenario.theirs, scenario.ours, MERGE_OPTIONS).report;

    it(`raises the same conflicts either way round: ${scenario.name}`, () => {
      // Ids are built without reference to argument position precisely so that a resolver can
      // keep the user's selections across a re-merge. If that ever stops being true, the
      // resolver silently forgets every choice the user made.
      expect(
        forwards()
          .conflicts.map((conflict) => conflict.id)
          .sort()
      ).toEqual(
        backwards()
          .conflicts.map((conflict) => conflict.id)
          .sort()
      );
      expect(forwards().requiresResolution).toBe(backwards().requiresResolution);
    });

    it(`reports the same outcome either way round: ${scenario.name}`, () => {
      expect(symmetricNotes(forwards())).toEqual(symmetricNotes(backwards()));
      expect(forwards().counts.merged).toBe(backwards().counts.merged);
      expect(forwards().counts.trashed).toBe(backwards().counts.trashed);
      expect(forwards().counts.conflicted).toBe(backwards().counts.conflicted);
    });

    it(`produces the same document when nothing is left unresolved: ${scenario.name}`, () => {
      const left = mergeDocuments(scenario.base, scenario.ours, scenario.theirs, MERGE_OPTIONS);
      const right = mergeDocuments(scenario.base, scenario.theirs, scenario.ours, MERGE_OPTIONS);
      if (left.report.requiresResolution) {
        // A provisional value is ours by construction, so the two documents differ exactly in
        // the fields the user has yet to decide. That is the intended behaviour, not an
        // exception being swept aside — the conflict-id assertion above still binds.
        expect(right.report.requiresResolution).toBe(true);
        return;
      }
      expect(left.document).toEqual(right.document);
    });
  }

  it('is deliberately not commutative in the version it writes about itself', () => {
    // The merge version records what *this device's copy* changed, so its snapshot holds this
    // device's previous values. Two devices therefore write different — and both correct —
    // merge entries. Making this symmetric would mean recording a "previous state" that the
    // device doing the restoring never had.
    const base = doc({ records: [gmail] });
    const ours = doc({ records: [edited(gmail, { title: 'Ours' })] });
    const theirs = doc({ records: [edited(gmail, { username: 'theirs' })] });
    const options = {
      ...MERGE_OPTIONS,
      mergeOrigin: { action: 'merge' as const, deviceName: 'd', platform: 'test', appVersion: '0' },
    };

    const left = mergeDocuments(base, ours, theirs, options);
    const right = mergeDocuments(base, theirs, ours, options);
    expect(left.document.records[0]?.history.versions.at(-1)?.snapshot).toEqual({
      username: 'user',
    });
    expect(right.document.records[0]?.history.versions.at(-1)?.snapshot).toEqual({
      title: 'Gmail',
    });
  });
});
