// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_TYPE_BY_ID,
  CREDENTIAL_TYPE_DEFINITIONS,
  credentialTypeDefinition,
} from './credential-templates.js';
import { CREDENTIAL_TYPES, SECRET_CUSTOM_FIELD_TYPES } from './credential.js';

/**
 * The templates, and the one property that is a security claim rather than a convenience.
 *
 * **A field that holds a credential must be typed as one.** A card number typed `text` would
 * cross into the renderer with every projection — in bulk, for every record — instead of
 * being fetched one at a time on an explicit reveal. That is decision D13, and a template is
 * exactly the place it would be undone by accident, because a template is a list somebody
 * extends in a hurry.
 *
 * Fault injection: `Number` on the card template changed from `password` to `text`. The first
 * case below fails and names the field.
 */

/** Labels whose value is the thing an attacker wants. Matched case-insensitively. */
const MUST_BE_SECRET = [
  'number',
  'key',
  'secret',
  'passphrase',
  'security code',
  'pin',
  'iban',
  'sort code',
];

describe('the field templates', () => {
  it('types every credential-bearing field as a secret one', () => {
    const leaks: string[] = [];
    for (const definition of CREDENTIAL_TYPE_DEFINITIONS) {
      for (const field of definition.fields) {
        const label = field.label.toLowerCase();
        // The public half of a key pair is named "public key" and is deliberately not secret.
        if (label.includes('public')) continue;
        if (!MUST_BE_SECRET.some((needle) => label.includes(needle))) continue;
        if (!SECRET_CUSTOM_FIELD_TYPES.includes(field.type)) {
          leaks.push(`${definition.id} → ${field.label} is ${field.type}`);
        }
      }
    }
    expect(leaks, 'a credential-bearing field is typed as ordinary text').toEqual([]);
  });

  it('covers every declared type, with no extras', () => {
    expect([...CREDENTIAL_TYPE_BY_ID.keys()].sort()).toEqual([...CREDENTIAL_TYPES].sort());
  });

  it('gives every type a label, a summary and an icon', () => {
    for (const definition of CREDENTIAL_TYPE_DEFINITIONS) {
      expect(definition.label.length, definition.id).toBeGreaterThan(2);
      expect(definition.summary.length, definition.id).toBeGreaterThan(10);
      expect(definition.icon.length, definition.id).toBeGreaterThan(2);
    }
  });

  it('falls back to login for a type this build does not know', () => {
    // A record written by a newer Keyhold must still open, showing its fields as they are.
    expect(credentialTypeDefinition('not-a-type' as never).id).toBe('login');
  });
});
