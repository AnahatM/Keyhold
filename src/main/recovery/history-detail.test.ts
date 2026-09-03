// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VERSIONED_FIELDS, type Credential } from '@shared/model/credential.js';
import { assertValidHistory } from '../history/versioning.js';
import { recordOf } from '../attachments/test-fixtures.js';
import { UNATTRIBUTED_HISTORY_DETAIL, describeHistoryViolation } from './history-detail.js';
import { FIXTURE_NOW } from './test-support.js';

/**
 * The sentence that replaced a redaction pass.
 *
 * Two properties are worth more than any individual wording here, and both are asserted over
 * every case: the sentence names the invariant that `assertValidHistory` actually threw on,
 * and it is built only from characters this file put there. The second is what makes the
 * "contains no secrets" claim on the report structural rather than hopeful — a value out of
 * the document cannot appear, because none is ever interpolated.
 */

const DAY = 86_400_000;

type Version = Credential['history']['versions'][number];

function versioned(versions: readonly unknown[], maxVersions: number | null = null): Credential {
  return {
    ...recordOf('r1'),
    history: { enabled: true, maxVersions, versions: versions as readonly Version[] },
  };
}

function version(overrides: Record<string, unknown> = {}): unknown {
  return {
    versionNumber: 1,
    savedAt: FIXTURE_NOW - DAY,
    changedFields: ['title'],
    snapshot: { title: 'a' },
    origin: { action: 'update' },
    ...overrides,
  };
}

/**
 * The characters a composed detail is allowed to contain.
 *
 * Letters, digits, and the punctuation this module writes. Not a taste rule — a value out of a
 * corrupt vault is overwhelmingly likely to carry something outside this set, so the class is
 * a cheap independent check that nothing from the document reached the string.
 */
const COMPOSED_ONLY = /^[A-Za-z0-9 ,.()"—-]+$/;

function expectComposed(detail: string): void {
  expect(detail).toMatch(COMPOSED_ONLY);
  // Quotes must pair, and the only thing ever quoted is one of our own field names. An odd
  // count is the signature of the truncation bypass that defeated the previous defence.
  expect(detail.split('"').length % 2).toBe(1);
  for (const match of detail.matchAll(/"([^"]*)"/g)) {
    expect(VERSIONED_FIELDS).toContain(match[1] ?? '');
  }
}

/** Every case here must be one `assertValidHistory` genuinely rejects, or it proves nothing. */
function detailFor(record: Credential): string {
  expect(() => {
    assertValidHistory(record);
  }).toThrow();

  const detail = describeHistoryViolation(record);
  expectComposed(detail);
  return detail;
}

describe('naming the invariant that broke', () => {
  it('names a version number that does not ascend, and where it sits', () => {
    const detail = detailFor(versioned([version({ versionNumber: 2 }), version()]));
    expect(detail).toContain('ascend');
    expect(detail).toContain('position 2');
    expect(detail).toContain('version 1 after 2');
  });

  it('refuses to print a version number that is not an integer', () => {
    // The ascending-order message in `versioning.ts` interpolates this value unquoted, so no
    // quoted-run scrubber could ever have covered it.
    const detail = detailFor(versioned([version({ versionNumber: 'SECRET-NOTE-FRAGMENT' })]));
    expect(detail).toContain('is not an integer');
    expect(detail).not.toContain('SECRET');
  });

  it('names a snapshot key that is one of our own field names', () => {
    const detail = detailFor(
      versioned([version({ snapshot: { title: 'a', password: 'never-shown' } })])
    );
    expect(detail).toBe(
      'the version at position 1 snapshots "password", which it does not list as changed'
    );
  });

  it('locates a snapshot key that is not, without reproducing a character of it', () => {
    const key = 'RECOVERY-CODE-8891';
    const detail = detailFor(versioned([version({ snapshot: { title: 'a', [key]: 'x' } })]));

    expect(detail).toContain('key 2 of 2');
    expect(detail).toContain('18 character(s)');
    expect(detail).not.toContain('RECOVERY');
  });

  it('counts characters, not UTF-16 units, so a length is the number a human would count', () => {
    const key = '👻👻👻';
    const detail = detailFor(versioned([version({ snapshot: { title: 'a', [key]: 'x' } })]));
    expect(detail).toContain('3 character(s)');
  });

  it('locates an unknown changed-field name the same way', () => {
    const detail = detailFor(versioned([version({ changedFields: ['title', 'employer-vpn'] })]));
    expect(detail).toContain('lists a changed field');
    expect(detail).toContain('entry 2 of 2');
    expect(detail).not.toContain('employer');
  });

  it('reports a cap that is exceeded with two counts and nothing else', () => {
    const detail = detailFor(versioned([version(), version({ versionNumber: 2 })], 1));
    expect(detail).toBe('2 version(s) exceed the history cap of 1');
  });

  it('rejects a maxVersions that is not a non-negative integer', () => {
    const record = versioned([], -1);
    expect(detailFor(record)).toContain('history.maxVersions');
  });

  it('describes the FIRST violation, because that is the one that fired', () => {
    // Two broken invariants on one record: the ascending check runs first in `versioning.ts`,
    // so a detail naming the snapshot key would be describing a violation the caller never saw.
    const detail = detailFor(
      versioned([
        version({ versionNumber: 5 }),
        version({ versionNumber: 1, snapshot: { title: 'a', password: 'p' } }),
      ])
    );
    expect(detail).toContain('ascend');
    expect(detail).not.toContain('snapshots');
  });
});

describe('failing closed on shapes the types say are impossible', () => {
  // Everything here reaches this module *because* the document is not the shape it claims, so
  // "the type says it cannot happen" is not an argument available to this file.

  it('does not throw on a history that is not an object', () => {
    const record = { ...recordOf('r1'), history: null } as unknown as Credential;
    expect(describeHistoryViolation(record)).toBe(UNATTRIBUTED_HISTORY_DETAIL);
  });

  it('does not throw on a versions array that is not an array', () => {
    const record = versioned([]);
    const broken = {
      ...record,
      history: { ...record.history, versions: 'nope' },
    } as unknown as Credential;
    expect(describeHistoryViolation(broken)).toBe(UNATTRIBUTED_HISTORY_DETAIL);
  });

  it('does not throw on a snapshot that is null, which would break Object.keys', () => {
    const detail = describeHistoryViolation(versioned([version({ snapshot: null })]));
    expect(detail).toContain('has no snapshot object');
    expectComposed(detail);
  });

  it('does not throw on changedFields that is not an array', () => {
    const detail = describeHistoryViolation(versioned([version({ changedFields: 'title' })]));
    expect(detail).toContain('does not list its changed fields');
  });

  it('does not throw on a version that is not an object', () => {
    expect(describeHistoryViolation(versioned(['not-a-version']))).toContain(
      'is not a version object'
    );
  });

  it('says something vague rather than nothing when it cannot attribute the failure', () => {
    // A valid history never reaches this module in production; if `versioning.ts` grows an
    // invariant this file has not been taught, this is the sentence the report gets. Vaguer
    // than the truth is the right direction to fail in — a leak is not.
    const healthy = versioned([version()]);
    expect(() => {
      assertValidHistory(healthy);
    }).not.toThrow();
    expect(describeHistoryViolation(healthy)).toBe(UNATTRIBUTED_HISTORY_DETAIL);
  });
});
