// SPDX-License-Identifier: GPL-3.0-or-later
import { parentPort } from 'node:worker_threads';
import { argon2id } from 'hash-wasm';
import type { KdfParams } from '@shared/format/types.js';

/**
 * Runs Argon2id on a worker thread.
 *
 * Argon2 is deliberately slow and deliberately memory-hard — that is the entire point of
 * choosing it. It is also **CPU-bound and synchronous inside the WASM module**, so running
 * it on the main thread blocks Electron's event loop for the full half-second or more.
 *
 * A blocked main process is not a subtle problem: the window stops repainting, the
 * progress indicator freezes at whatever frame it reached, and the OS marks the app as
 * "not responding". Which is to say the moment the app looks most broken is the moment it
 * is doing its most important work.
 *
 * Note that the renderer being a separate process does NOT solve this. The renderer stays
 * responsive, but it cannot paint anything the main process has not sent it, and every IPC
 * reply is queued behind the blocked loop. The work has to leave the main thread.
 *
 * This file is a separate build entry point — see `electron.vite.config.ts`.
 */

export interface KdfRequest {
  readonly id: number;
  readonly password: string;
  readonly params: KdfParams;
  readonly hashLength: number;
}

export type KdfResponse =
  | { readonly id: number; readonly ok: true; readonly key: Uint8Array }
  | { readonly id: number; readonly ok: false; readonly error: string };

if (parentPort === null) {
  throw new Error('kdf-worker must be started as a worker thread.');
}

const port = parentPort;

port.on('message', (request: KdfRequest) => {
  void (async () => {
    try {
      const key = await argon2id({
        password: request.password,
        salt: new Uint8Array(Buffer.from(request.params.salt, 'base64')),
        memorySize: request.params.memoryKib,
        iterations: request.params.iterations,
        parallelism: request.params.parallelism,
        hashLength: request.hashLength,
        outputType: 'binary',
      });

      // Transferred rather than copied, so the derived key exists in exactly one place
      // and this thread's copy is detached the moment it is sent. The cast is needed
      // because `Uint8Array.buffer` is typed as `ArrayBufferLike`, which could in
      // principle be a SharedArrayBuffer; hash-wasm always returns a plain one.
      port.postMessage({ id: request.id, ok: true, key } satisfies KdfResponse, [
        key.buffer as ArrayBuffer,
      ]);
    } catch (error) {
      // Never include the password or any derived material in the message — a worker
      // error surfaces in logs like any other.
      port.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : 'Key derivation failed.',
      } satisfies KdfResponse);
    }
  })();
});
