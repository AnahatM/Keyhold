// SPDX-License-Identifier: GPL-3.0-or-later
import { ZIP_METHOD_STORED } from '../zip-reader.js';
import { buildZip } from './zip-writer.js';

/**
 * The `.1pux` fixture, as code rather than as a committed blob nobody can read.
 *
 * Every other import fixture is a text file: a reviewer opens `bitwarden.json`, reads it, and
 * can say whether the parser's assertions match what a real export looks like. A `.1pux` is a
 * ZIP archive, so committing one alone would put a binary in the repository that no diff can
 * show and no reviewer can check — and it would be the fixture for the format with the most
 * attack surface, since a ZIP reader parses a hostile file.
 *
 * So the *contents* live here, in the open, and `onepassword-1pux-fixture.test.ts` writes the
 * archive from them — regenerating it when it is missing and failing when it has drifted.
 * That makes the committed blob an artefact of something reviewable rather than a fact nobody
 * can check.
 *
 * **Stored, never deflated.** 1Password writes deflated entries and the reader handles both,
 * but deflate output is not byte-stable across zlib versions — a fixture that changed when
 * Node changed would fail the round-trip guard for a reason that has nothing to do with
 * Keyhold. Stored entries are exactly reproducible, and the deflate path is covered by the
 * archives `zip-reader.test.ts` builds in memory.
 */

/** Invented, like every fixture here. No value in this file is a real credential. */
export const ONEPASSWORD_EXPORT_DATA = {
  accounts: [
    {
      attrs: { accountName: 'Example', name: 'Example Person', avatar: '', email: '' },
      vaults: [
        {
          attrs: { uuid: 'vault-personal', desc: '', avatar: '', name: 'Personal', type: 'P' },
          items: [
            {
              uuid: 'item-login',
              favIndex: 1,
              createdAt: 1_700_000_000,
              updatedAt: 1_700_000_100,
              state: 'active',
              categoryUuid: '001',
              details: {
                loginFields: [
                  { value: 'someone@example.com', name: 'username', designation: 'username' },
                  {
                    value: 'correct-horse-battery-staple',
                    name: 'password',
                    designation: 'password',
                  },
                ],
                notesPlain: 'The recovery kit is in the safe, not the drawer',
                sections: [
                  {
                    title: 'Security',
                    fields: [
                      {
                        title: 'One-time password',
                        id: 'totp',
                        value: { totp: 'otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP' },
                      },
                      {
                        title: 'What was your first pet called?',
                        id: 'q1',
                        value: { concealed: 'a-name-that-must-not-be-projected' },
                      },
                    ],
                  },
                ],
              },
              overview: {
                subtitle: 'someone@example.com',
                title: 'Example Mail',
                url: 'https://mail.example.com',
                urls: [{ label: 'website', url: 'https://mail.example.com' }],
                tags: ['work'],
              },
            },
            {
              uuid: 'item-card',
              favIndex: 0,
              createdAt: 1_700_000_200,
              updatedAt: 1_700_000_200,
              state: 'active',
              categoryUuid: '002',
              details: {
                loginFields: [],
                notesPlain: '',
                sections: [
                  {
                    title: '',
                    fields: [
                      {
                        title: 'number',
                        id: 'ccnum',
                        value: { creditCardNumber: '4111111111111111' },
                      },
                      { title: 'expiry date', id: 'expiry', value: { monthYear: 203005 } },
                      { title: 'verification number', id: 'cvv', value: { concealed: '123' } },
                    ],
                  },
                ],
              },
              overview: { subtitle: '', title: 'Example Card', url: '', urls: [], tags: [] },
            },
            {
              uuid: 'item-trashed',
              favIndex: 0,
              createdAt: 1_700_000_300,
              updatedAt: 1_700_000_300,
              // Trashed on purpose: the parser must leave it in the trash, and a fixture with
              // nothing to skip would let a broken skip pass.
              state: 'trashed',
              categoryUuid: '001',
              details: { loginFields: [], notesPlain: '', sections: [] },
              overview: { subtitle: '', title: 'Deleted Login', url: '', urls: [], tags: [] },
            },
          ],
        },
      ],
    },
  ],
};

/** The archive, byte for byte. */
export function buildOnePassword1pux(): Uint8Array {
  return buildZip([
    {
      name: 'export.data',
      data: JSON.stringify(ONEPASSWORD_EXPORT_DATA, null, 2),
      method: ZIP_METHOD_STORED,
    },
    // An attachment entry, because the parser counts these from the archive rather than from
    // the JSON — the two can disagree, and the warning about attachments not being imported
    // is only reachable when one is actually present.
    {
      name: 'files/example-attachment.txt',
      data: 'not a real attachment',
      method: ZIP_METHOD_STORED,
    },
  ]);
}
