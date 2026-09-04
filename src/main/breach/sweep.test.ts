// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Credential } from '@shared/model/credential.js';
import { bareRecord, buildDocument } from '../export/test-fixtures.js';
import type { BreachCheckInput, BreachRunSummary } from './client.js';
import { PwnedPasswordsClient } from './client.js';
import { sweepVaultForBreaches, type BreachSweepClient } from './sweep.js';

/**
 * The join between "the vault" and "a list of passwords to check".
 *
 * Small, and the most security-sensitive function in the subsystem, because it is the one
 * place where every password in the vault is in one array at once. The cases below are
 * therefore mostly about **what never gets into that array**.
 *
 * Fault injections performed:
 *
 * 1. **The trashed-record skip removed.** `does not check a record the user deleted` failed
 *    with the deleted record's password in the collected inputs. That is a report telling
 *    somebody their deleted account was breached — advice about a password they already
 *    decided they were done with, from a vault they think of as not containing it.
 * 2. **The empty-password skip removed.** `does not count a record with no password` failed:
 *    the record arrived as an `unknown` result and inflated `unknownCount`, which is the one
 *    number in this report whose whole job is to say how much of the answer is missing.
 * 3. **`client: null` made to throw instead of reporting.** `reports rather than throws when
 *    the check is off` failed. Off is the default state of this entire feature, so the
 *    disabled path is the *common* one, and a throw there would make the dashboard's normal
 *    appearance an error state.
 * 4. **`now` replaced with `Date.now()` inside the sweep.** Caught nothing, and that is
 *    recorded rather than hidden: no case here asserts the timestamp, because a report whose
 *    `generatedAt` is off by milliseconds harms nobody. The parameter exists so the function
 *    stays pure, which is a property of the design rather than a claim a test can make.
 */

const NOW = Date.UTC(2026, 1, 3, 4, 5, 6);

/** Records what it was asked to check, so the assertions can be about the inputs. */
function spyClient(summary?: Partial<BreachRunSummary>): {
  readonly client: BreachSweepClient;
  readonly seen: BreachCheckInput[];
} {
  const seen: BreachCheckInput[] = [];
  return {
    seen,
    client: {
      checkMany: (inputs) => {
        seen.push(...inputs);
        return Promise.resolve({
          results: inputs.map((input) => ({
            credentialId: input.credentialId,
            status: 'safe' as const,
            count: 0,
            reason: null,
          })),
          requestCount: 1,
          incompleteReason: null,
          ...summary,
        });
      },
    },
  };
}

function documentOf(records: readonly Credential[]): ReturnType<typeof buildDocument> {
  return buildDocument(records);
}

describe('what reaches the client', () => {
  it('checks every live record that has a password', async () => {
    const { client, seen } = spyClient();
    const document = documentOf([
      bareRecord({ id: 'a', title: 'A', password: 'first-password' }),
      bareRecord({ id: 'b', title: 'B', password: 'second-password' }),
    ]);

    const report = await sweepVaultForBreaches({ document, client, now: NOW });

    expect(seen.map((input) => input.credentialId).sort()).toEqual(['a', 'b']);
    expect(report.checkedCount).toBe(2);
    expect(report.safeCount).toBe(2);
  });

  it('does not check a record the user deleted', async () => {
    const { client, seen } = spyClient();
    const document = documentOf([
      bareRecord({ id: 'live', title: 'Live', password: 'kept-password' }),
      bareRecord({ id: 'gone', title: 'Gone', password: 'deleted-password', trashedAt: NOW - 10 }),
    ]);

    await sweepVaultForBreaches({ document, client, now: NOW });

    expect(seen.map((input) => input.credentialId)).toEqual(['live']);
    // Asserted on the value too, not only the id. The id is what the report keys on; the
    // password is the thing that must not have left the record at all.
    expect(seen.map((input) => input.secretPassword)).not.toContain('deleted-password');
  });

  it('does not count a record with no password as one it could not check', async () => {
    const { client, seen } = spyClient();
    const document = documentOf([
      bareRecord({ id: 'has', title: 'Has', password: 'a-real-password' }),
      bareRecord({ id: 'none', title: 'None', password: '' }),
    ]);

    const report = await sweepVaultForBreaches({ document, client, now: NOW });

    expect(seen).toHaveLength(1);
    expect(report.checkedCount).toBe(1);
    expect(report.unknownCount).toBe(0);
  });
});

