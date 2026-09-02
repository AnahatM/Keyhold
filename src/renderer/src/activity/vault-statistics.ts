// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Vault statistics, derived entirely from the safe projection.
 *
 * ## The input type is the security argument
 *
 * `StatisticsRecord` is deliberately much narrower than `CredentialProjection` — a
 * projection satisfies it, but this module can only see what is listed. Absent, on purpose:
 * `title`, `username`, `email`, `urls`, `custom`, `securityQuestions`, and — the one worth
 * arguing about — `passwordLength` and `notesLength`.
 *
 * Those two are on the projection legitimately, so a masked field renders at the right
 * width. A *distribution* of them is a different object: "eleven records have an 8-character
 * password" is a statement about the vault's weakest passwords that narrows an offline
 * attacker's search, and it would sit on a dashboard permanently rather than for the moment
 * a field is on screen. The health dashboard already says which records are weak, with
 * advice attached, which is the useful half without the aggregate. So the statistics view
 * cannot see a length, because the type does not let it.
 *
 * Everything here is pure and takes `now` as an argument. Nothing calls `Date.now()`, so
 * nothing here can be called during render and produce two different answers in one commit.
 *
 * ## Honesty about small numbers
 *
 * A "distribution" over four records is four records. Every `Distribution` carries
 * `meaningful`, and the view draws bars only when it is true — see
 * `MEANINGFUL_DISTRIBUTION_MIN`.
 */

// ── Input ────────────────────────────────────────────────────────────────────

/** Only the size matters — never a name, never a MIME type, never bytes. */
export interface StatisticsAttachment {
  readonly size: number;
}

export interface StatisticsMeta {
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly passwordUpdatedAt: number;
  readonly lastUsedAt: number | null;
  readonly useCount: number;
}

/**
 * What a statistic may look at. A `CredentialProjection` satisfies this structurally.
 *
 * Stating the fields rather than taking the whole projection keeps the review question —
 * "can the statistics view see anything about a secret?" — answered by reading one
 * interface, exactly as `HealthRecordRef` does for the health dashboard.
 */
export interface StatisticsRecord {
  readonly id: string;
  readonly favorite: boolean;
  readonly folderId: string | null;
  readonly tags: readonly string[];
  readonly hasPassword: boolean;
  readonly attachments: readonly StatisticsAttachment[];
  readonly historyCount: number;
  readonly meta: StatisticsMeta;
}

export interface StatisticsInput {
  /** Records outside the Trash. */
  readonly records: readonly StatisticsRecord[];
  /** From `VaultSummary`. Trashed records are counted, never inspected. */
  readonly trashedCount: number;
  readonly now: number;
  /**
   * Folder ids to names, when they are available.
   *
   * Optional because the safe projection carries `folderId` but no folder list — there is no
   * IPC channel for one yet, and this view is not the place to add its first caller. Without
   * it the folder statistics report shape (how many filed, across how many folders) and stay
   * silent about names, which is honest rather than printing raw ids at a user.
   */
  readonly folderNames?: ReadonlyMap<string, string>;
  /** The vault attachment budget, so the total can be shown against something. */
  readonly attachmentBudgetBytes?: number;
}

// ── Distributions ────────────────────────────────────────────────────────────

/**
 * The point below which a distribution is reported as counts and not drawn as a chart.
 *
 * Twelve, because the password-age chart has five bands: at twelve records one record moves
 * a band by more than eight percentage points, so the picture is dominated by individual
 * records rather than by any tendency. Drawing a confident shape over that is the most
 * common way a statistics page misleads the person who asked for it.
 *
 * The copy on screen is derived from this constant rather than restating it, so raising the
 * threshold moves the sentence too.
 */
export const MEANINGFUL_DISTRIBUTION_MIN = 12;

export interface Bucket {
  readonly id: string;
  readonly label: string;
  readonly count: number;
  /** `count / total`, 0 when `total` is 0. Not a percentage — the view formats it. */
  readonly share: number;
}

export interface Distribution {
  readonly buckets: readonly Bucket[];
  /** The denominator `share` is taken against. */
  readonly total: number;
  /** The largest bucket, so bars can be scaled to the tallest rather than to the total. */
  readonly largest: number;
  /** False below `MEANINGFUL_DISTRIBUTION_MIN`. The view must not draw bars when false. */
  readonly meaningful: boolean;
}

