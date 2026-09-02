// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ImportPreview } from '@shared/model/import-plan.js';
import {
  canAdvance,
  IMPORT_STEPS,
  IMPORT_STEP_HEADINGS,
  IMPORT_STEP_STOPS,
  IMPORT_STOP_LABELS,
  importWizardReducer,
  initialImportWizardState,
  needsMapping,
  nextStep,
  previewIsCurrent,
  previousStep,
  stopFor,
  visibleStops,
  type ImportWizardAction,
  type ImportWizardState,
} from './wizard-machine.js';
import { FAKE_IMPORT_FORMATS } from './fake-gateway.js';
import { GENERIC_SOURCE, genericMapping, PLANTED_SOURCE } from './test-fixtures.js';

/**
 * The rules about what happens next.
 *
 * All of them live in the reducer rather than in the component, so all of them can be
 * asserted — which is the point of the split, given that this project has no
 * `@testing-library/react`.
 *
 * The rule this file exists for above the others is **a stale preview must be impossible**.
 * Changing the format or the mapping clears the preview and the plan id it carries, so the
 * review step cannot show counts from a parse the user has since changed, and the commit
 * cannot point at one. That is a data-integrity property, not a cosmetic one: the plan id is
 * the only thing `commit` accepts, so clearing it is what makes "the preview runs the
 * commit's code" true in practice.
 */

function run(
  actions: readonly ImportWizardAction[],
  from: ImportWizardState = initialImportWizardState
): ImportWizardState {
  return actions.reduce(importWizardReducer, from);
}

const LOADED = run([{ type: 'formats-loaded', formats: FAKE_IMPORT_FORMATS }]);

/** A preview object shaped like one the gateway would return for a given source and format. */
function previewFor(sourceId: string, formatId: string): ImportPreview {
  return {
    planId: `plan-for-${formatId}`,
    sourceId,
    formatId,
    recordCount: 4,
    newRecordCount: 1,
    sample: [],
    warnings: [],
    folders: [],
    duplicates: [],
  };
}

describe('the steps themselves', () => {
  it('gives every step a heading and every stop a label', () => {
    for (const step of IMPORT_STEPS) expect(IMPORT_STEP_HEADINGS[step]).not.toBe('');
    for (const stop of IMPORT_STEP_STOPS) expect(IMPORT_STOP_LABELS[stop]).not.toBe('');
  });

  it('folds importing and done into the one indicator stop', () => {
    // A wizard that grows a stop the moment work starts is a wizard that moved the goalposts.
    expect(stopFor('importing')).toBe('import');
    expect(stopFor('done')).toBe('import');
    expect(stopFor('review')).toBe('review');
  });

  it('omits the mapping stop for a format that does not need one', () => {
    const direct = run([{ type: 'source-chosen', source: PLANTED_SOURCE }], LOADED);
    expect(needsMapping(direct)).toBe(false);
    expect(visibleStops(direct)).toEqual(['choose', 'format', 'review', 'import']);

    const generic = run([{ type: 'source-chosen', source: GENERIC_SOURCE }], LOADED);
    expect(needsMapping(generic)).toBe(true);
    expect(visibleStops(generic)).toContain('map');
  });
});

describe('moving through the wizard', () => {
  it('will not leave a step whose question is unanswered', () => {
    expect(nextStep(initialImportWizardState)).toBeNull();
    expect(canAdvance(initialImportWizardState)).toBe(false);
  });

  it('skips the mapping step for a format that brings its own', () => {
    const state = run([{ type: 'source-chosen', source: PLANTED_SOURCE }], LOADED);
    expect(state.step).toBe('format');
    expect(nextStep(state)).toBe('review');
    expect(previousStep({ ...state, step: 'review' })).toBe('format');
  });

  it('routes through the mapping step for the catch-all format', () => {
    const state = run([{ type: 'source-chosen', source: GENERIC_SOURCE }], LOADED);
    expect(nextStep(state)).toBe('map');
    expect(previousStep({ ...state, step: 'review' })).toBe('map');
  });

  it('offers no way back out of a write', () => {
    // Undo is a separate, explicit action on the result step. Conflating the two is how
    // someone comes to believe they cancelled something that already ran.
    expect(previousStep({ ...LOADED, step: 'importing' })).toBeNull();
    expect(previousStep({ ...LOADED, step: 'done' })).toBeNull();
    expect(nextStep({ ...LOADED, step: 'importing' })).toBeNull();
    expect(canAdvance({ ...LOADED, step: 'done' })).toBe(false);
  });

  it('will not advance while a call is in flight', () => {
    const state = run(
      [
        { type: 'source-chosen', source: PLANTED_SOURCE },
        { type: 'busy', busy: true },
      ],
      LOADED
    );
    expect(canAdvance(state)).toBe(false);
  });

  it('will not run the dry run on a mapping that cannot work', () => {
    const broken = { columns: { a: 'password', b: 'password' } } as const;
    const state = run(
      [
        { type: 'source-chosen', source: GENERIC_SOURCE },
        { type: 'go-to', step: 'map' },
        { type: 'mapping-changed', mapping: broken },
      ],
      LOADED
    );
    expect(canAdvance(state)).toBe(false);

    const fixed = run([{ type: 'mapping-changed', mapping: genericMapping() }], state);
    expect(canAdvance(fixed)).toBe(true);
  });
});

