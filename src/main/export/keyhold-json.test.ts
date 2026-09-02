// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VERSIONED_FIELDS } from '@shared/model/credential.js';
import { PLAINTEXT_EXPORT_WARNING } from '@shared/model/export.js';
import { parseVaultDocument } from '../vault/vault-service.js';
import {
  exportKeyholdJson,
  KEYHOLD_JSON_FORMAT,
  parseKeyholdJson,
  serialiseKeyholdJson,
} from './keyhold-json.js';
import { bareRecord, buildDocument, NOW, richRecord } from './test-fixtures.js';

/**
 * The lossless format's tests.
 *
 * The single most important assertion in this file is the first one: **a document that goes
 * through this format and comes back must be the same document**. Everything else — the key
 * ordering, the hostile-input checks, the loss reporting — exists to keep that true when
 * somebody adds a field to the record model in six months.
 *
 * Round-tripping is checked with the *rich* fixture rather than a small one on purpose. A
 * two-field record round-trips through almost any serialiser; a record with a hidden custom
 * field, a TOTP seed, two security questions, an attachment, a non-default icon and two
 * versions of history each carrying a full origin is the one that catches the field somebody
 * forgot to write out.
 *
 * Fault injections performed against this file, all reverted:
 *
 *  1. `serialiseOrigin` narrowed to `AUDIT_LEVEL_FIELDS.device`. 3 failed, including the
 *     encrypted round trip, which reads the same serialiser.
 *  2. `serialiseSnapshot` made to skip the `custom` case. 4 failed.
 *  3. The trashed filter in `selectRecords` inverted. 8 failed across three files.
 *  4. `parseIcon` made to assign `value` unconditionally, so an absent key came back
 *     present-but-`undefined`. 1 failed — the `'value' in icon` assertion, which exists
 *     precisely because `toEqual` forgives that difference and would not have caught it.
 *  5. `parseKeyholdJson`'s `format` check removed. 1 failed.
 *
 * **One injection did not fail anything, and that is worth recording rather than hiding.**
 * Making `serialiseIcon` assign `out.value = icon.value` unconditionally changed nothing
 * observable: `JSON.stringify` drops keys whose value is `undefined`, so the guard on the
 * *writing* side is defence in depth rather than the thing keeping the round trip honest.
 * The guard that is load-bearing is the one on the reading side, which is injection 4 above.
 */

const OPTIONS = { now: NOW } as const;

describe('round trip', () => {
  it('returns a document deep-equal to the one it was given', () => {
    const document = buildDocument([
      richRecord(),
      bareRecord(),
      richRecord({ id: 'rec-trashed', title: 'Old', trashedAt: NOW - 1000 }),
    ]);

    const text = serialiseKeyholdJson(document, { ...OPTIONS, includeTrashed: true });
    const parsed = parseKeyholdJson(text);

    expect(parsed.document).toEqual(document);
    expect(parsed.exportedAt).toBe(NOW);
  });

  it('keeps every version, its changed fields, its snapshot and its origin', () => {
    const document = buildDocument([richRecord()]);
    const parsed = parseKeyholdJson(serialiseKeyholdJson(document, OPTIONS));

    const versions = parsed.document.records[0]!.history.versions;
    expect(versions).toHaveLength(2);
    expect(versions[0]!.snapshot.password).toBe('hunter2');
    expect(versions[1]!.snapshot.custom?.[0]?.value).toBe('0000-0000');
    // The headline differentiator: no other free local manager carries this, so an export
    // that silently dropped it would quietly remove the reason to use Keyhold.
    expect(versions[1]!.origin).toEqual({
      action: 'restore',
      deviceName: 'DESKTOP-A',
      platform: 'win32',
      appVersion: '0.1.0',
      osUser: 'ada',
      networkName: 'Office',
      osRelease: '10.0.26200',
      localIp: '10.0.0.4',
    });
  });

  it('keeps the hidden flag and the type of a custom field', () => {
    const parsed = parseKeyholdJson(serialiseKeyholdJson(buildDocument([richRecord()]), OPTIONS));
    const custom = parsed.document.records[0]!.fields.custom;

    expect(custom.find((field) => field.id === 'cf-2')).toEqual({
      id: 'cf-2',
      label: 'Recovery PIN',
      type: 'pin',
      value: '9137',
      hidden: true,
      order: 1,
    });
  });

  it('does not invent an `undefined` icon value where the record had none', () => {
    // `exactOptionalPropertyTypes` makes "absent" and "present but undefined" different
    // types, and `toEqual` would forgive the difference — so this asserts on the key itself.
    const parsed = parseKeyholdJson(serialiseKeyholdJson(buildDocument([bareRecord()]), OPTIONS));
    expect('value' in parsed.document.records[0]!.icon).toBe(false);
  });

  it('reads back from bytes, and from a file some editor left a BOM on', () => {
    const document = buildDocument([bareRecord()]);
    const text = serialiseKeyholdJson(document, OPTIONS);

    expect(parseKeyholdJson(new Uint8Array(Buffer.from(text, 'utf8'))).document).toEqual(document);
    expect(parseKeyholdJson(`\uFEFF${text}`).document).toEqual(document);
  });
});

