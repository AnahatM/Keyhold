// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Credential } from '@shared/model/credential.js';
import { importFolderId } from '@shared/model/import.js';
import { bitwardenCsvParser } from '../import/bitwarden-csv.js';
import { parseCsvTable } from '../import/csv.js';
import { genericCsvParser } from '../import/generic-csv.js';
import { exportCsv, KEYHOLD_CSV_COLUMNS } from './csv.js';
import { COMPATIBLE_CSV_COLUMNS, exportCompatibleCsv } from './generic-csv.js';
import { bareRecord, buildDocument, NOW, richRecord } from './test-fixtures.js';

/**
 * The two flat formats' tests.
 *
 * Three things are being defended here, in descending order of how much damage a regression
 * would do:
 *
 *  1. **The compatible CSV must actually be importable.** Not "has the right header text" —
 *     importable. So it is asserted by running Keyhold's own Bitwarden parser over the
 *     output, which is the same code path another product's importer exercises. A format
 *     whose columns are right and whose packing is subtly wrong is worse than no format,
 *     because the user finds out after they have cancelled the old subscription.
 *  2. **Nothing is lost silently.** Every drop and every flatten is asserted to appear in the
 *     loss list by name and count.
 *  3. **No loss message ever carries a value.** The marker property test at the end is the
 *     most important one in this file: loss lists are shown on screen and pasted into bug
 *     reports, and one quoting the value it could not carry would put a password in both.
 *
 * Fault injections performed against this file, all reverted:
 *
 *  1. `reportFlatLosses` stopped counting history. 2 failed.
 *  2. `packLabelledValues` joined with `, ` instead of a newline. 1 failed — the packed cell
 *     no longer unpacks, so every extra field arrived as one run-on custom field.
 *  3. The `login_totp` hoist removed. 1 failed — the seed then reached neither the column nor
 *     the packed cell, since `extraEntries` still skipped it.
 *  4. `loginUsername` made to always return the username. 1 failed — the email-only record
 *     exported with an empty username column, which is an unusable import.
 *  5. A loss's `field` rewritten to quote the security answer it could not carry. 2 failed,
 *     one of them the marker property test at the end of this file.
 */

const DOCUMENT = buildDocument([richRecord(), bareRecord({ id: 'plain', title: 'Plain' })]);

// ── The Keyhold CSV ──────────────────────────────────────────────────────────

describe('the Keyhold CSV', () => {
  const text = (): string => Buffer.from(exportCsv(DOCUMENT).secretBytes).toString('utf8');

  it('writes the declared columns, and a full row for every record', () => {
    const { table } = parseCsvTable(text());
    expect(table.columns).toEqual([...KEYHOLD_CSV_COLUMNS]);
    expect(table.rows).toHaveLength(2);
    for (const row of table.rows) expect(row.cells).toHaveLength(KEYHOLD_CSV_COLUMNS.length);
  });

  it('puts each value in its own column', () => {
    const row = parseCsvTable(text()).table.rows[0]!;
    expect(row.values.get('title')).toBe('Example Mail');
    expect(row.values.get('username')).toBe('ada');
    expect(row.values.get('email')).toBe('ada@example.com');
    expect(row.values.get('password')).toBe('correct-horse-battery-staple');
    expect(row.values.get('folder')).toBe('Personal/Mail');
    expect(row.values.get('tags')).toBe('work, email');
    expect(row.values.get('favorite')).toBe('1');
  });

  it('keeps several URLs in one cell, separated by line breaks', () => {
    const row = parseCsvTable(text()).table.rows[0]!;
    expect(row.values.get('urls')).toBe('https://example.com/login\nhttps://mail.example.com');
  });

  it('packs custom fields and security questions as "label: value"', () => {
    const row = parseCsvTable(text()).table.rows[0]!;
    expect(row.values.get('custom_fields')).toContain('Account number: 4471-9902');
    expect(row.values.get('custom_fields')).toContain('Recovery PIN: 9137');
    expect(row.values.get('security_questions')).toContain('First pet’s name?: Byron');
  });

  it('writes dates as ISO 8601, which a spreadsheet can sort', () => {
    const row = parseCsvTable(text()).table.rows[0]!;
    expect(row.values.get('created_at')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row.values.get('trashed_at')).toBe('');
    expect(parseCsvTable(text()).table.rows[1]?.values.get('last_used_at')).toBe('');
  });

  it('survives a note carrying a comma, a quote and a newline', () => {
    const nasty = 'a "quoted" note, with a comma\nand a second line';
    const document = buildDocument([bareRecord({ notes: nasty })]);
    const exported = Buffer.from(exportCsv(document).secretBytes).toString('utf8');

    expect(parseCsvTable(exported).table.rows[0]?.values.get('notes')).toBe(nasty);
  });

  it('reads back through the "Any CSV" importer without losing a value', () => {
    const document = buildDocument([richRecord()]);
    const exported = Buffer.from(exportCsv(document).secretBytes).toString('utf8');
    const result = genericCsvParser.parse(exported);

    const record = result.records[0]!;
    expect(record.title).toBe('Example Mail');
    expect(record.username).toBe('ada');
    expect(record.password).toBe('correct-horse-battery-staple');
    expect(record.urls).toEqual(['https://example.com/login', 'https://mail.example.com']);
    expect(record.folderId).toBe(importFolderId('Personal/Mail'));
  });

  it('is deterministic', () => {
    const first = exportCsv(DOCUMENT).secretBytes;
    const second = exportCsv(DOCUMENT).secretBytes;
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });
});

