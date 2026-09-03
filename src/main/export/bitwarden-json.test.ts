// SPDX-License-Identifier: GPL-3.0-or-later
import type { Credential } from '@shared/model/credential.js';
import { PLAINTEXT_EXPORT_WARNING } from '@shared/model/export.js';
import { describe, expect, it } from 'vitest';
import { bitwardenJsonParser } from '../import/bitwarden-json.js';
import {
  BITWARDEN_JSON_EXPORT_ID,
  exportBitwardenJson,
  serialiseBitwardenJson,
} from './bitwarden-json.js';
import { bareRecord, buildDocument, NOW, richRecord } from './test-fixtures.js';

/**
 * The leaving-for-Bitwarden format's tests.
 *
 * The important ones are in the first block: **a document written by this exporter and read
 * back by the real `bitwardenJsonParser` must still hold the records**. Both sides of that
 * round trip are this project's, so it is the only assertion that fails when either drifts —
 * a test that checked the JSON against a hand-written expectation would keep passing while the
 * parser stopped understanding what the writer produced.
 *
 * The rest exists to hold the parts a round trip cannot see: the Bitwarden-specific shape
 * another product's importer needs, the determinism, and — the one that matters most — the
 * loss list, because a loss that is not reported is a user discovering their history is gone
 * after they have deleted their vault.
 *
 * Fault injections performed against `bitwarden-json.ts`, all reverted:
 *
 *   1. The `login.totp` hoist removed (`totp: null`). 1 failed — the seed then reached neither
 *      the field nor `fields`, since `fieldsOf` still skips it.
 *   2. `bitwardenFieldType` narrowed from `isCustomFieldValueSecret` to `type === 'password'`.
 *      3 failed. The security-critical one: a PIN, a hidden field and every security answer
 *      would have crossed as plain Bitwarden text.
 *   3. The security-question loop deleted from `fieldsOf`. 2 failed.
 *   4. `orNull` made to return the empty string. 1 failed.
 *   5. `deletedDate` made to carry the real `trashedAt`. 1 failed — the opted-in trashed
 *      record was then skipped by the importer, which is the whole reason it is `null`.
 *   6. `encrypted` written as `true`. The suite does not merely fail, it does not collect: the
 *      module-scope parse throws the importer's "encrypted with your Bitwarden account key"
 *      refusal. Loud enough, and the dedicated assertion covers it too.
 *   7. `losses.flush()` removed. 3 failed — every per-record loss vanished from the report
 *      while the file itself stayed correct, which is precisely the silent-loss failure mode.
 *   8. `folderScope`'s whole-vault branch removed. 2 failed — empty folders disappeared.
 *   9. A loss message rewritten to quote the security answer it could not carry. 1 failed —
 *      the marker property test at the end of this file.
 *  10. `loginUsername` made to always return the username. 1 failed — an email-only record
 *      exported with a null username, which is an unusable import.
 *  11. `passwordHistoryOf` switched from `unshift` to `push`. 1 failed.
 *  12. `passwordHistoryOf` made to treat a version with no password as one (`?? ''`). 1 failed.
 *  13. `serialiseFolder` made to write `folder.name` instead of the full path. 3 failed — the
 *      nesting silently flattened to `Mail`.
 *  14. `login.uris` written as bare strings rather than `{ match, uri }`. 1 failed — and only
 *      the shape test, because *our* importer accepts both forms. That is the finding behind
 *      keeping a Bitwarden-shape block at all: a round trip through a parser we also own
 *      cannot see a file that other products would reject.
 */

const DAY = 86_400_000;
const DOCUMENT = buildDocument([richRecord(), bareRecord({ id: 'plain', title: 'Plain' })]);

const textOf = (document = DOCUMENT): string => serialiseBitwardenJson(document);

interface Envelope {
  readonly encrypted: boolean;
  readonly folders: { readonly id: string; readonly name: string }[];
  readonly items: Record<string, unknown>[];
}

const envelopeOf = (text: string): Envelope => JSON.parse(text) as Envelope;

