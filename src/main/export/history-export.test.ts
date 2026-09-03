// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { CredentialProjection, VersionProjection } from '@shared/model/credential.js';
import {
  historyExportFileName,
  serialiseCredentialHistory,
  HISTORY_EXPORT_VERSION,
} from './history-export.js';

/**
 * One credential's audit trail, written to a file.
 *
 * The assertion that matters is the one that would be catastrophic to get wrong, and it is
 * asserted the way the projection's own guard is: with a **planted secret**. A value that the
 * real safe projection could never carry is put into the input anyway, and the output is swept
 * for it. That catches the failure a shape-based test cannot — somebody later widening this to
 * take a `Credential` instead of a `CredentialProjection` "because it has more in it", which is
 * exactly how a history export starts writing plaintext passwords.
 *
 * Fault injection performed:
 *  1. Adding `password: 'hunter2'` to the serialised credential block — fails "no planted
 *     secret reaches the file".
 *  2. Sorting versions newest-first — fails "versions are oldest first, because a file is read
 *     top to bottom".
 *  3. Dropping the `contains` note — fails "says what it deliberately leaves out".
 *  4. Removing the filename fallback — fails "a title that sanitises away falls back to the id"
 *     with an empty name.
 */

const PLANTED = 'ZQX-planted-secret-value-7f3a';

const version = (versionNumber: number, savedAt: number): VersionProjection => ({
  versionNumber,
  savedAt,
  changedFields: ['password'],
  // The length, which is all the real projection carries.
  snapshot: { passwordLength: 18 },
  secretFields: ['password'],
  origin: { action: 'update', deviceName: 'the-laptop' },
});

const credential = (overrides: Partial<CredentialProjection> = {}): CredentialProjection =>
  ({
    id: 'rec-1',
    title: 'GitHub',
    historyEnabled: true,
    history: [version(1, 1_000), version(2, 2_000)],
    meta: {
      createdAt: 500,
      updatedAt: 2_500,
      createdOrigin: { action: 'create', deviceName: 'the-laptop' },
    },
    ...overrides,
  }) as unknown as CredentialProjection;

const options = { appVersion: '0.1.0', exportedAt: 1_700_000_000_000 };

describe('what reaches the file', () => {
  it('no planted secret reaches the file, in any field', () => {
    // Planted in every place a widened input could carry one. The real projection has none of
    // these; that is the point — the sweep has to fail if somebody changes what comes in.
    const contaminated = {
      ...credential(),
      password: PLANTED,
      notes: PLANTED,
      fields: { password: PLANTED },
      history: [
        {
          ...version(1, 1_000),
          snapshot: { passwordLength: 18, password: PLANTED },
        } as unknown as VersionProjection,
      ],
    } as unknown as CredentialProjection;

    const file = serialiseCredentialHistory(contaminated, options);
    expect(file).not.toContain(PLANTED);
    // And the sweep saw a populated file, or it proves nothing.
    expect(file).toContain('GitHub');
    expect(file).toContain('passwordLength');
  });

  it('keeps the lengths, which are the whole point of a length', () => {
    const file = JSON.parse(serialiseCredentialHistory(credential(), options)) as {
      versions: { snapshot: { passwordLength?: number } }[];
    };
    expect(file.versions[0]?.snapshot.passwordLength).toBe(18);
  });

  it('says what it deliberately leaves out', () => {
    // Someone reading this months later, looking for the old password, should find the answer
    // in the file rather than concluding it was lost.
    const file = serialiseCredentialHistory(credential(), options);
    expect(file).toContain('never included in this file');
    expect(file).toContain('D27');
  });

  it('carries the provenance, which is the reason the file exists', () => {
    const file = serialiseCredentialHistory(credential(), options);
    expect(file).toContain('the-laptop');
    expect(file).toContain('createdOrigin');
  });
});

describe('the shape', () => {
  it('versions are oldest first, because a file is read top to bottom', () => {
    const shuffled = credential({
      history: [version(3, 3_000), version(1, 1_000), version(2, 2_000)],
    });
    const parsed = JSON.parse(serialiseCredentialHistory(shuffled, options)) as {
      versions: { versionNumber: number }[];
    };
    expect(parsed.versions.map((entry) => entry.versionNumber)).toEqual([1, 2, 3]);
  });

  it('stamps a format, a version and when it was written', () => {
    const parsed = JSON.parse(serialiseCredentialHistory(credential(), options)) as {
      format: string;
      version: number;
      exportedAtIso: string;
    };
    expect(parsed.format).toBe('keyhold-credential-history');
    expect(parsed.version).toBe(HISTORY_EXPORT_VERSION);
    expect(parsed.exportedAtIso).toContain('T');
  });

  it('is valid JSON with a trailing newline, like every other file we write', () => {
    const file = serialiseCredentialHistory(credential(), options);
    expect(file.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(file) as unknown).not.toThrow();
  });
});

describe('the filename', () => {
  it('identifies the record without being unusable', () => {
    const name = historyExportFileName(credential(), options.exportedAt);
    expect(name).toContain('GitHub');
    expect(name).toMatch(/-history-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it('a title that sanitises away falls back to the id', () => {
    // A folder of `-history-2026-09-03.json` files is worse than one naming ids.
    const name = historyExportFileName(credential({ title: '???' }), options.exportedAt);
    expect(name.startsWith('rec-1-history-')).toBe(true);
  });

  it('refuses the characters a filesystem would', () => {
    const name = historyExportFileName(
      credential({ title: 'a/b\\c:d*e?f"g<h>i|j' }),
      options.exportedAt
    );
    expect(name).not.toMatch(/[/\\:*?"<>|]/);
  });
});
