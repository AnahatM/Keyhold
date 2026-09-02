// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  GROWTH_MONTHS,
  MEANINGFUL_DISTRIBUTION_MIN,
  TOP_TAG_COUNT,
  computeVaultStatistics,
  formatBytes,
  medianPasswordAgeDays,
  monthlyGrowth,
  type StatisticsRecord,
} from './vault-statistics.js';

/**
 * The arithmetic, the edges, and the one property that matters: a statistic cannot contain a
 * password. The components are not tested directly — `@testing-library/react` is not a
 * dependency of this project — so everything the view shows is computed here, where it can
 * be.
 */

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);

function record(overrides: Partial<StatisticsRecord> = {}): StatisticsRecord {
  return {
    id: 'cred-1',
    favorite: false,
    folderId: null,
    tags: [],
    hasPassword: true,
    attachments: [],
    historyCount: 0,
    meta: {
      createdAt: NOW - 10 * DAY_MS,
      updatedAt: NOW - 10 * DAY_MS,
      passwordUpdatedAt: NOW - 10 * DAY_MS,
      lastUsedAt: null,
      useCount: 0,
    },
    ...overrides,
  };
}

function statisticsOf(
  records: readonly StatisticsRecord[],
  trashedCount = 0
): ReturnType<typeof computeVaultStatistics> {
  return computeVaultStatistics({ records, trashedCount, now: NOW });
}

describe('the empty vault', () => {
  const stats = statisticsOf([]);

  it('says it is empty rather than reporting zeroes as findings', () => {
    expect(stats.empty).toBe(true);
    expect(stats.recordCount).toBe(0);
  });

  it('has no oldest or newest record, rather than an oldest of zero', () => {
    expect(stats.oldestCreatedAt).toBeNull();
    expect(stats.newestCreatedAt).toBeNull();
  });

  it('has no median password age', () => {
    expect(stats.medianPasswordAgeDays).toBeNull();
  });

  it('divides by nothing without producing NaN', () => {
    for (const bucket of stats.passwordAge.buckets) {
      expect(Number.isFinite(bucket.share)).toBe(true);
      expect(bucket.share).toBe(0);
    }
    expect(stats.passwordAge.largest).toBe(0);
  });

  it('reports no distribution as meaningful', () => {
    expect(stats.passwordAge.meaningful).toBe(false);
    expect(stats.tags.meaningful).toBe(false);
  });

  it('still counts a trash that has records in it', () => {
    expect(statisticsOf([], 4).trashedCount).toBe(4);
  });

  it('produces a full growth window rather than an empty chart', () => {
    // Twelve points of zero is a true statement about a year; no points at all is a chart
    // that failed to render, and the two look identical to a user.
    expect(stats.growth).toHaveLength(GROWTH_MONTHS);
    expect(stats.growth.every((point) => point.added === 0 && point.total === 0)).toBe(true);
  });
});

describe('the single-record vault', () => {
  const stats = statisticsOf([record({ meta: { ...record().meta, passwordUpdatedAt: NOW } })]);

  it('counts one of everything it should', () => {
    expect(stats.recordCount).toBe(1);
    expect(stats.withPasswordCount).toBe(1);
    expect(stats.neverUsedCount).toBe(1);
  });

  it('gives the one record the whole share, and says the share means nothing', () => {
    const filled = stats.passwordAge.buckets.filter((bucket) => bucket.count > 0);
    expect(filled).toHaveLength(1);
    expect(filled[0]?.share).toBe(1);
    expect(stats.passwordAge.meaningful).toBe(false);
  });

  it('is its own oldest and newest', () => {
    expect(stats.oldestCreatedAt).toBe(stats.newestCreatedAt);
  });
});

