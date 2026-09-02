// SPDX-License-Identifier: GPL-3.0-or-later
import { clipboard, ClipboardItem } from 'electron';

/**
 * Copying a secret to the clipboard, and getting it back out again.
 *
 * The clipboard is the leakiest part of any password manager, and the leak is not the copy
 * itself — it is everything the OS does with it afterwards:
 *
 *  - **Windows clipboard history** (Win+V) keeps the last 25 entries indefinitely, and
 *    **cloud clipboard** syncs them to every machine signed into the same Microsoft
 *    account. A password copied once can end up on a device the user is not even holding.
 *  - **macOS clipboard managers** — Alfred, Raycast, Paste and many others — record every
 *    pasteboard change by design.
 *  - Any application can read the clipboard at any time, with no permission prompt.
 *
 * So a secret is written with **format markers asking the OS and well-behaved clipboard
 * managers not to retain it**, and it is cleared on a timer regardless.
 *
 * The honest limit, which the threat model states: those markers are advisory. A clipboard
 * manager that ignores them still records the value. Clearing on a timer is the part that
 * does not depend on anyone else's cooperation.
 *
 * ## API note
 *
 * Electron 44 replaced the synchronous `clipboard.writeText()` with a Promise-based,
 * W3C-aligned API built on MIME-keyed `ClipboardItem`s. Platform-specific formats go
 * through the `electron application/osclipboard;format="…"` custom type. Everything here
 * is therefore async, which is why `clearOnExit` exists separately — see its comment.
 */

export const DEFAULT_CLEAR_AFTER_MS = 30_000;

const TEXT = 'text/plain';

/** Wraps a native clipboard format name in Electron's custom-format MIME syntax. */
const osFormat = (name: string): string => `electron application/osclipboard;format="${name}"`;

/**
 * Windows: asks the shell not to place this entry in clipboard history or sync it to the
 * cloud. Honoured by the OS itself, not only by third-party tools.
 */
const WINDOWS_MARKERS = [
  'ExcludeClipboardContentFromMonitorProcessing',
  'CanIncludeInClipboardHistory',
  'CanUploadToCloudClipboard',
] as const;

/**
 * macOS: the convention clipboard managers agree to respect.
 * https://github.com/lodestone/org-nspasteboard
 */
const MACOS_CONCEALED_TYPE = 'org.nspasteboard.ConcealedType';

export interface CopyOptions {
  /** Milliseconds before the clipboard is cleared. `null` disables the timer entirely. */
  readonly clearAfterMs?: number | null;
}

export interface ClipboardState {
  readonly hasSecret: boolean;
  /** Milliseconds until the clipboard clears, for the countdown in the UI. */
  readonly clearsInMs: number | null;
}

type Listener = (state: ClipboardState) => void;

function buildItem(value: string): ClipboardItem {
  const payload: Record<string, string> = { [TEXT]: value };

  if (process.platform === 'win32') {
    // All markers travel in the SAME item. Writing plain text first and decorating it
    // afterwards produces two clipboard events, and history captures the first,
    // undecorated one — so the markers would appear to work while achieving nothing.
    for (const marker of WINDOWS_MARKERS) payload[osFormat(marker)] = '';
  } else if (process.platform === 'darwin') {
    payload[osFormat(MACOS_CONCEALED_TYPE)] = '';
  }

  return new ClipboardItem(payload);
}

export class SecretClipboard {
  #timer: NodeJS.Timeout | undefined;
  #clearsAt: number | null = null;
  /**
   * What we last wrote.
   *
   * Held so the clear can check before wiping: if the user has copied something else in
   * the meantime, clearing would destroy *their* clipboard contents — a small betrayal and
   * genuinely annoying. Comparing means we only ever clear our own value.
   */
  #lastWritten: string | null = null;
  #listeners = new Set<Listener>();

  async copySecret(value: string, options: CopyOptions = {}): Promise<ClipboardState> {
    this.#cancelTimer();

    await clipboard.write([buildItem(value)]);
    this.#lastWritten = value;

    const clearAfterMs =
      options.clearAfterMs === undefined ? DEFAULT_CLEAR_AFTER_MS : options.clearAfterMs;

    if (clearAfterMs !== null && clearAfterMs > 0) {
      this.#clearsAt = Date.now() + clearAfterMs;
      this.#timer = setTimeout(() => {
        void this.clear();
      }, clearAfterMs);
      // Must not hold the process open: a pending clear should never delay quit, and
      // `clearOnExit` covers the shutdown case.
      this.#timer.unref();
    }

    return this.#notify();
  }

  /**
   * Clears the clipboard — but only if it still holds what we put there.
   *
   * The check matters: without it, copying a password and then copying a URL means the URL
   * gets wiped thirty seconds later, from the user's point of view at random.
   */
  async clear(): Promise<ClipboardState> {
    this.#cancelTimer();

    if (this.#lastWritten !== null) {
      try {
        const current = await clipboard.readText();
        if (current === this.#lastWritten) {
          // Written empty rather than `clipboard.clear()`, because clearing on some
          // platforms leaves other formats of the same entry in place.
          await clipboard.writeText('');
        }
      } catch {
        // A clipboard that cannot be read is not a reason to fail; the timer has already
        // done its main job of bounding how long the value was there.
      }
    }

    this.#lastWritten = null;
    this.#clearsAt = null;
    return this.#notify();
  }

  /**
   * Clears on lock and on quit.
   *
   * Fire-and-forget deliberately: `will-quit` and the lock path are both synchronous, and
   * blocking either on a clipboard round-trip would delay shutdown for no benefit. The
   * local state is dropped immediately so nothing can observe a stale secret, and the
   * write is best-effort — which is the honest guarantee, since the OS may be tearing the
   * process down regardless.
   *
   * A vault locked while the password it just handed out sits on the clipboard is not
   * really locked, so this is called from every lock path.
   */
  clearOnExit(): void {
    void this.clear();
  }

  get state(): ClipboardState {
    return {
      hasSecret: this.#lastWritten !== null,
      clearsInMs: this.#clearsAt === null ? null : Math.max(0, this.#clearsAt - Date.now()),
    };
  }

  onChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): ClipboardState {
    const state = this.state;
    for (const listener of this.#listeners) listener(state);
    return state;
  }

  #cancelTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}
