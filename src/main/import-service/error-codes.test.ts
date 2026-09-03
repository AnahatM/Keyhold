// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IMPORT_ERROR_CODES as SHARED_CODES } from '@shared/model/import-plan.js';
import { describe, expect, it } from 'vitest';
import { IMPORT_ERROR_CODES } from './errors.js';

/**
 * Guard: there is one list of import error codes, and it stays one.
 *
 * There were two — the six the service raises, declared here, and the two the wizard reacts
 * to by name, declared again in `src/renderer/src/import/gateway.ts`. Two spellings of the
 * same strings, either side of a process boundary, kept in step by a version of this file
 * that read the renderer's source as **text** and parsed the literal back out with a regex.
 *
 * That guard worked and was the wrong shape. It kept two lists honest instead of removing
 * the second one, it broke if either file was reformatted, and it silently stopped guarding
 * anything the moment the renderer's constant moved or was renamed. Both sides now
 * re-export `@shared/model/import-plan.ts`, so the strings cannot disagree — there is
 * nothing left to compare.
 *
 * What remains worth asserting is that nobody re-introduces the copy. The text scan is kept
 * for exactly that: it fails if either file grows an object literal of its own again.
 */

const SOURCES = [
  resolve('src/renderer/src/import/gateway.ts'),
  resolve('src/main/import-service/errors.ts'),
];

describe('import error codes', () => {
  it('are the shared list, by identity and not by value', () => {
    // `toBe`, not `toEqual`. Two objects with equal contents are exactly the situation this
    // is here to prevent, and `toEqual` would be satisfied by it.
    expect(IMPORT_ERROR_CODES).toBe(SHARED_CODES);
  });

  it('are not re-declared on either side of the boundary', () => {
    for (const path of SOURCES) {
      const source = readFileSync(path, 'utf8');
      // A re-export mentions the name; a redeclaration assigns an object literal to it.
      expect(
        /IMPORT_ERROR_CODES\s*(?::[^=]*)?=\s*\{/.test(source),
        `${path} declares its own IMPORT_ERROR_CODES — fold it back into the shared list`
      ).toBe(false);
    }
  });

  it('namespaces every code, so a bare code cannot collide with a vault error', () => {
    for (const code of Object.values(IMPORT_ERROR_CODES)) {
      expect(code.startsWith('import/')).toBe(true);
    }
  });

  it('covers the two the wizard reacts to by name', () => {
    // Named explicitly rather than counted: these two are load-bearing, because a stale plan
    // gets "run the preview again" and a stale undo gets "the vault moved on". Losing either
    // degrades it into the generic error slot with every other test still passing.
    expect(IMPORT_ERROR_CODES.stalePlan).toBe('import/stale-plan');
    expect(IMPORT_ERROR_CODES.staleUndo).toBe('import/stale-undo');
  });
});