describe('the too-few-to-be-meaningful threshold', () => {
  const many = (count: number): StatisticsRecord[] =>
    Array.from({ length: count }, (_, index) => record({ id: `cred-${index}` }));

  it('is not meaningful one below the threshold', () => {
    expect(statisticsOf(many(MEANINGFUL_DISTRIBUTION_MIN - 1)).passwordAge.meaningful).toBe(false);
  });

  it('is meaningful exactly at the threshold', () => {
    expect(statisticsOf(many(MEANINGFUL_DISTRIBUTION_MIN)).passwordAge.meaningful).toBe(true);
  });

  it('stays meaningful above it', () => {
    expect(statisticsOf(many(MEANINGFUL_DISTRIBUTION_MIN + 40)).passwordAge.meaningful).toBe(true);
  });

  it('reports exact counts either side of the threshold — only the shape is withheld', () => {
    const stats = statisticsOf(many(3));
    const total = stats.passwordAge.buckets.reduce((sum, bucket) => sum + bucket.count, 0);
    expect(total).toBe(3);
  });
});

describe('password age banding', () => {
  const aged = (days: number): StatisticsRecord =>
    record({ meta: { ...record().meta, passwordUpdatedAt: NOW - days * DAY_MS } });

  const bandOf = (days: number): string | undefined =>
    statisticsOf([aged(days)]).passwordAge.buckets.find((bucket) => bucket.count === 1)?.id;

  it('puts a password changed today in the freshest band', () => {
    expect(bandOf(0)).toBe('under-30');
  });

  it('holds the boundary at 29 and moves at 30', () => {
    expect(bandOf(29)).toBe('under-30');
    expect(bandOf(30)).toBe('30-90');
  });

  it('holds the boundary at 89 and moves at 90', () => {
    expect(bandOf(89)).toBe('30-90');
    expect(bandOf(90)).toBe('90-365');
  });

  it('holds the boundary at 364 and moves at 365', () => {
    expect(bandOf(364)).toBe('90-365');
    expect(bandOf(365)).toBe('over-365');
  });

  it('lands a future timestamp in the freshest band rather than in none', () => {
    // A clock that went backwards, or an importer that wrote a date in the future — both
    // happen. A record that falls into no band is a record that vanishes from the chart.
    expect(bandOf(-500)).toBe('under-30');
  });

  it('separates records with no password from records with an old one', () => {
    const stats = statisticsOf([aged(1000), record({ id: 'b', hasPassword: false })]);
    const ids = stats.passwordAge.buckets.filter((b) => b.count > 0).map((b) => b.id);
    expect(ids).toEqual(['over-365', 'no-password']);
  });

  it('omits the no-password row entirely when every record has one', () => {
    const ids = statisticsOf([aged(5)]).passwordAge.buckets.map((bucket) => bucket.id);
    expect(ids).not.toContain('no-password');
  });
});

describe('median password age', () => {
  const aged = (days: number, id: string): StatisticsRecord =>
    record({ id, meta: { ...record().meta, passwordUpdatedAt: NOW - days * DAY_MS } });

  it('is null when nothing has a password', () => {
    expect(medianPasswordAgeDays([record({ hasPassword: false })], NOW)).toBeNull();
  });

  it('takes the middle of an odd number of records', () => {
    expect(medianPasswordAgeDays([aged(1, 'a'), aged(50, 'b'), aged(900, 'c')], NOW)).toBe(50);
  });

  it('averages the two middles of an even number', () => {
    expect(
      medianPasswordAgeDays([aged(10, 'a'), aged(20, 'b'), aged(30, 'c'), aged(40, 'd')], NOW)
    ).toBe(25);
  });

  it('is not dragged by one record imported with a 1970 date', () => {
    // The reason it is a median. A mean here would report about eleven years.
    const records = [aged(1, 'a'), aged(2, 'b'), aged(3, 'c'), aged(20_000, 'd'), aged(4, 'e')];
    expect(medianPasswordAgeDays(records, NOW)).toBe(3);
  });

  it('ignores records with no password rather than counting them as age zero', () => {
    const records = [aged(100, 'a'), record({ id: 'b', hasPassword: false })];
    expect(medianPasswordAgeDays(records, NOW)).toBe(100);
  });
});