// ── The compatible CSV ───────────────────────────────────────────────────────

describe('the compatible CSV', () => {
  const text = (document = DOCUMENT): string =>
    Buffer.from(exportCompatibleCsv(document).secretBytes).toString('utf8');

  it('writes exactly Bitwarden’s columns, in Bitwarden’s order', () => {
    expect(parseCsvTable(text()).table.columns).toEqual([...COMPATIBLE_CSV_COLUMNS]);
  });

  it('is recognised as a Bitwarden CSV by the importer that reads them', () => {
    // The real test of "other managers will accept this": a detector written against their
    // format, not our own assertion that the header looks right.
    expect(bitwardenCsvParser.detect(text())).toBe(true);
  });

  it('re-imports with its values intact', () => {
    const result = bitwardenCsvParser.parse(text(buildDocument([richRecord()])));
    const record = result.records[0]!;

    expect(record.title).toBe('Example Mail');
    expect(record.username).toBe('ada');
    expect(record.password).toBe('correct-horse-battery-staple');
    expect(record.notes).toBe('Recovery codes:\n1111-2222\n3333-4444');
    expect(record.urls).toEqual(['https://example.com/login', 'https://mail.example.com']);
    expect(record.favorite).toBe(true);
    expect(record.folderId).toBe(importFolderId('Personal/Mail'));
  });

  it('carries everything Bitwarden has no column for through the fields cell', () => {
    const result = bitwardenCsvParser.parse(text(buildDocument([richRecord()])));
    const custom = result.records[0]!.custom ?? [];
    const byLabel = new Map(custom.map((field) => [field.label, field]));

    expect(byLabel.get('Email')?.value).toBe('ada@example.com');
    expect(byLabel.get('Account number')?.value).toBe('4471-9902');
    expect(byLabel.get('Recovery PIN')?.value).toBe('9137');
    expect(byLabel.get('First pet’s name?')?.value).toBe('Byron');
    expect(byLabel.get('Tags')?.value).toBe('work, email');
  });

  it('hoists a TOTP seed into login_totp, so two-factor survives the move', () => {
    const result = bitwardenCsvParser.parse(text(buildDocument([richRecord()])));
    const totp = (result.records[0]!.custom ?? []).find((field) => field.type === 'otp-secret');

    expect(totp?.value).toBe('otpauth://totp/Example:ada?secret=JBSWY3DPEHPK3PXP');
    // And it is not also left in the packed cell, which would import it twice.
    const seeds = (result.records[0]!.custom ?? []).filter((field) =>
      field.value.startsWith('otpauth://')
    );
    expect(seeds).toHaveLength(1);
  });

  it('uses the email as the username when there is no username', () => {
    const document = buildDocument([bareRecord({ username: '', email: 'solo@example.com' })]);
    const row = parseCsvTable(text(document)).table.rows[0]!;

    expect(row.values.get('login_username')).toBe('solo@example.com');
    // …and does not then repeat it as a redundant custom field.
    expect(row.values.get('fields') ?? '').not.toContain('Email:');
  });

  it('is deterministic', () => {
    expect(text()).toBe(text());
  });
});

// ── Formula injection, end to end ────────────────────────────────────────────

describe('formula injection through a real export', () => {
  const PAYLOAD = "=cmd|'/c calc'!A0";
  const document = buildDocument([bareRecord({ title: 'Trap', password: PAYLOAD })]);

  it('never lets a payload reach a cell unprefixed, in either format', () => {
    for (const exported of [exportCsv(document), exportCompatibleCsv(document)]) {
      const text = Buffer.from(exported.secretBytes).toString('utf8');
      const { table } = parseCsvTable(text);
      const cell =
        table.rows[0]?.values.get('password') ?? table.rows[0]?.values.get('login_password');

      expect(cell).toBe(`'${PAYLOAD}`);
    }
  });

  it('reports the rewrite, because the file no longer matches the vault', () => {
    const loss = exportCsv(document).losses.find((entry) => entry.kind === 'altered');
    expect(loss?.field).toBe('password');
    expect(loss?.records).toBe(1);
    // The message names the column and the count. It does not quote the payload.
    expect(loss?.message).not.toContain('cmd');
  });
});

