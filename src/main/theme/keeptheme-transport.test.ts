// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  contrastAcknowledgement,
  evaluatePaletteContrast,
  keepThemeFromDefinition,
  KEEPTHEME_FORMAT,
  KEEPTHEME_FORMAT_VERSION,
  KEEPTHEME_MAX_BYTES,
  serialiseKeepTheme,
  type KeepTheme,
} from '@shared/theme/keeptheme.js';
import { THEME_ERROR_CODES, type ThemeImportResponse } from '@shared/theme/theme-channels.js';
import { readThemeImportResponse } from '@shared/theme/theme-validation.js';
import { FALLBACK_THEME } from '@shared/theme/themes.js';
import { COLOUR_TOKENS } from '@shared/theme/tokens.js';

/**
 * The `.keeptheme` transport, tested as the untrusted-input path it is.
 *
 * `keeptheme-format.test.ts` next door covers the *format* — what `parseKeepTheme` accepts
 * and refuses. This file covers the **boundary**: what a hostile file is able to put in
 * front of the renderer once the main process has read it, which is a different question and
 * the one the projection exists to answer.
 *
 * The load-bearing test is `never echoes the file back`. Everything else here can pass while
 * the app is still one careless `...rejection` away from handing an attacker-chosen string
 * to a CSS custom property, and a marker planted in every field the file controls is the
 * only check that notices.
 */

const dialogs = vi.hoisted(() => ({
  open: null as string | null,
  save: null as string | null,
}));

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: () =>
      Promise.resolve(
        dialogs.open === null
          ? { canceled: true, filePaths: [] }
          : { canceled: false, filePaths: [dialogs.open] }
      ),
    showSaveDialog: () =>
      Promise.resolve(
        dialogs.save === null
          ? { canceled: true, filePath: '' }
          : { canceled: false, filePath: dialogs.save }
      ),
  },
}));

const { createThemeIpcHandlers } = await import('./theme-ipc.js');
const { OpenedThemeStore } = await import('./opened-themes.js');
const { importKeepTheme } = await import('./theme-service.js');
const { projectParseResult } = await import('./theme-projection.js');

let directory = '';

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'keyhold-theme-ipc-'));
  dialogs.open = null;
  dialogs.save = null;
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BASE: KeepTheme = keepThemeFromDefinition(FALLBACK_THEME, 'Base');

/** Writes a file and returns its path. Contents are given verbatim — junk included. */
async function writeThemeFile(name: string, contents: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, contents, 'utf8');
  return path;
}

/** A theme file object with arbitrary doctoring, serialised however badly. */
function themeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: KEEPTHEME_FORMAT,
    version: KEEPTHEME_FORMAT_VERSION,
    name: BASE.name,
    description: BASE.description,
    scheme: BASE.scheme,
    basedOn: BASE.basedOn,
    palette: { ...BASE.palette },
    ...overrides,
  });
}

/** The whole main-side path: read, parse, project. What the renderer would be handed. */
async function importAndProject(path: string): Promise<ThemeImportResponse> {
  const imported = await importKeepTheme(path);
  if ('ok' in imported) {
    return {
      kind: 'refused',
      code:
        imported.code === 'too-large' ? THEME_ERROR_CODES.tooLarge : THEME_ERROR_CODES.unreadable,
      message: imported.message,
      tokens: [],
    };
  }
  return projectParseResult(imported.result, imported.fileName);
}

async function importFile(name: string, contents: string): Promise<ThemeImportResponse> {
  return importAndProject(await writeThemeFile(name, contents));
}

// ── The happy path ───────────────────────────────────────────────────────────

