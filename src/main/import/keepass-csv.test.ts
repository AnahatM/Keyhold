// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { loadFixture } from './fixtures/load.js';
import { keepassCsvParser } from './keepass-csv.js';

const result = keepassCsvParser.parse(loadFixture('keepass.csv'));
const [mail, build] = result.records;

describe('keepass / keepassxc CSV', () => {
  it('maps the KeePassXC columns', () => {
    expect(mail?.title).toBe('Example Mail');
    expect(mail?.username).toBe('ada@example.com');
    expect(mail?.password).toBe('hunter2');
    expect(mail?.urls).toEqual(['https://mail.example.com']);
    expect(mail?.notes).toBe('Recovery kit, kept offline');
    expect(mail?.custom?.[0]?.type).toBe('otp-secret');
  });

  it('keeps the group tree, root group and all', () => {
    // The root segment is the source database's name, which is deliberate: it keeps a KeePass
    // import from scattering its groups across the top level of the vault.
    expect(result.folders).toEqual(['Example DB', 'Example DB/Internet', 'Example DB/Work']);
    expect(build?.folderId).toBe('import-folder:Example DB/Work');
  });

  it('keeps a non-http URL scheme verbatim', () => {
    expect(build?.urls).toEqual(['ssh://build.example.com']);
  });

  it('names the icon and timestamp columns it drops', () => {
    const dropped = result.warnings.filter((warning) => warning.kind === 'dropped-value');
    expect(dropped.map((warning) => warning.column)).toEqual(['Icon', 'Last Modified', 'Created']);
  });

  it('also reads the older KeePass 1.x-style CSV', () => {
    const legacy =
      '"Account","Login Name","Password","Web Site","Comments"\n' +
      '"Example","ada","hunter2","https://example.com","A note, with a comma"\n';
    expect(keepassCsvParser.detect(legacy)).toBe(true);
    const [record] = keepassCsvParser.parse(legacy).records;
    expect(record?.title).toBe('Example');
    expect(record?.username).toBe('ada');
    expect(record?.urls).toEqual(['https://example.com']);
    expect(record?.notes).toBe('A note, with a comma');
  });
});