// ── Trashed records ──────────────────────────────────────────────────────────

describe('trashed records', () => {
  const document = buildDocument([
    bareRecord({ id: 'live', title: 'Live' }),
    bareRecord({ id: 'binned', title: 'Binned', trashedAt: NOW - 5 }),
  ]);

  it('are excluded by default from both formats', () => {
    for (const exported of [exportCsv(document), exportCompatibleCsv(document)]) {
      expect(exported.recordCount).toBe(1);
      expect(Buffer.from(exported.secretBytes).toString('utf8')).not.toContain('Binned');
      expect(exported.losses.some((entry) => entry.field === 'trashed records')).toBe(true);
    }
  });

  it('are included on an explicit opt-in', () => {
    const exported = exportCsv(document, { includeTrashed: true });
    expect(exported.recordCount).toBe(2);
    expect(Buffer.from(exported.secretBytes).toString('utf8')).toContain('Binned');
  });

  it('are reported by the compatible format as arriving un-trashed elsewhere', () => {
    const loss = exportCompatibleCsv(document, { includeTrashed: true }).losses.find(
      (entry) => entry.field === 'trash state'
    );
    expect(loss?.kind).toBe('dropped');
    expect(loss?.records).toBe(1);
  });
});

// ── What each format admits to losing ────────────────────────────────────────

describe('reported losses', () => {
  const fieldsOf = (losses: readonly { field: string }[]): string[] =>
    losses.map((loss) => loss.field);

  it('names everything a flat file cannot hold', () => {
    const losses = exportCsv(buildDocument([richRecord()])).losses;
    expect(fieldsOf(losses)).toEqual(
      expect.arrayContaining([
        'history',
        'attachments',
        'icon',
        'custom field type',
        'security questions',
        'urls',
        'record identity',
        'vault settings',
        'tag colours',
      ])
    );
  });

  it('counts the records each loss affected rather than repeating itself', () => {
    const document = buildDocument([richRecord({ id: 'a' }), richRecord({ id: 'b' })]);
    const history = exportCsv(document).losses.filter((loss) => loss.field === 'history');

    expect(history).toHaveLength(1);
    expect(history[0]?.records).toBe(2);
  });

  it('names what the compatible format gives up for compatibility', () => {
    const losses = exportCompatibleCsv(buildDocument([richRecord()])).losses;
    expect(fieldsOf(losses)).toEqual(
      expect.arrayContaining(['email', 'security questions', 'tags', 'dates'])
    );
  });

  it('reports nothing about custom fields for a record that has none', () => {
    const losses = exportCsv(buildDocument([bareRecord()])).losses;
    expect(fieldsOf(losses)).not.toContain('custom field type');
  });
});

// ── The property that matters most ───────────────────────────────────────────

describe('loss messages never carry a value', () => {
  const MARKER = 'ZZMARKERZZ';

  function markedRecord(): Credential {
    const base = richRecord();
    return {
      ...base,
      title: `${MARKER}-title`,
      fields: {
        ...base.fields,
        username: `${MARKER}-username`,
        email: `${MARKER}-email@example.com`,
        password: `${MARKER}-password`,
        notes: `${MARKER}-notes`,
        securityQuestions: base.fields.securityQuestions.map((question) => ({
          ...question,
          answer: `${MARKER}-answer`,
        })),
        custom: base.fields.custom.map((field) => ({ ...field, value: `${MARKER}-custom` })),
      },
    };
  }

  it('holds for both formats, with a marker planted in every secret', () => {
    const document = buildDocument([markedRecord()]);

    for (const exported of [exportCsv(document), exportCompatibleCsv(document)]) {
      // The export itself must carry the values — otherwise this test passes for the wrong
      // reason, which is how a no-secrets assertion quietly stops asserting anything.
      expect(Buffer.from(exported.secretBytes).toString('utf8')).toContain(`${MARKER}-password`);
      expect(JSON.stringify(exported.losses)).not.toContain(MARKER);
    }
  });

  it('holds when a neutralised value is what got reported', () => {
    const document = buildDocument([bareRecord({ password: `=${MARKER}` })]);
    const exported = exportCsv(document);

    expect(exported.losses.some((loss) => loss.kind === 'altered')).toBe(true);
    expect(JSON.stringify(exported.losses)).not.toContain(MARKER);
  });
});