describe('determinism', () => {
  it('serialises the same document to identical bytes', () => {
    const document = buildDocument([richRecord(), bareRecord()]);
    const first = exportKeyholdJson(document, OPTIONS);
    const second = exportKeyholdJson(document, OPTIONS);
    expect(Buffer.from(first.secretBytes).equals(Buffer.from(second.secretBytes))).toBe(true);
  });

  it('is unaffected by the key order of the object it was handed', () => {
    // A document that came out of `JSON.parse` carries its key order from the file it was
    // read from. Serialising by spreading whatever the object has would make the same vault
    // produce different bytes on two machines.
    const document = buildDocument([richRecord()]);
    const reordered = parseKeyholdJson(serialiseKeyholdJson(document, OPTIONS)).document;
    expect(serialiseKeyholdJson(reordered, OPTIONS)).toBe(serialiseKeyholdJson(document, OPTIONS));
  });

  it('writes the envelope keys in a fixed order', () => {
    const text = serialiseKeyholdJson(buildDocument([bareRecord()]), OPTIONS);
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      'format',
      'formatVersion',
      'exportedAt',
      'documentVersion',
      'settings',
      'folders',
      'tags',
      'records',
    ]);
  });

  it('writes a version snapshot in VERSIONED_FIELDS order, not in changed-field order', () => {
    const text = serialiseKeyholdJson(buildDocument([richRecord()]), OPTIONS);
    const envelope = JSON.parse(text) as {
      records: { history: { versions: { snapshot: object; changedFields: string[] }[] } }[];
    };
    const version = envelope.records[0]!.history.versions[1]!;

    const expected = VERSIONED_FIELDS.filter((field) => version.changedFields.includes(field));
    expect(Object.keys(version.snapshot)).toEqual(expected);
    // The two orders genuinely differ, so the assertion above is not vacuous.
    expect(Object.keys(version.snapshot)).not.toEqual(version.changedFields);
  });
});

describe('trashed records', () => {
  const document = buildDocument([
    bareRecord({ id: 'live' }),
    bareRecord({ id: 'binned', trashedAt: NOW - 5 }),
  ]);

  it('leaves them out by default', () => {
    const result = exportKeyholdJson(document, OPTIONS);
    const ids = parseKeyholdJson(result.secretBytes).document.records.map((r) => r.id);

    expect(ids).toEqual(['live']);
    expect(result.recordCount).toBe(1);
  });

  it('says so, rather than omitting them quietly', () => {
    const loss = exportKeyholdJson(document, OPTIONS).losses.find(
      (entry) => entry.field === 'trashed records'
    );
    expect(loss?.kind).toBe('excluded');
    expect(loss?.records).toBe(1);
  });

  it('includes them on an explicit opt-in', () => {
    const result = exportKeyholdJson(document, { ...OPTIONS, includeTrashed: true });
    const ids = parseKeyholdJson(result.secretBytes).document.records.map((r) => r.id);

    expect(ids).toEqual(['live', 'binned']);
    expect(result.losses.some((entry) => entry.field === 'trashed records')).toBe(false);
  });
});

describe('the warning', () => {
  it('comes back with the bytes, so a caller cannot take one without the other', () => {
    const result = exportKeyholdJson(buildDocument([bareRecord()]), OPTIONS);
    expect(result.containsSecrets).toBe(true);
    expect(result.warning).toBe(PLAINTEXT_EXPORT_WARNING);
  });
});

describe('what it reports as lost', () => {
  it('names the attachment contents it cannot carry', () => {
    const loss = exportKeyholdJson(buildDocument([richRecord()]), OPTIONS).losses.find(
      (entry) => entry.field === 'attachment contents'
    );
    expect(loss?.kind).toBe('dropped');
    expect(loss?.records).toBe(1);
  });

  it('reports nothing for a plain vault, because it loses nothing', () => {
    expect(exportKeyholdJson(buildDocument([bareRecord()]), OPTIONS).losses).toEqual([]);
  });
});

