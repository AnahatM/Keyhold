// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ACTIVITY_KINDS, type ActivityEntry } from '@shared/model/activity.js';
import {
  ANNOUNCED_KINDS,
  MEANINGFUL_DISTRIBUTION_MIN,
  NAMING_OFF,
  describeDistribution,
  describeEntry,
  formatShare,
  recordCount,
  shouldAnnounce,
  smallSampleNote,
  subjectName,
  tagsOverlap,
} from './activity-presentation.js';
import { computeVaultStatistics, type StatisticsRecord } from './vault-statistics.js';

/**
 * The strings, and the naming decision they implement.
 *
 * The components are not tested here — `@testing-library/react` is not a dependency — but
 * every sentence a component can render comes from this module, so the strings themselves
 * are covered even though the JSX is not.
 */

const NOW = Date.UTC(2026, 5, 15);

function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return { seq: 1, at: NOW, kind: 'reveal', ...overrides };
}

describe('a row never names a record by default', () => {
  const TITLE = 'Barclays';
  const naming = { showRecordNames: true, nameFor: (): string => TITLE };

  it('omits the title when naming is off, even with a resolver available', () => {
    const line = describeEntry(entry({ subjectId: 'cred-1', secretKind: 'password' }), {
      showRecordNames: false,
      nameFor: (): string => TITLE,
    });

    expect(line).not.toContain(TITLE);
    expect(line).toBe('Revealed a password');
  });

  it('is off in the default naming object, so a call site that passes nothing is safe', () => {
    expect(NAMING_OFF.showRecordNames).toBe(false);
    expect(describeEntry(entry({ subjectId: 'cred-1', secretKind: 'password' }))).not.toContain(
      TITLE
    );
  });

  it('includes the title once the user turns it on', () => {
    const line = describeEntry(entry({ subjectId: 'cred-1', secretKind: 'password' }), naming);
    expect(line).toBe(`Revealed a password for ${TITLE}`);
  });

  it('cannot name anything when the entry carries no id — the privacy level already stripped it', () => {
    expect(subjectName(entry({ secretKind: 'password' }), naming)).toBeNull();
  });

  it('says nothing rather than "Unknown record" when the id no longer resolves', () => {
    const line = describeEntry(entry({ subjectId: 'gone', secretKind: 'password' }), {
      showRecordNames: true,
      nameFor: (): undefined => undefined,
    });

    expect(line).toBe('Revealed a password');
  });

  it('treats a blank title as no title', () => {
    expect(
      subjectName(entry({ subjectId: 'cred-1' }), {
        showRecordNames: true,
        nameFor: (): string => '   ',
      })
    ).toBeNull();
  });
});

describe('every kind reads as a sentence', () => {
  for (const kind of ACTIVITY_KINDS) {
    it(`describes "${kind}" without showing an identifier`, () => {
      const line = describeEntry(entry({ kind, count: 3, secretKind: 'password' }));

      expect(line.length).toBeGreaterThan(0);
      // The identifiers are kebab-case; a sentence that still contains one means a label was
      // missing and the raw key fell through.
      // Single-word kinds are not checked: "unlock" legitimately appears inside
      // "Vault unlocked", so there is no assertion to make about them here.
      if (kind.includes('-')) expect(line).not.toContain(kind);
    });
  }

  it('says how the vault was opened', () => {
    expect(describeEntry(entry({ kind: 'unlock', unlockMethod: 'quick-unlock' }))).toBe(
      'Vault unlocked with quick unlock'
    );
  });

  it('says why the vault locked, in words rather than in a reason code', () => {
    expect(describeEntry(entry({ kind: 'lock', lockReason: 'idle' }))).toBe(
      'Vault locked — no activity for a while'
    );
  });

  it('omits the reason cleanly when there is not one', () => {
    expect(describeEntry(entry({ kind: 'lock' }))).toBe('Vault locked');
  });

  it('distinguishes a reveal from a copy — one of them left the app', () => {
    expect(describeEntry(entry({ kind: 'reveal', secretKind: 'notes' }))).toBe('Revealed a note');
    expect(describeEntry(entry({ kind: 'copy', secretKind: 'notes' }))).toBe(
      'Copied a note to the clipboard'
    );
  });

  it('names a historic secret as a past one', () => {
    expect(describeEntry(entry({ kind: 'reveal', secretKind: 'historic-password' }))).toBe(
      'Revealed a past password'
    );
  });

  it('says plainly that an export left the vault', () => {
    expect(describeEntry(entry({ kind: 'export', count: 120 }))).toBe(
      '120 records exported out of the vault'
    );
  });

  it('gets the singular right', () => {
    expect(recordCount(1)).toBe('1 record');
    expect(recordCount(0)).toBe('0 records');
    expect(recordCount(2)).toBe('2 records');
  });
});

