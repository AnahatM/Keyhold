// SPDX-License-Identifier: GPL-3.0-or-later
import type { CredentialType, CustomFieldType } from './credential.js';

/**
 * What each kind of record starts with.
 *
 * A template is a **list of empty custom fields the editor pre-fills**, and nothing more. It
 * is not a schema: nothing validates against it, nothing enforces it, and a user is free to
 * delete every field it offered or add ten of their own. It exists so that choosing "Payment
 * card" produces a form with `Number`, `Expiry` and `Security code` on it rather than an
 * empty record and a shrug.
 *
 * ## Why this is a list of fields rather than a type per record shape
 *
 * Because a second storage shape is a second everything: a second validator, a second
 * projection, a second merge path, a second import mapping, a second export column set. Each
 * of those is somewhere a card could be lost that a login would not be. Here a card **is** a
 * record, so a bug that loses one loses all of them and gets found on the first day.
 *
 * ## The field types are what protect the values
 *
 * A card's security code is a `pin`, an API key is a `password`, a WiFi passphrase is a
 * `password`. `SECRET_CUSTOM_FIELD_TYPES` decides what never crosses to the renderer, so
 * these values are protected because of **what they are**, not because of what record they
 * happen to sit in — which is the property that survives someone moving a field.
 *
 * Nothing here is a secret by virtue of its label. `Cardholder` is text and is not hidden,
 * because pretending a name is a secret trains people to reveal things without thinking.
 */

export interface TemplateField {
  readonly label: string;
  readonly type: CustomFieldType;
}

export interface CredentialTypeDefinition {
  readonly id: CredentialType;
  readonly label: string;
  /** One line for the type picker. What this is for, not what it contains. */
  readonly summary: string;
  /** The icon the list and the picker draw. A name from the app's own set. */
  readonly icon: string;
  /**
   * Whether the login block — username, password, URLs — is shown by default.
   *
   * False does not remove it. A secure note with a password on it is a perfectly ordinary
   * thing to want, and hiding the field would be the app deciding what the user meant. It
   * only decides what the editor leads with.
   */
  readonly showsLogin: boolean;
  readonly fields: readonly TemplateField[];
}

/**
 * The `login` definition, named so the fallback below needs no non-null assertion.
 *
 * A record written by a newer Keyhold carries a type this build has never heard of, and it
 * must still open and show its fields — so the fallback is a real requirement rather than
 * defensive tidiness.
 */
const LOGIN_DEFINITION: CredentialTypeDefinition = {
  id: 'login',
  label: 'Login',
  summary: 'A username and password for a website or an app.',
  icon: 'key',
  showsLogin: true,
  fields: [],
};

export const CREDENTIAL_TYPE_DEFINITIONS: readonly CredentialTypeDefinition[] = [
  LOGIN_DEFINITION,
  {
    id: 'note',
    label: 'Secure note',
    summary: 'Free text, encrypted like everything else. No login fields.',
    icon: 'document',
    showsLogin: false,
    fields: [],
  },
  {
    id: 'card',
    label: 'Payment card',
    summary: 'A card number, its expiry and its security code.',
    icon: 'clipboard',
    showsLogin: false,
    fields: [
      { label: 'Cardholder', type: 'text' },
      // `password`, not `text`: a card number is the credential, and it must not cross into
      // the renderer in bulk any more than a password does.
      { label: 'Number', type: 'password' },
      { label: 'Expiry', type: 'text' },
      { label: 'Security code', type: 'pin' },
      { label: 'Issuer', type: 'text' },
      { label: 'PIN', type: 'pin' },
    ],
  },
  {
    id: 'identity',
    label: 'Identity document',
    summary: 'A passport, a driving licence, a national ID.',
    icon: 'shield',
    showsLogin: false,
    fields: [
      { label: 'Full name', type: 'text' },
      { label: 'Document number', type: 'password' },
      { label: 'Issued', type: 'date' },
      { label: 'Expires', type: 'date' },
      { label: 'Issuing authority', type: 'text' },
      { label: 'Nationality', type: 'text' },
    ],
  },
  {
    id: 'bank',
    label: 'Bank account',
    summary: 'Account numbers and the codes needed to reach them.',
    icon: 'vault',
    showsLogin: true,
    fields: [
      { label: 'Bank', type: 'text' },
      { label: 'Account number', type: 'password' },
      { label: 'Sort code / routing', type: 'password' },
      { label: 'IBAN', type: 'password' },
      { label: 'SWIFT / BIC', type: 'text' },
    ],
  },
  {
    id: 'wifi',
    label: 'Wi‑Fi network',
    summary: 'A network name and its passphrase.',
    icon: 'offline',
    showsLogin: false,
    fields: [
      { label: 'Network name (SSID)', type: 'text' },
      { label: 'Passphrase', type: 'password' },
      { label: 'Security', type: 'text' },
    ],
  },
  {
    id: 'ssh-key',
    label: 'SSH key',
    summary: 'A private key, its passphrase, and where it is used.',
    icon: 'key',
    showsLogin: false,
    fields: [
      { label: 'Private key', type: 'password' },
      // The public half is not a secret and is deliberately typed so — marking it hidden
      // would teach the reader that every field on this record is dangerous, which makes the
      // one that is dangerous harder to see.
      { label: 'Public key', type: 'multiline' },
      { label: 'Passphrase', type: 'password' },
      { label: 'Fingerprint', type: 'text' },
      { label: 'Host', type: 'text' },
    ],
  },
  {
    id: 'api-key',
    label: 'API key',
    summary: 'A token or key pair for a service.',
    icon: 'bolt',
    showsLogin: false,
    fields: [
      { label: 'Key', type: 'password' },
      { label: 'Secret', type: 'password' },
      { label: 'Environment', type: 'text' },
      { label: 'Scopes', type: 'text' },
    ],
  },
  {
    id: 'licence',
    label: 'Software licence',
    summary: 'A licence key and what it unlocks.',
    icon: 'document',
    showsLogin: false,
    fields: [
      { label: 'Licence key', type: 'password' },
      { label: 'Product', type: 'text' },
      { label: 'Version', type: 'text' },
      { label: 'Purchased', type: 'date' },
      { label: 'Seats', type: 'number' },
    ],
  },
  {
    id: 'membership',
    label: 'Membership',
    summary: 'A card number for a club, a library, a loyalty scheme.',
    icon: 'star',
    showsLogin: false,
    fields: [
      { label: 'Organisation', type: 'text' },
      { label: 'Member number', type: 'password' },
      { label: 'Member since', type: 'date' },
      { label: 'Expires', type: 'date' },
    ],
  },
];

/**
 * The definitions by id.
 *
 * A `Map` rather than a lookup function with a fallback, because there is no sensible
 * fallback: a record whose type is not in the list is a record written by a newer Keyhold,
 * and the caller has to decide what to do about that rather than silently being handed a
 * login's template.
 */
export const CREDENTIAL_TYPE_BY_ID: ReadonlyMap<CredentialType, CredentialTypeDefinition> = new Map(
  CREDENTIAL_TYPE_DEFINITIONS.map((definition) => [definition.id, definition])
);

/** The definition for a type, falling back to `login` for one this build does not know. */
export function credentialTypeDefinition(type: CredentialType): CredentialTypeDefinition {
  return CREDENTIAL_TYPE_BY_ID.get(type) ?? LOGIN_DEFINITION;
}