const itemNamed = (text: string, name: string): Record<string, unknown> =>
  envelopeOf(text).items.find((item) => item.name === name) ?? {};

const loginOf = (text: string, name: string): Record<string, unknown> =>
  itemNamed(text, name).login as Record<string, unknown>;

const fieldsOf = (text: string, name: string): { name: string; value: string; type: number }[] =>
  itemNamed(text, name).fields as { name: string; value: string; type: number }[];

// ── The assertion the whole format exists for ────────────────────────────────

describe('the round trip through the real importer', () => {
  const parsed = bitwardenJsonParser.parse(textOf());
  const record = (title: string): (typeof parsed.records)[number] | undefined =>
    parsed.records.find((entry) => entry.title === title);
  const typeOf = (title: string, label: string): string | undefined =>
    record(title)?.custom?.find((field) => field.label === label)?.type;
  const valueOf = (title: string, label: string): string | undefined =>
    record(title)?.custom?.find((field) => field.label === label)?.value;

  it('is a file the importer recognises as Bitwarden JSON', () => {
    // `detect` drives which format the wizard offers. A file our own parser would not
    // volunteer for is one the user has to know to choose by hand.
    expect(bitwardenJsonParser.detect(textOf())).toBe(true);
  });

  it('carries the login itself: title, username, password, every URI, notes, favourite', () => {
    expect(record('Example Mail')?.username).toBe('ada');
    expect(record('Example Mail')?.password).toBe('correct-horse-battery-staple');
    expect(record('Example Mail')?.urls).toEqual([
      'https://example.com/login',
      'https://mail.example.com',
    ]);
    expect(record('Example Mail')?.notes).toBe('Recovery codes:\n1111-2222\n3333-4444');
    expect(record('Example Mail')?.favorite).toBe(true);
  });

  it('hoists the TOTP seed into login.totp, and gets it back as a seed', () => {
    // The difference between two-factor codes working after the move and re-enrolling every
    // account by hand. It leaves as a Bitwarden field and comes back as an `otp-secret`.
    expect(loginOf(textOf(), 'Example Mail').totp).toBe(
      'otpauth://totp/Example:ada?secret=JBSWY3DPEHPK3PXP'
    );
    expect(typeOf('Example Mail', 'One-time password')).toBe('otp-secret');
  });

  it('keeps a secret custom field secret, and leaves a plain one plain', () => {
    // Bitwarden has no `pin`, so the type is coarser on the way back — but "this is secret"
    // survives, which is the half that decides whether the value reaches the renderer.
    expect(typeOf('Example Mail', 'Recovery PIN')).toBe('password');
    expect(typeOf('Example Mail', 'Account number')).toBe('text');
  });

  it('carries security answers as hidden fields, so they arrive secret rather than as text', () => {
    expect(typeOf('Example Mail', 'First pet’s name?')).toBe('password');
    expect(valueOf('Example Mail', 'First pet’s name?')).toBe('Byron');
    expect(typeOf('Example Mail', 'City of birth?')).toBe('password');
  });

  it('carries the email the single username field had no room for', () => {
    expect(valueOf('Example Mail', 'Email')).toBe('ada@example.com');
  });

  it('flattens the folder tree into path names, and gets the tree back', () => {
    // `Archive` is in the file (see the folder-shape test below) but not here: Keyhold's
    // importer creates the folders its *records* need, so an empty one does not survive the
    // return leg. Bitwarden's own importer creates every folder in the list, which is why the
    // empty one is still written rather than skipped.
    expect(parsed.folders).toEqual(['Personal', 'Personal/Mail']);
    expect(record('Example Mail')?.folderId).toBe('import-folder:Personal/Mail');
  });

  it('carries tags, expiry and rotation as fields rather than dropping them', () => {
    expect(valueOf('Example Mail', 'Tags')).toBe('work, email');
    expect(valueOf('Example Mail', 'Expires')).toBe(new Date(NOW + 90 * DAY).toISOString());
    expect(valueOf('Example Mail', 'Rotation interval (days)')).toBe('180');
  });

  it('brings a record with nothing in it through intact rather than dropping it', () => {
    expect(record('Plain')).toBeDefined();
    expect(record('Plain')?.custom).toEqual([]);
  });
});