describe('a valid theme', () => {
  it('round-trips through the transport unchanged', async () => {
    const response = await importFile('good.keeptheme', serialiseKeepTheme(BASE));

    expect(response.kind).toBe('imported');
    if (response.kind !== 'imported') return;
    expect(response.theme).toEqual(BASE);
    expect(response.notices).toEqual([]);
    expect(response.fileName).toBe('good.keeptheme');
  });

  it('hands over a file name and never a path', async () => {
    const response = await importFile('good.keeptheme', serialiseKeepTheme(BASE));

    // The directory is a real absolute path with the OS temp root in it. If any part of it
    // reached the renderer it would land in screenshots attached to bug reports.
    expect(JSON.stringify(response)).not.toContain(directory);
  });

  it('survives the renderer-side re-validation it will actually face', async () => {
    // The projection is checked again on arrival (`readThemeImportResponse`). A response
    // this rejects is one the studio would show as "could not be read", so a projection that
    // drifts out of the contract fails here rather than silently in the UI.
    const response = await importFile('good.keeptheme', serialiseKeepTheme(BASE));
    expect(readThemeImportResponse(JSON.parse(JSON.stringify(response)))).toEqual(response);
  });
});

// ── Structural damage ────────────────────────────────────────────────────────

describe('a damaged theme', () => {
  it('fills a missing token from the base and says which', async () => {
    const palette: Record<string, string> = { ...BASE.palette };
    delete palette['warning-subtle'];

    const response = await importFile('missing.keeptheme', themeJson({ palette }));

    expect(response.kind).toBe('imported');
    if (response.kind !== 'imported') return;
    expect(response.notices).toContainEqual(
      expect.objectContaining({ kind: 'missing-token', token: 'warning-subtle' })
    );
    // Filled, not left blank: a token with no value renders as an invisible element.
    expect(response.theme.palette['warning-subtle']).toBe(BASE.palette['warning-subtle']);
  });

  it('collapses unknown tokens to a count and never names them', async () => {
    const response = await importFile(
      'extra.keeptheme',
      themeJson({
        palette: { ...BASE.palette, 'zz-marker-alpha': '#123456', 'zz-marker-beta': '#654321' },
      })
    );

    expect(response.kind).toBe('imported');
    if (response.kind !== 'imported') return;
    expect(response.notices).toContainEqual(
      expect.objectContaining({ kind: 'unknown-tokens', count: 2 })
    );
    expect(JSON.stringify(response)).not.toContain('zz-marker');
  });

  it('refuses a value that is not a colour, naming every offending token at once', async () => {
    const response = await importFile(
      'notcolour.keeptheme',
      themeJson({
        palette: { ...BASE.palette, bg: 'chartreuse', text: 'not a colour at all' },
      })
    );

    expect(response.kind).toBe('refused');
    if (response.kind !== 'refused') return;
    expect(response.code).toBe(THEME_ERROR_CODES.invalidColours);
    // Both, not the first. Reporting one at a time turns fixing a theme into whack-a-mole.
    expect([...response.tokens].sort()).toEqual(['bg', 'text']);
  });

  it('refuses a palette value that is not even a string', async () => {
    const response = await importFile(
      'nonstring.keeptheme',
      themeJson({ palette: { ...BASE.palette, bg: { r: 1, g: 2, b: 3 } } })
    );

    expect(response.kind).toBe('refused');
    if (response.kind !== 'refused') return;
    expect(response.code).toBe(THEME_ERROR_CODES.invalidColours);
    expect(response.tokens).toEqual(['bg']);
  });

  it('refuses a file that is not JSON', async () => {
    const response = await importFile('notes.txt', 'shopping list');

    expect(response.kind).toBe('refused');
    if (response.kind !== 'refused') return;
    expect(response.code).toBe(THEME_ERROR_CODES.notJson);
  });

  it('refuses JSON that is not a theme', async () => {
    const response = await importFile('other.keeptheme', JSON.stringify({ hello: 'world' }));

    expect(response.kind).toBe('refused');
    if (response.kind !== 'refused') return;
    expect(response.code).toBe(THEME_ERROR_CODES.notATheme);
  });

  it('refuses a JSON array, which is an object to `typeof` and not a theme', async () => {
    const response = await importFile('array.keeptheme', JSON.stringify([BASE]));

    expect(response.kind).toBe('refused');
    if (response.kind !== 'refused') return;
    expect(response.code).toBe(THEME_ERROR_CODES.notATheme);
  });

  it('refuses a newer format version rather than guessing at it', async () => {
    const response = await importFile('future.keeptheme', themeJson({ version: 99 }));

    expect(response.kind).toBe('refused');
    if (response.kind !== 'refused') return;
    expect(response.code).toBe(THEME_ERROR_CODES.futureVersion);
  });

  it('refuses an enormous file before reading it', async () => {
    const response = await importFile('huge.keeptheme', 'x'.repeat(KEEPTHEME_MAX_BYTES * 2));

    expect(response.kind).toBe('refused');
    if (response.kind !== 'refused') return;
    // `too-large`, not `not-json`: the `stat` check fired, so the file was never read into
    // memory. A parse rejection here would mean the cap ran after the allocation it exists
    // to prevent.
    expect(response.code).toBe(THEME_ERROR_CODES.tooLarge);
  });
});

