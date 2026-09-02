// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import type { ExportFormatDescriptor } from '@shared/model/export.js';
import {
  matchesPlaintextConfirmation,
  normaliseConfirmation,
  PLAINTEXT_CONFIRMATION_PHRASE,
} from '@shared/model/export-plan.js';
import {
  buildExportPlan,
  canAdvance,
  confirmationSatisfied,
  emptyDraft,
  EXPORT_STEPS,
  EXPORT_STEP_HEADINGS,
  EXPORT_STEP_LABELS,
  nextStep,
  previousStep,
  resetDraft,
  scopeIsUsable,
  stepIndex,
  type ExportDraft,
  type ExportStep,
} from './export-steps.js';
import { SAMPLE_FORMATS } from './fake-export-gateway.js';

/**
 * The rules of the export dialog, tested without a renderer.
 *
 * `@testing-library/react` is not a dependency of this project, so anything expressed only
 * inside a component is effectively untested. That is why every gate lives in
 * `export-steps.ts` and why this file is where the security-relevant assertions are: the
 * one about a plaintext export never being reachable without a typed confirmation is worth
 * more than any number of assertions about which button was rendered.
 *
 * `ExportDialogBody.test.tsx` covers the wiring — that the components actually call these
 * functions — through a real mount.
 */

function formatById(id: string): ExportFormatDescriptor {
  const found = SAMPLE_FORMATS.find((format) => format.id === id);
  if (found === undefined) throw new Error(`no such fixture format: ${id}`);
  return found;
}

const PARCEL = formatById('keyhold-parcel');
const JSON_FORMAT = formatById('keyhold-json');
const CSV = formatById('keyhold-csv');
const COMPATIBLE_CSV = formatById('compatible-csv');

const PLAINTEXT_FORMATS = [JSON_FORMAT, CSV, COMPATIBLE_CSV];

function draftFor(
  descriptor: ExportFormatDescriptor,
  overrides: Partial<ExportDraft> = {}
): ExportDraft {
  return { ...emptyDraft(), formatId: descriptor.id, ...overrides };
}

// ── The confirmation phrase ──────────────────────────────────────────────────

describe('the plaintext confirmation phrase', () => {
  it('accepts the phrase however it was capitalised or spaced', () => {
    for (const typed of [
      PLAINTEXT_CONFIRMATION_PHRASE,
      'export unencrypted',
      '  Export   Unencrypted  ',
      'eXpOrT\tUNENCRYPTED',
    ]) {
      expect(matchesPlaintextConfirmation(typed)).toBe(true);
    }
  });

  it('rejects anything that is not the phrase', () => {
    for (const typed of [
      '',
      ' ',
      'export',
      'unencrypted',
      'EXPORT UNENCRYPTE',
      'EXPORTUNENCRYPTED',
      'yes',
      'EXPORT ENCRYPTED',
    ]) {
      expect(matchesPlaintextConfirmation(typed)).toBe(false);
    }
  });

  it('is not a substring match — a phrase inside a sentence does not authorise anything', () => {
    // The failure mode this guards: an `includes` implementation would let a pasted sentence
    // that happens to quote the warning back at us count as a deliberate confirmation.
    expect(matchesPlaintextConfirmation('I do not want to EXPORT UNENCRYPTED data')).toBe(false);
    expect(matchesPlaintextConfirmation(`${PLAINTEXT_CONFIRMATION_PHRASE} please`)).toBe(false);
  });

  it('normalises to a comparable form without changing what was typed', () => {
    expect(normaliseConfirmation('  export   unencrypted ')).toBe(PLAINTEXT_CONFIRMATION_PHRASE);
  });
});

// ── Step order ───────────────────────────────────────────────────────────────

