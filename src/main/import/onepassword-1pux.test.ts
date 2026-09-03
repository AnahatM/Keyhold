// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VaultError } from '../crypto/errors.js';
import { buildZip, type ZipFileSpec } from './fixtures/zip-writer.js';
import { onePassword1puxParser, parseOnePassword1pux } from './onepassword-1pux.js';
import { ZIP_METHOD_STORED } from './zip-reader.js';

/**
 * The 1PUX parser.
 *
 * The archive fixtures are built here rather than committed, for the reason
 * `fixtures/zip-writer.ts` sets out: a committed `.1pux` is a binary blob nobody reviewing a
 * diff can read, and one of the fixtures below is deliberately malformed. Built in the test,
 * every byte of every fixture is visible beside the assertion that uses it.
 *
 * **Every value here is invented.** `example.com`, `correct-horse-battery-staple` and
 * `4111111111111111` — the standard Visa test number — follow the same convention as the
 * fixtures in `tests/fixtures/import/`.
 */

// ── The fixture ──────────────────────────────────────────────────────────────

const LOGIN_ITEM = {
  uuid: 'item-login',
  favIndex: 1,
  createdAt: 1614298956,
  updatedAt: 1614298956,
  trashed: false,
  categoryUuid: '001',
  details: {
    loginFields: [
      {
        value: 'ada@example.com',
        id: '',
        name: 'username',
        fieldType: 'E',
        designation: 'username',
      },
      {
        value: 'correct-horse-battery-staple',
        id: '',
        name: 'password',
        fieldType: 'P',
        designation: 'password',
      },
      { value: 'workspace-7781', id: 'tenant', name: 'tenant', fieldType: 'T', designation: '' },
      { value: '', id: 'blank', name: 'blank', fieldType: 'T', designation: '' },
    ],
    notesPlain: 'Recovery kit is in the safe, not the drawer',
    sections: [
      {
        title: 'Security',
        name: 'Section_security',
        fields: [
          {
            id: 'q1',
            title: 'What was your first pet called?',
            value: { concealed: 'Ada-the-hamster' },
          },
          {
            id: 'otp',
            title: 'One-time password',
            value: { totp: 'otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP' },
          },
          { id: 'ref', title: 'Related item', value: { reference: 'item-elsewhere' } },
        ],
      },
    ],
    passwordHistory: [{ value: 'hunter2', time: 1614298000 }],
  },
  overview: {
    title: 'Example Mail',
    url: 'https://mail.example.com',
    urls: [
      { label: 'website', url: 'https://mail.example.com' },
      { label: 'admin', url: 'https://admin.example.com' },
    ],
    tags: ['personal', 'email'],
  },
};

const CARD_ITEM = {
  uuid: 'item-card',
  favIndex: 0,
  trashed: false,
  categoryUuid: '002',
  details: {
    loginFields: [],
    notesPlain: '',
    sections: [
      {
        title: '',
        name: 'Section_card',
        fields: [
          { id: 'ccnum', title: 'number', value: { creditCardNumber: '4111111111111111' } },
          { id: 'cvv', title: 'verification number', value: { concealed: '4471' } },
          { id: 'expiry', title: 'expiry date', value: { monthYear: 202601 } },
          { id: 'type', title: 'type', value: { creditCardType: 'visa' } },
          {
            id: 'addr',
            title: 'billing address',
            value: {
              address: {
                street: '12 Rowan Avenue',
                city: 'Springfield',
                state: 'IL',
                zip: '62704',
                country: 'us',
              },
            },
          },
          { id: 'issued', title: 'issued on', value: { date: 1609459200 } },
          { id: 'contact', title: 'support address', value: { email: 'cards@example.com' } },
          { id: 'novel', title: 'quantum field', value: { quantumThing: 'invented value here' } },
        ],
      },
    ],
  },
  overview: { title: 'Example Card', tags: [] },
};

const DOCUMENT_ITEM = {
  uuid: 'item-doc',
  categoryUuid: '006',
  trashed: false,
  details: {
    documentAttributes: {
      fileName: 'renewal-paperwork.pdf',
      documentId: 'doc-1',
      decryptedSize: 12345,
    },
    notesPlain: '',
  },
  overview: { title: 'Renewal paperwork', tags: [] },
};

