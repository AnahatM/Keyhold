// SPDX-License-Identifier: GPL-3.0-or-later
import {
  ACTIVITY_LEVEL_DETAIL,
  ACTIVITY_LOG_CAPACITY,
  emptyActivityTotals,
  type ActivityEntry,
  type ActivityKind,
  type ActivityLockReason,
  type ActivitySnapshot,
  type ActivityUnlockMethod,
} from '@shared/model/activity.js';
import type { AuditPrivacyLevel, SecretRef } from '@shared/model/credential.js';

/**
 * The session activity log.
 *
 * A bounded, in-memory record of what this session did: what was unlocked, what failed,
 * what was revealed, what was copied, what was saved. It is the consumer the secret
 * broker's header names, and it exists to answer one question a password manager otherwise
 * cannot: *"did something just walk my vault?"*
 *
 * ## Four decisions, and why each is the way round it is
 *
 * **It is never persisted, and there is no option to persist it.** A durable log of which
 * credentials were revealed and when is a second, unencrypted index of the vault's
 * contents — it says which accounts exist, which are used, and how often, and it says it in
 * a file that survives the lock. The vault's own encrypted history already records every
 * *change* with provenance; that is the durable audit trail, and it is durable precisely
 * because it lives inside the ciphertext. This log covers the actions history cannot —
 * reads — and reads are the ones whose durable record would be most dangerous. If a
 * persisted variant is ever wanted it must be a decision-log entry and it must default to
 * off; nothing in this file should be reused to build one by accident, which is why there is
 * no serialiser.
 *
 * **It holds ids and counts, never values and never names.** See the header of
 * `@shared/model/activity.ts`. The entry type has no field that could hold a secret, and no
 * field that could hold a title.
 *
 * **It is cleared on lock**, like the broker's grants. A lock that leaves behind a list of
 * everything the session revealed is a lock in name only, and it is a list an attacker who
 * sits down at the locked machine would find more useful than the lock screen.
 *
 * **It is a ring, not a list.** Bounded at `ACTIVITY_LOG_CAPACITY`. The workload that
 * overflows it — a bulk import, a runaway reveal loop — is exactly the workload where an
 * unbounded log would allocate hardest, so the bound matters most at the moment it bites.
 * Because entries are evicted, `totals` and `droppedCount` are tracked separately: an
 * under-reported count during a harvest would defeat the whole purpose.
 *
 * The core is pure over an injected clock. Nothing here touches Electron, the filesystem,
 * or the vault.
 */

export interface ActivityLogOptions {
  readonly capacity?: number;
  /** Injectable so tests do not have to sleep. */
  readonly now?: () => number;
  /** Governs `subjectId` and `vaultLabel`, exactly as it governs `ChangeOrigin`. */
  readonly privacyLevel?: AuditPrivacyLevel;
}

/**
 * What a call site asks to be recorded.
 *
 * Detail fields are *requested* here and *granted or dropped* by the log, so a call site
 * cannot bypass the privacy level by assembling an entry itself.
 */
export interface ActivityInput {
  readonly kind: ActivityKind;
  readonly subjectId?: string;
  readonly vaultLabel?: string;
  readonly count?: number;
  readonly secretKind?: SecretRef['kind'];
  readonly lockReason?: ActivityLockReason;
  readonly unlockMethod?: ActivityUnlockMethod;
}

export class ActivityLog {
  readonly #capacity: number;
  readonly #now: () => number;

  /**
   * A fixed-size ring. `#head` is the index of the oldest live entry; `#count` is how many
   * are live. Overwriting in place rather than `shift()`-ing an array keeps a record at
   * capacity O(1) instead of O(n) — which matters because the only time the buffer is full
   * is the only time records arrive in a burst.
   */
  #buffer: (ActivityEntry | undefined)[];
  #head = 0;
  #count = 0;

  #seq = 0;
  #dropped = 0;
  #startedAt: number | null = null;
  #totals = emptyActivityTotals();
  #level: AuditPrivacyLevel;

  constructor(options: ActivityLogOptions = {}) {
    const capacity = options.capacity ?? ACTIVITY_LOG_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 1) {
      // Loud rather than clamped. A log configured to hold nothing would silently record
      // nothing, and the first person to notice would be someone who needed it.
      throw new RangeError(`Activity log capacity must be a positive integer, got ${capacity}.`);
    }