// ── Injection ────────────────────────────────────────────────────────────────

/**
 * Values that are a problem specifically because a palette token becomes a CSS custom
 * property. Each one, if it reached `style.setProperty`, would be more than a wrong colour.
 */
const INJECTIONS: readonly (readonly [string, string])[] = [
  ['closes the rule', '#fff}body{display:none'],
  ['starts another declaration', '#fff;position:fixed'],
  ['fetches over the network', 'url(https://example.invalid/a.png)'],
  ['evaluates on a legacy engine', 'expression(alert(1))'],
  ['smuggles a newline', '#ff0000\n  --kh-color-text: #ff0000'],
  ['opens a comment', '#fff/*'],
  ['imports a stylesheet', '@import "https://example.invalid/x.css"'],
  ['is a var() chain that cannot be measured', 'var(--kh-color-bg)'],
  ['is translucent, so no ratio can be computed', 'rgba(255, 0, 0, 0.4)'],
];

describe('a hostile colour value', () => {
  for (const [why, value] of INJECTIONS) {
    it(`is refused when it ${why}`, async () => {
      const response = await importFile(
        'hostile.keeptheme',
        themeJson({ palette: { ...BASE.palette, bg: value } })
      );

      expect(response.kind, `"${value}" should be refused`).toBe('refused');
      if (response.kind !== 'refused') return;
      expect(response.code).toBe(THEME_ERROR_CODES.invalidColours);
      expect(response.tokens).toEqual(['bg']);
    });
  }

  it('is refused rather than sanitised — no partial value survives', async () => {
    // The difference matters. Sanitising `#fff}body{display:none` to `#fff` would apply a
    // colour the author never chose while reporting success, which is the failure mode the
    // missing/unparseable split in `parseKeepTheme` exists to avoid.
    const response = await importFile(
      'sanitise.keeptheme',
      themeJson({ palette: { ...BASE.palette, bg: '#fff}body{display:none' } })
    );

    expect(response.kind).toBe('refused');
    expect(JSON.stringify(response)).not.toContain('#fff');
  });
});