const TRASHED_ITEM = {
  uuid: 'item-trashed',
  trashed: true,
  categoryUuid: '001',
  details: { loginFields: [{ value: 'gone', designation: 'password', fieldType: 'P' }] },
  overview: { title: 'Cancelled account' },
};

const ARCHIVED_ITEM = {
  uuid: 'item-archived',
  state: 'archived',
  categoryUuid: '001',
  details: { loginFields: [{ value: 'stale', designation: 'password', fieldType: 'P' }] },
  overview: { title: 'Old subscription' },
};

function exportData(): Record<string, unknown> {
  return {
    accounts: [
      {
        attrs: { accountName: 'ada', name: 'Ada Lovelace', email: 'ada@example.com', uuid: 'acct' },
        vaults: [
          {
            attrs: { uuid: 'vault-personal', name: 'Personal', type: 'P' },
            items: [
              { item: LOGIN_ITEM },
              { item: CARD_ITEM },
              { item: TRASHED_ITEM },
              { item: ARCHIVED_ITEM },
            ],
          },
          {
            // A vault name containing a separator, which becomes a nested folder path.
            attrs: { uuid: 'vault-work', name: 'Shared/Work', type: 'E' },
            items: [{ item: DOCUMENT_ITEM }],
          },
        ],
      },
    ],
  };
}

/**
 * The fixture with every survivable defect in it at once.
 *
 * Not a separate scenario — the same export, damaged, so that the warnings a *damaged* file
 * produces are covered by the same properties the good one is. Every warning path this parser
 * has is reachable from one of the two.
 */
function damagedExportData(): Record<string, unknown> {
  const data = exportData();
  const accounts = data.accounts as Record<string, unknown>[];
  const vaults = accounts[0]?.vaults as Record<string, unknown>[];
  const items = vaults[0]?.items as unknown[];
  items.unshift('a placeholder string that is not an item at all');
  items.push({ item: { categoryUuid: '001', details: {}, overview: {} } });
  return data;
}

/** A `.1pux` archive: the JSON entry, the manifest, and whatever attachments are asked for. */
function build1pux(data: unknown, attachments: readonly string[] = []): Uint8Array {
  const files: ZipFileSpec[] = [
    { name: 'export.data', data: JSON.stringify(data) },
    { name: 'export.attributes', data: JSON.stringify({ version: 3, description: 'invented' }) },
  ];
  if (attachments.length > 0) {
    files.push({ name: 'files/', data: '', method: ZIP_METHOD_STORED });
    for (const name of attachments) files.push({ name: `files/${name}`, data: 'invented bytes' });
  }
  return buildZip(files);
}

const ATTACHMENTS = ['doc-1__renewal-paperwork.pdf'];
const result = parseOnePassword1pux(build1pux(exportData(), ATTACHMENTS));
const byTitle = (title: string) => result.records.find((record) => record.title === title);

// ── The happy path ───────────────────────────────────────────────────────────

describe('a 1PUX login item', () => {
  it('maps the designated login fields', () => {
    const mail = byTitle('Example Mail');
    expect(mail?.username).toBe('ada@example.com');
    expect(mail?.password).toBe('correct-horse-battery-staple');
    // `finishDraft` mirrors an email-shaped username into `email`; that rule lives in one place.
    expect(mail?.email).toBe('ada@example.com');
  });

  it('keeps every URL from the overview, de-duplicated', () => {
    expect(byTitle('Example Mail')?.urls).toEqual([
      'https://mail.example.com',
      'https://admin.example.com',
    ]);
  });

  it('keeps the tags, the favourite flag and the note', () => {
    const mail = byTitle('Example Mail');
    expect(mail?.tags).toEqual(['personal', 'email']);
    expect(mail?.favorite).toBe(true);
    expect(mail?.notes).toBe('Recovery kit is in the safe, not the drawer');
    expect(byTitle('Example Card')?.favorite).toBe(false);
  });

  it('files each item under its 1Password vault, ancestors included', () => {
    expect(byTitle('Example Mail')?.folderId).toBe('import-folder:Personal');
    expect(byTitle('Renewal paperwork')?.folderId).toBe('import-folder:Shared/Work');
    expect(result.folders).toEqual(['Personal', 'Shared', 'Shared/Work']);
  });

  it('carries an undesignated form field rather than dropping it', () => {
    const tenant = byTitle('Example Mail')?.custom?.find((field) => field.label === 'tenant');
    expect(tenant?.value).toBe('workspace-7781');
    expect(tenant?.type).toBe('text');
  });

  it('skips a form field with no value', () => {
    expect(byTitle('Example Mail')?.custom?.map((field) => field.label)).not.toContain('blank');
  });

  it('prefixes a section field with its section title', () => {
    const labels = byTitle('Example Mail')?.custom?.map((field) => field.label) ?? [];
    expect(labels).toContain('Security: One-time password');
  });
});