    this.#capacity = capacity;
    this.#now = options.now ?? Date.now;
    this.#level = options.privacyLevel ?? 'device';
    this.#buffer = new Array<ActivityEntry | undefined>(capacity).fill(undefined);
  }

  get capacity(): number {
    return this.#capacity;
  }

  get size(): number {
    return this.#count;
  }

  get droppedCount(): number {
    return this.#dropped;
  }

  get privacyLevel(): AuditPrivacyLevel {
    return this.#level;
  }

  /**
   * Applies the vault's audit privacy level.
   *
   * Called when a vault opens, because the level is a vault setting rather than an app
   * preference. Entries already recorded are not rewritten — they were captured under the
   * level in force at the time, and retroactively editing an audit record would be a worse
   * habit than the one it fixed. In practice the log is empty at that moment anyway, since
   * it was cleared by the lock that preceded the unlock.
   */
  setPrivacyLevel(level: AuditPrivacyLevel): void {
    this.#level = level;
  }

  /**
   * Records one action and returns the entry as stored.
   *
   * Detail fields are assigned through a single gate rather than gathered and filtered
   * afterwards — the same reasoning as `OriginCapture.capture`: a field that was never
   * assigned cannot leak, while one forgotten `delete` on a fully-built object puts a
   * credential id in a log the user asked to be anonymous.
   */
  record(input: ActivityInput): ActivityEntry {
    const at = this.#now();
    this.#seq += 1;

    const entry: {
      seq: number;
      at: number;
      kind: ActivityKind;
      subjectId?: string;
      vaultLabel?: string;
      count?: number;
      secretKind?: SecretRef['kind'];
      lockReason?: ActivityLockReason;
      unlockMethod?: ActivityUnlockMethod;
    } = { seq: this.#seq, at, kind: input.kind };

    const permitted = new Set<string>(ACTIVITY_LEVEL_DETAIL[this.#level]);
    if (permitted.has('subjectId') && input.subjectId !== undefined) {
      entry.subjectId = input.subjectId;
    }
    if (permitted.has('vaultLabel') && input.vaultLabel !== undefined) {
      entry.vaultLabel = input.vaultLabel;
    }

    // Not gated: these describe the action rather than the user's situation. See the notes
    // on the fields in `@shared/model/activity.ts`.
    if (input.count !== undefined) entry.count = input.count;
    if (input.secretKind !== undefined) entry.secretKind = input.secretKind;
    if (input.lockReason !== undefined) entry.lockReason = input.lockReason;
    if (input.unlockMethod !== undefined) entry.unlockMethod = input.unlockMethod;

    const stored: ActivityEntry = entry;

    this.#totals[input.kind] += 1;
    this.#startedAt ??= at;
    this.#push(stored);

    return stored;
  }

  /** Oldest first. A copy, so a caller cannot mutate the ring by holding onto the result. */
  entries(): ActivityEntry[] {
    const out: ActivityEntry[] = [];
    for (let offset = 0; offset < this.#count; offset += 1) {
      const entry = this.#buffer[(this.#head + offset) % this.#capacity];
      // Unreachable while `#count` is correct, and cheap insurance against it not being:
      // a hole in the ring must not become an `undefined` in a rendered list.
      if (entry !== undefined) out.push(entry);
    }
    return out;
  }

  snapshot(): ActivitySnapshot {
    return {
      entries: this.entries(),
      totals: { ...this.#totals },
      droppedCount: this.#dropped,
      capacity: this.#capacity,
      startedAt: this.#startedAt,
    };
  }

  /**
   * Drops everything. Called on lock, on window close, and on quit.
   *
   * The buffer is refilled with `undefined` rather than just resetting the indices, so no
   * entry stays reachable from the array after the session that produced it has ended.
   * `#seq` deliberately survives — see the note on `ActivityEntry.seq`.
   */
  clear(): void {
    this.#buffer.fill(undefined);
    this.#head = 0;
    this.#count = 0;
    this.#dropped = 0;
    this.#startedAt = null;
    this.#totals = emptyActivityTotals();
  }

  #push(entry: ActivityEntry): void {
    if (this.#count < this.#capacity) {
      this.#buffer[(this.#head + this.#count) % this.#capacity] = entry;
      this.#count += 1;
      return;
    }

    // Full: the oldest entry is overwritten and the window slides forward.
    this.#buffer[this.#head] = entry;
    this.#head = (this.#head + 1) % this.#capacity;
    this.#dropped += 1;
  }
}