/**
 * A bucket before its share is known — `Bucket` minus the one field this file computes.
 *
 * Derived from `Bucket` rather than restated so the two cannot drift, and named so the
 * builders below can annotate their local arrays with it. That annotation is load-bearing:
 * an array inferred from a `map` over an `as const` table gets the table's *literal* id and
 * label types, and a later `push` of a row the table does not contain — "no password saved",
 * which is not an age band — is then a type error rather than the intended fifth row.
 */
type CountedBucket = Omit<Bucket, 'share'>;

function buildDistribution(counted: readonly CountedBucket[], total: number): Distribution {
  const buckets = counted.map((bucket) => ({
    ...bucket,
    share: total === 0 ? 0 : bucket.count / total,
  }));

  return {
    buckets,
    total,
    largest: buckets.reduce((max, bucket) => Math.max(max, bucket.count), 0),
    meaningful: total >= MEANINGFUL_DISTRIBUTION_MIN,
  };
}

// ── Password age ─────────────────────────────────────────────────────────────

export const DAY_MS = 86_400_000;

/**
 * Age bands, freshest first.
 *
 * The boundaries match the ones the rest of the app already reasons in: 30 and 90 days are
 * the common rotation intervals, and a year is `passwordAgeWarningDays`' default in
 * `DEFAULT_VAULT_SETTINGS`. Picking different numbers here would give a user a chart that
 * disagrees with the health dashboard about what "old" means.
 */
const AGE_BANDS = [
  { id: 'under-30', label: 'Under 30 days', upToDays: 30 },
  { id: '30-90', label: '30 to 90 days', upToDays: 90 },
  { id: '90-365', label: '90 days to a year', upToDays: 365 },
  { id: 'over-365', label: 'Over a year', upToDays: Number.POSITIVE_INFINITY },
] as const;

/** Whole days between two instants, floored, never negative. */
export function ageInDays(from: number, now: number): number {
  return Math.max(0, Math.floor((now - from) / DAY_MS));
}

function passwordAgeDistribution(records: readonly StatisticsRecord[], now: number): Distribution {
  const counts = new Map<string, number>();
  for (const band of AGE_BANDS) counts.set(band.id, 0);
  let withoutPassword = 0;

  for (const record of records) {
    if (!record.hasPassword) {
      withoutPassword += 1;
      continue;
    }
    // A clock that went backwards, or an import that carried a future timestamp, must not
    // land a record in no band at all. `ageInDays` floors at zero, so it lands in the first.
    const days = ageInDays(record.meta.passwordUpdatedAt, now);
    const band = AGE_BANDS.find((candidate) => days < candidate.upToDays) ?? AGE_BANDS[3];
    counts.set(band.id, (counts.get(band.id) ?? 0) + 1);
  }

  const buckets: CountedBucket[] = AGE_BANDS.map((band) => ({
    id: band.id,
    label: band.label,
    count: counts.get(band.id) ?? 0,
  }));

  // Last, and only when it is not empty: "no password" is not an age, and a permanent empty
  // row on every healthy vault trains people to skim the chart.
  if (withoutPassword > 0) {
    buckets.push({ id: 'no-password', label: 'No password saved', count: withoutPassword });
  }

  return buildDistribution(buckets, records.length);
}

/**
 * The middle password age in days, over records that have a password.
 *
 * A median rather than a mean, because one record imported with a 1970 timestamp — which
 * happens, every importer has a format that does it — drags a mean by years and a median not
 * at all.
 */
export function medianPasswordAgeDays(
  records: readonly StatisticsRecord[],
  now: number
): number | null {
  const ages = records
    .filter((record) => record.hasPassword)
    .map((record) => ageInDays(record.meta.passwordUpdatedAt, now))
    .sort((a, b) => a - b);

  if (ages.length === 0) return null;

  const middle = Math.floor(ages.length / 2);
  if (ages.length % 2 === 1) return ages[middle] ?? null;
  const lower = ages[middle - 1] ?? 0;
  const upper = ages[middle] ?? 0;
  return Math.round((lower + upper) / 2);
}

// ── Tags ─────────────────────────────────────────────────────────────────────

/** How many tags get their own bar before the rest are folded into one row. */
export const TOP_TAG_COUNT = 8;