describe('tags', () => {
  it('folds case and whitespace, the way the vault does', () => {
    const stats = statisticsOf([
      record({ id: 'a', tags: ['Work'] }),
      record({ id: 'b', tags: ['work'] }),
      record({ id: 'c', tags: ['  WORK  '] }),
    ]);

    expect(stats.tags.buckets).toHaveLength(1);
    expect(stats.tags.buckets[0]?.count).toBe(3);
  });

  it('shows the first spelling it saw, not a lower-cased key', () => {
    const stats = statisticsOf([
      record({ id: 'a', tags: ['Work'] }),
      record({ id: 'b', tags: ['work'] }),
    ]);
    expect(stats.tags.buckets[0]?.label).toBe('Work');
  });

  it('counts a record once per tag even if it lists one twice', () => {
    const stats = statisticsOf([record({ id: 'a', tags: ['Work', 'work'] })]);
    expect(stats.tags.buckets[0]?.count).toBe(1);
  });

  it('folds everything past the top few into one row rather than dropping it', () => {
    const records = Array.from({ length: TOP_TAG_COUNT + 5 }, (_, index) =>
      record({ id: `cred-${index}`, tags: [`tag-${index}`] })
    );
    const stats = statisticsOf(records);

    expect(stats.tags.buckets).toHaveLength(TOP_TAG_COUNT + 1);
    const other = stats.tags.buckets.at(-1);
    expect(other?.id).toBe('other-tags');
    expect(other?.count).toBe(5);
  });

  it('ignores an empty tag rather than charting a blank row', () => {
    expect(statisticsOf([record({ tags: ['  '] })]).tags.buckets).toEqual([]);
  });
});

describe('folders', () => {
  it('separates filed from unfiled and counts the folders in use', () => {
    const stats = statisticsOf([
      record({ id: 'a', folderId: 'f1' }),
      record({ id: 'b', folderId: 'f1' }),
      record({ id: 'c', folderId: 'f2' }),
      record({ id: 'd', folderId: null }),
    ]);

    expect(stats.folders).toMatchObject({ filedCount: 3, unfiledCount: 1, usedFolderCount: 2 });
  });

  it('says nothing per folder when it has no names — an id is not a statistic', () => {
    expect(statisticsOf([record({ folderId: 'f1' })]).folders.named).toBeNull();
  });

  it('names folders when it is given names, and adds the unfiled row', () => {
    const stats = computeVaultStatistics({
      records: [record({ id: 'a', folderId: 'f1' }), record({ id: 'b', folderId: null })],
      trashedCount: 0,
      now: NOW,
      folderNames: new Map([['f1', 'Banking']]),
    });

    expect(stats.folders.named?.buckets.map((bucket) => bucket.label)).toEqual([
      'Banking',
      'Not in a folder',
    ]);
  });

  it('does not invent a name for a folder that is gone', () => {
    const stats = computeVaultStatistics({
      records: [record({ folderId: 'missing' })],
      trashedCount: 0,
      now: NOW,
      folderNames: new Map(),
    });

    expect(stats.folders.named?.buckets[0]?.label).toBe('Folder no longer in this vault');
  });
});

describe('growth', () => {
  const created = (at: number, id: string): StatisticsRecord =>
    record({ id, meta: { ...record().meta, createdAt: at } });

  it('covers a full year, ending with the current month', () => {
    const points = monthlyGrowth([], NOW);
    expect(points).toHaveLength(GROWTH_MONTHS);
    expect(new Date(points.at(-1)?.startedAt ?? 0).getMonth()).toBe(new Date(NOW).getMonth());
  });

  it('starts the running total where the vault already was', () => {
    // The load-bearing case: a vault imported with 400 records two years ago must not be
    // drawn as though it started this window empty.
    const old = Array.from({ length: 400 }, (_, index) =>
      created(Date.UTC(2023, 0, 1), `old-${index}`)
    );
    const points = monthlyGrowth(old, NOW);

    expect(points[0]?.added).toBe(0);
    expect(points[0]?.total).toBe(400);
    expect(points.at(-1)?.total).toBe(400);
  });

  it('attributes a record to the month it was created in', () => {
    const points = monthlyGrowth([created(Date.UTC(2026, 4, 20), 'a')], NOW);
    const may = points.find((point) => new Date(point.startedAt).getMonth() === 4);
    expect(may?.added).toBe(1);
  });

  it('accumulates rather than resetting each month', () => {
    const points = monthlyGrowth(
      [created(Date.UTC(2026, 3, 2), 'a'), created(Date.UTC(2026, 4, 2), 'b')],
      NOW
    );
    expect(points.at(-1)?.total).toBe(2);
  });

  it('labels the first point and every January with a year', () => {
    const points = monthlyGrowth([], NOW);
    expect(points[0]?.label).toMatch(/\d{4}/);
    const january = points.find((point) => new Date(point.startedAt).getMonth() === 0);
    expect(january?.label).toMatch(/\d{4}/);
  });

  it('returns nothing for a window of no months rather than looping forever', () => {
    expect(monthlyGrowth([], NOW, 0)).toEqual([]);
  });
});

