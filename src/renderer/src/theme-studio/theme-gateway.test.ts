// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepThemeFromDefinition, type KeepTheme } from '@shared/theme/keeptheme.js';
import { THEME_ERROR_CODES } from '@shared/theme/theme-channels.js';
import { FALLBACK_THEME } from '@shared/theme/themes.js';
import { createThemeGateway } from './theme-gateway.js';

/**
 * The renderer's half of the theme bridge.
 *
 * The interesting behaviour is all refusal: what happens when the namespace is absent, when
 * a call rejects, and — the one that matters — when a response arrives in a shape this build
 * does not recognise. A gateway that forwarded whatever it was handed would make the
 * main-side projection the only thing standing between a malformed payload and
 * `style.setProperty`, and "both ways" is written into the architecture for a reason.
 */

const THEME: KeepTheme = keepThemeFromDefinition(FALLBACK_THEME, 'Fixture');

const IMPORTED = { kind: 'imported', fileName: 'a.keeptheme', theme: THEME, notices: [] };

interface FakeApi {
  importTheme?: unknown;
  exportTheme?: unknown;
  takeOpenedTheme?: unknown;
  onFileOpened?: unknown;
}

function install(api: FakeApi | undefined): void {
  (globalThis as { keyhold?: unknown }).keyhold = api === undefined ? undefined : { theme: api };
}

function workingApi(overrides: FakeApi = {}): FakeApi {
  return {
    importTheme: () => Promise.resolve({ ok: true, value: IMPORTED }),
    exportTheme: () =>
      Promise.resolve({ ok: true, value: { kind: 'saved', fileName: 'a.keeptheme' } }),
    takeOpenedTheme: () => Promise.resolve({ ok: true, value: null }),
    onFileOpened: () => () => undefined,
    ...overrides,
  };
}

afterEach(() => {
  delete (globalThis as { keyhold?: unknown }).keyhold;
});

describe('when the channels are missing', () => {
  it.each([
    ['there is no bridge at all', undefined],
    ['the namespace is absent', {}],
    ['a method is missing', { importTheme: () => undefined }],
    ['a member is not a function', workingApi({ exportTheme: 'nope' })],
  ])('reports unavailable when %s', async (_why, api) => {
    if (api === undefined) {
      delete (globalThis as { keyhold?: unknown }).keyhold;
    } else {
      install(api);
    }

    const gateway = createThemeGateway();

    expect(gateway.available).toBe(false);
    expect(await gateway.importTheme()).toEqual({ kind: 'unavailable' });
    expect(await gateway.exportTheme(THEME, null)).toEqual({ kind: 'unavailable' });
    expect(await gateway.takeOpenedTheme()).toEqual({ kind: 'unavailable' });
    // A no-op unsubscribe rather than a throw, so callers need no branch of their own.
    expect(() => {
      gateway.onFileOpened(() => undefined)();
    }).not.toThrow();
  });

  it('does not fall back to a browser file input', () => {
    install({});
    createThemeGateway();

    // The whole point of the switch. A hidden `<input type="file">` was how the studio used
    // to move themes, and a fallback that silently takes over is how a worse transport
    // survives unnoticed.
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
  });
});

describe('importing', () => {
  it('unwraps and re-validates a good response', async () => {
    install(workingApi());
    expect(await createThemeGateway().importTheme()).toEqual(IMPORTED);
  });

  it.each([
    ['the call fails', { ok: false, code: 'INTERNAL', message: 'no', recoverable: false }],
    ['the payload is not a response', { ok: true, value: { kind: 'applied' } }],
    [
      'the palette is not canonical hex',
      {
        ok: true,
        value: { ...IMPORTED, theme: { ...THEME, palette: { ...THEME.palette, bg: 'url(x)' } } },
      },
    ],
    [
      'the refusal code is unknown',
      {
        ok: true,
        value: { kind: 'refused', code: 'theme/made-up', message: 'no', tokens: [] },
      },
    ],
  ])('reports failed when %s', async (_why, result) => {
    install(workingApi({ importTheme: () => Promise.resolve(result) }));
    expect(await createThemeGateway().importTheme()).toEqual({ kind: 'failed' });
  });

  it('reports failed rather than throwing when the invoke rejects', async () => {
    install(workingApi({ importTheme: () => Promise.reject(new Error('no handler')) }));
    expect(await createThemeGateway().importTheme()).toEqual({ kind: 'failed' });
  });

  it('passes a refusal through so the studio can name what was wrong', async () => {
    const refusal = {
      kind: 'refused',
      code: THEME_ERROR_CODES.illegible,
      message: 'This theme cannot be used.',
      tokens: [],
    };
    install(workingApi({ importTheme: () => Promise.resolve({ ok: true, value: refusal }) }));
    expect(await createThemeGateway().importTheme()).toEqual(refusal);
  });
});

describe('exporting', () => {
  it('sends the theme and the acknowledgement, and nothing else', async () => {
    const exportTheme = vi.fn(() =>
      Promise.resolve({ ok: true, value: { kind: 'saved', fileName: 'out.keeptheme' } })
    );
    install(workingApi({ exportTheme }));

    const outcome = await createThemeGateway().exportTheme(THEME, 'a1b2c3d4');

    expect(outcome).toEqual({ kind: 'saved', fileName: 'out.keeptheme' });
    // No path, no file name, no serialised text. The user names the file in an OS dialog and
    // the main process writes the bytes.
    expect(exportTheme).toHaveBeenCalledWith({ theme: THEME, acknowledgement: 'a1b2c3d4' });
  });

  it('reports failed on a response it cannot read', async () => {
    install(
      workingApi({ exportTheme: () => Promise.resolve({ ok: true, value: { kind: 'saved' } }) })
    );
    expect(await createThemeGateway().exportTheme(THEME, null)).toEqual({ kind: 'failed' });
  });
});

describe('a theme the OS handed us', () => {
  it('distinguishes "nothing waiting" from a failure', async () => {
    install(workingApi());
    // `null` is the ordinary answer and must survive the unwrap intact — the studio stays
    // silent for it and shows an error for `failed`.
    expect(await createThemeGateway().takeOpenedTheme()).toBeNull();

    install(
      workingApi({ takeOpenedTheme: () => Promise.resolve({ ok: false, code: 'INTERNAL' }) })
    );
    expect(await createThemeGateway().takeOpenedTheme()).toEqual({ kind: 'failed' });
  });

  it('forwards the subscription and its unsubscribe', () => {
    const unsubscribe = vi.fn();
    const onFileOpened = vi.fn(() => unsubscribe);
    install(workingApi({ onFileOpened }));

    const listener = (): void => undefined;
    const stop = createThemeGateway().onFileOpened(listener);

    expect(onFileOpened).toHaveBeenCalledWith(listener);
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