describe('step order', () => {
  it('runs format → scope → confirm → result and stops', () => {
    expect(EXPORT_STEPS).toEqual(['format', 'scope', 'confirm', 'result']);
    expect(nextStep('format')).toBe('scope');
    expect(nextStep('scope')).toBe('confirm');
    expect(nextStep('confirm')).toBe('result');
    expect(nextStep('result')).toBeNull();
  });

  it('walks back the same way, and not off the front', () => {
    expect(previousStep('result')).toBe('confirm');
    expect(previousStep('confirm')).toBe('scope');
    expect(previousStep('scope')).toBe('format');
    expect(previousStep('format')).toBeNull();
  });

  it('gives every step an index, a chip label and a heading', () => {
    for (const step of EXPORT_STEPS) {
      expect(stepIndex(step)).toBeGreaterThanOrEqual(0);
      expect(EXPORT_STEP_LABELS[step].length).toBeGreaterThan(0);
      expect(EXPORT_STEP_HEADINGS[step].length).toBeGreaterThan(0);
    }
  });
});

// ── The trashed default ──────────────────────────────────────────────────────

describe('trashed records', () => {
  it('are excluded by a fresh draft', () => {
    expect(emptyDraft().scope.includeTrashed).toBe(false);
  });

  it('are excluded again by the draft the dialog resets to', () => {
    expect(resetDraft().scope.includeTrashed).toBe(false);
  });

  it('reach the plan only as an explicit true', () => {
    const off = buildExportPlan(
      draftFor(JSON_FORMAT, { confirmation: PLAINTEXT_CONFIRMATION_PHRASE }),
      JSON_FORMAT
    );
    expect(off?.scope.includeTrashed).toBe(false);

    const on = buildExportPlan(
      draftFor(JSON_FORMAT, {
        confirmation: PLAINTEXT_CONFIRMATION_PHRASE,
        scope: { includeTrashed: true, recordIds: null },
      }),
      JSON_FORMAT
    );
    expect(on?.scope.includeTrashed).toBe(true);
  });
});

// ── The scope ────────────────────────────────────────────────────────────────

describe('scope', () => {
  it('treats the whole vault and a non-empty selection as usable', () => {
    expect(scopeIsUsable({ includeTrashed: false, recordIds: null })).toBe(true);
    expect(scopeIsUsable({ includeTrashed: false, recordIds: ['a'] })).toBe(true);
  });

  it('refuses an empty selection rather than silently exporting everything', () => {
    // The engine treats `[]` as "export nothing", which is a legitimate request from a
    // caller and a mistake from a person. The dialog blocks it; it must never quietly widen
    // it to the whole vault, which would be the dangerous repair.
    expect(scopeIsUsable({ includeTrashed: false, recordIds: [] })).toBe(false);
    expect(
      buildExportPlan(
        draftFor(JSON_FORMAT, {
          confirmation: PLAINTEXT_CONFIRMATION_PHRASE,
          scope: { includeTrashed: false, recordIds: [] },
        }),
        JSON_FORMAT
      )
    ).toBeNull();
  });
});

// ── The guard ────────────────────────────────────────────────────────────────

