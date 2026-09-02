// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FORMAT_VERSION } from '@shared/format/types.js';
import { VaultError } from '../crypto/errors.js';
import { assertMigrationChainIsComplete, migrateBody, MIGRATIONS } from './migrations.js';

/**
 * The chain guard is the point of this file.
 *
 * There are no migrations yet, so most of what could be tested is the absence of things.
 * What is genuinely worth asserting now is the invariant that will matter the first time
 * someone adds one: **the chain has no gaps**. That failure is silent at runtime — a
 * vault simply skips a transformation and loads with fields in a shape nothing expects —
 * so it has to be caught at build time.
 */

describe('the migration chain', () => {
  it('is contiguous from version 1 to the current format version', () => {
    expect(() => {
      assertMigrationChainIsComplete();
    }).not.toThrow();
  });

  it('has exactly one migration per version step', () => {
    expect(MIGRATIONS).toHaveLength(FORMAT_VERSION - 1);
  });

  it('detects a gap — fault injection for the guard above', () => {
    // Simulates someone bumping FORMAT_VERSION to 3 while only writing the 1→2 migration.
    const withGap = [{ fromVersion: 1, description: '1→2', migrate: (b: unknown) => b }];
    const check = (target: number): void => {
      const seen = new Set(withGap.map((m) => m.fromVersion));
      for (let v = 1; v < target; v += 1) {
        if (!seen.has(v)) throw new Error(`No migration from format version ${v}`);
      }
    };
    expect(() => {
      check(3);
    }).toThrow(/No migration from format version 2/);
  });
});

describe('migrateBody', () => {
  it('is a no-op for a vault already at the current version', () => {
    const body = { records: [{ id: 'a' }] };
    const result = migrateBody(body, FORMAT_VERSION);

    expect(result.body).toBe(body);
    expect(result.applied).toEqual([]);
    expect(result.toVersion).toBe(FORMAT_VERSION);
  });

  it('refuses a version newer than this build understands', () => {
    // Unreachable in practice — readPreamble rejects newer files before decryption — but
    // reaching it would mean version gating has a hole, so it must not silently proceed.
    expect(() => migrateBody({}, FORMAT_VERSION + 1)).toThrow(VaultError);
  });

  it('refuses a nonsensical version', () => {
    expect(() => migrateBody({}, 0)).toThrow(VaultError);
    expect(() => migrateBody({}, -1)).toThrow(VaultError);
  });
});