describe('the concealed/plain distinction — the reason this parser exists', () => {
  it('types a concealed value as a secret whatever its label says', () => {
    // The load-bearing assertion in this file. A security question's answer is `concealed`
    // under a label no heuristic would ever call sensitive; `guessCustomFieldType` would call
    // this one `text`, which puts the answer in the safe projection (decision D13). The type
    // comes from the JSON key instead, exactly as `bitwarden-json.ts` trusts `FIELD_HIDDEN`.
    const answer = byTitle('Example Mail')?.custom?.find((field) =>
      field.label.includes('first pet')
    );
    expect(answer?.value).toBe('Ada-the-hamster');
    expect(answer?.type).toBe('password');
  });

  it('types a TOTP value as an OTP seed', () => {
    const otp = byTitle('Example Mail')?.custom?.find((field) => field.label.endsWith('password'));
    expect(otp?.type).toBe('otp-secret');
  });

  it('types a card number as a secret, not as a number', () => {
    // Same reasoning as `bitwarden-json.ts`'s `CARD_TYPES`: a card number is exactly as
    // sensitive as a password, and the model has no card type, so the closest secret one wins.
    const number = byTitle('Example Card')?.custom?.find((field) => field.label === 'number');
    expect(number?.value).toBe('4111111111111111');
    expect(number?.type).toBe('password');
  });

  it('types a short concealed value as a secret even where the label suggests a number', () => {
    const cvv = byTitle('Example Card')?.custom?.find((field) =>
      field.label.includes('verification')
    );
    expect(cvv?.type).toBe('password');
  });
});

describe('typed section values', () => {
  const card = () => byTitle('Example Card')?.custom ?? [];
  const valueOf = (label: string) => card().find((field) => field.label === label)?.value;
  const typeOf = (label: string) => card().find((field) => field.label === label)?.type;

  it('renders a Unix-seconds date as a plain ISO date', () => {
    expect(valueOf('issued on')).toBe('2021-01-01');
    expect(typeOf('issued on')).toBe('date');
  });

  it('renders a YYYYMM expiry as a year and month', () => {
    expect(valueOf('expiry date')).toBe('2026-01');
    expect(typeOf('expiry date')).toBe('date');
  });

  it('flattens a structured address in a readable order', () => {
    expect(valueOf('billing address')).toBe('12 Rowan Avenue, Springfield, IL, 62704, us');
    expect(typeOf('billing address')).toBe('address');
  });

  it('reads a plain email value', () => {
    expect(valueOf('support address')).toBe('cards@example.com');
    expect(typeOf('support address')).toBe('email');
  });

  it('reads the object form of an email value newer exports use', () => {
    const archive = build1pux(
      singleItem({
        categoryUuid: '111',
        details: {
          sections: [
            {
              title: '',
              fields: [
                {
                  id: 'e',
                  title: 'address',
                  value: { email: { email_address: 'bob@example.com', provider: 'example' } },
                },
              ],
            },
          ],
        },
        overview: { title: 'Example Email Account' },
      })
    );
    const field = parseOnePassword1pux(archive).records[0]?.custom?.[0];
    expect(field?.value).toBe('bob@example.com');
    expect(field?.type).toBe('email');
  });

  it('reads an SSH private key as a secret', () => {
    const archive = build1pux(
      singleItem({
        categoryUuid: '114',
        details: {
          sections: [
            {
              title: '',
              fields: [
                {
                  id: 'k',
                  title: 'private key',
                  value: { sshKey: { privateKey: 'INVENTED-KEY-MATERIAL', metadata: {} } },
                },
              ],
            },
          ],
        },
        overview: { title: 'Example SSH Key' },
      })
    );
    const field = parseOnePassword1pux(archive).records[0]?.custom?.[0];
    expect(field?.value).toBe('INVENTED-KEY-MATERIAL');
    expect(field?.type).toBe('password');
  });

  it('keeps a value whose kind this parser has never heard of', () => {
    // A schema change must not delete data. The value arrives as text and the *kind* — never
    // the value — is named in a warning, so the next release knows what to add.
    expect(valueOf('quantum field')).toBe('invented value here');
    const formats = result.warnings.filter((warning) => warning.kind === 'format');
    expect(formats.some((warning) => warning.message.includes('quantumThing'))).toBe(true);
  });
});

