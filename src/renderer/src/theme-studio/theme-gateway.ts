// SPDX-License-Identifier: GPL-3.0-or-later
import type { IpcResult } from '@shared/ipc/api.js';
import type { KeepTheme } from '@shared/theme/keeptheme.js';
import type {
  ThemeApi,
  ThemeExportResponse,
  ThemeImportResponse,
} from '@shared/theme/theme-channels.js';
import {
  readThemeExportResponse,
  readThemeImportResponse,
} from '@shared/theme/theme-validation.js';

/**
 * How the studio gets a `.keeptheme` on and off disk: over IPC, and only over IPC.
 *
 * ## What this replaced, and why
 *
 * This file used to be `theme-file-bridge.ts`, and it had two transports: the `kh:theme:*`
 * channels when they existed, and — because they did not — an `<input type="file">` and an
 * `<a download>`. The argument for the fallback was that a `.keeptheme` holds no secret
 * material, so the renderer may as well handle it. That argument is true about secrecy and
 * beside the point about everything else:
 *
 *  - An `<a download>` in a packaged Electron app is not a save dialog. It drops a file
 *    somewhere with a name the user did not choose and no overwrite warning, while every
 *    other file operation in Keyhold — vault open and save, attachment add and save, import,
 *    export — opens a real one in the main process.
 *  - An `<input type="file">` can only be reached by clicking inside one React screen. The
 *    OS already hands the app `.keeptheme` files on double-click, and a menu item is the
 *    obvious next place to put "Import a theme"; neither can start a hidden file input.
 *  - It put 64 KB of a stranger's file into the renderer to be parsed there. The parse now
 *    happens in the main process and the renderer is handed a projection — see
 *    `theme-channels.ts` for the full rule, and `theme-projection.ts` for where it is
 *    enforced. **Every palette value the studio receives is a `#rrggbb` literal the main
 *    process wrote**, which is what makes it safe to put one into a CSS custom property.
 *
 * ## Degrading honestly
 *
 * `window.keyhold.theme` is probed structurally, and when it is absent the studio says the
 * theme files are unavailable and disables the two buttons. It does **not** fall back to
 * anything. A fallback that is worse than the real path is a fallback that hides the fact
 * that the real path is missing — which is precisely how the browser transport survived as
 * long as it did.
 */

/** Anything that stopped the request before the main process could answer. */
export type ThemeGatewayFailure =
  /** `window.keyhold.theme` is not present — the channels are not wired in this build. */
  | { readonly kind: 'unavailable' }
  /** The call threw, failed, or came back in a shape this build does not recognise. */
  | { readonly kind: 'failed' };

export type ThemeImportOutcome = ThemeImportResponse | ThemeGatewayFailure;
export type ThemeExportOutcome = ThemeExportResponse | ThemeGatewayFailure;

export interface ThemeGateway {
  /** False when the channels are missing. The studio disables its file buttons. */
  readonly available: boolean;
  readonly importTheme: () => Promise<ThemeImportOutcome>;
  readonly exportTheme: (
    theme: KeepTheme,
    acknowledgement: string | null
  ) => Promise<ThemeExportOutcome>;
  /** A theme the OS handed the app, or `null` when none is waiting. */
  readonly takeOpenedTheme: () => Promise<ThemeImportOutcome | null>;
  /** Fires when the OS hands the app a theme. Returns an unsubscribe function. */
  readonly onFileOpened: (listener: () => void) => () => void;
}

/**
 * Probes for the namespace structurally.
 *
 * `KeyholdApi` is owned by `@shared/ipc/api.ts`, and this reads the property through a loose
 * record so the studio compiles whether or not that file has grown `theme: ThemeApi` yet.
 * The cast is narrow, it is here and nowhere else, and every method it produces is verified
 * to be a function before it is used — the type is a claim about a runtime boundary and this
 * is the boundary.
 */
function themeApi(): ThemeApi | null {
  const root = (globalThis as { keyhold?: Record<string, unknown> | undefined }).keyhold;
  if (root === undefined) return null;

  const namespace = root.theme;
  if (typeof namespace !== 'object' || namespace === null) return null;

  const candidate = namespace as Record<string, unknown>;
  const required = ['importTheme', 'exportTheme', 'takeOpenedTheme', 'onFileOpened'] as const;
  for (const name of required) {
    if (typeof candidate[name] !== 'function') return null;
  }

  return namespace as unknown as ThemeApi;
}

/**
 * Unwraps an `IpcResult` and re-validates its payload.
 *
 * The re-validation is not paranoia about our own main process: the preload is the only
 * thing between the two, `api.ts` is a compile-time claim about a runtime boundary, and
 * "schema-validated both ways" is written into the architecture rather than into whichever
 * half seemed likelier to be wrong. A response we cannot read becomes `failed` rather than
 * an exception, so a main-process bug is a message on screen and not a blank studio.
 */
function unwrap<T>(result: IpcResult<unknown>, read: (value: unknown) => T | null): T | null {
  if (!result.ok) return null;
  return read(result.value);
}

const UNAVAILABLE: ThemeGatewayFailure = { kind: 'unavailable' };
const FAILED: ThemeGatewayFailure = { kind: 'failed' };

export function createThemeGateway(): ThemeGateway {
  const api = themeApi();

  if (api === null) {
    return {
      available: false,
      importTheme: () => Promise.resolve(UNAVAILABLE),
      exportTheme: () => Promise.resolve(UNAVAILABLE),
      takeOpenedTheme: () => Promise.resolve(UNAVAILABLE),
      // A no-op unsubscribe, so callers need no branch of their own.
      onFileOpened: () => () => undefined,
    };
  }

  return {
    available: true,

    importTheme: async (): Promise<ThemeImportOutcome> => {
      try {
        return unwrap(await api.importTheme(), readThemeImportResponse) ?? FAILED;
      } catch {
        return FAILED;
      }
    },

    exportTheme: async (theme, acknowledgement): Promise<ThemeExportOutcome> => {
      try {
        const result = await api.exportTheme({ theme, acknowledgement });
        return unwrap(result, readThemeExportResponse) ?? FAILED;
      } catch {
        return FAILED;
      }
    },

    takeOpenedTheme: async (): Promise<ThemeImportOutcome | null> => {
      try {
        const result = await api.takeOpenedTheme();
        // `null` is the ordinary "nothing was waiting" answer and has to survive the
        // unwrap intact, so it is checked before the payload is read.
        if (!result.ok) return FAILED;
        if (result.value === null) return null;
        return readThemeImportResponse(result.value) ?? FAILED;
      } catch {
        return FAILED;
      }
    },

    onFileOpened: (listener) => api.onFileOpened(listener),
  };
}
