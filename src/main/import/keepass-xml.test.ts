// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VaultError } from '../crypto/errors.js';
import { loadFixture } from './fixtures/load.js';
import { KDBX_ATTACHMENT_MARKER, kdbxAttachmentMarker, keepassXmlParser } from './keepass-xml.js';

/**
 * KeePass XML, and the things about this format that are easy to get quietly wrong.
 *
 * The parser contract (`parser-contract.test.ts`) already covers what every parser must do.
 * What is here is what only this one can get wrong, and every case below stands for a bug
 * that would ship silently — a vault that imports, opens, and is subtly not the user's vault.
 *
 * ## Fault injections performed, and what each caught
 *
 * 1. **The `History` comment acted on**, so the walk read an entry's previous versions as
 *    entries. Failed with 4 records instead of 3 — the shape of the bug exactly: a vault
 *    multiplied by however many times each password had been changed, every superseded
 *    password back in it.
 * 2. **The recycle-bin skip deleted.** Three cases failed, including "Cancelled Subscription"
 *    arriving as a credential. Worth its own case rather than trusting the warning: a parser
 *    could report the skip and import them anyway.
 * 3. **`current.isDocumentRoot ||` removed from the path.** Folders became
 *    `["Example Vault", "Example Vault/Work", "Example Vault/Work/Cloud"]` — the whole tree
 *    one level too deep, under a word that means nothing outside KeePass.
 * 4. **`looksLikeOtpUri(value) ? 'otp-secret' : undefined` replaced with `false`, and it
 *    failed nothing.** That is a finding, not a passing guard: `guessCustomFieldType` already
 *    checks `looksLikeOtpUri` first, so the explicit type was a restatement of a rule that
 *    lives elsewhere — rule 8's second list, found only because the injection was run. The
 *    special case is gone; the case below now guards the shared authority through this
 *    parser. Re-injected against the real behaviour — the `default` branch made to drop the
 *    string instead of keeping it — three cases fail.
 */

const FIXTURE = loadFixture('keepass.xml');

function parse(): ReturnType<typeof keepassXmlParser.parse> {
  return keepassXmlParser.parse(FIXTURE);
}

describe('reading a KeePass XML export', () => {
  it('maps the standard five strings onto their own fields', () => {
    const record = parse().records.find((candidate) => candidate.title === 'Example Bank');

    expect(record?.username).toBe('alice@example.com');
    expect(record?.password).toBe('correct-horse-battery-staple');
    expect(record?.urls).toEqual(['https://bank.example.com/login']);
    expect(record?.notes).toBe(
      'Recovery kit is in the safe, not the drawer\nSecond line, so a Windows export exercises line-ending handling'
    );
  });

  it('mirrors an email-shaped username into the email field', () => {
    // Not cosmetic: search, grouping and the health rules read `email`, and leaving it empty
    // on an imported vault makes those features useless on most vaults.
    const record = parse().records.find((candidate) => candidate.title === 'Example Bank');
    expect(record?.email).toBe('alice@example.com');
  });

  it('keeps every other string as a custom field under the label the user chose', () => {
    const record = parse().records.find((candidate) => candidate.title === 'Example Payroll');
    const field = record?.custom?.find((candidate) => candidate.label === 'Employee number');

    expect(field?.value).toBe('EMP-0042199');
  });

  it('keeps a TOTP URI as an otp-secret field, recognised by shape', () => {
    // By shape rather than by key name, because KeePassXC writes at least two different ones
    // (`otp`, and `TOTP Seed`/`TOTP Settings`) while the value says what it is unambiguously.
    const record = parse().records.find((candidate) => candidate.title === 'Example Payroll');
    const field = record?.custom?.find((candidate) => candidate.type === 'otp-secret');

    expect(field?.value).toContain('otpauth://totp/');
  });

  it('rebuilds the group tree as folder paths', () => {
    expect(parse().folders).toEqual(['Work', 'Work/Cloud']);
  });

  it('does not turn the database’s own name into a folder', () => {
    // The single group under `<Root>` is the database, not a folder. Letting its name through
    // would file the entire vault one level deep under "Example Vault" — and every other
    // import would then sit beside it rather than among it.
    const result = parse();
    const record = result.records.find((candidate) => candidate.title === 'Example Payroll');

    expect(record?.folderId).toBe('import-folder:Work');
    expect(result.folders.some((folder) => folder.startsWith('Example Vault'))).toBe(false);
  });

  it('reads a password containing markup, because CDATA is literal', () => {
    // The reason KeePass writes CDATA at all. A reader that resolved entities inside one, or
    // that found `<` with a regex, would corrupt exactly the value it was protecting.
    const record = parse().records.find(
      (candidate) => candidate.title === 'Example Object Storage'
    );

    expect(record?.password).toBe('p<ssw>rd&with&markup');
  });

  it('resolves an entity in an ordinary value', () => {
    const record = parse().records.find((candidate) => candidate.title === 'Example Payroll');
    const field = record?.custom?.find((candidate) => candidate.type === 'otp-secret');

    expect(field?.value).toContain('&issuer=Example');
    expect(field?.value).not.toContain('&amp;');
  });
});