// ── The shape another product's importer needs ───────────────────────────────

describe('the file is shaped like Bitwarden’s own', () => {
  it('declares itself unencrypted, which is what makes it readable at all', () => {
    // Both Bitwarden's importer and ours read this key first and refuse the file if it is
    // true. Omitting it also costs `detect` one of the two markers it looks for.
    expect(envelopeOf(textOf()).encrypted).toBe(false);
    expect(Object.keys(envelopeOf(textOf()))).toEqual(['encrypted', 'folders', 'items']);
  });

  it('writes every item key in Bitwarden’s own order', () => {
    expect(Object.keys(itemNamed(textOf(), 'Plain'))).toEqual([
      'passwordHistory',
      'revisionDate',
      'creationDate',
      'deletedDate',
      'id',
      'organizationId',
      'folderId',
      'type',
      'reprompt',
      'name',
      'notes',
      'favorite',
      'fields',
      'login',
      'collectionIds',
    ]);
  });

  it('writes an absent value as null, the way Bitwarden does, not as an empty string', () => {
    const item = itemNamed(textOf(), 'Plain');
    expect(item.notes).toBeNull();
    expect(item.passwordHistory).toBeNull();
    expect(item.fields).toEqual([]);
    expect(loginOf(textOf(), 'Plain')).toEqual({
      fido2Credentials: [],
      uris: [],
      username: null,
      password: null,
      totp: null,
    });
  });

  it('writes a login item with the URI shape Bitwarden reads', () => {
    expect(loginOf(textOf(), 'Example Mail').uris).toEqual([
      { match: null, uri: 'https://example.com/login' },
      { match: null, uri: 'https://mail.example.com' },
    ]);
    expect(itemNamed(textOf(), 'Example Mail').type).toBe(1);
    expect(itemNamed(textOf(), 'Example Mail').reprompt).toBe(0);
  });

  it('marks a hidden field hidden and a boolean boolean, and everything else text', () => {
    const typed = Object.fromEntries(
      fieldsOf(textOf(), 'Example Mail').map((entry) => [entry.name, entry.type])
    );
    expect(typed['Recovery PIN']).toBe(1);
    expect(typed['First pet’s name?']).toBe(1);
    expect(typed['Account number']).toBe(0);
    expect(typed.Tags).toBe(0);
  });

  it('writes a boolean custom field as a Bitwarden boolean only when its value is one', () => {
    const truthy = withCustom(bareRecord({ id: 'b1', title: 'Bool' }), {
      id: 'cf-b',
      label: 'Two-factor enabled',
      type: 'boolean',
      value: 'true',
      hidden: false,
      order: 0,
    });
    const nonsense = withCustom(bareRecord({ id: 'b2', title: 'Maybe' }), {
      id: 'cf-m',
      label: 'Two-factor enabled',
      type: 'boolean',
      value: 'maybe',
      hidden: false,
      order: 0,
    });
    const text = textOf(buildDocument([truthy, nonsense]));

    expect(fieldsOf(text, 'Bool')[0]?.type).toBe(2);
    expect(fieldsOf(text, 'Maybe')[0]?.type).toBe(0);
  });

  it('hides a field the user hid by hand, whatever its type says', () => {
    const record = withCustom(bareRecord({ id: 'h1', title: 'Hidden' }), {
      id: 'cf-h',
      label: 'Nickname',
      type: 'text',
      value: 'Ada',
      hidden: true,
      order: 0,
    });
    expect(fieldsOf(textOf(buildDocument([record])), 'Hidden')[0]?.type).toBe(1);
  });

  it('writes folders as flat, slash-joined paths with no ancestor entries of their own', () => {
    expect(envelopeOf(textOf()).folders).toEqual([
      { id: 'folder-root', name: 'Personal' },
      { id: 'folder-child', name: 'Personal/Mail' },
      { id: 'folder-empty', name: 'Archive' },
    ]);
  });

  it('writes the old passwords as Bitwarden password history, newest first', () => {
    // The one part of the timeline this format can hold. The importer drops it again on the
    // way back in, so it is asserted on the file rather than on a parsed record.
    //
    // Three versions, two of which changed the password: enough for the *order* to be
    // observable, and enough to catch a writer that treated every version as a password
    // change. A single-entry fixture would have made both bugs invisible.
    const base = richRecord({ id: 'rot', title: 'Rotated' });
    const rotated: Credential = {
      ...base,
      history: {
        ...base.history,
        versions: [
          {
            versionNumber: 1,
            savedAt: NOW - 300 * DAY,
            changedFields: ['password'],
            snapshot: { password: 'oldest' },
            origin: { action: 'update' },
          },
          {
            versionNumber: 2,
            savedAt: NOW - 100 * DAY,
            changedFields: ['title'],
            snapshot: { title: 'Older name' },
            origin: { action: 'update' },
          },
          {
            versionNumber: 3,
            savedAt: NOW - 20 * DAY,
            changedFields: ['password'],
            snapshot: { password: 'newer' },
            origin: { action: 'update' },
          },
        ],
      },
    };

    expect(itemNamed(textOf(buildDocument([rotated])), 'Rotated').passwordHistory).toEqual([
      { lastUsedDate: new Date(NOW - 20 * DAY).toISOString(), password: 'newer' },
      { lastUsedDate: new Date(NOW - 300 * DAY).toISOString(), password: 'oldest' },
    ]);
  });

  it('puts the email in login.username when there is no username, so the import is usable', () => {
    // A record with only an email would otherwise export with an empty username field, which
    // is an import the user has to repair by hand on every row.
    const emailOnly = bareRecord({ id: 'e1', title: 'Email only', email: 'ada@example.com' });
    const text = textOf(buildDocument([emailOnly]));

    expect(loginOf(text, 'Email only').username).toBe('ada@example.com');
    // And it is not also duplicated into a redundant "Email" custom field.
    expect(fieldsOf(text, 'Email only')).toEqual([]);
  });
});

