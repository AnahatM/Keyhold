// SPDX-License-Identifier: GPL-3.0-or-later
import type { TotpParameters } from '@shared/model/totp.js';
import type { SecretBytes } from '../crypto/secret.js';
import { decodeBase32Secret } from './base32.js';
import { defaultTotpParameters } from './parameters.js';
import {
  generateTotpSecretCode,
  verifyTotpSecretCode,
  type TotpSecretCode,
  type TotpVerification,
  type TotpVerifyOptions,
} from './totp.js';
import { isOtpauthUri, parseOtpauthUri } from './uri.js';

/**
 * The bridge between what is **already in people's vaults** and the engine.
 *
 * This is the reason the engine was worth building now rather than alongside a UI. The record
 * model has had an `otp-secret` custom-field type since the field system landed, and eight
 * import parsers already write into it — `bitwarden-csv`, `bitwarden-json`, `lastpass-csv`,
 * `dashlane-csv`, `onepassword-csv`, `safari-csv`, `keepass-csv` and the generic CSV mapper.
 * So users who have migrated already have their second factors sitting in the vault, and
 * until this module existed there was nothing that could do anything with them.
 *
 * Those parsers store whichever form the source gave them, and the sources disagree:
 *
 *   - **A full `otpauth://` URI.** Safari, 1Password and Bitwarden's JSON export write these,
 *     and `safari-csv.ts` explicitly keeps the whole URI rather than reducing it to the seed —
 *     "reducing it to the seed would throw away everything a TOTP implementation needs beyond
 *     the seed itself". This module is that implementation, and it reads what was kept.
 *   - **A bare base32 seed.** LastPass and many CSVs write only the seed, which means the
 *     algorithm, digit count and period are simply not known and the format's defaults apply.
 *
 * Both are handled, and which one arrived is reported rather than hidden, because it changes
 * what the UI can honestly say: for a bare seed, "SHA-1, 6 digits, 30 seconds" is an
 * assumption, not a fact read from the record.
 *
 * ## Ownership of the decoded seed
 *
 * `parseOtpSecretField` hands back live `SecretBytes` and the caller must `destroy()` it. The
 * two convenience functions below exist so that most callers never have to: they take the
 * field value, do the one thing, and destroy the key in a `finally` — including on the error
 * path, which is the path where a leaked key matters most.
 */

export type TotpSecretSource = 'otpauth-uri' | 'bare-seed';

export interface TotpConfiguration {
  readonly parameters: TotpParameters;
  /** **The caller owns this and must `destroy()` it.** */
  readonly secret: SecretBytes;
  /** Whether the parameters were read from the record or assumed from the defaults. */
  readonly source: TotpSecretSource;
  /** From the URI's label prefix, when it disagreed with the `issuer` parameter. */
  readonly labelIssuer: string | null;
  readonly issuerMismatch: boolean;
}

/**
 * Reads an `otp-secret` custom field's value.
 *
 * The parameter is named `secretValue` because that is what a field of this type holds — see
 * `SECRET_CUSTOM_FIELD_TYPES` in the record model, which classifies `otp-secret` next to
 * `password`. Nothing about it is ever echoed into an error.
 */
export function parseOtpSecretField(secretValue: string): TotpConfiguration {
  if (isOtpauthUri(secretValue)) {
    const parsed = parseOtpauthUri(secretValue);
    return {
      parameters: parsed.parameters,
      secret: parsed.secret,
      source: 'otpauth-uri',
      labelIssuer: parsed.labelIssuer,
      issuerMismatch: parsed.issuerMismatch,
    };
  }

  return {
    parameters: defaultTotpParameters(),
    secret: decodeBase32Secret(secretValue),
    source: 'bare-seed',
    labelIssuer: null,
    issuerMismatch: false,
  };
}

/**
 * The current code for a stored field, with the key destroyed before returning.
 *
 * The intended entry point for the IPC handler: one field value in, one code and its absolute
 * expiry out, and no key material outliving the call. `now` stays a parameter all the way up
 * — the handler passes `Date.now()`, and the tests pass whatever instant they are pinning.
 */
export function totpSecretCodeFromField(secretValue: string, now: number): TotpSecretCode {
  const configuration = parseOtpSecretField(secretValue);
  try {
    return generateTotpSecretCode(configuration.secret, configuration.parameters, now);
  } finally {
    configuration.secret.destroy();
  }
}

/** Verifies a typed code against a stored field. Same ownership discipline as above. */
export function verifyTotpSecretCodeAgainstField(
  secretValue: string,
  candidateSecretCode: string,
  now: number,
  options: TotpVerifyOptions = {}
): TotpVerification {
  const configuration = parseOtpSecretField(secretValue);
  try {
    return verifyTotpSecretCode(
      configuration.secret,
      configuration.parameters,
      candidateSecretCode,
      now,
      options
    );
  } finally {
    configuration.secret.destroy();
  }
}
