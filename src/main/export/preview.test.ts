// SPDX-License-Identifier: GPL-3.0-or-later
import { EXPORT_FORMAT_IDS, type ExportFormatId } from '@shared/model/export.js';
import { MIN_KDF_PARAMS } from '@shared/format/types.js';
import { describe, expect, it } from 'vitest';
import { exportCompatibleCsv } from './generic-csv.js';
import { exportCsv } from './csv.js';
import { exportEncrypted } from './encrypted.js';
import { exportBitwardenJson } from './bitwarden-json.js';
import { exportKeyholdJson } from './keyhold-json.js';
import { previewExport } from './preview.js';
import { bareRecord, buildDocument, NOW, richRecord } from './test-fixtures.js';

/**
 * Guard: the preview is the export.
 *
 * The export dialog makes one promise that matters -- "here is exactly what this format will
 * lose, before you press the button". That promise is worth precisely as much as the
 * agreement between these two computations, so it is asserted rather than assumed.
 *
 * The readable formats are checked against the real exporter's own loss list, field for
 * field. The parcel is checked against `exportEncrypted`, which costs a key derivation and is
 * therefore run once with the cheapest Argon2 parameters the floor allows rather than for
 * every case.
 */

const DOCUMENT = buildDocument([
  richRecord({ id: 'a', title: 'Bank' }),
  richRecord({ id: 'b', title: 'Mail', trashedAt: NOW - 1000 }),
  bareRecord({ id: 'c', title: 'Router' }),
  richRecord({ id: 'd', title: 'Archive', trashedAt: NOW - 2000 }),
]);

const WHOLE = { includeTrashed: false, recordIds: null } as const;

const READABLE = ['keyhold-json', 'keyhold-csv', 'compatible-csv', 'bitwarden-json'] as const;

function runReadable(format: (typeof READABLE)[number], includeTrashed: boolean) {
  const options = { now: NOW, includeTrashed };
  switch (format) {
    case 'keyhold-json':
      return exportKeyholdJson(DOCUMENT, options);
    // No `now`: Bitwarden's envelope carries no export timestamp, so there is nothing to stamp
    // and the file is deterministic for a given vault.
    case 'bitwarden-json':
      return exportBitwardenJson(DOCUMENT, { includeTrashed });
    case 'keyhold-csv':
      return exportCsv(DOCUMENT, options);
    case 'compatible-csv':
      return exportCompatibleCsv(DOCUMENT, options);
  }
}

describe('previewExport', () => {
  it('covers every format in the registry', () => {
    // Not a formality: a format with no preview branch would throw on the dialog's first
    // render, and the only place that shows up is here.
    expect(new Set<ExportFormatId>([...READABLE, 'keyhold-parcel'])).toEqual(
      new Set(EXPORT_FORMAT_IDS)
    );
  });

  for (const format of READABLE) {
    for (const includeTrashed of [false, true]) {
      it(`reports exactly what ${format} loses (trashed: ${includeTrashed})`, () => {
        const preview = previewExport(DOCUMENT, {
          format,
          scope: { includeTrashed, recordIds: null },
          now: NOW,
        });
        const actual = runReadable(format, includeTrashed);

        expect(preview.losses).toEqual(actual.losses);
        expect(preview.recordCount).toBe(actual.recordCount);
        expect(preview.containsSecrets).toBe(true);
      });
    }
  }

  it('reports what a parcel loses without deriving a key', async () => {
    const preview = previewExport(DOCUMENT, {
      format: 'keyhold-parcel',
      scope: WHOLE,
      now: NOW,
    });
    const actual = await exportEncrypted(DOCUMENT, {
      password: 'a passphrase used only by this test',
      now: NOW,
      includeTrashed: false,
      // The floor, not a cheaper setting: `assertUsableKdfParams` refuses anything below
      // it, which is the guard doing its job. Still a real derivation, still the
      // production path -- it is simply the cheapest one the project permits.
      kdf: MIN_KDF_PARAMS,
    });

    expect(preview.losses).toEqual(actual.losses);
    expect(preview.recordCount).toBe(actual.recordCount);
    expect(preview.containsSecrets).toBe(false);
  });

  it('counts trashed records in scope both ways round', () => {
    const excluded = previewExport(DOCUMENT, {
      format: 'keyhold-csv',
      scope: WHOLE,
      now: NOW,
    });
    const included = previewExport(DOCUMENT, {
      format: 'keyhold-csv',
      scope: { includeTrashed: true, recordIds: null },
      now: NOW,
    });

    // The same fact, reported identically whichever way the switch is set. A dialog that
    // could only say "2 excluded" would go silent the moment the user turned them on, which
    // is the moment the number matters most.
    expect(excluded.trashedInScope).toBe(2);
    expect(included.trashedInScope).toBe(2);
    expect(excluded.recordCount).toBe(2);
    expect(included.recordCount).toBe(4);
  });

  it('counts selected ids that are no longer in the vault', () => {
    const preview = previewExport(DOCUMENT, {
      format: 'keyhold-json',
      scope: { includeTrashed: false, recordIds: ['a', 'gone', 'also-gone'] },
      now: NOW,
    });

    expect(preview.unknownIds).toBe(2);
    expect(preview.recordCount).toBe(1);
  });

  it('never returns bytes', () => {
    const preview = previewExport(DOCUMENT, {
      format: 'keyhold-json',
      scope: WHOLE,
      now: NOW,
    });

    // The preview crosses IPC. `ExportPreview` has no byte field by type, and this asserts
    // the object does not carry one anyway -- the readable branch builds one internally and
    // an accidental spread of it would be a plaintext dump of the vault in the renderer.
    const serialised = JSON.stringify(preview);
    expect(Object.keys(preview).sort()).toEqual([
      'containsSecrets',
      'format',
      'losses',
      'recordCount',
      'trashedInScope',
      'unknownIds',
    ]);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('correct-horse-battery-staple');
  });

  it('refuses an unknown format rather than reporting no losses', () => {
    expect(() =>
      previewExport(DOCUMENT, {
        format: 'not-a-format' as ExportFormatId,
        scope: WHOLE,
        now: NOW,
      })
    ).toThrow(/Unknown export format/);
  });
});
