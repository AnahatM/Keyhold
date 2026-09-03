// SPDX-License-Identifier: GPL-3.0-or-later
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { KEY_BYTES, type KdfParams } from '@shared/format/types.js';
import { estimateMs, kdfProgressAt, type KdfProgress } from './kdf-estimate.js';
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

/**
 * What the session needs from a key-derivation backend.
 *
 * An interface rather than the concrete class so tests can supply an in-process
 * implementation: the worker is loaded from a BUILT file path, which does not exist when
 * running the source directly.
 *
 * Deliberately not a silent fallback inside `KdfRunner` — a missing worker in a packaged
 * app is a real bug, and quietly deriving on the main thread instead would hide it behind
 * a frozen window rather than a clear failure.
 */
export interface KdfProvider {
  derive(password: string, params: KdfParams, hashLength?: number): Promise<SecretBytes>;
  dispose(): void;
}

/** Derives in-process. For tests only — this blocks the calling thread. */
export class InProcessKdf implements KdfProvider {
  async derive(password: string, params: KdfParams, hashLength = KEY_BYTES): Promise<SecretBytes> {
    assertUsableKdfParams(params);
    const { deriveKey } = await import('./kdf.js');
    return deriveKey({ password, params, ...(hashLength === KEY_BYTES ? {} : {}) });
  }

  dispose(): void {
    // Nothing to tear down.
  }
}

/** How often the progress estimate is recomputed while a derivation is in flight. */
const PROGRESS_TICK_MS = 100;

export interface KdfRunnerOptions {
  /**
   * Called on a timer while a derivation runs, and never after it settles.
   *
   * The position is predicted rather than measured — see `kdf-estimate.ts` for why Argon2 can
   * report nothing of its own. This is a UI signal and nothing else: no caller waits on it,
   * and a listener that throws must not take a derivation down with it.
   */
  readonly onProgress?: ((progress: KdfProgress) => void) | undefined;
  /**
   * This machine's learned milliseconds-per-cost-unit, or `null` before anything is known.
   *
   * A function rather than a value: it is kept in machine preferences and updated after every
   * derivation, so a value captured at construction would be the one from before this session
   * started learning.
   */
  readonly rate?: (() => number | null) | undefined;
  /** How long a derivation actually took, so the rate can move toward the truth. */
  readonly onMeasured?: ((params: KdfParams, measuredMs: number) => void) | undefined;
}

export class KdfRunner implements KdfProvider {
  #worker: Worker | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #idleTimer: NodeJS.Timeout | undefined;
  readonly #workerPath: string;
  readonly #options: KdfRunnerOptions;

  constructor(
    workerPath = join(import.meta.dirname, 'kdf-worker.js'),
    options: KdfRunnerOptions = {}
  ) {
    this.#workerPath = workerPath;
    this.#options = options;
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

    // Started before the message is posted, so the estimate covers the whole wait the user
    // sees — including the worker's own start-up on the first derivation of a session, which
    // is real time they are looking at a bar.
    const startedAt = performance.now();
    const stopTicking = this.#startProgress(params, startedAt);

    try {
      const key = await new Promise<SecretBytes>((resolve, reject) => {
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

      // Only a derivation that finished is a measurement of how long one takes. A rejection
      // is a timeout or a dead worker, and folding either into the rate would teach the
      // estimator that this machine is enormously slow on the strength of it not working.
      this.#options.onMeasured?.(params, performance.now() - startedAt);
      return key;
    } finally {
      // In a `finally` for the same reason the write guard is: a derivation that throws must
      // still stop the ticker, or the bar keeps climbing over a screen that has given up.
      stopTicking();
    }
  }

  /**
   * Emits a predicted position every {@link PROGRESS_TICK_MS} until the returned stop is called.
   *
   * Silent when no listener was supplied, which is the case in every test that does not care
   * and in `InProcessKdf` entirely — a timer that exists to call nothing is a timer keeping a
   * process awake for no reason.
   */
  #startProgress(params: KdfParams, startedAt: number): () => void {
    const onProgress = this.#options.onProgress;
    if (onProgress === undefined) return () => undefined;

    const estimated = estimateMs(params, this.#options.rate?.() ?? null);

    const tick = (): void => {
      try {
        onProgress(kdfProgressAt(performance.now() - startedAt, estimated));
      } catch (error) {
        // Swallowed deliberately. This is a progress bar; a listener that throws must not be
        // able to fail an unlock.
        console.error('[kdf] a progress listener threw:', error);
      }
    };

    tick();
    const interval = setInterval(tick, PROGRESS_TICK_MS);
    // Never hold the process open for a progress bar.
    interval.unref();

    return () => {
      clearInterval(interval);
    };
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
