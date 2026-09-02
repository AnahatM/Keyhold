// SPDX-License-Identifier: GPL-3.0-or-later
import { TOTP_DEFAULTS, type TotpParameters } from '@shared/model/totp.js';
import type { SecretBytes } from '../crypto/secret.js';
import { decodeBase32Secret, encodeBase32 } from './base32.js';
import { hotpNotSupported, invalidUri, unsupportedOtpType } from './errors.js';
import {
  assertTotpParameters,
  normaliseAlgorithm,
  normaliseDigits,
  normalisePeriodSeconds,
} from './parameters.js';

/**
 * The `otpauth://` Key Uri Format — reading it, and writing it back.
 *
 * This is the interchange format for one-time passwords: it is what a QR code encodes, what
 * `src/main/import/` already carries into `otp-secret` custom fields from Bitwarden, Safari,
 * 1Password, LastPass, Dashlane and KeePass, and what `src/main/export/generic-csv.ts`
 * hoists back out into a `login_totp` column. So this module is the boundary where a pile of
 * other applications' habits meets a strict engine, and it is written to be liberal in what
 * it reads and exact in what it writes.
 *
 * ## The shape
 *
 *     otpauth://totp/Issuer:account@example.com?secret=JBSW…&issuer=Issuer&algorithm=SHA1&digits=6&period=30
 *              └type┘└──────── label ─────────┘ └──────────────── parameters ────────────────┘
 *
 * ## The variations that actually turn up
 *
 *  - `TOTP` and `totp` — the type is case-insensitive here, though WHATWG only lower-cases
 *    hosts for special schemes, so it is folded by hand.
 *  - No label at all (`otpauth://totp/?secret=…`), which some exporters emit for an account
 *    with no name.
 *  - A label with no issuer prefix — just the account.
 *  - A percent-encoded label (`Big%20Corp%3Aada%40example.com`), and a colon written as
 *    `%3A`, which is the same thing once decoded.
 *  - `Issuer: account` with a space after the colon, which the format explicitly allows.
 *  - `algorithm=SHA-1`, hyphenated the way the hash is named everywhere else.
 *  - Missing `algorithm`, `digits` or `period`, which is the common case and means the
 *    default.
 *  - Parameters we do not know, which are ignored rather than treated as an error: a URI
 *    carrying some other authenticator's extension is still a perfectly good TOTP URI.
 *
 * ## The issuer conflict, and why the query parameter wins
 *
 * The issuer can appear twice — as a prefix on the label and as an `issuer` parameter — and
 * they can disagree. **The query parameter wins.** Three reasons, in order of weight:
 *
 *  1. **It is unambiguous and the label is not.** The label is one string that has to be
 *     split on a colon, and account names contain colons (a SIP address, a namespaced login,
 *     an account name someone simply typed a colon into). Every such label parses with the
 *     wrong issuer. The parameter has its own key and cannot be misread.
 *  2. **The format itself treats the parameter as the authoritative one.** The label prefix
 *     is described as legacy compatibility for readers that predate the parameter; the
 *     parameter is what a conforming reader is told to use.
 *  3. **The parameter is what survives handling.** Label prefixes get rewritten by
 *     applications that re-display and re-export a code — an importer that prepends its own
 *     folder name, an exporter that drops the prefix entirely. The parameter is copied
 *     verbatim far more often.
 *
 * A disagreement is **not** silently discarded, though: the label's issuer comes back as
 * `labelIssuer` with an `issuerMismatch` flag, so the UI can show "this link says Big Corp
 * in one place and BigCorp in another" rather than picking one and pretending. Case and
 * surrounding whitespace are not a mismatch — flagging `GitHub` against `github` would be
 * noise on a real difference of nothing.
 */

const OTPAUTH_SCHEME = /^otpauth:/i;

/**
 * Whether a stored value is a link rather than a bare seed.
 *
 * The scheme test lives here, next to the parser that relies on it, so there is one answer to
 * "is this an otpauth URI" rather than one per caller. `looksLikeOtpUri` in
 * `src/main/import/mapping.ts` predates this module and asks the same question with its own
 * copy of the same regular expression; folding that one into this is noted in the handover
 * rather than done here, because that file belongs to the importers.
 */
export function isOtpauthUri(value: string): boolean {
  return OTPAUTH_SCHEME.test(value.trim());
}

export interface ParsedOtpauth {
  readonly parameters: TotpParameters;
  /** The decoded seed. **The caller owns this and must `destroy()` it.** */
  readonly secret: SecretBytes;
  /** The issuer as written in the label prefix, before the query parameter overrode it. */
  readonly labelIssuer: string | null;
  /** Both issuers were given and they differ by more than case or spacing. */
  readonly issuerMismatch: boolean;
}

/**
 * Reads an `otpauth://totp/...` link.
 *
 * The argument is named `secretUri` because it is one: the seed is in it, so it is subject
 * to every rule a password is. It is never echoed into an error.
 *
 * @throws {TotpError} `INVALID_URI`, `UNSUPPORTED_OTP_TYPE` or `INVALID_PARAMETER`.
 */
