// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { MIN_KDF_PARAMS } from '@shared/format/types.js';
import {
  EXPORT_FORMAT_IDS,
  exportFileName,
  PLAINTEXT_EXPORT_WARNING,
  type ExportFormatId,
} from '@shared/model/export.js';
import { EXPORT_FORMATS, findExportFormat, runExport } from './index.js';
import { bareRecord, buildDocument, NOW } from './test-fixtures.js';
import { reportOf } from './types.js';

/**
 * The registry's guard tests.
 *
 * Rule 8 says there is one format registry, and rule 9 says a registry ships with a
 * uniqueness test. Both matter here for a specific reason: the format list, the save
 * dialog's filter and the dispatcher all read `EXPORT_FORMATS`, so a format that exists in
 * the union but not in the array is a button that is never drawn, and one in the array twice
 * is a dropdown with a duplicate entry that dispatches to whichever came first.
 */

const KDF = {
  memoryKib: MIN_KDF_PARAMS.memoryKib,
  iterations: MIN_KDF_PARAMS.iterations,
  parallelism: MIN_KDF_PARAMS.parallelism,
} as const;

const DOCUMENT = buildDocument([bareRecord()]);

describe('the registry', () => {
  it('describes every format exactly once', () => {
    const ids = EXPORT_FORMATS.map((format) => format.id);
    expect([...ids].sort()).toEqual([...EXPORT_FORMAT_IDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every format a dotted, lower-case extension', () => {
    for (const format of EXPORT_FORMATS) {
      expect(format.extension).toMatch(/^\.[a-z]+$/);
    }
  });

  it('offers the encrypted format first, so the safe choice is the obvious one', () => {
    expect(EXPORT_FORMATS[0]?.encrypted).toBe(true);
  });

  it('finds a format by id, and returns null rather than throwing for one it has not got', () => {
    expect(findExportFormat('keyhold-json')?.extension).toBe('.json');
    expect(findExportFormat('not-a-format' as ExportFormatId)).toBeNull();
  });
});

describe('runExport', () => {
  it('produces every format, tagged with the id it was asked for', async () => {
    const requests = [
      { format: 'keyhold-json', now: NOW },
      { format: 'keyhold-csv' },
      { format: 'compatible-csv' },
      { format: 'keyhold-parcel', password: 'parcel passphrase', now: NOW, kdf: KDF },
    ] as const;

    for (const request of requests) {
      const output = await runExport(DOCUMENT, request);
      expect(output.format).toBe(request.format);
      expect(output.extension).toBe(findExportFormat(request.format)?.extension);
    }
  });

  it('attaches the warning to every readable format and to no sealed one', async () => {
    for (const format of EXPORT_FORMATS) {
      const output = await runExport(
        DOCUMENT,
        format.encrypted
          ? { format: 'keyhold-parcel', password: 'parcel passphrase', now: NOW, kdf: KDF }
          : format.id === 'keyhold-json'
            ? { format: 'keyhold-json', now: NOW }
            : { format: format.id === 'keyhold-csv' ? 'keyhold-csv' : 'compatible-csv' }
      );

      expect(output.containsSecrets).toBe(!format.encrypted);
      expect(output.warning).toBe(format.encrypted ? null : PLAINTEXT_EXPORT_WARNING);
    }
  });
});

describe('the IPC-safe report', () => {
  it('carries no bytes, whichever branch it came from', async () => {
    const plaintext = reportOf(await runExport(DOCUMENT, { format: 'keyhold-csv' }));
    const sealed = reportOf(
      await runExport(DOCUMENT, {
        format: 'keyhold-parcel',
        password: 'parcel passphrase',
        now: NOW,
        kdf: KDF,
      })
    );

    for (const report of [plaintext, sealed]) {
      expect(Object.keys(report).sort()).toEqual([
        'containsSecrets',
        'extension',
        'format',
        'losses',
        'recordCount',
        'warning',
      ]);
    }
  });
});

describe('default file names', () => {
  it('keeps a readable name and strips what a path separator could exploit', () => {
    const json = findExportFormat('keyhold-json')!;
    expect(exportFileName('Personal vault', json)).toBe('Personal vault-export.json');
    expect(exportFileName('../../etc/passwd', json)).toBe('etcpasswd-export.json');
    expect(exportFileName('', json)).toBe('vault-export.json');
  });
});
