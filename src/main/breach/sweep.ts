// SPDX-License-Identifier: GPL-3.0-or-later
import type { BreachReport } from '@shared/model/breach.js';
import type { VaultDocument } from '@shared/model/vault-document.js';
import type { BreachCheckInput, BreachRunOptions, BreachRunSummary } from './client.js';
import { toBreachReport } from './projection.js';

/**
 * Sweeping an open vault, and the seam that keeps the passwords on this side of it.
 *
 * `PwnedPasswordsClient` knows how to check a list of passwords; `analyseVault` knows how to
 * read a document. Nothing joined them, which is why the whole breach subsystem was finished
 * and unreachable — every piece correct, and no function that turned "the vault" into "a list
 * to check". This is that function, and it is deliberately the only one.
 *
 * ## Why it takes a client rather than importing one
 *
 * `BreachSweepClient` is the *shape* `PwnedPasswordsClient` already has, not the class. So
 * this file — which handles every password in the vault at once — has no path to the network
 * in it at all, and cannot acquire one: whoever calls it decides whether a transport exists,
 * and `BreachService` is the only thing that builds one. `null` is a first-class argument
 * rather than an error, because "the user has not turned this on" is the normal case and
 * should produce a report saying so rather than a thrown exception the UI has to translate.
 *
 * ## What is skipped, and why each
 *
 * **Trashed records.** The same rule every health check follows: a record the user deleted is
 * not one they are asking about, and including it would put "your deleted Twitter password
 * was breached" in a report about the vault they actually use.
 *
 * **Records with no password.** Not reported as unknown, skipped entirely. There is nothing
 * to check, and counting them as "could not check" would inflate the one number in this
 * report whose whole job is to say how much of the answer is missing — the health rules
 * already flag an empty password as `incomplete`.
 */

/** What a sweep needs from a client. The shape `PwnedPasswordsClient` already has. */
export interface BreachSweepClient {
  checkMany(
    inputs: readonly BreachCheckInput[],
    options?: BreachRunOptions
  ): Promise<BreachRunSummary>;
}

export interface BreachSweepInput {
  readonly document: VaultDocument;
  /** `null` when the check is off, the kill-switch is down, or no vault is open. */
  readonly client: BreachSweepClient | null;
  readonly now: number;
  readonly signal?: AbortSignal | undefined;
}

export async function sweepVaultForBreaches(input: BreachSweepInput): Promise<BreachReport> {
  const inputs: BreachCheckInput[] = [];
  for (const record of input.document.records) {
    if (record.trashedAt !== null) continue;
    if (record.fields.password === '') continue;
    inputs.push({ credentialId: record.id, secretPassword: record.fields.password });
  }

  if (input.client === null) {
    // A report, not a throw. The dashboard renders this the same way it renders any other
    // incomplete run, so "you have not turned this on" and "the network was unreachable"
    // arrive through one path and cannot be styled inconsistently.
    return toBreachReport(
      { results: [], requestCount: 0, incompleteReason: 'disabled' },
      input.now
    );
  }

  const summary = await input.client.checkMany(inputs, { signal: input.signal });
  return toBreachReport(summary, input.now);
}