describe('a stale preview is impossible', () => {
  const chosen = run([{ type: 'source-chosen', source: PLANTED_SOURCE }], LOADED);
  const previewed = run(
    [{ type: 'preview-loaded', preview: previewFor('source-1', 'bitwarden-csv') }],
    chosen
  );

  it('recognises a preview that still describes the current choices', () => {
    expect(previewIsCurrent(previewed)).toBe(true);
    expect(canAdvance({ ...previewed, step: 'review' })).toBe(true);
  });

  it('drops the preview, and its plan id, when the format changes', () => {
    const switched = run([{ type: 'format-chosen', formatId: 'lastpass-csv' }], previewed);
    expect(switched.preview).toBeNull();
    expect(previewIsCurrent(switched)).toBe(false);
    expect(canAdvance({ ...switched, step: 'review' })).toBe(false);
  });

  it('drops the preview when the mapping changes', () => {
    const remapped = run([{ type: 'mapping-changed', mapping: genericMapping() }], previewed);
    expect(remapped.preview).toBeNull();
  });

  it('drops the preview when a different file is chosen', () => {
    const refiled = run([{ type: 'source-chosen', source: GENERIC_SOURCE }], previewed);
    expect(refiled.preview).toBeNull();
    expect(refiled.decisions).toEqual({});
    expect(refiled.result).toBeNull();
  });

  it('does not clear anything when the format is re-picked unchanged', () => {
    // Re-selecting the same radio must not throw away a preview the user is reading.
    const same = run([{ type: 'format-chosen', formatId: 'bitwarden-csv' }], previewed);
    expect(same).toBe(previewed);
  });

  it('keeps the preview on screen when a call fails', () => {
    const failed = run([{ type: 'failed', message: 'The vault is locked.' }], previewed);
    expect(failed.preview).toBe(previewed.preview);
    expect(failed.step).toBe(previewed.step);
    expect(failed.busy).toBe(false);
    expect(failed.error).toBe('The vault is locked.');
  });

  it('restores the file’s inferred mapping when the user switches back to the generic parser', () => {
    const generic = run([{ type: 'source-chosen', source: GENERIC_SOURCE }], LOADED);
    const away = run([{ type: 'format-chosen', formatId: 'bitwarden-csv' }], generic);
    expect(away.mapping).toBeNull();

    const back = run([{ type: 'format-chosen', formatId: 'generic-csv' }], away);
    expect(back.mapping).toEqual(genericMapping());
  });
});

describe('cancelling', () => {
  it('leaves nothing behind but the format registry', () => {
    const busy = run(
      [
        { type: 'source-chosen', source: PLANTED_SOURCE },
        { type: 'preview-loaded', preview: previewFor('source-1', 'bitwarden-csv') },
        { type: 'decision-changed', key: 'some-key', action: 'merge' },
        { type: 'go-to', step: 'review' },
      ],
      LOADED
    );

    const reset = run([{ type: 'reset' }], busy);
    expect(reset).toEqual({ ...initialImportWizardState, formats: FAKE_IMPORT_FORMATS });
    // Specifically: no source, no plan, no decisions, no result.
    expect(reset.source).toBeNull();
    expect(reset.preview).toBeNull();
    expect(reset.decisions).toEqual({});
    expect(reset.result).toBeNull();
  });
});

describe('duplicate decisions in the reducer', () => {
  const withGroups = run(
    [
      { type: 'source-chosen', source: PLANTED_SOURCE },
      {
        type: 'preview-loaded',
        preview: {
          ...previewFor('source-1', 'bitwarden-csv'),
          duplicates: [
            {
              key: 'group-a',
              matchedOn: { title: 'google', identity: 'alice', host: 'google.com' },
              existing: null,
              incoming: [],
              mergeableFields: [],
            },
            {
              key: 'group-b',
              matchedOn: { title: 'github', identity: 'alice', host: 'github.com' },
              existing: null,
              incoming: [],
              mergeableFields: [],
            },
          ],
        },
      },
    ],
    LOADED
  );

  it('seeds every group with the safe default', () => {
    expect(withGroups.decisions).toEqual({ 'group-a': 'skip', 'group-b': 'skip' });
  });

  it('changes one group without touching the others', () => {
    const one = run([{ type: 'decision-changed', key: 'group-a', action: 'merge' }], withGroups);
    expect(one.decisions).toEqual({ 'group-a': 'merge', 'group-b': 'skip' });
  });

  it('sets every group at once, and only the groups that exist', () => {
    const all = run([{ type: 'decisions-set-all', action: 'import-anyway' }], withGroups);
    expect(all.decisions).toEqual({ 'group-a': 'import-anyway', 'group-b': 'import-anyway' });
  });
});
