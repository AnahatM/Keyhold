// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ICON_KINDS } from '../src/shared/model/credential.js';

/**
 * Guard: the two layers that cap the same arrays must cap them at the same numbers, and
 * the IPC validator's list of icon kinds must be the model's list.
 *
 * The double-capping is deliberate and documented — `credential-validation.ts` rejects an
 * over-long array before anything tries to validate it entry by entry, and
 * `credential-ops.ts` rejects one so a single record cannot bloat a vault. Two layers, two
 * reasons, both sound. What was missing was anything noticing when the numbers stop
 * agreeing: raise the ops cap alone and the IPC boundary silently becomes the real limit,
 * and the ops cap never fires again. The same shape of defect applies to `ICON_KINDS`,
 * which is declared in the model and restated in the validator — add a kind to the model
 * and the IPC boundary rejects it as "not a known kind", which presents as a UI bug.
 *
 * Read out of the source text rather than imported because both sets of constants are
 * module-private, and exporting them purely to be tested would widen two module surfaces
 * to satisfy a test. `tools/alias-parity.test.ts` establishes this pattern in this repo.
 *
 * **This is the guard, not the fix.** The fix is one `export`/`import` in each case, and it
 * belongs to whoever owns `src/shared/ipc/` — see `docs/14-Audits/00-Security-Audit.md`
 * S13 and S14. When that lands, the constants become importable and this file should be
 * rewritten to compare values instead of parsing text, or deleted if the copies are gone.
 *
 * Fault injection performed: changing `MAX_TAGS` to 65 in `credential-ops.ts` fails
 * "cap the same arrays at the same numbers"; adding `'svg'` to the validator's `ICON_KINDS`
 * fails "accepts exactly the icon kinds the model declares".
 */

const ROOT = resolve(import.meta.dirname, '..');

const VALIDATION_FILE = 'src/shared/ipc/credential-validation.ts';
const OPS_FILE = 'src/main/vault/credential-ops.ts';

/** The four caps both layers declare, by name. */
const SHARED_CAP_NAMES = [
  'MAX_URLS',
  'MAX_TAGS',
  'MAX_CUSTOM_FIELDS',
  'MAX_SECURITY_QUESTIONS',
] as const;

function readSource(file: string): string {
  return readFileSync(resolve(ROOT, file), 'utf8');
}

/** `const NAME = 1_234;` → 1234. Underscore separators are used in both files. */
function numericConstant(source: string, file: string, name: string): number {
  const match = new RegExp(`\\bconst ${name} = ([\\d_]+);`).exec(source);
  expect(match, `${file} no longer declares ${name} as a numeric constant`).not.toBeNull();
  return Number.parseInt((match?.[1] ?? '').replaceAll('_', ''), 10);
}

describe('array caps', () => {
  it('cap the same arrays at the same numbers in both layers', () => {
    const validation = readSource(VALIDATION_FILE);
    const ops = readSource(OPS_FILE);

    const fromValidation: Record<string, number> = {};
    const fromOps: Record<string, number> = {};
    for (const name of SHARED_CAP_NAMES) {
      fromValidation[name] = numericConstant(validation, VALIDATION_FILE, name);
      fromOps[name] = numericConstant(ops, OPS_FILE, name);
    }

    // Compared as whole objects so a failure names every cap that drifted, not just the
    // first one.
    expect(fromOps).toEqual(fromValidation);
  });

  it('are all real, positive limits rather than a disabled check', () => {
    const validation = readSource(VALIDATION_FILE);
    for (const name of SHARED_CAP_NAMES) {
      expect(numericConstant(validation, VALIDATION_FILE, name)).toBeGreaterThan(0);
    }
  });
});

describe('icon kinds', () => {
  it('accepts exactly the icon kinds the model declares', () => {
    const source = readSource(VALIDATION_FILE);
    const match = /const ICON_KINDS = \[([^\]]*)\]/.exec(source);
    expect(
      match,
      `${VALIDATION_FILE} no longer declares ICON_KINDS as an array literal`
    ).not.toBeNull();

    const declared = [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((entry) => entry[1]!);
    // Order matters as little as it ever does, but a set comparison would hide a duplicate.
    expect([...declared].sort()).toEqual([...ICON_KINDS].sort());
  });
});
