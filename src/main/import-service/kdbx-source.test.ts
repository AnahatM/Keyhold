// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VaultError } from '../crypto/errors.js';
import { KDBX_ATTACHMENT_MARKER, keepassXmlParser } from '../import/keepass-xml.js';
import { writeKdbx } from '../kdbx/write.js';
import { looksLikeKdbx, readKdbxAsImportSource } from './kdbx-source.js';
import { readVaultAsImportSource } from './vault-source.js';

/**
 * A KeePass database, all the way from bytes on disk to records the wizard would commit.
 *
 * The most valuable test in the KDBX work, because it is the only one that exercises the
 * actual claim: that a `.kdbx` becomes credentials **without a KDBX-specific record mapper**.
 * The decrypt hands over KeePass XML and `import/keepass-xml.ts` — written, tested and
 * fault-injected before any of this existed — does the mapping. If that seam were wrong, this
 * is where it shows, and no unit test on either side would notice.
 *
 * Fault injections performed:
 *
 * 1. **`looksLikeKdbx` made to return `false`.** `readVaultAsImportSource` then tried to read
 *    a KeePass database as a KEEP container and refused it as "not a vault" — the failure a
 *    user would report as "Keyhold won't open my KeePass file".
 * 2. **The attachment marker dropped from the source text.** This injection used to catch
 *    nothing, and the reason was recorded here rather than dressed up: Keyhold's own writer
 *    emitted no attachments, so no database this suite could build had one to count, and the
 *    append path was reachable only from a real KeePassXC database.
 *
 *    **It is reachable now.** `writeInnerHeader` had always accepted a binary pool; only
 *    `writeKdbx` insisted on an empty one. It takes `binaries` as an injection point, beside
 *    the `kdf` and `random` ones already there for the same kind of reason, and the case
 *    below builds a database with two attachments and asserts the *count* — an append path
 *    that always wrote `1` would pass a contains-check and lie to every user with two.
 *    Dropping the marker now fails.
 *
 *    The pair around it is guarded too. The marker used to be composed here from a string
 *    this file owned and matched in `keepass-xml.ts` against a *separate hardcoded copy* — a
 *    second list, agreeing by luck. Both derive from `KDBX_ATTACHMENT_MARKER` in the parser.
 *    The zero case is still asserted as well, so a database with no attachments cannot grow
 *    a spurious marker.
 * 3. **The `.kdbx` extension left on the source's file name.** Detection then ranked the
 *    candidates by an extension no parser claims; it still resolved to `keepass-xml` by
 *    content, so this one caught nothing on its own — recorded rather than dressed up. The
 *    rename is a correctness-of-ranking improvement, not a guard.
 */

const FAST_KDF = { memoryKib: 64, iterations: 1, parallelism: 1 } as const;

const XML = [
  '<KeePassFile><Meta><DatabaseName>Example Vault</DatabaseName></Meta>',
  '<Root><Group><Name>Example Vault</Name>',
  '<Group><Name>Work</Name>',
  '<Entry>',
  '<String><Key>Title</Key><Value>Example Payroll</Value></String>',
  '<String><Key>UserName</Key><Value>alice@example.com</Value></String>',
  '<String><Key>Password</Key><Value Protected="True">correct-horse-battery-staple</Value></String>',
  '<String><Key>URL</Key><Value>https://payroll.example.com</Value></String>',
  '</Entry>',
  '</Group></Group></Root></KeePassFile>',
].join('');

async function database(xml = XML, password = 'opens-it'): Promise<Uint8Array> {
  return await writeKdbx({ secretXml: xml, secretPassword: password, kdf: FAST_KDF });
}

