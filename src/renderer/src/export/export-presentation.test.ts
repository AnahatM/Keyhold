// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { EXPORT_LOSS_KINDS, exportLoss } from '@shared/model/export.js';
import type { ExportPreview, ExportScope } from '@shared/model/export-plan.js';
import {
  affectedFields,
  formatBytes,
  groupLossesByKind,
  LOSS_KIND_LABELS,
  LOSS_KIND_MEANINGS,
  LOSS_KIND_ORDER,
  LOSS_KIND_SYMBOLS,
  LOSS_KIND_TONES,
  recordSentence,
  safetyBadge,
  summariseLosses,
  trashSentence,
  unknownSentence,
} from './export-presentation.js';
import { SAMPLE_FORMATS } from './fake-export-gateway.js';

/**
 * The presentation guards.
 *
 * The important one is the coverage test: a new `ExportLossKind` must not be able to render
 * as a blank chip. The exhaustive `Record`s are already compile errors when a kind is
 * missing, but `LOSS_KIND_ORDER` is an *array*, and TypeScript cannot tell an array that
 * covers a union from one that quietly dropped a member — so a kind added to the engine and
 * forgotten here would simply never appear in the grouped list. That is the silent failure
 * this file exists to make loud.
 */

function previewWith(overrides: Partial<ExportPreview> = {}): ExportPreview {
  return {
    format: 'keyhold-csv',
    recordCount: 12,
    trashedInScope: 0,
    unknownIds: 0,
    containsSecrets: true,
    losses: [],
    ...overrides,
  };
}

// ── Coverage ─────────────────────────────────────────────────────────────────

describe('every loss kind has a presentation', () => {
  it.each(EXPORT_LOSS_KINDS)('%s has a label, a meaning, a symbol and a tone', (kind) => {
    expect(LOSS_KIND_LABELS[kind].length).toBeGreaterThan(0);
    expect(LOSS_KIND_MEANINGS[kind].length).toBeGreaterThan(0);
    expect(LOSS_KIND_SYMBOLS[kind].length).toBeGreaterThan(0);
    expect(LOSS_KIND_TONES[kind].length).toBeGreaterThan(0);
  });

  it('orders every kind exactly once, so none can be dropped from the grouped list', () => {
    expect([...LOSS_KIND_ORDER].sort()).toEqual([...EXPORT_LOSS_KINDS].sort());
    expect(new Set(LOSS_KIND_ORDER).size).toBe(LOSS_KIND_ORDER.length);
  });

  it('renders a group for every kind, so a new one cannot come out blank', () => {
    const losses = EXPORT_LOSS_KINDS.map((kind) =>
      exportLoss(kind, `${kind} field`, `${kind} happened to 1 record.`, 1)
    );
    const groups = groupLossesByKind(losses);

    expect(groups).toHaveLength(EXPORT_LOSS_KINDS.length);
    for (const group of groups) {
      expect(group.label).not.toBe('');
      expect(group.symbol).not.toBe('');
      expect(group.meaning).not.toBe('');
      expect(group.losses.length).toBeGreaterThan(0);
    }
  });

  it('gives each kind a distinct symbol, so the shapes are readable in greyscale', () => {
    const symbols = EXPORT_LOSS_KINDS.map((kind) => LOSS_KIND_SYMBOLS[kind]);
    expect(new Set(symbols).size).toBe(symbols.length);
  });
});

// ── Grouping ─────────────────────────────────────────────────────────────────

describe('grouping', () => {
  it('puts the worst kind first and the user’s own choice last', () => {
    const losses = [
      exportLoss('excluded', 'trashed records', '3 records were left out.', 3),
      exportLoss('flattened', 'custom fields', 'Packed into one cell.', 4),
      exportLoss('dropped', 'history', 'Past versions were not carried.', 9),
      exportLoss('altered', 'password', 'Two cells were rewritten.', 2),
    ];

    expect(groupLossesByKind(losses).map((group) => group.kind)).toEqual([
      'dropped',
      'altered',
      'flattened',
      'excluded',
    ]);
  });

  it('emits nothing for a kind that did not occur', () => {
    const groups = groupLossesByKind([exportLoss('dropped', 'history', 'Gone.', 1)]);
    expect(groups.map((group) => group.kind)).toEqual(['dropped']);
  });

  it('totals the records within a group rather than counting entries', () => {
    const groups = groupLossesByKind([
      exportLoss('dropped', 'history', 'Gone for 9.', 9),
      exportLoss('dropped', 'attachments', 'Gone for 4.', 4),
    ]);
    expect(groups[0]?.records).toBe(13);
    expect(groups[0]?.losses).toHaveLength(2);
  });

  it('keeps the engine’s own order inside a group', () => {
    const groups = groupLossesByKind([
      exportLoss('dropped', 'history', 'a', 1),
      exportLoss('dropped', 'attachments', 'b', 1),
      exportLoss('dropped', 'icons', 'c', 1),
    ]);
    expect(groups[0]?.losses.map((loss) => loss.field)).toEqual([
      'history',
      'attachments',
      'icons',
    ]);
  });

  it('returns nothing at all for a lossless export', () => {
    expect(groupLossesByKind([])).toEqual([]);
  });
});

// ── Summaries ────────────────────────────────────────────────────────────────

