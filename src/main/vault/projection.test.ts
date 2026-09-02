// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  CUSTOM_FIELD_TYPES,
  isCustomFieldValueSecret,
  SECRET_CUSTOM_FIELD_TYPES,
  type Credential,
  type CustomFieldType,
} from '@shared/model/credential.js';
import { toProjection, toProjections } from './projection.js';

/**
 * **The most important test in the project.**
 *
 * Decision D13 — the renderer never holds secret material — is a claim about a boundary,
 * and a boundary that is only enforced by a developer remembering is not a boundary. The
 * property test below is what makes it real: it plants a unique, recognisable marker in
 * every secret position in a record, projects it, serialises the whole projection, and
 * asserts that no marker survives anywhere in the output.
 *
 * That formulation matters. It does not check specific fields, so it cannot be defeated
 * by a *new* field being added and forgotten — which is precisely the failure mode a
 * hand-written per-field assertion would miss. Any future code path that leaks a secret
 * into the projection, by any route, fails this test.
 *
 * Fault injections performed (see the last describe block, and the testing-policy doc):
 * spreading the record instead of building explicitly; including `version.snapshot`;
 * treating a hidden text field as non-secret. All three are caught here.
 */

const SECRET_MARKER = 'SECRET_MARKER_MUST_NOT_LEAK';

/** A distinct marker per position, so a failure says exactly which one leaked. */
const marker = (where: string): string => `${SECRET_MARKER}_${where}`;

/**
 * A record with a marker in every secret position, and realistic values elsewhere.
 *
 * `customTypes` defaults to every type in the model, so adding a new custom-field type
 * automatically extends the test's coverage rather than requiring someone to notice.
 */
function credentialWithSecretsEverywhere(
  customTypes: readonly CustomFieldType[] = CUSTOM_FIELD_TYPES
): Credential {
  return {
    id: 'cred-1',
    type: 'login',
    title: 'GitHub',
    favorite: true,
    folderId: 'folder-1',
    tags: ['dev', 'work'],
    icon: { kind: 'letter', value: 'G' },
    fields: {
      username: 'anahat',
      email: 'anahat@example.com',
      password: marker('password'),
      urls: ['https://github.com'],
      securityQuestions: [
        { id: 'q1', question: "Your first pet's name?", answer: marker('answer1') },
        { id: 'q2', question: 'City of birth?', answer: marker('answer2') },
      ],
      notes: marker('notes'),
      custom: [
        // Every type, all hidden:false — so only genuinely secret TYPES should be stripped.
        ...customTypes.map((type, index) => ({
          id: `custom-${type}`,
          label: `Field ${type}`,
          type,
          value: SECRET_CUSTOM_FIELD_TYPES.includes(type)
            ? marker(`custom-${type}`)
            : `visible-${type}`,
          hidden: false,
          order: index,
        })),
        // A plain text field the USER marked hidden. Type is harmless; the user's flag is
        // what makes it secret, and that must be honoured.
        {
          id: 'custom-user-hidden',
          label: 'Recovery code',
          type: 'text' as const,
          value: marker('user-hidden'),
          hidden: true,
          order: 99,
        },
      ],
    },
    attachments: [
      {
        id: 'a'.repeat(32),
        name: 'recovery-codes.pdf',
        mime: 'application/pdf',
        size: 1234,
        sha256: 'b'.repeat(64),
        addedAt: 1_700_000_000_000,
      },
    ],
    meta: {
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
      passwordUpdatedAt: 1_700_000_050_000,
      lastUsedAt: 1_700_000_200_000,
      useCount: 12,
      expiresAt: null,
      rotationIntervalDays: 90,
    },
    history: {
      enabled: true,
      maxVersions: 20,
      versions: [
        {
          versionNumber: 1,
          savedAt: 1_699_000_000_000,
          changedFields: ['password'],
          // The previous password. The single most dangerous thing in the record — an
          // attacker who gets old passwords learns the user's pattern.
          snapshot: { password: marker('history-old-password') },
          origin: {
            action: 'update',
            deviceName: 'ANAHAT-DESKTOP',
            platform: 'win32',
            appVersion: '0.1.0',
          },
        },
        {
          versionNumber: 2,
          savedAt: 1_699_500_000_000,
          changedFields: ['notes'],
          snapshot: { notes: marker('history-old-notes') },
          origin: { action: 'update', deviceName: 'ANAHAT-MBP', platform: 'darwin' },
        },
      ],
    },
    trashedAt: null,
  };
}

/** Every string anywhere in a value, however deeply nested. */
function allStrings(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, found);
  else if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) allStrings(nested, found);
  }
  return found;
}

