// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VERSIONED_FIELDS, type ChangeOrigin } from '@shared/model/credential.js';
import {
  changeSummary,
  fieldLabel,
  originDetail,
  originSummary,
  relativeTime,
} from './origin-labels.js';

/**
 * The strings the audit trail is judged on.
 *
 * Pure, so they are tested directly rather than through a rendered component. The one that
 * genuinely matters is `originSummary`: it is the difference between a timeline that
 * respects a privacy setting and one that announces "unknown device" on every row of a
 * vault whose owner deliberately turned provenance off.
 */

const NOW = Date.parse('2026-03-02T12:00:00Z');

describe('fieldLabel', () => {
  it('has a human label for every versioned field', () => {
    // The `Record<VersionedField, string>` makes this a compile error too — but a compile
    // error is invisible in a review diff, and this names the field that is missing.
    for (const field of VERSIONED_FIELDS) {
      const label = fieldLabel(field);
      expect(label, `no label for "${field}"`).not.toBe('');
      expect(label, `"${field}" shows its identifier to the user`).not.toBe(field);
    }
  });
});

describe('changeSummary', () => {
  it('reads as a sentence for one, two and many', () => {
    expect(changeSummary(['password'])).toBe('Password changed');
    expect(changeSummary(['password', 'title'])).toBe('Password and Name changed');
    expect(changeSummary(['password', 'title', 'email', 'tags'])).toBe(
      'Password, Name and 2 more changed'
    );
  });

  it('says so rather than producing an empty sentence', () => {
    expect(changeSummary([])).toBe('No changes recorded');
  });
});

describe('originSummary', () => {
  it('reads as a sentence fragment', () => {
    const origin: ChangeOrigin = {
      action: 'update',
      deviceName: 'ANAHAT-DESKTOP',
      osUser: 'anahat',
      networkName: 'Home Network',
    };
    expect(originSummary(origin)).toBe('from ANAHAT-DESKTOP as anahat on Home Network');
  });

  it('says nothing at all when the privacy level recorded nothing', () => {
    // The load-bearing case. "Unknown device" on every row reads as a fault in the app
    // rather than as the setting the user chose, and would push people towards turning
    // provenance back on to make the message go away.
    expect(originSummary({ action: 'update' })).toBe('');
  });

  it('degrades cleanly when only part was recorded', () => {
    expect(originSummary({ action: 'update', deviceName: 'LAPTOP' })).toBe('from LAPTOP');
  });
});

describe('originDetail', () => {
  it('joins the platform with its release when both were captured', () => {
    expect(
      originDetail({
        action: 'update',
        platform: 'Windows',
        osRelease: '10.0.26200',
        appVersion: '0.1.0',
      })
    ).toBe('Windows 10.0.26200 · Keyhold 0.1.0');
  });

  it('omits the release rather than printing a trailing space', () => {
    expect(originDetail({ action: 'update', platform: 'Windows' })).toBe('Windows');
  });

  it('is empty at the lowest privacy level', () => {
    expect(originDetail({ action: 'create' })).toBe('');
  });
});

describe('relativeTime', () => {
  it('collapses anything under a minute', () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe('just now');
  });

  it('uses relative wording inside a week', () => {
    // Not asserting the exact string: `Intl.RelativeTimeFormat` is locale-dependent, and
    // pinning "2 hours ago" would make this test fail on a machine set to another language
    // while the code was perfectly correct.
    const twoHours = relativeTime(NOW - 7_200_000, NOW);
    expect(twoHours).not.toBe('just now');
    expect(twoHours).not.toContain('2026');
  });

  it('switches to an absolute date past a week', () => {
    // "43 weeks ago" is a worse answer than a date for the question a timeline is asked.
    expect(relativeTime(Date.parse('2025-03-02T12:00:00Z'), NOW)).toContain('2025');
  });

  it('handles a future timestamp without producing nonsense', () => {
    // Clock skew between two devices sharing a vault is a real source of these.
    expect(relativeTime(NOW + 7_200_000, NOW)).not.toBe('');
  });
});
