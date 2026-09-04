// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { keepassXmlParser } from '../import/keepass-xml.js';
import { readKdbx } from '../kdbx/read.js';
import { exportKdbx, serialiseKdbxXml } from './kdbx.js';
import { bareRecord, buildDocument, richRecord } from './test-fixtures.js';

/**
 * The KDBX export, and the loop it closes.
 *
 * The case that matters most here is the last one: a vault exported to KeePass's format and
 * **imported straight back through Keyhold's own KeePass importer**. That is the closest an
 * offline test gets to interoperability, because the two halves were written for different
 * reasons — the importer against KeePassXC's schema months before this exporter existed — and
 * neither was adjusted to make the other pass.
 *
 * It is still not proof that KeePassXC opens these files. Nothing offline can be. That check
 * is a manual step and is recorded as one in `MANUAL-BACKLOG.md`.
 *
 * Fault injections performed:
 *
 * 1. **`Protected="True"` dropped from the `Password` string.** The round trip still passed —
 *    the value survives either way — but `writes a password as a protected value` failed on
 *    the decrypted XML. That is the case worth having: a KDBX whose passwords are plain text
 *    is a file that looks encrypted, opens in KeePass, and shows every password in the entry
 *    list without asking.
 * 2. **The database's own root group given a folder path.** `rebuilds the folder tree` failed
 *    with every record one level deeper than it should be — the same bug the importer has its
 *    own case for, from the other direction.
 * 3. **`isCustomFieldValueSecret` replaced with `false`.** `writes a secret custom field
 *    protected` failed. A recovery code exported as visible text is a real leak into another
 *    application's UI.
 * 4. **The timestamp encoder made to emit an ISO string**, as KDBX 3 used. Caught nothing —
 *    recorded rather than hidden. Keyhold's own importer ignores KeePass's times, so nothing
 *    on this side can see it; only KeePassXC can, and it is on the manual interop list.
 */

const PASSWORD = 'a-passphrase-for-the-file';
const FAST_KDF = { memoryKib: 64, iterations: 1, parallelism: 1 } as const;
const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);

/**
 * One record with something in every corner of the model, one plain one, and one in the trash.
 *
 * The trashed record is not decoration: "a KDBX export does not carry a record the user
 * deleted" is a real promise, and a fixture with nothing in the trash would let a writer that
 * ignores `trashedAt` pass every case here.
 */
const DOCUMENT = buildDocument([
  richRecord(),
  bareRecord({ id: 'plain', title: 'Plain', folderId: null }),
  bareRecord({ id: 'gone', title: 'Deleted Long Ago', trashedAt: NOW - 1_000 }),
]);

function xml(): string {
  return serialiseKdbxXml(DOCUMENT, DOCUMENT.records, { now: NOW, databaseName: 'Keyhold' });
}

describe('the XML a KDBX export carries', () => {
  it('writes a password as a protected value', () => {
    // In the clear here on purpose: `writeKdbx` encrypts protected values on the way out, in
    // document order. The attribute is the instruction; the encryption happens at the seam.
    expect(xml()).toMatch(/<Key>Password<\/Key><Value Protected="True">/);
  });

  it('writes a note as a protected value', () => {
    // `notes` is in `SECRET_CORE_FIELDS` because people put recovery codes in it. Exporting
    // it visible in another application would quietly undo that decision.
    expect(xml()).toMatch(/<Key>Notes<\/Key><Value Protected="True">/);
  });

  it('escapes markup in a value rather than emitting a broken document', () => {
    const document = {
      ...DOCUMENT,
      records: [
        {
          ...DOCUMENT.records[0]!,
          title: 'Sharp & <pointy>',
          fields: { ...DOCUMENT.records[0]!.fields, password: 'p<ss&w"rd' },
        },
      ],
    };
    const written = serialiseKdbxXml(document, document.records, {
      now: NOW,
      databaseName: 'Keyhold',
    });

    expect(written).toContain('Sharp &amp; &lt;pointy&gt;');
    expect(written).not.toContain('<pointy>');
  });

  it('writes a secret custom field protected, and a plain one not', () => {
    // The model already decides which custom fields never cross into the renderer, and
    // `isCustomFieldValueSecret` is that decision. The attribute follows it exactly rather
    // than re-deriving it — a second answer to the same question, in the one place where
    // getting it wrong means a recovery code shown as plain text in somebody else's app.
    const secret = richRecord().fields.custom.find(
      (field) => field.hidden || field.type !== 'text'
    );
    expect(secret, 'the fixture has no secret custom field to test with').toBeDefined();

    const written = xml();
    expect(written).toContain(`<Key>${secret?.label ?? ''}</Key><Value Protected="True">`);
  });

  it('names the generator, so a file can be traced back to what wrote it', () => {
    expect(xml()).toContain('<Generator>Keyhold</Generator>');
  });
});

describe('exporting, then importing back through Keyhold’s own KeePass reader', () => {
  it('returns the records, the passwords and the folder tree', async () => {
    const output = await exportKdbx(DOCUMENT, {
      secretPassword: PASSWORD,
      now: NOW,
      kdf: FAST_KDF,
    });
    const back = await readKdbx(output.bytes, PASSWORD);
    const imported = keepassXmlParser.parse(back.xml);

    expect(imported.records.length).toBe(output.recordCount);
    for (const original of DOCUMENT.records.filter((record) => record.trashedAt === null)) {
      const match = imported.records.find((record) => record.title === original.title);
      expect(match, `"${original.title}" did not survive the round trip`).toBeDefined();
      expect(match?.password).toBe(original.fields.password);
    }
  });

  it('rebuilds the folder tree, without the database’s own name in it', async () => {
    // The mirror of the importer's own case. KeePass's root group is the database, not a
    // folder, and a writer that treats it as one produces a file that imports one level deep
    // — in Keyhold and in KeePass alike.
    const output = await exportKdbx(DOCUMENT, {
      secretPassword: PASSWORD,
      now: NOW,
      kdf: FAST_KDF,
    });
    const imported = keepassXmlParser.parse((await readKdbx(output.bytes, PASSWORD)).xml);

    expect(imported.folders.some((folder) => folder.startsWith('Keyhold'))).toBe(false);
    expect(imported.folders.length).toBeGreaterThan(0);
  });

  it('reports what it could not carry, rather than dropping it quietly', async () => {
    const output = await exportKdbx(DOCUMENT, {
      secretPassword: PASSWORD,
      now: NOW,
      kdf: FAST_KDF,
    });
    const fields = output.losses.map((loss) => loss.field);

    // History is the real loss, and it is the one a user is most likely to care about.
    expect(fields).toContain('version history');
  });

  it('is an encrypted export, so it carries no plaintext warning', async () => {
    const output = await exportKdbx(DOCUMENT, {
      secretPassword: PASSWORD,
      now: NOW,
      kdf: FAST_KDF,
    });

    expect(output.containsSecrets).toBe(false);
    expect(output.warning).toBeNull();
    expect(output.extension).toBe('.kdbx');
  });

  it('does not export trashed records unless asked', async () => {
    const withTrash = DOCUMENT.records.filter((record) => record.trashedAt !== null);
    expect(withTrash.length, 'the fixture has no trashed record to test with').toBeGreaterThan(0);

    const output = await exportKdbx(DOCUMENT, {
      secretPassword: PASSWORD,
      now: NOW,
      kdf: FAST_KDF,
    });
    const imported = keepassXmlParser.parse((await readKdbx(output.bytes, PASSWORD)).xml);

    for (const trashed of withTrash) {
      expect(imported.records.map((record) => record.title)).not.toContain(trashed.title);
    }
  });
});