describe('the safe projection never carries secret material', () => {
  it('leaks no marker anywhere in the serialised projection', () => {
    const projection = toProjection(credentialWithSecretsEverywhere());
    expect(JSON.stringify(projection)).not.toContain(SECRET_MARKER);
  });

  it('leaks no marker in any nested string, however deep', () => {
    // Belt and braces: JSON.stringify would miss a value hidden behind a custom toJSON.
    const projection = toProjection(credentialWithSecretsEverywhere());
    for (const value of allStrings(projection)) {
      expect(value).not.toContain(SECRET_MARKER);
    }
  });

  it('holds for a list projection too', () => {
    const many = Array.from({ length: 5 }, () => credentialWithSecretsEverywhere());
    expect(JSON.stringify(toProjections(many))).not.toContain(SECRET_MARKER);
  });

  it('never carries a history snapshot — those are previous passwords', () => {
    const projection = toProjection(credentialWithSecretsEverywhere());
    for (const version of projection.history) {
      expect(version).not.toHaveProperty('snapshot');
    }
    expect(JSON.stringify(projection.history)).not.toContain('history-old-password');
  });

  it('never carries a security answer', () => {
    const projection = toProjection(credentialWithSecretsEverywhere());
    for (const question of projection.securityQuestions) {
      expect(question).not.toHaveProperty('answer');
    }
  });

  it('strips the value of every secret custom-field type', () => {
    const projection = toProjection(credentialWithSecretsEverywhere());
    for (const type of SECRET_CUSTOM_FIELD_TYPES) {
      const field = projection.custom.find((f) => f.id === `custom-${type}`);
      expect(field, `custom field of type ${type} should be projected`).toBeDefined();
      expect(field?.value, `value of secret type ${type} must be stripped`).toBeUndefined();
      expect(field?.isSecret).toBe(true);
    }
  });

  it("honours the user's hidden flag even on a harmless type", () => {
    const projection = toProjection(credentialWithSecretsEverywhere());
    const field = projection.custom.find((f) => f.id === 'custom-user-hidden');
    expect(field?.isSecret).toBe(true);
    expect(field?.value).toBeUndefined();
  });
});

describe('the projection carries what the UI genuinely needs', () => {
  const projection = toProjection(credentialWithSecretsEverywhere());

  it('keeps the fields search, sort and grouping run on', () => {
    expect(projection.title).toBe('GitHub');
    expect(projection.username).toBe('anahat');
    expect(projection.email).toBe('anahat@example.com');
    expect(projection.urls).toEqual(['https://github.com']);
    expect(projection.tags).toEqual(['dev', 'work']);
    expect(projection.folderId).toBe('folder-1');
    expect(projection.favorite).toBe(true);
  });

  it('keeps facts about secrets, so a masked field can be rendered honestly', () => {
    // "Has a password" and "is 27 characters long" let the UI show a correctly-sized
    // masked field and distinguish "not set" from "hidden", without carrying anything
    // usable.
    expect(projection.hasPassword).toBe(true);
    expect(projection.passwordLength).toBe(marker('password').length);
    expect(projection.hasNotes).toBe(true);
  });

  it('reports an empty secret as absent rather than hidden', () => {
    const empty = credentialWithSecretsEverywhere();
    const projection2 = toProjection({
      ...empty,
      fields: { ...empty.fields, password: '', notes: '' },
    });
    expect(projection2.hasPassword).toBe(false);
    expect(projection2.passwordLength).toBe(0);
    expect(projection2.hasNotes).toBe(false);
  });

  it('keeps security-question prompts, which are not secret', () => {
    expect(projection.securityQuestions.map((q) => q.question)).toEqual([
      "Your first pet's name?",
      'City of birth?',
    ]);
    expect(projection.securityQuestions.every((q) => q.hasAnswer)).toBe(true);
  });

  it('keeps the values of non-secret custom fields, so lists need no round trip', () => {
    const visible = projection.custom.filter((f) => !f.isSecret);
    expect(visible.length).toBeGreaterThan(0);
    for (const field of visible) {
      expect(field.value).toBe(`visible-${field.type}`);
    }
  });

  it('keeps attachment metadata but no bytes', () => {
    expect(projection.attachments[0]?.name).toBe('recovery-codes.pdf');
    expect(projection.attachments[0]).not.toHaveProperty('data');
  });

  it('keeps the history timeline — what changed, when, and from where', () => {
    // The headline feature. The renderer must be able to render this without a round trip.
    expect(projection.history).toHaveLength(2);
    expect(projection.history[0]?.changedFields).toEqual(['password']);
    expect(projection.history[0]?.origin.deviceName).toBe('ANAHAT-DESKTOP');
    expect(projection.history[1]?.origin.deviceName).toBe('ANAHAT-MBP');
    expect(projection.historyCount).toBe(2);
    expect(projection.historyEnabled).toBe(true);
  });

  it('keeps the metadata the health rules and sorting need', () => {
    expect(projection.meta.passwordUpdatedAt).toBe(1_700_000_050_000);
    expect(projection.meta.useCount).toBe(12);
    expect(projection.meta.rotationIntervalDays).toBe(90);
  });
});

describe('the classification itself', () => {
  it('classifies every custom-field type as secret or not, with none left out', () => {
    for (const type of CUSTOM_FIELD_TYPES) {
      const secret = isCustomFieldValueSecret({ type, hidden: false });
      expect(typeof secret).toBe('boolean');
      expect(secret).toBe(SECRET_CUSTOM_FIELD_TYPES.includes(type));
    }
  });

  it('makes any field secret once the user hides it', () => {
    for (const type of CUSTOM_FIELD_TYPES) {
      expect(isCustomFieldValueSecret({ type, hidden: true })).toBe(true);
    }
  });

  it('treats password, pin and otp-secret as secret by type', () => {
    // Pinned explicitly: if someone ever removes one of these from the list, that is a
    // deliberate act that has to break a test, not a quiet edit to an array.
    expect(SECRET_CUSTOM_FIELD_TYPES).toEqual(['password', 'pin', 'otp-secret']);
  });
});