describe('when the check is off', () => {
  it('reports rather than throws, because off is the normal state', async () => {
    const document = documentOf([bareRecord({ id: 'a', title: 'A', password: 'p' })]);

    const report = await sweepVaultForBreaches({ document, client: null, now: NOW });

    expect(report.incompleteReason).toBe('disabled');
    expect(report.checkedCount).toBe(0);
    expect(report.requestCount).toBe(0);
    expect(report.results).toEqual([]);
  });

  it('makes no request, which is the whole point of the default', async () => {
    // `client: null` is not "a client that declines" — there is no client, so there is no
    // transport, so no password here is even hashed. The assertion is that nothing was asked.
    const { client, seen } = spyClient();
    const document = documentOf([bareRecord({ id: 'a', title: 'A', password: 'p' })]);

    await sweepVaultForBreaches({ document, client: null, now: NOW });

    expect(seen).toEqual([]);
    expect(client).toBeDefined();
  });
});

describe('the report it produces', () => {
  it('carries no password, and no count, for any record', async () => {
    // The projection boundary, asserted from this side. `BreachProjection` reduces a hit
    // count to a band on purpose — "seen 3 times" and "seen 24 million times" are different
    // advice, and both are facts *about a password*.
    const { client } = spyClient({
      results: [{ credentialId: 'a', status: 'breached', count: 24_230_577, reason: null }],
    });
    const document = documentOf([
      bareRecord({ id: 'a', title: 'A', password: 'correct-horse-battery-staple' }),
    ]);

    const report = await sweepVaultForBreaches({ document, client, now: NOW });
    const serialised = JSON.stringify(report);

    expect(serialised).not.toContain('correct-horse-battery-staple');
    expect(serialised).not.toContain('24230577');
    expect(report.results[0]?.band).toBe('severe');
  });

  /**
   * The abort path, end to end, through the real client.
   *
   * The check above proves only that the signal is handed over — which is what the ledger
   * called out as insufficient, and it was right: a sweep that passed the signal to a client
   * that ignored it would satisfy it completely. What matters to a user is the *report*, and
   * specifically that a run they stopped does not come back reading like a clean one.
   *
   * So this uses `PwnedPasswordsClient` itself with a fake transport, and asserts the three
   * things that would each be a lie on their own: the reason is `cancelled` and not `offline`
   * or `timeout`; the headline refuses to claim a clean result; and no record is reported as
   * `safe` on the strength of an answer that never arrived.
   */
  it('reports a cancelled run as cancelled, all the way out to the report', async () => {
    const controller = new AbortController();
    controller.abort();

    const client = new PwnedPasswordsClient({
      // Booby-trapped rather than merely unused: if cancellation stopped working, this says so
      // loudly here instead of letting the assertions below fail for an unrelated reason.
      transport: {
        fetchRange: () => {
          throw new Error('a cancelled sweep must not reach the transport');
        },
      },
      requestIntervalMs: 0,
    });

    const report = await sweepVaultForBreaches({
      document: documentOf([
        bareRecord({ id: 'a', title: 'A', password: 'password' }),
        bareRecord({ id: 'b', title: 'B', password: 'hunter2' }),
      ]),
      client,
      now: NOW,
      signal: controller.signal,
    });

    expect(report.incompleteReason).toBe('cancelled');
    expect(report.requestCount).toBe(0);
    // The number that must never be inflated by a run that did not happen.
    expect(report.safeCount).toBe(0);
    expect(report.breachedCount).toBe(0);
    expect(report.unknownCount).toBe(2);
  });

  it('passes the abort signal through, so a slow sweep can be cancelled', async () => {
    let seenSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const client: BreachSweepClient = {
      checkMany: (_inputs, options) => {
        seenSignal = options?.signal;
        return Promise.resolve({ results: [], requestCount: 0, incompleteReason: null });
      },
    };

    await sweepVaultForBreaches({
      document: documentOf([bareRecord({ id: 'a', title: 'A', password: 'p' })]),
      client,
      now: NOW,
      signal: controller.signal,
    });

    expect(seenSignal).toBe(controller.signal);
  });

  it('stamps the report with the caller’s clock, not its own', async () => {
    const { client } = spyClient();
    const report = await sweepVaultForBreaches({
      document: documentOf([bareRecord({ id: 'a', title: 'A', password: 'p' })]),
      client,
      now: NOW,
    });

    expect(report.generatedAt).toBe(NOW);
  });
});
