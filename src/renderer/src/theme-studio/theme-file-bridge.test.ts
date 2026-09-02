// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEEPTHEME_MAX_BYTES } from '@shared/theme/keeptheme.js';
import { createThemeFileBridge } from './theme-file-bridge.js';

/**
 * The transport that carries a `.keeptheme` on and off disk.
 *
 * Two things here are worth a test and the rest is not. The first is **transport
 * selection**: the studio has to work today over the browser path and pick up the native
 * one the moment the IPC namespace exists, without either being a special case at the call
 * site. The second is that the native path treats what comes back over IPC as **data of
 * unknown shape** — an `IpcResult` that is not `ok`, a payload missing a field, a payload
 * that is not an object at all — because a bridge that trusted it would hand
 * `parseKeepTheme` an `undefined` and turn a channel change into a crash on a settings
 * screen.
 *
 * The size cap is tested on the browser side because that is the only side where the cap is
 * this module's job; the native side has `stat` in front of it (`keeptheme-file.ts`).
 */

interface MutableGlobal {
  keyhold?: unknown;
}

function installNativeChannel(channel: unknown): void {
  (globalThis as MutableGlobal).keyhold = { theme: channel };
}

afterEach(() => {
  delete (globalThis as MutableGlobal).keyhold;
  document.body.innerHTML = '';
});

describe('choosing a transport', () => {
  it('uses the browser path when there is no native channel', () => {
    expect(createThemeFileBridge().kind).toBe('browser');
  });

  it('uses the browser path when the namespace exists but is the wrong shape', () => {
    // A half-wired channel is worse than none: calling a missing function throws inside a
    // click handler, where nothing is there to catch it.
    installNativeChannel({ chooseAndRead: 'not a function' });
    expect(createThemeFileBridge().kind).toBe('browser');

    installNativeChannel({ chooseAndRead: (): void => undefined });
    expect(createThemeFileBridge().kind).toBe('browser');
  });

  it('uses the native path once both functions are present', () => {
    installNativeChannel({
      chooseAndRead: (): Promise<unknown> => Promise.resolve(null),
      chooseAndWrite: (): Promise<unknown> => Promise.resolve(null),
    });
    expect(createThemeFileBridge().kind).toBe('native');
  });
});

describe('the native path, given whatever IPC returns', () => {
  function bridgeReturning(
    read: unknown,
    write: unknown = null
  ): ReturnType<typeof createThemeFileBridge> {
    installNativeChannel({
      chooseAndRead: (): Promise<unknown> => Promise.resolve(read),
      chooseAndWrite: (): Promise<unknown> => Promise.resolve(write),
    });
    return createThemeFileBridge();
  }

  it('opens a well-formed result', async () => {
    const bridge = bridgeReturning({
      ok: true,
      value: { fileName: 'dusk.keeptheme', contents: '{}' },
    });

    await expect(bridge.openTheme()).resolves.toEqual({
      kind: 'opened',
      file: { name: 'dusk.keeptheme', contents: '{}' },
    });
  });

  it.each([
    ['a cancelled dialog', null],
    ['a failed IpcResult', { ok: false, error: 'nope' }],
    ['a result with no value', { ok: true }],
    ['a payload that is not an object', { ok: true, value: 'dusk.keeptheme' }],
    ['a payload missing its contents', { ok: true, value: { fileName: 'dusk.keeptheme' } }],
    ['a payload whose contents are not text', { ok: true, value: { fileName: 'a', contents: 3 } }],
    ['something that is not an IpcResult at all', 'surprise'],
  ])('treats %s as nothing opened, rather than as a theme', async (_label, payload) => {
    await expect(bridgeReturning(payload).openTheme()).resolves.toEqual({ kind: 'cancelled' });
  });

  it('reports a written path as saved, and a cancelled dialog as cancelled', async () => {
    await expect(
      bridgeReturning(null, { ok: true, value: 'C:/themes/dusk.keeptheme' }).saveTheme('a', 'b')
    ).resolves.toBe('saved');

    await expect(bridgeReturning(null, { ok: true }).saveTheme('a', 'b')).resolves.toBe(
      'cancelled'
    );
    await expect(bridgeReturning(null, { ok: false }).saveTheme('a', 'b')).resolves.toBe(
      'cancelled'
    );
  });

  it('passes the file name and contents through untouched', async () => {
    const chooseAndWrite = vi.fn(() => Promise.resolve({ ok: true, value: '/tmp/x' }));
    installNativeChannel({
      chooseAndRead: (): Promise<unknown> => Promise.resolve(null),
      chooseAndWrite,
    });

    await createThemeFileBridge().saveTheme('dusk.keeptheme', '{"format":"keyhold-theme"}');
    expect(chooseAndWrite).toHaveBeenCalledWith('dusk.keeptheme', '{"format":"keyhold-theme"}');
  });
});

describe('the browser path', () => {
  /** The hidden `<input type="file">` the bridge just appended, with a chosen file on it. */
  function pickFile(file: File | null): void {
    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('the bridge did not create a file input');

    // `files` is read-only, as it is in a real browser — a page cannot fabricate a chosen
    // file, which is precisely the property that makes the picker an act of consent.
    Object.defineProperty(input, 'files', { value: file === null ? [] : [file], writable: false });
    input.dispatchEvent(new Event('change'));
  }

  it('reads a chosen file, keeping its own name for “imported from …”', async () => {
    const bridge = createThemeFileBridge();
    const opened = bridge.openTheme();

    pickFile(new File(['{"format":"keyhold-theme"}'], 'friend.keeptheme'));

    await expect(opened).resolves.toEqual({
      kind: 'opened',
      file: { name: 'friend.keeptheme', contents: '{"format":"keyhold-theme"}' },
    });
  });

  it('refuses an over-large file before its bytes are read', async () => {
    const bridge = createThemeFileBridge();
    const opened = bridge.openTheme();

    const huge = new File(['x'], 'huge.keeptheme');
    // Stubbed rather than actually allocating 64 KB+: the point of the check is that it
    // happens before `text()`, and a real payload would only prove the same thing slower.
    Object.defineProperty(huge, 'size', { value: KEEPTHEME_MAX_BYTES + 1 });
    const text = vi.spyOn(huge, 'text');

    pickFile(huge);

    await expect(opened).resolves.toEqual({ kind: 'too-large', name: 'huge.keeptheme' });
    expect(text).not.toHaveBeenCalled();
  });

  it('resolves as cancelled when the dialog is dismissed', async () => {
    const bridge = createThemeFileBridge();
    const opened = bridge.openTheme();

    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]');
    input?.dispatchEvent(new Event('cancel'));

    await expect(opened).resolves.toEqual({ kind: 'cancelled' });
  });

  it('tidies the input away, so Settings does not collect stray tab stops', async () => {
    const bridge = createThemeFileBridge();
    const opened = bridge.openTheme();

    pickFile(new File(['{}'], 'x.keeptheme'));
    await opened;

    expect(document.body.querySelector('input[type="file"]')).toBeNull();
  });
});