// ── What is reported rather than silently lost ───────────────────────────────

describe('what did not come across is named', () => {
  const messagesOfKind = (kind: string) =>
    result.warnings.filter((warning) => warning.kind === kind).map((warning) => warning.message);

  it('leaves trashed and archived items out, and says how many', () => {
    expect(result.records.map((record) => record.title)).toEqual([
      'Example Mail',
      'Example Card',
      'Renewal paperwork',
    ]);
    expect(messagesOfKind('skipped-row').join(' ')).toContain('1 item(s) are in 1Password’s Trash');
    expect(messagesOfKind('skipped-row').join(' ')).toContain('1 item(s) are archived');
  });

  it('names the non-login category rather than the item', () => {
    const unsupported = messagesOfKind('unsupported-item');
    expect(unsupported.some((message) => message.includes('1 Credit Card item(s)'))).toBe(true);
    expect(unsupported.some((message) => message.includes('1 Document item(s)'))).toBe(true);
  });

  it('warns about attachments it cannot carry, counting what is in the archive', () => {
    const dropped = messagesOfKind('dropped-value').join(' ');
    expect(dropped).toContain('1 attached file(s)');
    expect(dropped).toContain('keep the .1pux');
  });

  it('keeps the attached file’s name on the record, so it can be re-attached', () => {
    const note = byTitle('Renewal paperwork')?.custom?.[0];
    expect(note?.label).toBe('Attached file (not imported)');
    expect(note?.value).toBe('renewal-paperwork.pdf');
  });

  it('warns about a field that only links to another item', () => {
    expect(messagesOfKind('dropped-value').join(' ')).toContain(
      '1 field(s) link to another 1Password item'
    );
  });

  it('warns that password history does not travel', () => {
    expect(messagesOfKind('dropped-value').join(' ')).toContain(
      '1 item(s) carry a 1Password password history'
    );
  });

  it('never puts a field value in a warning message', () => {
    /**
     * The same property `parser-contract.test.ts` asserts over every registered parser, applied
     * here because this parser is not in the registry yet. Warnings are shown on screen,
     * written into the import report and pasted into bug reports; a message quoting the value
     * it could not carry would put a password in all three.
     *
     * **Run over the damaged export as well as the good one.** The first version checked only
     * the good fixture, and a fault injection that echoed the offending item into the "not an
     * object" warning sailed straight past — because that warning is only ever produced by a
     * *different* fixture, which the property never looked at. `parser-contract.test.ts` makes
     * the same point about its own damaged variants; this is the 1PUX-shaped version of it.
     */
    const interesting = (source: unknown): string[] =>
      jsonStringLeaves(source).filter(
        (value) => value.trim().length >= 8 && !SCHEMA_VOCABULARY.has(value.trim())
      );

    const damaged = damagedExportData();
    const values = [...new Set([...interesting(exportData()), ...interesting(damaged)])];
    expect(values.length, 'the fixture has no values worth checking').toBeGreaterThan(8);

    const parsed = [result, parseOnePassword1pux(build1pux(damaged, ATTACHMENTS))];
    for (const source of parsed) {
      for (const warning of source.warnings) {
        for (const value of values) {
          expect(warning.message, `a warning leaked the value "${value}"`).not.toContain(value);
        }
      }
    }
  });

  it('reports a record that held nothing rather than importing a blank one', () => {
    const archive = build1pux(singleItem({ categoryUuid: '001', details: {}, overview: {} }));
    const parsed = parseOnePassword1pux(archive);
    expect(parsed.records).toEqual([]);
    expect(parsed.warnings.some((warning) => warning.kind === 'skipped-row')).toBe(true);
  });

  it('clips a pathological item at the model’s custom-field ceiling', () => {
    // Without this the record would be built, and then `assertValidCredential` would throw at
    // commit time — failing the *entire* import over one item rather than reducing that item.
    const fields = Array.from({ length: 200 }, (_unused, index) => ({
      id: `f${index}`,
      title: `Field ${index}`,
      value: { string: `value ${index}` },
    }));
    const archive = build1pux(
      singleItem({
        categoryUuid: '001',
        details: { sections: [{ title: '', fields }] },
        overview: { title: 'Example Overloaded' },
      })
    );
    const parsed = parseOnePassword1pux(archive);
    expect(parsed.records[0]?.custom).toHaveLength(128);
    expect(parsed.warnings.map((warning) => warning.message).join(' ')).toContain(
      '72 custom field(s) were past the 128-field limit'
    );
  });
});