// ── Determinism ──────────────────────────────────────────────────────────────

describe('determinism', () => {
  it('serialises the same document to identical bytes', () => {
    const first = exportBitwardenJson(DOCUMENT);
    const second = exportBitwardenJson(DOCUMENT);
    expect(Buffer.from(first.secretBytes).equals(Buffer.from(second.secretBytes))).toBe(true);
  });

  it('indents by default, and does not when asked not to', () => {
    expect(textOf()).toContain('\n');
    expect(serialiseBitwardenJson(DOCUMENT, { pretty: false })).not.toContain('\n');
  });
});

// ── Trashed records ──────────────────────────────────────────────────────────

describe('trashed records', () => {
  const document = buildDocument([
    bareRecord({ id: 'live', title: 'Live' }),
    bareRecord({ id: 'binned', title: 'Binned', trashedAt: NOW - 5 }),
  ]);

  it('leaves them out by default, and says so', () => {
    const result = exportBitwardenJson(document);
    const names = envelopeOf(Buffer.from(result.secretBytes).toString('utf8')).items.map(
      (item) => item.name
    );

    expect(names).toEqual(['Live']);
    expect(result.recordCount).toBe(1);
    expect(result.losses.find((loss) => loss.field === 'trashed records')?.kind).toBe('excluded');
  });

  it('writes an opted-in trashed record as an ordinary item, so it actually arrives', () => {
    // `deletedDate` would be the faithful field and the wrong one: every importer that reads
    // it, ours included, skips the item — so an explicit "include trashed" would import
    // nothing. The record arrives un-deleted instead, and the loss list says so.
    const text = serialiseBitwardenJson(document, { includeTrashed: true });
    expect(itemNamed(text, 'Binned').deletedDate).toBeNull();
    expect(bitwardenJsonParser.parse(text).records.map((entry) => entry.title)).toEqual([
      'Live',
      'Binned',
    ]);

    const loss = exportBitwardenJson(document, { includeTrashed: true }).losses.find(
      (entry) => entry.field === 'trash state'
    );
    expect(loss?.kind).toBe('dropped');
    expect(loss?.records).toBe(1);
  });
});