/**
 * The comparison key for a tag name.
 *
 * `Credential.tags` holds tag **names**, folded case-insensitively — the rule is defined by
 * `tagKey` in `src/main/organisation/tag-ops.ts`, which the renderer may not import (main
 * code, banned by lint, and rightly). This is that rule restated; the honest fix is for
 * `tagKey` to move to `@shared`, which is noted in the report accompanying this change.
 * Folding matters: `Work` and `work` typed a week apart are one tag to everybody except a
 * string comparison, and splitting them would make the chart wrong rather than merely ugly.
 */
function tagKey(name: string): string {
  return name.trim().toLowerCase();
}

function tagDistribution(records: readonly StatisticsRecord[]): Distribution {
  const counts = new Map<string, { label: string; count: number }>();

  for (const record of records) {
    // A record's own tag list is already case-insensitively unique upstream; folding again
    // here is what makes this key match that one.
    const seen = new Set<string>();
    for (const name of record.tags) {
      const key = tagKey(name);
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      const existing = counts.get(key);
      // First spelling seen wins the label, so the chart shows the user's own capitalisation
      // rather than a lower-cased key.
      counts.set(key, { label: existing?.label ?? name.trim(), count: (existing?.count ?? 0) + 1 });
    }
  }

  const ordered = [...counts.entries()]
    .map(([id, value]) => ({ id, label: value.label, count: value.count }))
    // Count descending, then label, so equal counts do not reshuffle between renders.
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const top = ordered.slice(0, TOP_TAG_COUNT);
  const rest = ordered.slice(TOP_TAG_COUNT);
  if (rest.length > 0) {
    top.push({
      id: 'other-tags',
      label: `${rest.length} other tag${rest.length === 1 ? '' : 's'}`,
      count: rest.reduce((total, tag) => total + tag.count, 0),
    });
  }

  return buildDistribution(top, records.length);
}

// ── Folders ──────────────────────────────────────────────────────────────────

export interface FolderStatistics {
  readonly filedCount: number;
  readonly unfiledCount: number;
  /** Distinct folders actually in use. Not the vault's folder count — empty ones do not show. */
  readonly usedFolderCount: number;
  /**
   * Per-folder counts, present only when names were supplied.
   *
   * Empty rather than keyed by raw id when they were not: `f3a1-…: 7` is not a statistic, it
   * is a database row shown to someone who cannot read it.
   */
  readonly named: Distribution | null;
}