describe('what it refuses to bring across', () => {
  it('does not import an entry’s history', () => {
    // A `History` element holds previous versions of the *same* entry, as `Entry` nodes.
    // Walking them would import each superseded version as its own credential: a vault
    // silently multiplied, with every password the user had already replaced back in it.
    const result = parse();

    expect(result.records).toHaveLength(3);
    expect(result.records.map((record) => record.title)).not.toContain('Example Payroll (old)');
    expect(JSON.stringify(result.records)).not.toContain('hunter2-was-here');
  });

  it('does not import what the user deleted', () => {
    const result = parse();

    expect(result.records.map((record) => record.title)).not.toContain('Cancelled Subscription');
    expect(result.warnings.map((warning) => warning.message).join(' ')).toContain('recycle bin');
  });

  it('reports an entry marked as expiring rather than importing the date', () => {
    // KeePass's expiry is a flag *plus* a time. Importing one already in the past would flag
    // the record in the health dashboard on day one — a vault that arrives looking broken
    // because of how it was imported.
    const messages = parse().warnings.map((warning) => warning.message);
    expect(messages.some((message) => message.includes('expiring'))).toBe(true);
  });

  it('reports an inline attachment rather than dropping it silently', () => {
    // A plain XML export carries attachments inline as `<Binary>`. They are not imported —
    // the importer creates records, not chunks, exactly as the `.1pux` and `.keep` importers
    // do — so the whole job here is to say so.
    const withFile = FIXTURE.replace(
      '<Times>',
      '<Binary><Key>notes.pdf</Key><Value>QUJD</Value></Binary><Times>'
    );
    const messages = keepassXmlParser
      .parse(withFile)
      .warnings.map((warning) => warning.message)
      .join(' ');

    expect(messages).toContain('1 attached file(s) were not imported');
  });

  it('reports the attachments a .kdbx declared, which live outside the XML', () => {
    // A `.kdbx` keeps its attachments in the **inner header**, so nothing in the XML mentions
    // them and this parser would have no way to know. `import-service/kdbx-source.ts` counts
    // them and appends the count as an XML *comment* — the one thing `xml-reader.ts` skips,
    // so it cannot be mistaken for data by anything that parses this.
    //
    // Composed with `kdbxAttachmentMarker` rather than written out, which makes this a real
    // round trip: the exact string the source appends, read by the parser that consumes it.
    // The two used to keep separate hardcoded copies of the marker and agreed only by luck —
    // change one and attachments silently stop being reported, with nothing failing anywhere.
    const declared = `${FIXTURE}${kdbxAttachmentMarker(3)}`;
    const messages = keepassXmlParser
      .parse(declared)
      .warnings.map((warning) => warning.message)
      .join(' ');

    expect(messages).toContain('3 attached file(s) were not imported');
  });

  it('appends nothing when the database carried no attachments', () => {
    // The other direction, and the one that would otherwise be invisible: a spurious marker
    // would tell somebody files had been left behind when none had, which is a worse lie than
    // silence because it sends them back to a database they no longer need.
    expect(kdbxAttachmentMarker(0)).toBe('');

    const messages = keepassXmlParser
      .parse(`${FIXTURE}${kdbxAttachmentMarker(0)}`)
      .warnings.map((warning) => warning.message)
      .join(' ');

    expect(messages).not.toContain('attached file(s) were not imported');
  });

  it('the marker survives the parser as a comment rather than becoming data', () => {
    // The reason it is a comment at all. If it parsed as an element, the count would land in
    // whichever record happened to follow it — a phantom field in somebody's vault.
    const declared = `${FIXTURE}${kdbxAttachmentMarker(2)}`;
    const records = keepassXmlParser.parse(declared).records;

    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain(KDBX_ATTACHMENT_MARKER);
  });

  it('reports a value the exporter withheld rather than importing a blank', () => {
    const withheld = FIXTURE.replace(
      '</Root>',
      '<Entry><String><Key>Title</Key><Value>Withheld</Value></String>' +
        '<String><Key>Password</Key><Value Protected="True"/></String></Entry></Root>'
    );
    const result = keepassXmlParser.parse(withheld);
    const record = result.records.find((candidate) => candidate.title === 'Withheld');

    expect(record?.password).toBe('');
    expect(result.warnings.map((warning) => warning.message).join(' ')).toContain(
      'still encrypted'
    );
  });
});

describe('deciding whether a file is this format', () => {
  it('claims its own fixture and no other fixture in the registry', () => {
    expect(keepassXmlParser.detect(FIXTURE)).toBe(true);
    expect(keepassXmlParser.detect(loadFixture('keepass.csv'))).toBe(false);
    expect(keepassXmlParser.detect(loadFixture('bitwarden.json'))).toBe(false);
  });

  it('refuses a document that is XML but not a KeePass export', () => {
    // The one sanctioned throw. Returning zero records here would leave the wizard saying
    // "0 credentials found", which reads as an empty database rather than as the wrong
    // format having been picked.
    expect(() => keepassXmlParser.parse('<html><body>not a vault</body></html>')).toThrow(
      VaultError
    );
  });
});