describe('recognising a KeePass database', () => {
  it('knows one by its signature', async () => {
    expect(looksLikeKdbx(await database())).toBe(true);
  });

  it('does not claim a Keyhold vault, a short file, or noise', () => {
    expect(looksLikeKdbx(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(looksLikeKdbx(new Uint8Array(64))).toBe(false);
    expect(looksLikeKdbx(new TextEncoder().encode('KEEP'))).toBe(false);
  });
});

describe('opening one as an import source', () => {
  it('produces XML the KeePass parser claims', async () => {
    const source = await readKdbxAsImportSource({
      fileName: 'personal.kdbx',
      bytes: await database(),
      secretPassphrase: 'opens-it',
    });

    const text = new TextDecoder().decode(source.bytes);
    expect(keepassXmlParser.detect(text)).toBe(true);
    expect(source.fileName).toBe('personal.xml');
  });

  it('maps straight through to records, with no KDBX-specific mapper anywhere', async () => {
    const source = await readKdbxAsImportSource({
      fileName: 'personal.kdbx',
      bytes: await database(),
      secretPassphrase: 'opens-it',
    });
    const result = keepassXmlParser.parse(new TextDecoder().decode(source.bytes));

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.title).toBe('Example Payroll');
    expect(result.records[0]?.password).toBe('correct-horse-battery-staple');
    expect(result.records[0]?.folderId).toBe('import-folder:Work');
    expect(result.folders).toEqual(['Work']);
  });

  it('appends no attachment marker when the database has none', async () => {
    const source = await readKdbxAsImportSource({
      fileName: 'personal.kdbx',
      bytes: await database(),
      secretPassphrase: 'opens-it',
    });
    const text = new TextDecoder().decode(source.bytes);

    expect(text).not.toContain('keyhold-kdbx-attachments');
    expect(keepassXmlParser.parse(text).warnings).toEqual([]);
  });

  it('counts the attachments a real database carries, and says so', async () => {
    // The branch that was unreachable until `writeKdbx` gained its `binaries` injection
    // point. A KDBX keeps attachments in the inner header's binary pool, referenced from the
    // XML by index; the reader counts them there and appends a marker the wizard turns into
    // "N attachments were not imported". Keyhold's own export emits none, so before this the
    // only file with a binary in it was one KeePassXC had written.
    const bytes = await writeKdbx({
      secretXml: XML,
      secretPassword: 'opens-it',
      kdf: FAST_KDF,
      binaries: [
        // Flags 0 and 1 — the second is KeePass's "protected in memory" bit, which does not
        // change the bytes and must not change the count either.
        { flags: 0, data: new Uint8Array([1, 2, 3]) },
        { flags: 1, data: new Uint8Array([4, 5]) },
      ],
    });

    const source = await readKdbxAsImportSource({
      fileName: 'personal.kdbx',
      bytes,
      secretPassphrase: 'opens-it',
    });
    const text = new TextDecoder().decode(source.bytes);

    // The count, not merely the marker's presence: an append path that always wrote `1` would
    // pass a contains-check and lie to every user with two attachments.
    expect(text).toContain(`${KDBX_ATTACHMENT_MARKER}:2`);

    // And the whole point of the marker: the parser reads it back and the user is told. This
    // asserts the outcome a person sees rather than a private counter, so the pair that used
    // to be two hardcoded copies agreeing by luck is checked end to end.
    const warnings = keepassXmlParser.parse(text).warnings;
    expect(warnings.map((warning) => warning.message)).toContain(
      '2 attached file(s) were not imported. Keep the original database if you need them.'
    );
  });

  it('refuses the wrong passphrase', async () => {
    await expect(
      readKdbxAsImportSource({
        fileName: 'personal.kdbx',
        bytes: await database(),
        secretPassphrase: 'not-it',
      })
    ).rejects.toBeInstanceOf(VaultError);
  });
});

describe('the encrypted import door', () => {
  it('routes a .kdbx to the KeePass reader by signature, not by extension', async () => {
    // Renamed on purpose. A file the user renamed is still the file it was, and an importer
    // that decided by extension would refuse this one while a hex editor could see what it is.
    const source = await readVaultAsImportSource({
      fileName: 'renamed.keep',
      bytes: await database(),
      secretPassphrase: 'opens-it',
    });

    expect(new TextDecoder().decode(source.bytes)).toContain('Example Payroll');
  });
});
