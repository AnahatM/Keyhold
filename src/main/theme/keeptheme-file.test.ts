// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keepThemeFromDefinition, serialiseKeepTheme } from '@shared/theme/keeptheme.js';
import { FALLBACK_THEME } from '@shared/theme/themes.js';
import {
  readKeepThemeFile,
  THEME_TEMP_SUFFIX,
  themeDirectoryOf,
  writeKeepThemeFile,
} from './keeptheme-file.js';
import { importKeepTheme, prepareKeepThemeExport } from './theme-service.js';

/** Real files in a real directory: the failure modes here are all filesystem ones. */

let directory = '';

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'keyhold-theme-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const SAMPLE = serialiseKeepTheme(keepThemeFromDefinition(FALLBACK_THEME, 'Sample'));

describe('readKeepThemeFile', () => {
  it('reads a theme back exactly as written', async () => {
    const path = join(directory, 'sample.keeptheme');
    await writeFile(path, SAMPLE, 'utf8');

    const result = await readKeepThemeFile(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contents).toBe(SAMPLE);
  });

  it('strips a byte-order mark, so a theme edited in Notepad still parses', async () => {
    const path = join(directory, 'bom.keeptheme');
    await writeFile(path, `${String.fromCharCode(0xfeff)}${SAMPLE}`, 'utf8');

    const result = await readKeepThemeFile(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contents).toBe(SAMPLE);
    expect(() => {
      JSON.parse(result.contents);
    }).not.toThrow();
  });

  it('refuses a file larger than the cap without reading it', async () => {
    const path = join(directory, 'huge.keeptheme');
    await writeFile(path, 'x'.repeat(128 * 1024), 'utf8');

    const result = await readKeepThemeFile(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('too-large');
  });

  it('refuses a directory', async () => {
    const result = await readKeepThemeFile(directory);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not-a-file');
  });

  it('reports a missing file without leaking the path into the message', async () => {
    const path = join(directory, 'absent.keeptheme');
    const result = await readKeepThemeFile(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unreadable');
    expect(result.message).not.toContain(directory);
  });
});

describe('writeKeepThemeFile', () => {
  it('writes and leaves no temp file behind', async () => {
    const path = join(directory, 'out.keeptheme');
    const result = await writeKeepThemeFile(path, SAMPLE);

    expect(result.ok).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(SAMPLE);
    expect(await readdir(directory)).toEqual(['out.keeptheme']);
  });

  it('overwrites an existing theme in one step', async () => {
    const path = join(directory, 'out.keeptheme');
    await writeFile(path, 'stale', 'utf8');

    expect((await writeKeepThemeFile(path, SAMPLE)).ok).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(SAMPLE);
  });

  it('fails cleanly on an unwritable location and leaves no debris', async () => {
    const path = join(directory, 'no-such-directory', 'out.keeptheme');
    const result = await writeKeepThemeFile(path, SAMPLE);

    expect(result.ok).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  });

  it('names its temp file predictably', () => {
    expect(THEME_TEMP_SUFFIX).toBe('.tmp');
    expect(themeDirectoryOf(join(directory, 'a.keeptheme'))).toBe(directory);
  });
});

describe('the import / export service', () => {
  it('exports a theme that imports back identically', async () => {
    const path = join(directory, 'exported.keeptheme');
    const theme = keepThemeFromDefinition(FALLBACK_THEME, 'Exported');

    const prepared = prepareKeepThemeExport(theme);
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) return;
    expect((await writeKeepThemeFile(path, prepared.contents)).ok).toBe(true);

    const imported = await importKeepTheme(path);
    expect('result' in imported).toBe(true);
    if (!('result' in imported)) return;
    expect(imported.fileName).toBe('exported.keeptheme');
    expect(imported.result.ok).toBe(true);
    if (!imported.result.ok) return;
    expect(imported.result.theme).toEqual(theme);
  });

  it('refuses to prepare a theme it could not import back, before any dialog opens', async () => {
    const theme = keepThemeFromDefinition(FALLBACK_THEME, 'Bad');
    // Text one shade off its background: below the legibility floor, so unexportable.
    const illegible = { ...theme, palette: { ...theme.palette, text: '#131419' } };

    const prepared = prepareKeepThemeExport(illegible);
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.rejection.kind).toBe('illegible');
    // Nothing was written and nothing could have been: the verification happens before a
    // path exists, which is the reason it is a separate function from the write.
    expect(await readdir(directory)).toEqual([]);
  });

  it('reports a file that is not a theme as a parse rejection, not a read failure', async () => {
    const path = join(directory, 'notes.txt');
    await writeFile(path, 'shopping list', 'utf8');

    const imported = await importKeepTheme(path);
    expect('result' in imported).toBe(true);
    if (!('result' in imported)) return;
    expect(imported.result.ok).toBe(false);
    if (imported.result.ok) return;
    expect(imported.result.rejection.kind).toBe('not-json');
  });

  it('reports an over-large file as a read failure before parsing', async () => {
    const path = join(directory, 'huge.keeptheme');
    await writeFile(path, 'x'.repeat(128 * 1024), 'utf8');

    const imported = await importKeepTheme(path);
    expect('ok' in imported && !imported.ok).toBe(true);
    if (!('ok' in imported)) return;
    // The code, not a phrase out of the message: the IPC layer maps this onto a
    // `ThemeErrorCode`, and matching words in human copy is a mapping that silently rots.
    expect(imported.code).toBe('too-large');
  });
});