// ── The warning ──────────────────────────────────────────────────────────────

describe('the warning', () => {
  it('comes back with the bytes, so a caller cannot take one without the other', () => {
    const result = exportBitwardenJson(DOCUMENT);
    expect(result.containsSecrets).toBe(true);
    expect(result.warning).toBe(PLAINTEXT_EXPORT_WARNING);
    expect(result.format).toBe(BITWARDEN_JSON_EXPORT_ID);
    expect(result.extension).toBe('.json');
  });
});

// ── What it admits to losing ─────────────────────────────────────────────────

describe('what it reports as lost', () => {
  const losses = exportBitwardenJson(DOCUMENT).losses;
  const loss = (field: string): (typeof losses)[number] | undefined =>
    losses.find((entry) => entry.field === field);

  it('names everything the format cannot hold at all', () => {
    expect(loss('attachments')?.kind).toBe('dropped');
    expect(loss('attachments')?.records).toBe(1);
    expect(loss('history')?.kind).toBe('dropped');
    expect(loss('icon')?.kind).toBe('dropped');
    expect(loss('record identity')?.kind).toBe('dropped');
    expect(loss('dates')?.kind).toBe('dropped');
    expect(loss('vault settings')?.kind).toBe('dropped');
    expect(loss('tag colours')?.kind).toBe('dropped');
  });

  it('names everything that survives only as a custom field, as flattened rather than lost', () => {
    // `flattened` and `dropped` are not interchangeable: one says "it is in the file, in the
    // wrong shape", the other says "it is not in the file". Collapsing them would turn a
    // reported loss of shape into an unreported loss of data.
    expect(loss('custom field type')?.kind).toBe('flattened');
    expect(loss('email')?.kind).toBe('flattened');
    expect(loss('security questions')?.kind).toBe('flattened');
    expect(loss('tags')?.kind).toBe('flattened');
    expect(loss('expiry')?.kind).toBe('flattened');
  });

  it('does not invent per-record losses for a record that has none of those things', () => {
    const plain = exportBitwardenJson(buildDocument([bareRecord()]));
    const fields = plain.losses.map((entry) => entry.field);

    expect(fields).not.toContain('attachments');
    expect(fields).not.toContain('history');
    expect(fields).not.toContain('security questions');
    expect(fields).not.toContain('tags');
    expect(fields).not.toContain('email');
    // The vault-level ones are still true of any export, and are still reported.
    expect(fields).toContain('vault settings');
  });
});

// ── A subset export ──────────────────────────────────────────────────────────

describe('a subset export', () => {
  it('carries only the folders its records point at, and reports the rest as left out', () => {
    const result = exportBitwardenJson(DOCUMENT, { recordIds: ['rec-1'] });
    const text = Buffer.from(result.secretBytes).toString('utf8');

    expect(envelopeOf(text).folders).toEqual([{ id: 'folder-child', name: 'Personal/Mail' }]);
    expect(result.losses.some((loss) => loss.field === 'folders')).toBe(true);
  });

  it('keeps every folder on a whole-vault export, empty ones included', () => {
    expect(envelopeOf(textOf()).folders).toHaveLength(3);
    expect(exportBitwardenJson(DOCUMENT).losses.some((loss) => loss.field === 'folders')).toBe(
      false
    );
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
      tags: [`${MARKER}-tag`],
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

  it('holds with a marker planted in every secret the record has', () => {
    const exported = exportBitwardenJson(buildDocument([markedRecord()]));

    // The export itself must carry the values — otherwise this passes for the wrong reason,
    // which is how a no-secrets assertion quietly stops asserting anything.
    expect(Buffer.from(exported.secretBytes).toString('utf8')).toContain(`${MARKER}-password`);
    expect(JSON.stringify(exported.losses)).not.toContain(MARKER);
  });
});

/** A record with exactly one custom field, for the type-mapping cases. */
function withCustom(
  record: Credential,
  custom: Credential['fields']['custom'][number]
): Credential {
  return { ...record, fields: { ...record.fields, custom: [custom] } };
}