describe('a subset export', () => {
  const document = buildDocument([richRecord(), bareRecord({ id: 'other' })]);

  it('carries only the folders its records live in, plus their ancestors', () => {
    const parsed = parseKeyholdJson(
      serialiseKeyholdJson(document, { ...OPTIONS, recordIds: ['rec-1'] })
    );
    expect(parsed.document.folders.map((folder) => folder.id)).toEqual([
      'folder-root',
      'folder-child',
    ]);
  });

  it('carries only the tags its records use', () => {
    const parsed = parseKeyholdJson(
      serialiseKeyholdJson(document, { ...OPTIONS, recordIds: ['rec-1'] })
    );
    expect(parsed.document.tags.map((tag) => tag.name)).toEqual(['work', 'email']);
  });

  it('keeps every folder on a whole-vault export, empty ones included', () => {
    const parsed = parseKeyholdJson(serialiseKeyholdJson(document, OPTIONS));
    expect(parsed.document.folders).toHaveLength(3);
  });

  it('reports an id that is no longer in the vault', () => {
    const loss = exportKeyholdJson(document, {
      ...OPTIONS,
      recordIds: ['rec-1', 'gone'],
    }).losses.find((entry) => entry.field === 'unknown records');
    expect(loss?.records).toBe(1);
  });
});

describe('the payload is also a vault body', () => {
  it('opens with the ordinary document parser, which is what makes a parcel unlockable', () => {
    const document = buildDocument([richRecord()]);
    const body = new Uint8Array(Buffer.from(serialiseKeyholdJson(document, OPTIONS), 'utf8'));
    expect(parseVaultDocument(body).records[0]?.id).toBe('rec-1');
  });
});

describe('hostile input', () => {
  const good = (): string => serialiseKeyholdJson(buildDocument([richRecord()]), OPTIONS);

  it('refuses something that is not JSON', () => {
    expect(() => parseKeyholdJson('not json at all')).toThrow(/not valid JSON/);
  });

  it('refuses a JSON file that is not a Keyhold export', () => {
    expect(() => parseKeyholdJson(JSON.stringify({ format: 'something-else' }))).toThrow(
      /not a Keyhold export/
    );
  });

  it('refuses a format version from the future rather than guessing at it', () => {
    const envelope = JSON.parse(good()) as Record<string, unknown>;
    envelope.formatVersion = 99;
    expect(() => parseKeyholdJson(JSON.stringify(envelope))).toThrow(/newer than the supported/);
  });

  it('refuses a field of the wrong type instead of carrying it into the vault', () => {
    const envelope = JSON.parse(good()) as { records: Record<string, unknown>[] };
    envelope.records[0]!.title = 42;
    expect(() => parseKeyholdJson(JSON.stringify(envelope))).toThrow(/"records\[0\].title"/);
  });

  it('refuses an unknown custom field type', () => {
    const envelope = JSON.parse(good()) as {
      records: { fields: { custom: Record<string, unknown>[] } }[];
    };
    envelope.records[0]!.fields.custom[0]!.type = 'nuclear-launch-code';
    expect(() => parseKeyholdJson(JSON.stringify(envelope))).toThrow(/is not one of/);
  });

  it('refuses history whose snapshot claims a field the version does not list as changed', () => {
    const envelope = JSON.parse(good()) as {
      records: { history: { versions: { snapshot: Record<string, unknown> }[] } }[];
    };
    envelope.records[0]!.history.versions[0]!.snapshot.notes = 'smuggled';
    expect(() => parseKeyholdJson(JSON.stringify(envelope))).toThrow(/does not list as changed/);
  });

  it('names the path of the bad field and never its value', () => {
    const envelope = JSON.parse(good()) as { records: { fields: Record<string, unknown> }[] };
    envelope.records[0]!.fields.password = { secret: 'super-secret-value' };
    expect(() => parseKeyholdJson(JSON.stringify(envelope))).toThrow(
      /"records\[0\].fields.password" is not a string/
    );
    expect(() => parseKeyholdJson(JSON.stringify(envelope))).not.toThrow(/super-secret-value/);
  });
});

describe('the format marker', () => {
  it('is written into the file, so a stray JSON is not mistaken for an export', () => {
    const envelope = JSON.parse(serialiseKeyholdJson(buildDocument([]), OPTIONS)) as {
      format: string;
    };
    expect(envelope.format).toBe(KEYHOLD_JSON_FORMAT);
  });
});