describe('a plaintext export cannot be planned without the confirmation', () => {
  it.each(PLAINTEXT_FORMATS.map((format) => [format.id, format] as const))(
    '%s refuses an unconfirmed draft',
    (_id, descriptor) => {
      for (const confirmation of ['', 'yes', 'EXPORT', 'export unencrypte']) {
        expect(buildExportPlan(draftFor(descriptor, { confirmation }), descriptor)).toBeNull();
        expect(
          confirmationSatisfied(draftFor(descriptor, { confirmation }), descriptor, true)
        ).toBe(false);
        expect(
          canAdvance('confirm', draftFor(descriptor, { confirmation }), descriptor, true)
        ).toBe(false);
      }
    }
  );

  it.each(PLAINTEXT_FORMATS.map((format) => [format.id, format] as const))(
    '%s produces a plan once the phrase is typed, carrying it verbatim',
    (_id, descriptor) => {
      const typed = ' export   unencrypted ';
      const plan = buildExportPlan(draftFor(descriptor, { confirmation: typed }), descriptor);

      expect(plan).not.toBeNull();
      expect(plan?.kind).toBe('plaintext');
      expect(plan?.format).toBe(descriptor.id);
      // Sent raw, not normalised: the main process runs the same matcher itself rather than
      // trusting a decision the renderer already made.
      expect(plan?.kind === 'plaintext' ? plan.confirmation : null).toBe(typed);
    }
  );

  it('never lets a passphrase stand in for the confirmation', () => {
    const draft = draftFor(CSV, {
      confirmation: '',
      secretPassphrase: 'correct horse battery staple',
      passphraseRepeat: 'correct horse battery staple',
    });
    expect(buildExportPlan(draft, CSV)).toBeNull();
    expect(canAdvance('confirm', draft, CSV, true)).toBe(false);
  });

  it('refuses a draft whose format does not match the descriptor it is checked against', () => {
    // The shape of a mis-wired dialog: the confirm step showing one format's warning while
    // the draft still holds another. Refusing is the only safe answer.
    const draft = draftFor(CSV, { confirmation: PLAINTEXT_CONFIRMATION_PHRASE });
    expect(buildExportPlan(draft, JSON_FORMAT)).toBeNull();
  });
});

// ── The parcel ───────────────────────────────────────────────────────────────

describe('the encrypted parcel', () => {
  it('needs a passphrase entered twice, identically', () => {
    expect(buildExportPlan(draftFor(PARCEL), PARCEL)).toBeNull();
    expect(
      buildExportPlan(draftFor(PARCEL, { secretPassphrase: 'a-long-one' }), PARCEL)
    ).toBeNull();
    expect(
      buildExportPlan(
        draftFor(PARCEL, { secretPassphrase: 'a-long-one', passphraseRepeat: 'a-long-two' }),
        PARCEL
      )
    ).toBeNull();

    const plan = buildExportPlan(
      draftFor(PARCEL, { secretPassphrase: 'a-long-one', passphraseRepeat: 'a-long-one' }),
      PARCEL
    );
    expect(plan?.kind).toBe('encrypted');
    expect(plan?.kind === 'encrypted' ? plan.secretPassphrase : null).toBe('a-long-one');
  });

  it('is blocked by a weak passphrase at the step gate, but is not a malformed plan', () => {
    const draft = draftFor(PARCEL, { secretPassphrase: '1234', passphraseRepeat: '1234' });

    // Strength is a policy the dialog enforces...
    expect(canAdvance('confirm', draft, PARCEL, false)).toBe(false);
    expect(confirmationSatisfied(draft, PARCEL, false)).toBe(false);
    // ...not a security invariant of the request, which is why it is not checked here.
    // Keeping the two apart is what makes it obvious which one a future edit weakens.
    expect(buildExportPlan(draft, PARCEL)).not.toBeNull();
  });

  it('ignores the strength answer entirely for a plaintext format', () => {
    const draft = draftFor(CSV, { confirmation: PLAINTEXT_CONFIRMATION_PHRASE });
    expect(confirmationSatisfied(draft, CSV, false)).toBe(true);
    expect(confirmationSatisfied(draft, CSV, true)).toBe(true);
  });
});

// ── Advancing ────────────────────────────────────────────────────────────────

describe('canAdvance', () => {
  it('blocks the first step until a format is chosen', () => {
    expect(canAdvance('format', emptyDraft(), null, false)).toBe(false);
    expect(canAdvance('format', draftFor(CSV), CSV, false)).toBe(true);
  });

  it('blocks the scope step when the selection is empty', () => {
    const draft = draftFor(CSV, { scope: { includeTrashed: false, recordIds: [] } });
    expect(canAdvance('scope', draft, CSV, false)).toBe(false);
  });

  it('has nowhere to go from the result step', () => {
    const done: ExportStep = 'result';
    expect(canAdvance(done, draftFor(CSV, { confirmation: 'export unencrypted' }), CSV, true)).toBe(
      false
    );
  });
});
