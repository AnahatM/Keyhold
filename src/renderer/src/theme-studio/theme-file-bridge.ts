// SPDX-License-Identifier: GPL-3.0-or-later
import { KEEPTHEME_EXTENSION, KEEPTHEME_MAX_BYTES } from '@shared/theme/keeptheme.js';

/**
 * How the studio gets a `.keeptheme` on and off disk.
 *
 * ## Why the renderer is allowed to touch this one file type at all
 *
 * Everything else in Keyhold goes through the main process, because the main process owns
 * the keys and the decrypted vault (decision D13). A `.keeptheme` is the deliberate
 * exception and it is worth stating rather than leaving to look like a hole: it holds **no
 * secret material**, it is not encrypted, and it is meant to be shared. Nothing about
 * reading or writing one touches the security boundary.
 *
 * Two transports, one behaviour:
 *
 *  - **native** — `window.keyhold.theme.*`, when the IPC namespace is present. Native
 *    dialogs, opened by the main process, with the size cap enforced by `stat` before a
 *    byte is read.
 *  - **browser** — a plain `<input type="file">` and a blob download. Standard web APIs,
 *    no Node, no new dependency. The user picking a file in the OS dialog is the same act
 *    of consent either way.
 *
 * The bridge moves **raw text only**. `parseKeepTheme` runs once, in the studio, so the two
 * transports cannot validate differently — and so the acknowledgement round trip (parse,
 * show the failures, re-parse with the token) does not need a process hop per attempt.
 */

export interface ThemeFileContents {
  /** The file's own name, for "imported from …". Never a path. */
  readonly name: string;
  readonly contents: string;
}

export type ThemeSaveOutcome = 'saved' | 'cancelled' | 'failed';

export type ThemeOpenOutcome =
  | { readonly kind: 'opened'; readonly file: ThemeFileContents }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'too-large'; readonly name: string }
  | { readonly kind: 'failed' };

export interface ThemeFileBridge {
  readonly kind: 'native' | 'browser';
  readonly openTheme: () => Promise<ThemeOpenOutcome>;
  readonly saveTheme: (fileName: string, contents: string) => Promise<ThemeSaveOutcome>;
}

/** The shape the studio needs from `window.keyhold.theme`, if it is ever wired up. */
interface NativeThemeChannel {
  readonly chooseAndRead: () => Promise<unknown>;
  readonly chooseAndWrite: (fileName: string, contents: string) => Promise<unknown>;
}

/**
 * Probes for the native channel structurally rather than by type.
 *
 * `window.keyhold` is typed as `KeyholdApi`, which has no `theme` namespace yet. Reaching
 * for it through a loose record is honest about that: the studio works today over the
 * browser transport and picks up the native one the moment the IPC contract grows it,
 * without a build-time dependency on a channel that may not exist.
 */
function nativeChannel(): NativeThemeChannel | null {
  const root = (globalThis as { keyhold?: Record<string, unknown> }).keyhold;
  if (root === undefined) return null;

  const theme = root.theme as Record<string, unknown> | undefined;
  if (theme === undefined) return null;

  const chooseAndRead = theme.chooseAndRead;
  const chooseAndWrite = theme.chooseAndWrite;
  if (typeof chooseAndRead !== 'function' || typeof chooseAndWrite !== 'function') return null;

  return {
    chooseAndRead: chooseAndRead as () => Promise<unknown>,
    chooseAndWrite: chooseAndWrite as (fileName: string, contents: string) => Promise<unknown>,
  };
}

/** Unwraps the project's `IpcResult` shape without importing a type the channel may not use. */
function unwrap(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return null;
  const result = value as { ok?: unknown; value?: unknown };
  return result.ok === true ? (result.value ?? null) : null;
}

function readContents(value: unknown): ThemeFileContents | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { fileName?: unknown; contents?: unknown };
  if (typeof candidate.fileName !== 'string' || typeof candidate.contents !== 'string') return null;
  return { name: candidate.fileName, contents: candidate.contents };
}

function createNativeBridge(channel: NativeThemeChannel): ThemeFileBridge {
  return {
    kind: 'native',
    openTheme: async (): Promise<ThemeOpenOutcome> => {
      // The main side already enforces the size cap with `stat`, so an over-large file
      // never comes back as content — it comes back as a failure, like any other.
      const file = readContents(unwrap(await channel.chooseAndRead()));
      return file === null ? { kind: 'cancelled' } : { kind: 'opened', file };
    },
    saveTheme: async (fileName, contents): Promise<ThemeSaveOutcome> => {
      const written = unwrap(await channel.chooseAndWrite(fileName, contents));
      if (written === null) return 'cancelled';
      return typeof written === 'string' ? 'saved' : 'failed';
    },
  };
}

function createBrowserBridge(): ThemeFileBridge {
  return {
    kind: 'browser',

    openTheme: (): Promise<ThemeOpenOutcome> =>
      new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = `.${KEEPTHEME_EXTENSION},application/json`;
        // Kept out of the layout entirely: an off-screen input is still focusable, and a
        // stray tab stop in Settings is a real keyboard-navigation bug.
        input.hidden = true;

        let settled = false;
        const finish = (outcome: ThemeOpenOutcome): void => {
          if (settled) return;
          settled = true;
          input.remove();
          resolve(outcome);
        };

        input.addEventListener('cancel', () => {
          finish({ kind: 'cancelled' });
        });

        input.addEventListener('change', () => {
          const file = input.files?.[0];
          if (file === undefined) {
            finish({ kind: 'cancelled' });
            return;
          }
          if (file.size > KEEPTHEME_MAX_BYTES) {
            // Refused before `text()` allocates it. `parseKeepTheme` would refuse it too,
            // but only after the whole file was already in memory.
            finish({ kind: 'too-large', name: file.name });
            return;
          }
          void file.text().then(
            (contents) => {
              finish({ kind: 'opened', file: { name: file.name, contents } });
            },
            () => {
              finish({ kind: 'failed' });
            }
          );
        });

        document.body.append(input);
        input.click();
      }),

    saveTheme: (fileName, contents): Promise<ThemeSaveOutcome> => {
      try {
        const blob = new Blob([contents], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        anchor.hidden = true;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        // Revoked on the next task, not immediately: revoking synchronously after `click`
        // races the download starting, and the file arrives empty on the losing side.
        window.setTimeout(() => {
          URL.revokeObjectURL(url);
        }, 0);
        return Promise.resolve('saved');
      } catch {
        return Promise.resolve('failed');
      }
    },
  };
}

export function createThemeFileBridge(): ThemeFileBridge {
  const channel = nativeChannel();
  return channel === null ? createBrowserBridge() : createNativeBridge(channel);
}
