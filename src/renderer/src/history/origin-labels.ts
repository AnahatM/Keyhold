// SPDX-License-Identifier: GPL-3.0-or-later
import type { ChangeOrigin, HistoryAction, VersionedField } from '@shared/model/credential.js';

/**
 * Turning the audit trail into English.
 *
 * Pure, and separate from the components, because these are the strings the whole feature
 * is judged on. A timeline that says `passwordUpdatedAt` and `win32` is a database dump; one
 * that says "Password changed · 2 March, from ANAHAT-DESKTOP on Home Network" is the feature
 * people came for. Keeping the mapping out of JSX also means it can be tested directly and
 * reused by the export.
 */

const ACTION_LABELS: Readonly<Record<HistoryAction, string>> = {
  create: 'Created',
  update: 'Edited',
  restore: 'Restored',
  import: 'Imported',
  merge: 'Merged',
};

/**
 * Field names as a person would say them.
 *
 * Deliberately exhaustive over `VersionedField` rather than a lookup with a fallback: a new
 * versioned field with no label here would show its identifier to a user, and a `Record`
 * makes that a compile error instead.
 */
const FIELD_LABELS: Readonly<Record<VersionedField, string>> = {
  title: 'Name',
  username: 'Username',
  email: 'Email',
  password: 'Password',
  urls: 'Web addresses',
  securityQuestions: 'Security questions',
  notes: 'Notes',
  custom: 'Custom fields',
  tags: 'Tags',
  folderId: 'Folder',
  favorite: 'Favourite',
  icon: 'Icon',
  expiresAt: 'Expiry date',
  rotationIntervalDays: 'Rotation reminder',
};

export function actionLabel(action: HistoryAction): string {
  return ACTION_LABELS[action];
}

export function fieldLabel(field: VersionedField): string {
  return FIELD_LABELS[field];
}

/** "Password and Name", "Password, Name and 2 more". */
export function changeSummary(fields: readonly VersionedField[]): string {
  const labels = fields.map(fieldLabel);
  if (labels.length === 0) return 'No changes recorded';
  if (labels.length === 1) return `${labels[0] ?? ''} changed`;
  if (labels.length === 2) return `${labels[0] ?? ''} and ${labels[1] ?? ''} changed`;
  // Past three, listing them all makes every row a paragraph. The diff shows the rest.
  return `${labels[0] ?? ''}, ${labels[1] ?? ''} and ${labels.length - 2} more changed`;
}

/**
 * "from ANAHAT-DESKTOP on Home Network", or nothing at all.
 *
 * Returns an empty string rather than "Unknown device" when the privacy level recorded
 * nothing. A user who deliberately turned provenance off should not then be told, on every
 * row, that their device is unknown — that reads as a fault rather than as their choice.
 */
export function originSummary(origin: ChangeOrigin): string {
  const parts: string[] = [];
  if (origin.deviceName !== undefined) parts.push(`from ${origin.deviceName}`);
  if (origin.osUser !== undefined) parts.push(`as ${origin.osUser}`);
  if (origin.networkName !== undefined) parts.push(`on ${origin.networkName}`);
  return parts.join(' ');
}

/** The secondary line: platform, app version, IP — the detail nobody needs at a glance. */
export function originDetail(origin: ChangeOrigin): string {
  const parts: string[] = [];
  if (origin.platform !== undefined) {
    parts.push(
      origin.osRelease === undefined ? origin.platform : `${origin.platform} ${origin.osRelease}`
    );
  }
  if (origin.appVersion !== undefined) parts.push(`Keyhold ${origin.appVersion}`);
  if (origin.localIp !== undefined) parts.push(origin.localIp);
  return parts.join(' · ');
}

/**
 * A relative time that stays honest.
 *
 * `Intl.RelativeTimeFormat` rather than a hand-rolled "2 days ago", so it is localised and
 * so "1 days ago" cannot happen. Anything older than a week gets an absolute date instead:
 * "43 weeks ago" is worse than "2 March 2025" for the question a timeline actually answers.
 */
export function relativeTime(timestamp: number, now: number): string {
  const seconds = Math.round((timestamp - now) / 1000);
  const absolute = Math.abs(seconds);

  if (absolute < 60) return 'just now';

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (absolute < 3_600) return formatter.format(Math.round(seconds / 60), 'minute');
  if (absolute < 86_400) return formatter.format(Math.round(seconds / 3_600), 'hour');
  if (absolute < 604_800) return formatter.format(Math.round(seconds / 86_400), 'day');

  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