// ── Shapes the schema can arrive in ──────────────────────────────────────────

describe('schema shapes', () => {
  it('accepts an item that is not wrapped in an `item` key', () => {
    const archive = build1pux({
      accounts: [
        {
          attrs: { name: 'Ada Lovelace' },
          vaults: [{ attrs: { name: 'Personal' }, items: [LOGIN_ITEM] }],
        },
      ],
    });
    expect(parseOnePassword1pux(archive).records[0]?.title).toBe('Example Mail');
  });

  it('accepts an export with no account wrapper at all', () => {
    const archive = build1pux({
      vaults: [{ attrs: { name: 'Personal' }, items: [{ item: LOGIN_ITEM }] }],
    });
    expect(parseOnePassword1pux(archive).records[0]?.title).toBe('Example Mail');
  });

  it('prefixes the vault with the account only when there is more than one account', () => {
    const twoAccounts = {
      accounts: [
        {
          attrs: { name: 'Ada Lovelace' },
          vaults: [{ attrs: { name: 'Personal' }, items: [{ item: LOGIN_ITEM }] }],
        },
        {
          attrs: { name: 'Grace Hopper' },
          vaults: [{ attrs: { name: 'Personal' }, items: [{ item: CARD_ITEM }] }],
        },
      ],
    };
    const parsed = parseOnePassword1pux(build1pux(twoAccounts));
    expect(parsed.folders).toEqual([
      'Ada Lovelace',
      'Ada Lovelace/Personal',
      'Grace Hopper',
      'Grace Hopper/Personal',
    ]);
  });

  it('skips an item that is not an object, and keeps the rest', () => {
    const archive = build1pux({
      accounts: [
        {
          attrs: { name: 'Ada Lovelace' },
          vaults: [{ attrs: { name: 'Personal' }, items: ['not an item', { item: LOGIN_ITEM }] }],
        },
      ],
    });
    const parsed = parseOnePassword1pux(archive);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.warnings.some((warning) => warning.kind === 'skipped-row')).toBe(true);
  });

  it('reads an export with no accounts without throwing', () => {
    const parsed = parseOnePassword1pux(build1pux({ accounts: [] }));
    expect(parsed.records).toEqual([]);
    expect(parsed.folders).toEqual([]);
    expect(parsed.warnings.some((warning) => warning.kind === 'format')).toBe(true);
  });

  it('derives a title from the URL when the overview has none', () => {
    const archive = build1pux(
      singleItem({
        categoryUuid: '001',
        details: { loginFields: [{ value: 'hunter2', designation: 'password', fieldType: 'P' }] },
        overview: { url: 'https://forum.example.com/login' },
      })
    );
    expect(parseOnePassword1pux(archive).records[0]?.title).toBe('forum.example.com');
  });
});

// ── Refusals ─────────────────────────────────────────────────────────────────

describe('a file that is not a 1PUX export', () => {
  it('is refused when the archive has no export.data', () => {
    const archive = buildZip([{ name: 'word/document.xml', data: '<w:document/>' }]);
    const error = expectVaultError(() => parseOnePassword1pux(archive), 'a .docx');
    expect(error.message).toContain('export.data');
  });

  it('is refused when export.data is not JSON', () => {
    const archive = buildZip([{ name: 'export.data', data: 'title,username\nExample,ada\n' }]);
    expectVaultError(() => parseOnePassword1pux(archive), 'a CSV inside the archive');
  });

  it('is refused when export.data is JSON but not an object', () => {
    const archive = buildZip([{ name: 'export.data', data: '["accounts"]' }]);
    expectVaultError(() => parseOnePassword1pux(archive), 'a JSON array');
  });

  it('is refused when the archive itself is damaged', () => {
    const damaged = build1pux(exportData()).slice(0, 60);
    expectVaultError(() => parseOnePassword1pux(damaged), 'a truncated archive');
  });

  it('does not leak vault content in the refusal it throws', () => {
    const archive = buildZip([{ name: 'export.data', data: '{"accounts": [ broken' }]);
    const error = expectVaultError(() => parseOnePassword1pux(archive), 'broken JSON');
    expect(error.message).not.toContain('broken');
  });
});

