// SPDX-License-Identifier: GPL-3.0-or-later
import { EXPORT_FORMAT_IDS } from '@shared/model/export.js';
import {
  matchesPlaintextConfirmation,
  PLAINTEXT_CONFIRMATION_PHRASE,
} from '@shared/model/export-plan.js';
import { describe, expect, it } from 'vitest';
import {
  requireExportFormatId,
  requireExportPlan,
  requireExportPreviewRequest,
  requireExportScope,
} from './export-validation.js';
import { IpcValidationError } from './validation.js';

/**
 * Guard: the boundary an export plan has to get through.
 *
 * This is the one channel that turns an encrypted vault into a file, so the assertions here
 * are about what a **hostile** renderer cannot do, not about what a well-behaved one sends.
 * Every case below is a plan that a compromised renderer would want to send, and every one
 * is refused.
 */

const CHANNEL = 'kh:export:run';
const SCOPE = { includeTrashed: false, recordIds: null };

describe('requireExportFormatId', () => {
  it('accepts every id in the registry and nothing else', () => {
    for (const id of EXPORT_FORMAT_IDS) {
      expect(requireExportFormatId(CHANNEL, id)).toBe(id);
    }
    for (const bad of ['', 'csv', 'keyhold', 'KEYHOLD-CSV', null, 7, {}]) {
      expect(() => requireExportFormatId(CHANNEL, bad)).toThrow(IpcValidationError);
    }
  });
});

describe('requireExportScope', () => {
  it('requires includeTrashed to be present and boolean', () => {
    // Not defaulted. At the boundary where a person is choosing, an omission is a bug, and
    // reading it as `false` would quietly export less than was asked for while looking like
    // it worked.
    expect(() => requireExportScope(CHANNEL, { recordIds: null })).toThrow(IpcValidationError);
    expect(() => requireExportScope(CHANNEL, { includeTrashed: 'yes', recordIds: null })).toThrow(
      IpcValidationError
    );
  });

  it('keeps empty and null apart', () => {
    // An empty array is a request for an empty export. `null` is the whole vault. Collapsing
    // one into the other is the difference between exporting nothing and exporting
    // everything, which is not a difference to be relaxed about.
    expect(requireExportScope(CHANNEL, { includeTrashed: false, recordIds: [] }).recordIds).toEqual(
      []
    );
    expect(requireExportScope(CHANNEL, { includeTrashed: false, recordIds: null }).recordIds).toBe(
      null
    );
  });

  it('rejects malformed id lists', () => {
    for (const ids of ['a', 0, [''], [null], [{ id: 'a' }]]) {
      expect(() => requireExportScope(CHANNEL, { includeTrashed: false, recordIds: ids })).toThrow(
        IpcValidationError
      );
    }
  });
});

describe('requireExportPlan', () => {
  it('accepts a well-formed parcel plan', () => {
    const plan = requireExportPlan(CHANNEL, {
      kind: 'encrypted',
      format: 'keyhold-parcel',
      scope: SCOPE,
      secretPassphrase: 'a passphrase',
    });
    expect(plan).toEqual({
      kind: 'encrypted',
      format: 'keyhold-parcel',
      scope: SCOPE,
      secretPassphrase: 'a passphrase',
    });
  });

  it('accepts a well-formed plaintext plan and keeps the confirmation verbatim', () => {
    // Unnormalised on purpose: the main process runs the matcher, not the renderer, and it
    // can only do that if it receives what was actually typed.
    const plan = requireExportPlan(CHANNEL, {
      kind: 'plaintext',
      format: 'keyhold-csv',
      scope: SCOPE,
      confirmation: '  export unencrypted  ',
    });
    expect(plan).toMatchObject({ confirmation: '  export unencrypted  ' });
  });

  it('refuses a parcel with no passphrase', () => {
    for (const secretPassphrase of [undefined, '', null, 12345]) {
      expect(() =>
        requireExportPlan(CHANNEL, {
          kind: 'encrypted',
          format: 'keyhold-parcel',
          scope: SCOPE,
          secretPassphrase,
        })
      ).toThrow(IpcValidationError);
    }
  });

  it('refuses a plan whose kind disagrees with its format', () => {
    // The two shapes a renderer would try if it wanted to route a readable dump around the
    // confirmation, or to get a parcel written with no passphrase.
    expect(() =>
      requireExportPlan(CHANNEL, {
        kind: 'encrypted',
        format: 'keyhold-csv',
        scope: SCOPE,
        secretPassphrase: 'x',
      })
    ).toThrow(IpcValidationError);
    expect(() =>
      requireExportPlan(CHANNEL, {
        kind: 'plaintext',
        format: 'keyhold-parcel',
        scope: SCOPE,
        confirmation: PLAINTEXT_CONFIRMATION_PHRASE,
      })
    ).toThrow(IpcValidationError);
  });

  it('refuses a plan that carries a boolean instead of the typed phrase', () => {
    // The specific attack this shape exists to prevent: a renderer asserting "the user
    // confirmed" rather than passing along what they typed. There is no field for it, and a
    // plan carrying one instead of `confirmation` does not validate.
    expect(() =>
      requireExportPlan(CHANNEL, {
        kind: 'plaintext',
        format: 'keyhold-json',
        scope: SCOPE,
        confirmed: true,
      })
    ).toThrow(IpcValidationError);
  });

  it('refuses a plan with no kind at all', () => {
    for (const kind of [undefined, null, 'PLAINTEXT', 'readable', 1]) {
      expect(() =>
        requireExportPlan(CHANNEL, { kind, format: 'keyhold-json', scope: SCOPE, confirmation: '' })
      ).toThrow(IpcValidationError);
    }
  });

  it('does not judge the confirmation itself', () => {
    // Validation shapes; the handler decides. An empty confirmation has to *parse* so the
    // handler can report "that is not the phrase" as an outcome the dialog can render,
    // rather than an INVALID_REQUEST the user cannot act on.
    const plan = requireExportPlan(CHANNEL, {
      kind: 'plaintext',
      format: 'keyhold-json',
      scope: SCOPE,
      confirmation: '',
    });
    expect(plan).toMatchObject({ confirmation: '' });
    expect(matchesPlaintextConfirmation('')).toBe(false);
  });
});

describe('requireExportPreviewRequest', () => {
  it('has no room for a passphrase or a confirmation', () => {
    // Asserted on the *result*, not the input: extra keys are dropped rather than carried
    // through. A preview happens before the user has been asked for either, and a request
    // that could carry a passphrase is one that eventually does.
    const request = requireExportPreviewRequest(CHANNEL, {
      format: 'keyhold-csv',
      scope: SCOPE,
      secretPassphrase: 'should not survive',
      confirmation: PLAINTEXT_CONFIRMATION_PHRASE,
    });
    expect(Object.keys(request).sort()).toEqual(['format', 'scope']);
  });

  it('rejects a request with no scope', () => {
    expect(() => requireExportPreviewRequest(CHANNEL, { format: 'keyhold-csv' })).toThrow(
      IpcValidationError
    );
  });
});
