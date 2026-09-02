// SPDX-License-Identifier: GPL-3.0-or-later
import type { KeyholdApi } from '@shared/ipc/api.js';

declare global {
  interface Window {
    /** The allow-listed bridge to the main process. See src/preload/index.ts. */
    keyhold: KeyholdApi;
  }
}

export {};
