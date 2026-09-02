// SPDX-License-Identifier: GPL-3.0-or-later
import { headerMatchesAny, readHeaderKeys } from './csv.js';
import { mapCsv, type CsvMappingSpec } from './csv-mapper.js';
import type { ImportParser, ImportResult } from './types.js';

/**
 * Safari's password export — **and the macOS/iOS Passwords app's**, which is the same
 * exporter behind a different front door.
 *
 * Header: `Title,URL,Username,Password,Notes,OTPAuth`
 * Older Safari builds stop at `Notes`; both are accepted.
 *
 * `OTPAuth` holds a full `otpauth://totp/...` URI rather than a bare seed. It is stored
 * verbatim in an `otp-secret` custom field: the URI carries the issuer, the account, the
 * digit count and the period, and reducing it to the seed would throw away everything a TOTP
 * generator needs to reproduce Apple's codes.
 */

const HEADER_VARIANTS = [
  ['title', 'url', 'username', 'password', 'notes', 'otpauth'],
  ['title', 'url', 'username', 'password', 'notes'],
];

const SPEC: CsvMappingSpec = {
  targets: {
    title: 'title',
    url: 'url',
    username: 'username',
    password: 'password',
    notes: 'notes',
    otpauth: 'totp',
  },
};

export const safariCsvParser: ImportParser = {
  id: 'safari-csv',
  name: 'Safari or Apple Passwords (CSV)',
  extensions: ['.csv'],
  description: 'The CSV exported by Safari and by the Apple Passwords app.',
  needsMapping: false,

  detect(content: string): boolean {
    // Exact-set: 1Password's export is a superset of these columns and would otherwise match.
    return headerMatchesAny(readHeaderKeys(content), HEADER_VARIANTS);
  },

  parse(content: string): ImportResult {
    return mapCsv(content, SPEC);
  },
};