describe('summarising losses', () => {
  it('says so plainly when nothing is lost', () => {
    expect(summariseLosses([])).toBe('Nothing is left out. This format carries everything.');
  });

  it('names one field, two fields and three fields correctly', () => {
    expect(summariseLosses([exportLoss('dropped', 'history', 'x', 1)])).toBe(
      'Does not carry history intact.'
    );
    expect(
      summariseLosses([
        exportLoss('dropped', 'history', 'x', 1),
        exportLoss('dropped', 'attachments', 'x', 1),
      ])
    ).toBe('Does not carry history and attachments intact.');
    expect(
      summariseLosses([
        exportLoss('dropped', 'history', 'x', 1),
        exportLoss('dropped', 'attachments', 'x', 1),
        exportLoss('dropped', 'icons', 'x', 1),
      ])
    ).toBe('Does not carry history, attachments and icons intact.');
  });

  it('counts the rest once there are more than three, in the singular and the plural', () => {
    const four = ['history', 'attachments', 'icons', 'dates'].map((field) =>
      exportLoss('dropped', field, 'x', 1)
    );
    expect(summariseLosses(four)).toBe(
      'Does not carry history, attachments and icons, and 1 other thing, intact.'
    );

    const five = [...four, exportLoss('dropped', 'record identity', 'x', 1)];
    expect(summariseLosses(five)).toBe(
      'Does not carry history, attachments and icons, and 2 other things, intact.'
    );
  });

  it('names the heaviest kinds first when space runs out', () => {
    // `excluded` is the user's own choice and must not push `dropped` out of the sentence.
    const losses = [
      exportLoss('excluded', 'trashed records', 'x', 3),
      exportLoss('dropped', 'history', 'x', 1),
      exportLoss('altered', 'password', 'x', 1),
      exportLoss('flattened', 'custom fields', 'x', 1),
    ];
    expect(affectedFields(losses)).toEqual([
      'history',
      'password',
      'custom fields',
      'trashed records',
    ]);
    expect(summariseLosses(losses)).toContain('history, password and custom fields');
  });

  it('counts a field once even when several losses name it', () => {
    expect(
      affectedFields([
        exportLoss('dropped', 'history', 'x', 1),
        exportLoss('flattened', 'history', 'x', 1),
      ])
    ).toEqual(['history']);
  });
});

// ── Formats ──────────────────────────────────────────────────────────────────

describe('the safety badge', () => {
  it('calls a plaintext format readable, in words, not just in colour', () => {
    for (const format of SAMPLE_FORMATS.filter((candidate) => !candidate.encrypted)) {
      const badge = safetyBadge(format);
      expect(badge.label).toBe('Readable by anyone');
      expect(badge.tone).toBe('danger');
      expect(badge.symbol).not.toBe('');
      expect(badge.meaning).toContain('plain text');
    }
  });

  it('calls the parcel encrypted, and says the recipient needs the passphrase', () => {
    const badge = safetyBadge(SAMPLE_FORMATS[0]!);
    expect(badge.label).toBe('Encrypted');
    expect(badge.tone).toBe('success');
    expect(badge.meaning).toContain('passphrase');
  });
});

// ── Counts ───────────────────────────────────────────────────────────────────

describe('the trash sentence', () => {
  const withTrash = (scope: ExportScope, trashedInScope: number): string =>
    trashSentence(scope, previewWith({ trashedInScope }));

  it('states the count when they are being left out', () => {
    expect(withTrash({ includeTrashed: false, recordIds: null }, 12)).toBe(
      '12 records in the Trash will be left out.'
    );
  });

  it('states the same count when they are being included', () => {
    // Both directions are surprises, and only one of them is usually warned about.
    expect(withTrash({ includeTrashed: true, recordIds: null }, 12)).toBe(
      '12 records in the Trash will be included in this file.'
    );
  });

  it('says something rather than nothing when the Trash is empty', () => {
    expect(withTrash({ includeTrashed: false, recordIds: null }, 0)).toBe(
      'Nothing you have chosen is in the Trash.'
    );
    expect(withTrash({ includeTrashed: true, recordIds: null }, 0)).toBe(
      'Nothing you have chosen is in the Trash.'
    );
  });

  it('gets the singular right', () => {
    expect(withTrash({ includeTrashed: false, recordIds: null }, 1)).toBe(
      '1 record in the Trash will be left out.'
    );
  });
});

describe('the record and stale-id sentences', () => {
  it('warns rather than reassures when the export would be empty', () => {
    expect(recordSentence(previewWith({ recordCount: 0 }))).toContain('would be empty');
  });

  it('counts what will actually be written', () => {
    expect(recordSentence(previewWith({ recordCount: 1 }))).toBe(
      '1 record will be written to this file.'
    );
  });

  it('stays silent about stale ids only when there are none', () => {
    expect(unknownSentence(previewWith({ unknownIds: 0 }))).toBeNull();
    expect(unknownSentence(previewWith({ unknownIds: 2 }))).toContain('no longer in this vault');
  });
});

describe('file sizes', () => {
  it('uses the decimal units the operating system’s file browser shows', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(1000)).toBe('1.0 kB');
    expect(formatBytes(1_500_000)).toBe('1.5 MB');
  });
});

// ── The compact summary must stay compact ────────────────────────────────────

describe('the one-line summary', () => {
  it('is built from field names only, never from engine messages', () => {
    // The summary sits inside a format card. Splicing the engine's full sentences into it
    // would make the card unreadable, and — since a message is the one string in a loss
    // that grows with the data — it is also the one most likely to arrive long.
    const planted = 'A-VERY-LONG-ENGINE-SENTENCE';
    const summary = summariseLosses([exportLoss('dropped', 'history', planted, 3)]);

    expect(summary).toContain('history');
    expect(summary).not.toContain(planted);
  });
});
