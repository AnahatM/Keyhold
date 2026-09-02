// SPDX-License-Identifier: GPL-3.0-or-later
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { KEY_BYTES, type KdfParams } from '@shared/format/types.js';
import { assertUsableKdfParams } from './kdf.js';
import { SecretBytes } from './secret.js';
import type { KdfRequest, KdfResponse } from './kdf-worker.js';

/**
 * Owns the Argon2 worker thread and the requests in flight on it.
 *
 * Deliberately **one worker, one request at a time**. Argon2 with the default parameters
 * asks for 64 MiB and four lanes; running several concurrently would multiply that and can
 * genuinely exhaust memory on a modest machine. There is also no real use case for
 * concurrency here — a person unlocks one vault at a time.
 *
 * The worker is created lazily and torn down when idle, so the memory is not held for the
 * whole session just in case someone unlocks something later.
 */

/** How long an idle worker is kept alive before being disposed of. */
const IDLE_TIMEOUT_MS = 30_000;

/**
 * A ceiling on one derivation.
 *
 * Not arbitrary: a vault header can legitimately ask for 2 GiB and 32 iterations, which is
 * slow but valid. What this catches is a wedged worker — if the promise never settles,
 * the unlock screen would spin forever with no way back.
 */
const DERIVATION_TIMEOUT_MS = 120_000;

interface Pending {
  readonly resolve: (key: SecretBytes) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class KdfRunner {
  #worker: Worker | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #idleTimer: NodeJS.Timeout | undefined;
  readonly #workerPath: string;

  constructor(workerPath = join(import.meta.dirname, 'kdf-worker.js')) {
    this.#workerPath = workerPath;
  }

  /**
   * Derives a key without blocking the main thread.
   *
   * Validates the parameters here rather than in the worker: a hostile vault header is
   * rejected before 2 GiB is allocated on another thread, not after.
   */
  async derive(password: string, params: KdfParams, hashLength = KEY_BYTES): Promise<SecretBytes> {
    assertUsableKdfParams(params);

    const worker = this.#ensureWorker();
    const id = this.#nextId++;

    return new Promise<SecretBytes>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(
            'Key derivation did not finish in time. The vault may be configured with a cost this machine cannot meet.'
          )
        );
        // A worker that missed its deadline is in an unknown state; replace it rather
        // than reusing it for the next attempt.
        this.#disposeWorker();
      }, DERIVATION_TIMEOUT_MS);

      this.#pending.set(id, { resolve, reject, timer });

      const request: KdfRequest = { id, password, params, hashLength };
      worker.postMessage(request);
    });
  }

  /** Tears the worker down. Safe to call at any time; a new one is created on demand. */
  dispose(): void {
    this.#disposeWorker();
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Key derivation was cancelled.'));
    }
    this.#pending.clear();
  }

  #ensureWorker(): Worker {
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    if (this.#worker !== null) return this.#worker;

    const worker = new Worker(this.#workerPath);

    worker.on('message', (response: KdfResponse) => {
      const pending = this.#pending.get(response.id);
      if (pending === undefined) return;

      this.#pending.delete(response.id);
      clearTimeout(pending.timer);

      if (response.ok) {
        pending.resolve(SecretBytes.adopt(response.key));
      } else {
        pending.reject(new Error(response.error));
      }
      this.#scheduleIdleShutdown();
    });

    worker.on('error', (error) => {
      // Every in-flight request fails together: the worker is gone and none of them can
      // ever be answered.
      for (const [, pending] of this.#pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
      this.#worker = null;
    });

    worker.on('exit', () => {
      this.#worker = null;
    });

    // Without this the worker keeps the process alive after the last window closes, and
    // the app never quits.
    worker.unref();

    this.#worker = worker;
    return worker;
  }

  #scheduleIdleShutdown(): void {
    if (this.#pending.size > 0) return;
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.#disposeWorker();
    }, IDLE_TIMEOUT_MS);
  }

  #disposeWorker(): void {
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    if (this.#worker === null) return;
    void this.#worker.terminate();
    this.#worker = null;
  }
}
