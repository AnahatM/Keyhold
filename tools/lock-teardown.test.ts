// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard: everything in the main process that holds material derived from the open vault is
 * torn down when the vault locks — and the teardown is *registered*, not merely written.
 *
 * This guards the seam, not the behaviour. `BreachService.reset()` has its own unit tests and
 * they pass whether or not anything ever calls it; that is precisely how audit finding N15
 * survived for as long as it did. The comment on `client.ts` said the lock path "should call"
 * `clearCache()`, the method was covered, and no caller existed. A finding of the form "this
 * is correct and unreachable" cannot be caught by testing the thing that is correct.
 *
 * So this reads the composition root as text and asserts the wire is there. Text, because the
 * alternative is booting Electron: `src/main/index.ts` calls `app.whenReady()` at module
 * scope and registers a `single-instance` lock, so importing it in a test is not a smaller
 * thing than running the app.
 *
 * **What the breach cache is.** Keyed by 20-bit hash prefix, one entry per password checked.
 * The set of live keys is a partial fingerprint of the passwords in the open vault, held in
 * main-process memory. It is not a password and it is not directly invertible — and it is
 * still material derived from the vault, surviving the one event whose entire meaning is that
 * nothing derived from the vault is still in memory.
 *
 * Fault injection performed: deleting the `session.onLock(() => { breach.reset(); })` block
 * from `src/main/index.ts` fails this test; changing it to call anything other than `reset`
 * fails it too. Both were reverted.
 */

const ROOT = resolve(import.meta.dirname, '..');
const INDEX = 'src/main/index.ts';

/**
 * Each teardown the lock owes, as the call that must appear inside an `onLock` registration.
 *
 * A list rather than one assertion because it will grow: anything that caches vault-derived
 * material in main belongs here the moment it is built, and a new entry costs one line.
 */
const LOCK_TEARDOWNS: readonly { readonly what: string; readonly call: string }[] = [
  {
    what: 'the breach range cache, whose keys are prefixes of the open vault’s passwords',
    call: 'breach.reset()',
  },
];

/** The body of every `session.onLock(...)` registration in the composition root. */
function onLockBodies(source: string): string {
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf('session.onLock(', from);
    if (start === -1) break;

    // Balanced from the opening paren, so a nested call or an arrow body does not end it
    // early. Cheap and exact enough for a file this shape; a parser would be more machinery
    // than the claim is worth.
    let depth = 0;
    let index = source.indexOf('(', start);
    const open = index;
    for (; index < source.length; index += 1) {
      const character = source[index];
      if (character === '(') depth += 1;
      else if (character === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies.push(source.slice(open, index + 1));
    from = index + 1;
  }
  return bodies.join('\n');
}

describe('what the lock takes with it', () => {
  const source = readFileSync(resolve(ROOT, INDEX), 'utf8');
  const registered = onLockBodies(source);

  it('registers at least one teardown, so the sweep below cannot pass vacuously', () => {
    expect(registered).not.toBe('');
    expect(LOCK_TEARDOWNS.length).toBeGreaterThan(0);
  });

  for (const { what, call } of LOCK_TEARDOWNS) {
    it(`drops ${what}`, () => {
      expect(
        registered,
        `${INDEX} must call ${call} from a session.onLock registration. A teardown that is ` +
          'written but never registered is finding N15 happening again.'
      ).toContain(call);
    });
  }
});