describe('counting the rest', () => {
  it('adds up attachments and their bytes', () => {
    const stats = statisticsOf([
      record({ id: 'a', attachments: [{ size: 1024 }, { size: 2048 }] }),
      record({ id: 'b', attachments: [{ size: 512 }] }),
    ]);

    expect(stats.attachmentCount).toBe(3);
    expect(stats.attachmentBytes).toBe(3584);
  });

  it('counts records carrying history and the versions they hold', () => {
    const stats = statisticsOf([
      record({ id: 'a', historyCount: 4 }),
      record({ id: 'b', historyCount: 0 }),
      record({ id: 'c', historyCount: 2 }),
    ]);

    expect(stats.withHistoryCount).toBe(2);
    expect(stats.historyVersionCount).toBe(6);
  });

  it('separates used from never used', () => {
    const stats = statisticsOf([
      record({ id: 'a', meta: { ...record().meta, lastUsedAt: NOW, useCount: 3 } }),
      record({ id: 'b' }),
    ]);

    expect(stats.usedCount).toBe(1);
    expect(stats.neverUsedCount).toBe(1);
  });

  it('counts favourites', () => {
    expect(
      statisticsOf([record({ id: 'a', favorite: true }), record({ id: 'b' })]).favouriteCount
    ).toBe(1);
  });
});

describe('formatBytes', () => {
  it('reports nothing as nothing', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(-5)).toBe('0 bytes');
  });

  it('stays in whole bytes below a kibibyte', () => {
    expect(formatBytes(512)).toBe('512 bytes');
  });

  it('uses binary units, like the rest of the app', () => {
    expect(formatBytes(1024)).toBe('1 KiB');
    expect(formatBytes(1_572_864)).toBe('1.5 MiB');
  });

  it('stops at the largest unit it knows rather than inventing one', () => {
    expect(formatBytes(1024 ** 4)).toBe('1024 GiB');
  });
});

describe('no statistic can contain a secret', () => {
  const MARKER = 'correct-horse-battery-staple-MARKER';

  it('ignores every secret-shaped field a projection-like object carries', () => {
    // A record shaped like the real `CredentialProjection` — which genuinely does carry a
    // title, a username, and secret *lengths* — plus, planted, the things it must never
    // carry. If any of it reaches a statistic, the marker shows up in the serialised result.
    const hostile = {
      ...record({ id: 'cred-1', tags: ['Work'], attachments: [{ size: 10 }] }),
      title: MARKER,
      username: MARKER,
      email: MARKER,
      urls: [MARKER],
      password: MARKER,
      notes: MARKER,
      passwordLength: 32,
      notesLength: 400,
      custom: [{ id: 'f1', label: MARKER, value: MARKER }],
      securityQuestions: [{ id: 'q1', question: MARKER, answer: MARKER }],
    } as unknown as StatisticsRecord;

    const stats = computeVaultStatistics({ records: [hostile], trashedCount: 0, now: NOW });

    expect(JSON.stringify(stats)).not.toContain(MARKER);
  });

  it('does not distribute password lengths, even though the projection has them', () => {
    // The deliberate omission. A per-vault histogram of password lengths narrows an offline
    // search in a way a single masked field on screen does not, so the input type does not
    // carry the field and no bucket exists to hold it.
    const stats = statisticsOf([record()]);
    expect(JSON.stringify(stats).toLowerCase()).not.toContain('passwordlength');
  });

  it('names no record, only counts and dates', () => {
    const stats = statisticsOf([record({ id: MARKER })]);
    // Even the id — the one identifier this module is handed — never reaches the output.
    // The view links to records through the credential list, not through a statistic.
    expect(JSON.stringify(stats)).not.toContain(MARKER);
  });
});
