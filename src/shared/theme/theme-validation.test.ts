// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { keepThemeFromDefinition, type KeepTheme } from './keeptheme.js';
import {
  isThemeErrorCode,
  THEME_CHANNELS,
  THEME_ERROR_CODES,
  THEME_EVENTS,
} from './theme-channels.js';
import {
  readThemeExportResponse,
  readThemeImportResponse,
  requireThemeExportRequest,
} from './theme-validation.js';
import { FALLBACK_THEME } from './themes.js';
import { COLOUR_TOKENS } from './tokens.js';

/**
 * Both directions of the `kh:theme:*` bridge, validated the way a runtime boundary has to
 * be: TypeScript is erased, so every one of these shapes is a claim nothing enforces until
 * this file does.
 */

const CHANNEL = THEME_CHANNELS.themeExport;
const THEME: KeepTheme = keepThemeFromDefinition(FALLBACK_THEME, 'Fixture');

function request(overrides: Record<string, unknown> = {}): unknown {
  return { theme: THEME, acknowledgement: null, ...overrides };
}

function theme(overrides: Record<string, unknown> = {}): unknown {
  return { ...THEME, palette: { ...THEME.palette }, ...overrides };
}

// ── renderer → main ──────────────────────────────────────────────────────────

describe('requireThemeExportRequest', () => {
  it('accepts a well-formed request', () => {
    expect(requireThemeExportRequest(CHANNEL, request())).toEqual({
      theme: THEME,
      acknowledgement: null,
    });
  });

  it('accepts a well-formed acknowledgement token', () => {
    const parsed = requireThemeExportRequest(CHANNEL, request({ acknowledgement: 'a1b2c3d4' }));
    expect(parsed.acknowledgement).toBe('a1b2c3d4');
  });

  it.each([
    ['null', null],
    ['a string', 'theme'],
    ['an array', [THEME]],
    ['a number', 7],
  ])('refuses a request that is %s', (_why, value) => {
    expect(() => requireThemeExportRequest(CHANNEL, value)).toThrow(/must be an object/);
  });

  it.each([
    ['no format marker', { format: 'something-else' }],
    ['a future version', { version: 2 }],
    ['a version that is not a number', { version: '1' }],
    ['a scheme that is neither light nor dark', { scheme: 'sepia' }],
    ['a name that is not text', { name: 42 }],
    ['a basedOn that is not text', { basedOn: null }],
    ['a palette that is not an object', { palette: 'all of them' }],
    ['a palette that is an array', { palette: [] }],
  ])('refuses a theme with %s', (_why, overrides) => {
    expect(() => requireThemeExportRequest(CHANNEL, request({ theme: theme(overrides) }))).toThrow(
      /Invalid IPC payload/
    );
  });

  it('refuses a palette value that is not a string', () => {
    const palette: Record<string, unknown> = { ...THEME.palette, bg: { r: 0, g: 0, b: 0 } };
    expect(() =>
      requireThemeExportRequest(CHANNEL, request({ theme: theme({ palette }) }))
    ).toThrow(/palette\.bg must be a string/);
  });

  it('refuses a palette missing a token rather than filling it in', () => {
    // Filling is the *file* reader's behaviour, where an absent key means an older or newer
    // theme. A renderer sending an incomplete palette is a bug in our own code, and guessing
    // at it would write a colour nobody chose into somebody's file.
    const palette: Record<string, string> = { ...THEME.palette };
    delete palette.bg;
    expect(() =>
      requireThemeExportRequest(CHANNEL, request({ theme: theme({ palette }) }))
    ).toThrow(/palette\.bg must be a string/);
  });

  it('caps the name and description rather than passing a megabyte to a save dialog', () => {
    expect(() =>
      requireThemeExportRequest(CHANNEL, request({ theme: theme({ name: 'x'.repeat(81) }) }))
    ).toThrow(/name exceeds 80 characters/);
    expect(() =>
      requireThemeExportRequest(
        CHANNEL,
        request({ theme: theme({ description: 'x'.repeat(241) }) })
      )
    ).toThrow(/description exceeds 240 characters/);
  });

  it.each([
    ['is not hex', 'zzzzzzzz'],
    ['is the wrong length', 'a1b2c3'],
    ['is a boolean', true],
    ['is enormous', 'a'.repeat(100_000)],
  ])('refuses an acknowledgement that %s', (_why, value) => {
    expect(() => requireThemeExportRequest(CHANNEL, request({ acknowledgement: value }))).toThrow(
      /acknowledgement must be null or an 8-digit token/
    );
  });

  it('keeps only the tokens it knows, dropping anything else the renderer attached', () => {
    const palette: Record<string, unknown> = {
      ...THEME.palette,
      'zz-extra': '#010203',
      constructor: '#040506',
    };

    const parsed = requireThemeExportRequest(CHANNEL, request({ theme: theme({ palette }) }));

    // Rebuilt key by key from `COLOUR_TOKENS`, so nothing rides along into the object that
    // is about to be serialised to a file.
    expect(Object.keys(parsed.theme.palette).sort()).toEqual([...COLOUR_TOKENS].sort());
  });

  it('never puts the offending value into the error, which is destined for a log', () => {
    let message = '';
    try {
      requireThemeExportRequest(
        CHANNEL,
        request({ theme: theme({ name: 'zz-marker'.repeat(20) }) })
      );
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('name exceeds');
    expect(message).not.toContain('zz-marker');
  });
});

// ── main → renderer ──────────────────────────────────────────────────────────

const IMPORTED = {
  kind: 'imported',
  fileName: 'friend.keeptheme',
  theme: THEME,
  notices: [],
};

describe('readThemeImportResponse', () => {
  it('accepts each well-formed response', () => {
    expect(readThemeImportResponse({ kind: 'cancelled' })).toEqual({ kind: 'cancelled' });
    expect(readThemeImportResponse(IMPORTED)).toEqual(IMPORTED);
    expect(readThemeImportResponse({ ...IMPORTED, kind: 'needs-review' })).toEqual({
      ...IMPORTED,
      kind: 'needs-review',
    });
    expect(
      readThemeImportResponse({
        kind: 'refused',
        code: THEME_ERROR_CODES.invalidColours,
        message: 'two colours could not be read',
        tokens: ['bg', 'text'],
      })
    ).not.toBeNull();
  });

  it('accepts every notice shape the projection produces', () => {
    const notices = [
      { kind: 'missing-token', token: 'bg', filledFrom: 'midnight', message: 'filled in' },
      { kind: 'unknown-tokens', count: 3, message: 'ignored three' },
      { kind: 'unknown-base', usedInstead: 'midnight', message: 'used midnight' },
    ];
    expect(readThemeImportResponse({ ...IMPORTED, notices })).not.toBeNull();
  });

  it.each([
    ['an unknown kind', { kind: 'applied' }],
    ['no kind at all', { fileName: 'x.keeptheme' }],
    ['a string', 'imported'],
    ['null', null],
    ['an array', []],
  ])('rejects %s', (_why, value) => {
    expect(readThemeImportResponse(value)).toBeNull();
  });

  it('rejects a palette value that is not canonical hex', () => {
    // The belt to the projection's braces. Every value here is destined for
    // `style.setProperty`, and this is the last place before it gets there.
    for (const bad of ['red', '#fff', 'rgb(1,2,3)', '#FFFFFF', '#fff}body{x:y', 'url(a)']) {
      expect(
        readThemeImportResponse({
          ...IMPORTED,
          theme: { ...THEME, palette: { ...THEME.palette, bg: bad } },
        }),
        `"${bad}" must not be accepted as a palette value`
      ).toBeNull();
    }
  });

  it('rejects a theme with a token missing from its palette', () => {
    const palette: Record<string, string> = { ...THEME.palette };
    delete palette.overlay;
    expect(readThemeImportResponse({ ...IMPORTED, theme: { ...THEME, palette } })).toBeNull();
  });

  it('rejects a refusal carrying a code this build does not declare', () => {
    expect(
      readThemeImportResponse({
        kind: 'refused',
        code: 'theme/whatever',
        message: 'no',
        tokens: [],
      })
    ).toBeNull();
  });

  it('rejects a refusal naming a token that is not in the vocabulary', () => {
    // A refusal is rendered as text. An arbitrary string in `tokens` means the response did
    // not come from our own projection, whatever else it looks like.
    expect(
      readThemeImportResponse({
        kind: 'refused',
        code: THEME_ERROR_CODES.invalidColours,
        message: 'no',
        tokens: ['bg', 'zz-marker'],
      })
    ).toBeNull();
  });

  it('rejects a notice shape it does not recognise', () => {
    expect(
      readThemeImportResponse({
        ...IMPORTED,
        notices: [{ kind: 'unknown-token', token: 'zz-marker', message: 'ignored' }],
      })
    ).toBeNull();
    expect(
      readThemeImportResponse({
        ...IMPORTED,
        notices: [{ kind: 'unknown-tokens', count: -1, message: 'ignored' }],
      })
    ).toBeNull();
  });
});

describe('readThemeExportResponse', () => {
  it('accepts saved, cancelled and refused', () => {
    expect(readThemeExportResponse({ kind: 'saved', fileName: 'a.keeptheme' })).toEqual({
      kind: 'saved',
      fileName: 'a.keeptheme',
    });
    expect(readThemeExportResponse({ kind: 'cancelled' })).toEqual({ kind: 'cancelled' });
    expect(
      readThemeExportResponse({
        kind: 'refused',
        code: THEME_ERROR_CODES.writeFailed,
        message: 'could not be written',
        tokens: [],
      })
    ).not.toBeNull();
  });

  it('rejects a saved response with no file name, and an imported one', () => {
    expect(readThemeExportResponse({ kind: 'saved' })).toBeNull();
    expect(readThemeExportResponse({ kind: 'imported' })).toBeNull();
  });
});

// ── The channel group itself ─────────────────────────────────────────────────

describe('the channel group', () => {
  it('names every channel and event `kh:<domain>:<action>`', () => {
    for (const channel of Object.values(THEME_CHANNELS)) {
      expect(channel).toMatch(/^kh:theme:[a-z-]+$/);
    }
    for (const event of Object.values(THEME_EVENTS)) {
      expect(event).toMatch(/^kh:event:[a-z-]+$/);
    }
  });

  it('recognises exactly its own error codes', () => {
    for (const code of Object.values(THEME_ERROR_CODES)) {
      expect(isThemeErrorCode(code)).toBe(true);
      expect(code).toMatch(/^theme\/[a-z-]+$/);
    }
    expect(isThemeErrorCode('import/stale-plan')).toBe(false);
    expect(isThemeErrorCode(undefined)).toBe(false);
  });
});