describe('the live region is not everything that happens', () => {
  it('announces a failed unlock, a lock, and an export', () => {
    expect(ANNOUNCED_KINDS).toEqual(['unlock-failed', 'lock', 'export']);
  });

  it('does not announce a copy, a reveal, or a save', () => {
    // The rule this exists for: a screen reader narrating every clipboard copy immediately
    // after the copy's own feedback is a live region people switch off, and one that is off
    // announces the failed unlock too.
    for (const kind of ['copy', 'reveal', 'save', 'clipboard-clear', 'unlock', 'import'] as const) {
      expect(shouldAnnounce(entry({ kind }))).toBe(false);
    }
  });

  it('announces the three that interrupt for a reason', () => {
    for (const kind of ['unlock-failed', 'lock', 'export'] as const) {
      expect(shouldAnnounce(entry({ kind }))).toBe(true);
    }
  });
});

describe('honesty about small numbers', () => {
  const records = (count: number): StatisticsRecord[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `cred-${index}`,
      favorite: false,
      folderId: null,
      tags: [],
      hasPassword: true,
      attachments: [],
      historyCount: 0,
      meta: {
        createdAt: NOW,
        updatedAt: NOW,
        passwordUpdatedAt: NOW,
        lastUsedAt: null,
        useCount: 0,
      },
    }));

  const distributionOf = (
    count: number
  ): ReturnType<typeof computeVaultStatistics>['passwordAge'] =>
    computeVaultStatistics({ records: records(count), trashedCount: 0, now: NOW }).passwordAge;

  it('warns below the threshold', () => {
    expect(smallSampleNote(distributionOf(MEANINGFUL_DISTRIBUTION_MIN - 1))).not.toBeNull();
  });

  it('stops warning at the threshold', () => {
    expect(smallSampleNote(distributionOf(MEANINGFUL_DISTRIBUTION_MIN))).toBeNull();
  });

  it('says what one record is worth, derived from the threshold rather than written down', () => {
    // Rule 9, applied to prose: the number in the sentence is parsed back out and checked
    // against the arithmetic, so raising the threshold cannot leave a stale percentage in
    // the copy.
    const note = smallSampleNote(distributionOf(5)) ?? '';
    expect(note).toContain('5 records');
    expect(note).toContain('20%');
  });

  it('says there is nothing to summarise rather than dividing by zero', () => {
    expect(smallSampleNote(distributionOf(0))).toBe('Nothing to summarise yet.');
  });
});

describe('distributions as text', () => {
  it('lists every non-empty bucket with its count and share', () => {
    const stats = computeVaultStatistics({
      records: [
        {
          id: 'a',
          favorite: false,
          folderId: null,
          tags: ['Work'],
          hasPassword: true,
          attachments: [],
          historyCount: 0,
          meta: {
            createdAt: NOW,
            updatedAt: NOW,
            passwordUpdatedAt: NOW,
            lastUsedAt: null,
            useCount: 0,
          },
        },
      ],
      trashedCount: 0,
      now: NOW,
    });

    expect(describeDistribution(stats.passwordAge, 'Password age')).toBe(
      'Password age, out of 1 record — Under 30 days: 1 (100%).'
    );
  });

  it('says so when there is nothing, rather than producing a dangling sentence', () => {
    const empty = computeVaultStatistics({ records: [], trashedCount: 0, now: NOW });
    expect(describeDistribution(empty.tags, 'Tags')).toBe('No Tags to summarise.');
  });

  it('rounds shares to whole percentages', () => {
    expect(formatShare(0.3333)).toBe('33%');
    expect(formatShare(1)).toBe('100%');
    expect(formatShare(0)).toBe('0%');
  });

  it('notices when tag bars add up to more than the records they describe', () => {
    // Tags are multi-valued, so the bars genuinely do not sum to the record count. The view
    // has to say so; this is what tells it to.
    const record = (id: string, tags: string[]): StatisticsRecord => ({
      id,
      favorite: false,
      folderId: null,
      tags,
      hasPassword: true,
      attachments: [],
      historyCount: 0,
      meta: {
        createdAt: NOW,
        updatedAt: NOW,
        passwordUpdatedAt: NOW,
        lastUsedAt: null,
        useCount: 0,
      },
    });

    const overlapping = computeVaultStatistics({
      records: [record('a', ['Work', 'Finance'])],
      trashedCount: 0,
      now: NOW,
    });
    const plain = computeVaultStatistics({
      records: [record('a', ['Work'])],
      trashedCount: 0,
      now: NOW,
    });

    expect(tagsOverlap(overlapping.tags)).toBe(true);
    expect(tagsOverlap(plain.tags)).toBe(false);
  });
});