// ── The string adapter ───────────────────────────────────────────────────────

describe('the ImportParser adapter', () => {
  const archive = build1pux(exportData(), ATTACHMENTS);

  it('detects a .1pux and nothing else', () => {
    expect(onePassword1puxParser.detect(binaryString(archive))).toBe(true);
    expect(onePassword1puxParser.detect('Title,Url,Username,Password,Archived\n')).toBe(false);
    expect(onePassword1puxParser.detect('{"encrypted":false,"items":[]}')).toBe(false);
    // A ZIP that is not a 1PUX — the signature matches and the marker does not.
    expect(
      onePassword1puxParser.detect(binaryString(buildZip([{ name: 'sheet.xml', data: 'x' }])))
    ).toBe(false);
  });

  it('does not throw from detect, whatever it is handed', () => {
    for (const junk of ['', '\0\0\0', '{', 'not,a,real\nfile', '"unclosed', 'PK']) {
      expect(() => onePassword1puxParser.detect(junk)).not.toThrow();
    }
  });

  it('parses a byte-preserving string identically to the bytes', () => {
    expect(onePassword1puxParser.parse(binaryString(archive)).records).toEqual(
      parseOnePassword1pux(archive).records
    );
  });

  it('says so plainly when the archive arrived as lossily-decoded text', () => {
    // The failure this adapter exists to make legible. `decodeSourceText` in
    // `import-service/source-store.ts` decodes as UTF-8, and a compressed stream is full of
    // sequences UTF-8 has no representation for — every one becomes U+FFFD, irreversibly. The
    // replacement character cannot arise any other way, so it is a reliable signal.
    const mangled = new TextDecoder('utf-8').decode(archive);
    expect(mangled.includes(String.fromCharCode(0xfffd)), 'the premise of this test').toBe(true);

    const error = expectVaultError(() => onePassword1puxParser.parse(mangled), 'mangled text');
    expect(error.message).toContain('raw bytes');
  });

  it('refuses a string that is not an archive at all', () => {
    expectVaultError(() => onePassword1puxParser.parse('title,username\n'), 'a CSV');
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fixture leaves that are 1PUX **vocabulary**, not the user's data.
 *
 * `state: "archived"` is the schema's own word, and a warning saying an item was archived is
 * doing exactly its job — the same exemption `parser-contract.test.ts` grants to column
 * headers. Listed explicitly and kept to three entries so the check stays a property:
 * every title, value, note, tag and URL in the fixture is still asserted against.
 */
const SCHEMA_VOCABULARY: ReadonlySet<string> = new Set(['archived', 'username', 'password']);

function expectVaultError(run: () => unknown, what: string): VaultError {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `${what} did not throw`).toBeInstanceOf(VaultError);
  return thrown as VaultError;
}

/** One item in one vault in one account — the smallest export that parses. */
function singleItem(item: Record<string, unknown>): Record<string, unknown> {
  return {
    accounts: [
      {
        attrs: { name: 'Ada Lovelace' },
        vaults: [{ attrs: { name: 'Personal' }, items: [{ item }] }],
      },
    ],
  };
}

/**
 * The archive as a byte-preserving string.
 *
 * `latin1` maps bytes 0–255 to code points 0–255 one for one, so this round-trips exactly —
 * which is what the string half of `ImportParser` needs and what UTF-8 cannot provide.
 */
function binaryString(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

function jsonStringLeaves(node: unknown, into: string[] = []): string[] {
  if (typeof node === 'string') into.push(node);
  else if (Array.isArray(node)) node.forEach((child) => jsonStringLeaves(child, into));
  else if (typeof node === 'object' && node !== null) {
    Object.values(node).forEach((child) => jsonStringLeaves(child, into));
  }
  return into;
}