export function parseOtpauthUri(secretUri: string): ParsedOtpauth {
  const trimmed = secretUri.trim();
  if (!OTPAUTH_SCHEME.test(trimmed)) throw invalidUri('it does not begin with "otpauth:"');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // The cause is deliberately dropped rather than chained: `URL`'s error message quotes
    // the input, which here is the seed.
    throw invalidUri('it is not a well-formed link');
  }

  // For a non-special scheme the host keeps its case, so fold it here.
  const type = url.hostname.toLowerCase();
  if (type === 'hotp') throw hotpNotSupported();
  if (type !== 'totp') throw unsupportedOtpType();

  const rawSecret = url.searchParams.get('secret');
  if (rawSecret === null || rawSecret.trim() === '') {
    throw invalidUri('it has no "secret" value, so there is no seed to generate codes from');
  }

  const label = readLabel(url.pathname);
  const queryIssuer = emptyToNull(url.searchParams.get('issuer')?.trim() ?? '');

  const parameters: TotpParameters = {
    algorithm: readOptional(url, 'algorithm', normaliseAlgorithm, TOTP_DEFAULTS.algorithm),
    digits: readOptional(url, 'digits', normaliseDigits, TOTP_DEFAULTS.digits),
    periodSeconds: readOptional(url, 'period', normalisePeriodSeconds, TOTP_DEFAULTS.periodSeconds),
    issuer: queryIssuer ?? label.issuer,
    account: label.account,
  };
  assertTotpParameters(parameters);

  return {
    parameters,
    // Decoded last, so a URI that is going to be rejected for a bad parameter never
    // materialises key material at all.
    secret: decodeBase32Secret(rawSecret),
    labelIssuer: label.issuer,
    issuerMismatch: isMismatch(label.issuer, queryIssuer),
  };
}

/**
 * Reads a parameter that has a default.
 *
 * Absent means the default; present but unreadable is an error. That asymmetry is the whole
 * point — see the note on rejecting rather than falling back in `parameters.ts`.
 */
function readOptional<T>(url: URL, key: string, parse: (raw: string) => T, fallback: T): T {
  const raw = url.searchParams.get(key);
  if (raw === null || raw.trim() === '') return fallback;
  return parse(raw);
}

interface Label {
  readonly issuer: string | null;
  readonly account: string | null;
}

/**
 * Splits the label into issuer and account.
 *
 * Split on the **first** colon: the format puts the issuer first, so a later colon belongs to
 * the account. `WHATWG URL` leaves the path percent-encoded, which is what we want — decoding
 * happens here, after the structure has been read, so a `%3A` inside an account name cannot
 * be mistaken for the separator.
 */
function readLabel(pathname: string): Label {
  const raw = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  if (raw === '') return { issuer: null, account: null };

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw invalidUri('its label contains a broken percent-escape');
  }

  const separator = decoded.indexOf(':');
  if (separator === -1) return { issuer: null, account: emptyToNull(decoded.trim()) };

  return {
    issuer: emptyToNull(decoded.slice(0, separator).trim()),
    // The format allows one optional space after the colon; `trim` handles that and the
    // people who put three.
    account: emptyToNull(decoded.slice(separator + 1).trim()),
  };
}

function emptyToNull(value: string): string | null {
  return value === '' ? null : value;
}

function isMismatch(labelIssuer: string | null, queryIssuer: string | null): boolean {
  if (labelIssuer === null || queryIssuer === null) return false;
  return labelIssuer.trim().toLowerCase() !== queryIssuer.trim().toLowerCase();
}

// ── Writing one back ─────────────────────────────────────────────────────────

export interface OtpauthInput {
  readonly parameters: TotpParameters;
  readonly secret: SecretBytes;
}

/**
 * Builds an `otpauth://totp/...` link.
 *
 * **The returned string is secret material** — it contains the seed — which is why it says so
 * in the name. It is what a QR code for re-enrolment would encode and what an export writes
 * into a `login_totp` column, so it must be handled exactly like a password.
 *
 * Two deliberate choices:
 *
 *  - **The issuer is written in both places.** Belt and braces: readers that only look at the
 *    label and readers that only look at the parameter both get it right, and since we write
 *    the same value into both there is nothing for them to disagree about.
 *  - **`algorithm`, `digits` and `period` are always written, even at their defaults.** A
 *    self-describing URI cannot be broken by a reader whose idea of "default" differs from
 *    the specification's — and at least one exporter in the wild does differ.
 *
 * The query string is assembled with `encodeURIComponent` rather than `URLSearchParams`
 * because the latter serialises with form encoding, which turns a space into `+`. An issuer
 * of "Big Corp" would come back out of a strict reader as "Big+Corp".
 */
export function buildOtpauthSecretUri(input: OtpauthInput): string {
  const { parameters, secret } = input;
  assertTotpParameters(parameters);

  const account = parameters.account ?? '';
  const label =
    parameters.issuer === null
      ? encodeURIComponent(account)
      : `${encodeURIComponent(parameters.issuer)}:${encodeURIComponent(account)}`;

  const seed = secret.use((bytes) => encodeBase32(bytes));
  const query = [
    `secret=${seed}`,
    ...(parameters.issuer === null ? [] : [`issuer=${encodeURIComponent(parameters.issuer)}`]),
    `algorithm=${parameters.algorithm}`,
    `digits=${parameters.digits}`,
    `period=${parameters.periodSeconds}`,
  ].join('&');

  return `otpauth://totp/${label}?${query}`;
}