function folderStatistics(
  records: readonly StatisticsRecord[],
  names: ReadonlyMap<string, string> | undefined
): FolderStatistics {
  const counts = new Map<string, number>();
  let unfiled = 0;

  for (const record of records) {
    if (record.folderId === null) {
      unfiled += 1;
      continue;
    }
    counts.set(record.folderId, (counts.get(record.folderId) ?? 0) + 1);
  }

  const base = {
    filedCount: records.length - unfiled,
    unfiledCount: unfiled,
    usedFolderCount: counts.size,
  };

  if (names === undefined) return { ...base, named: null };

  const buckets = [...counts.entries()]
    .map(([id, count]) => ({ id, label: names.get(id) ?? 'Folder no longer in this vault', count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  if (unfiled > 0) buckets.push({ id: 'unfiled', label: 'Not in a folder', count: unfiled });

  return { ...base, named: buildDistribution(buckets, records.length) };
}

// ── Growth ───────────────────────────────────────────────────────────────────

/** How many months the growth chart covers. A year reads as a year on any axis. */
export const GROWTH_MONTHS = 12;

export interface GrowthPoint {
  /** Local midnight on the first of the month. */
  readonly startedAt: number;
  readonly label: string;
  readonly added: number;
  /** Every record created up to and including this month, whenever the window starts. */
  readonly total: number;
}

/**
 * Records added per month, and the running total.
 *
 * The running total counts records created *before* the window too, so the line starts where
 * the vault actually was rather than at zero. A growth chart that implies the vault was empty
 * a year ago, when it was imported with four hundred records, is a chart that lies about the
 * only thing it was drawn to show.
 */
export function monthlyGrowth(
  records: readonly StatisticsRecord[],
  now: number,
  months: number = GROWTH_MONTHS
): readonly GrowthPoint[] {
  if (months < 1) return [];

  const end = new Date(now);
  const starts: number[] = [];
  for (let back = months - 1; back >= 0; back -= 1) {
    starts.push(new Date(end.getFullYear(), end.getMonth() - back, 1).getTime());
  }

  const windowStart = starts[0] ?? now;
  const added = new Array<number>(months).fill(0);
  let carried = 0;

  for (const record of records) {
    const at = record.meta.createdAt;
    if (at < windowStart) {
      carried += 1;
      continue;
    }
    // The last month whose start is at or before this record. Walking backwards costs at
    // most `months` steps and avoids the date arithmetic that daylight saving breaks.
    for (let index = months - 1; index >= 0; index -= 1) {
      if (at >= (starts[index] ?? 0)) {
        added[index] = (added[index] ?? 0) + 1;
        break;
      }
    }
  }

  const points: GrowthPoint[] = [];
  let running = carried;
  for (let index = 0; index < months; index += 1) {
    const startedAt = starts[index] ?? now;
    running += added[index] ?? 0;
    points.push({
      startedAt,
      label: monthLabel(startedAt, index === 0),
      added: added[index] ?? 0,
      total: running,
    });
  }
  return points;
}

/**
 * "Mar", or "Mar 2025" on January and on the first point.
 *
 * The year on every label would triple the width of the axis; the year on none of them makes
 * a twelve-month window ambiguous at exactly the point it wraps.
 */
function monthLabel(at: number, force: boolean): string {
  const date = new Date(at);
  const withYear = force || date.getMonth() === 0;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

// ── Bytes ────────────────────────────────────────────────────────────────────

const BYTE_UNITS = ['bytes', 'KiB', 'MiB', 'GiB'] as const;

/**
 * "4.2 MiB".
 *
 * Binary units, because every other size in this codebase is binary — the attachment
 * ceilings, the KDF memory cost, the container's chunk limit — and a page mixing MB and MiB
 * makes a user think one of the two numbers is wrong.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 bytes';

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  // Whole bytes; one decimal above that, which is the precision a size is actually known to.
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${BYTE_UNITS[unit] ?? 'bytes'}`;
}

// ── The whole thing ──────────────────────────────────────────────────────────

export interface VaultStatistics {
  readonly recordCount: number;
  readonly trashedCount: number;
  readonly favouriteCount: number;
  readonly withPasswordCount: number;
  readonly withHistoryCount: number;
  readonly historyVersionCount: number;
  readonly attachmentCount: number;
  readonly attachmentBytes: number;
  readonly attachmentBudgetBytes: number;
  readonly usedCount: number;
  readonly neverUsedCount: number;
  /** `null` for an empty vault — there is no oldest record, rather than an oldest of zero. */
  readonly oldestCreatedAt: number | null;
  readonly newestCreatedAt: number | null;
  readonly medianPasswordAgeDays: number | null;
  readonly passwordAge: Distribution;
  readonly tags: Distribution;
  readonly folders: FolderStatistics;
  readonly growth: readonly GrowthPoint[];
  /** True when there is nothing to describe. The view says so instead of drawing zeros. */
  readonly empty: boolean;
}

export function computeVaultStatistics(input: StatisticsInput): VaultStatistics {
  const { records, now } = input;

  let favourites = 0;
  let withPassword = 0;
  let withHistory = 0;
  let historyVersions = 0;
  let attachments = 0;
  let attachmentBytes = 0;
  let used = 0;
  let oldest: number | null = null;
  let newest: number | null = null;

  for (const record of records) {
    if (record.favorite) favourites += 1;
    if (record.hasPassword) withPassword += 1;
    if (record.historyCount > 0) withHistory += 1;
    historyVersions += record.historyCount;
    attachments += record.attachments.length;
    for (const attachment of record.attachments) attachmentBytes += attachment.size;
    if (record.meta.lastUsedAt !== null) used += 1;

    const createdAt = record.meta.createdAt;
    oldest = oldest === null ? createdAt : Math.min(oldest, createdAt);
    newest = newest === null ? createdAt : Math.max(newest, createdAt);
  }

  return {
    recordCount: records.length,
    trashedCount: input.trashedCount,
    favouriteCount: favourites,
    withPasswordCount: withPassword,
    withHistoryCount: withHistory,
    historyVersionCount: historyVersions,
    attachmentCount: attachments,
    attachmentBytes,
    attachmentBudgetBytes: input.attachmentBudgetBytes ?? 0,
    usedCount: used,
    neverUsedCount: records.length - used,
    oldestCreatedAt: oldest,
    newestCreatedAt: newest,
    medianPasswordAgeDays: medianPasswordAgeDays(records, now),
    passwordAge: passwordAgeDistribution(records, now),
    tags: tagDistribution(records),
    folders: folderStatistics(records, input.folderNames),
    growth: monthlyGrowth(records, now),
    empty: records.length === 0,
  };
}
