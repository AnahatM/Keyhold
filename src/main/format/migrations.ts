// SPDX-License-Identifier: GPL-3.0-or-later
import { FORMAT_VERSION } from '@shared/format/types.js';
import { malformed } from '../crypto/errors.js';

/**
 * Forward-only migration of the decrypted vault body between format versions.
 *
 * There is exactly one format version today, so this registry is empty. It exists now
 * rather than later because the shape of a migration system determines whether the first
 * migration is safe, and by the time one is needed there are real users' vaults to be
 * careful with. Three properties are worth fixing while it costs nothing:
 *
 *  - **Forward only.** There is no downgrade path. An older build refuses a newer file
 *    (see `readPreamble`) instead of stripping fields it does not understand, because
 *    "open it in an old version and lose your custom fields" is data loss.
 *
 *  - **The chain must be contiguous.** Migrations run 1→2→3, never 1→3. A skipped step is
 *    how a field silently arrives in the wrong shape. `assertMigrationChainIsComplete`
 *    is a guard test, not a runtime check — a gap is a build-time bug.
 *
 *  - **Migrations operate on the decrypted body, never the file.** The caller decrypts,
 *    migrates, then writes through the normal atomic path with a backup of the original
 *    already in place. A migration therefore cannot corrupt anything: the worst case is
 *    that it throws and the original file is still sitting there untouched.
 */

/** Transforms a parsed body from `fromVersion` to `fromVersion + 1`. */
export interface Migration {
  readonly fromVersion: number;
  readonly description: string;
  readonly migrate: (body: unknown) => unknown;
}

/**
 * Every migration, in order.
 *
 * When adding one: append it, bump `FORMAT_VERSION` in `@shared/format/types.ts`, and
 * write a test that runs a real fixture of the old version through it. The chain guard
 * will fail until the versions line up.
 */
export const MIGRATIONS: readonly Migration[] = [];

/**
 * Guard: the registry must cover every version from 1 up to the current one, with no
 * gaps and no duplicates.
 *
 * Exported so the test can call it directly. A gap here would mean a vault silently
 * skipping a transformation and loading with fields in a shape nothing expects.
 */
export function assertMigrationChainIsComplete(): void {
  const seen = new Set<number>();

  for (const migration of MIGRATIONS) {
    if (seen.has(migration.fromVersion)) {
      throw new Error(
        `Two migrations both start at version ${migration.fromVersion}. Each version needs exactly one.`
      );
    }
    seen.add(migration.fromVersion);
  }

  for (let version = 1; version < FORMAT_VERSION; version += 1) {
    if (!seen.has(version)) {
      throw new Error(
        `No migration from format version ${version} to ${version + 1}. The chain must be contiguous up to ${FORMAT_VERSION}.`
      );
    }
  }

  for (const migration of MIGRATIONS) {
    if (migration.fromVersion >= FORMAT_VERSION) {
      throw new Error(
        `Migration from version ${migration.fromVersion} is beyond the current FORMAT_VERSION of ${FORMAT_VERSION}. Bump FORMAT_VERSION when adding it.`
      );
    }
  }
}

export interface MigrationResult {
  readonly body: unknown;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly applied: readonly string[];
}

/**
 * Runs every migration needed to bring `body` from `fromVersion` up to the current
 * format version.
 *
 * A no-op when the vault is already current, which is the overwhelmingly common case —
 * so callers can invoke it unconditionally rather than branching on version.
 */
export function migrateBody(body: unknown, fromVersion: number): MigrationResult {
  if (fromVersion > FORMAT_VERSION) {
    // Should be unreachable: `readPreamble` refuses newer files before decryption. Kept
    // as a belt-and-braces check, because reaching here means version gating has a hole.
    throw malformed(
      `cannot migrate from format version ${fromVersion}, which is newer than the supported ${FORMAT_VERSION}`
    );
  }
  if (fromVersion < 1) throw malformed(`format version ${fromVersion} is not valid`);

  let current = body;
  const applied: string[] = [];

  for (let version = fromVersion; version < FORMAT_VERSION; version += 1) {
    const migration = MIGRATIONS.find((m) => m.fromVersion === version);
    if (migration === undefined) {
      throw malformed(`no migration from format version ${version} to ${version + 1}`);
    }
    current = migration.migrate(current);
    applied.push(migration.description);
  }

  return { body: current, fromVersion, toVersion: FORMAT_VERSION, applied };
}