describe('the projection', () => {
  it('never echoes the file back, on the accepted path', async () => {
    const markers = ['zz-marker-key', 'zz-marker-base'];
    const response = await importFile(
      'markers.keeptheme',
      themeJson({
        basedOn: 'zz-marker-base',
        palette: { ...BASE.palette, 'zz-marker-key': '#010203' },
      })
    );

    expect(response.kind).toBe('imported');
    const serialised = JSON.stringify(response);
    for (const marker of markers) {
      expect(serialised, `"${marker}" must not cross the bridge`).not.toContain(marker);
    }
  });

  it('never echoes the file back, on the refused path', async () => {
    const response = await importFile(
      'markers-bad.keeptheme',
      themeJson({
        basedOn: 'zz-marker-base',
        palette: { ...BASE.palette, bg: 'zz-marker-colour', 'zz-marker-key': '#010203' },
      })
    );

    expect(response.kind).toBe('refused');
    const serialised = JSON.stringify(response);
    for (const marker of ['zz-marker-base', 'zz-marker-colour', 'zz-marker-key']) {
      expect(serialised, `"${marker}" must not cross the bridge`).not.toContain(marker);
    }
  });

  it('lets only canonical #rrggbb values into the palette it hands over', async () => {
    // Every token rewritten into a different accepted spelling of *the same colour*, so the
    // theme still passes contrast and the only thing under test is the canonicalisation.
    // What comes back must be the one form we format, because that string goes into a CSS
    // custom property.
    const palette: Record<string, string> = {};
    COLOUR_TOKENS.forEach((token, index) => {
      const hex = BASE.palette[token];
      const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
      palette[token] =
        index % 3 === 0
          ? hex.toUpperCase()
          : index % 3 === 1
            ? `rgb(${r}, ${g}, ${b})`
            : `${hex}ff`;
    });

    const response = await importFile('forms.keeptheme', themeJson({ palette }));

    expect(response.kind).toBe('imported');
    if (response.kind !== 'imported') return;
    for (const token of COLOUR_TOKENS) {
      expect(response.theme.palette[token], `${token} must be canonical`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('keeps the name and description, which are the only file text that may cross', async () => {
    const response = await importFile(
      'named.keeptheme',
      themeJson({ name: 'Nocturne <b>', description: 'By a friend & co' })
    );

    expect(response.kind).toBe('imported');
    if (response.kind !== 'imported') return;
    // Kept verbatim, not escaped and not stripped: they are rendered as React text nodes,
    // never as markup and never as a style value, and mangling them here would corrupt every
    // legitimate name containing an ampersand.
    expect(response.theme.name).toBe('Nocturne <b>');
    expect(response.theme.description).toBe('By a friend & co');
  });
});

// ── Contrast: the two tiers, at the boundary ─────────────────────────────────

describe('contrast at the boundary', () => {
  /** Fails AA on body text but stays above the 3:1 legibility floor. */
  const DIM: KeepTheme = { ...BASE, palette: { ...BASE.palette, text: '#7b7d86' } };

  /** Text barely distinguishable from the background: below the floor. */
  const ILLEGIBLE: KeepTheme = { ...BASE, palette: { ...BASE.palette, text: '#131419' } };

  it('loads an AA failure for review rather than refusing it', async () => {
    const response = await importFile('dim.keeptheme', serialiseKeepTheme(DIM));

    expect(response.kind).toBe('needs-review');
    if (response.kind !== 'needs-review') return;
    // The palette *is* handed over: the studio's whole job here is to show the failing pairs
    // and let the user decide with them on screen. Refusing outright would remove the report
    // that makes the choice informed.
    expect(response.theme.palette.text).toBe('#7b7d86');
    expect(evaluatePaletteContrast(response.theme.palette).passes).toBe(false);
  });

  it('refuses a theme below the legibility floor and hands over no palette at all', async () => {
    const response = await importFile('dark.keeptheme', serialiseKeepTheme(ILLEGIBLE));

    expect(response.kind).toBe('refused');
    if (response.kind !== 'refused') return;
    expect(response.code).toBe(THEME_ERROR_CODES.illegible);
    // The point of the whole tier. A theme that makes Settings unreadable must not be
    // loadable, previewable, or one click from being applied — because the screen that
    // undoes it is the screen it broke.
    expect(response).not.toHaveProperty('theme');
    expect(JSON.stringify(response)).not.toContain('#131419');
  });
});

// ── The IPC handlers ─────────────────────────────────────────────────────────

describe('the IPC handlers', () => {
  const handlers = createThemeIpcHandlers({ getWindow: () => null });

  it('reports a dismissed open dialog as cancelled, not as a failure', async () => {
    dialogs.open = null;
    expect(await handlers.importTheme()).toEqual({ kind: 'cancelled' });
  });

  it('imports the file the dialog returned', async () => {
    dialogs.open = await writeThemeFile('picked.keeptheme', serialiseKeepTheme(BASE));

    const response = await handlers.importTheme();
    expect(response.kind).toBe('imported');
  });

  it('reports a dismissed save dialog as cancelled and writes nothing', async () => {
    dialogs.save = null;

    expect(await handlers.exportTheme({ theme: BASE, acknowledgement: null })).toEqual({
      kind: 'cancelled',
    });
    expect(await readdir(directory)).toEqual([]);
  });

  it('writes a theme the app can read back', async () => {
    dialogs.save = join(directory, 'out.keeptheme');

    const response = await handlers.exportTheme({ theme: BASE, acknowledgement: null });
    expect(response).toEqual({ kind: 'saved', fileName: 'out.keeptheme' });

    const written = await readFile(dialogs.save, 'utf8');
    expect(JSON.parse(written)).toEqual(JSON.parse(serialiseKeepTheme(BASE)));
  });

  it('refuses to export an unacknowledged AA failure, without opening a dialog', async () => {
    const dim: KeepTheme = { ...BASE, palette: { ...BASE.palette, text: '#7b7d86' } };
    dialogs.save = join(directory, 'never.keeptheme');

    const response = await handlers.exportTheme({ theme: dim, acknowledgement: null });
    expect(response.kind).toBe('refused');
    if (response.kind !== 'refused') return;
    expect(response.code).toBe(THEME_ERROR_CODES.notAcknowledged);
    // The token that would admit it is deliberately not handed back: a consent gate that
    // answers "what would you accept?" is not a gate.
    expect(JSON.stringify(response)).not.toContain(
      contrastAcknowledgement(dim.palette, evaluatePaletteContrast(dim.palette))
    );
    expect(await readdir(directory)).toEqual([]);
  });

  it('exports an AA failure carrying the matching acknowledgement', async () => {
    const dim: KeepTheme = { ...BASE, palette: { ...BASE.palette, text: '#7b7d86' } };
    dialogs.save = join(directory, 'dim.keeptheme');

    const response = await handlers.exportTheme({
      theme: dim,
      acknowledgement: contrastAcknowledgement(dim.palette, evaluatePaletteContrast(dim.palette)),
    });

    expect(response).toEqual({ kind: 'saved', fileName: 'dim.keeptheme' });
  });

  it('refuses a renderer-supplied theme that is not a theme', async () => {
    // The renderer is semi-trusted, and TypeScript is erased at runtime. A request that
    // reaches the handler malformed must throw rather than be guessed at.
    await expect(handlers.exportTheme({ theme: null, acknowledgement: null })).rejects.toThrow(
      /Invalid IPC payload/
    );
    await expect(
      handlers.exportTheme({ theme: BASE, acknowledgement: 'x'.repeat(4096) })
    ).rejects.toThrow(/Invalid IPC payload/);
  });

  it('never accepts a path from its caller', () => {
    // The signature is the guarantee. `importTheme` and `takeOpenedTheme` take nothing, and
    // `exportTheme`'s payload has no path field — a renderer cannot name a file, only a
    // theme, and the user names the file in an OS dialog.
    expect(handlers.importTheme.length).toBe(0);
    expect(handlers.takeOpenedTheme.length).toBe(0);
  });
});

// ── The theme the OS hands us ────────────────────────────────────────────────

describe('a theme opened from the operating system', () => {
  it('is delivered once and only once', async () => {
    const store = new OpenedThemeStore();
    const handlers = createThemeIpcHandlers({ getWindow: () => null, openedThemeStore: store });

    expect(await handlers.takeOpenedTheme()).toBeNull();

    store.remember(await writeThemeFile('dropped.keeptheme', serialiseKeepTheme(BASE)));
    expect(store.hasPending).toBe(true);

    const first = await handlers.takeOpenedTheme();
    expect(first?.kind).toBe('imported');

    // Cleared by the take. Re-delivering would mean the studio silently replacing whatever
    // the user had been editing, every time they navigated back to the screen.
    expect(await handlers.takeOpenedTheme()).toBeNull();
    expect(store.hasPending).toBe(false);
  });

  it('faces exactly the same refusals as a file picked in the dialog', async () => {
    const store = new OpenedThemeStore();
    const handlers = createThemeIpcHandlers({ getWindow: () => null, openedThemeStore: store });

    store.remember(
      await writeThemeFile(
        'dropped-bad.keeptheme',
        themeJson({ palette: { ...BASE.palette, bg: 'url(https://example.invalid/a.png)' } })
      )
    );

    const response = await handlers.takeOpenedTheme();
    expect(response?.kind).toBe('refused');
    if (response?.kind !== 'refused') return;
    expect(response.code).toBe(THEME_ERROR_CODES.invalidColours);
  });
});
