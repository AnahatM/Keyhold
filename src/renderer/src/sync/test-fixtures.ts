// SPDX-License-Identifier: GPL-3.0-or-later
import type { MergePreview } from '@shared/model/sync-plan.js';
import type {
  ConflictSide,
  MergeConflict,
  MergeConflictKind,
  MergeMode,
  MergeNote,
  MergeRecordCounts,
  MergeReport,
  MergeResolution,
} from '@shared/model/sync.js';
import { targetNamesFrom, type MergeTargetNames } from './merge-targets.js';

/**
 * Reports to test against, and one deliberately hostile one.
 *
 * Shared between the pure-logic tests and the mounted-component test so that both are arguing
 * about the same shapes. Nothing here is exported from `index.ts`.
 */

const BASE_COUNTS: MergeRecordCounts = {
  ours: 3,
  theirs: 3,
  base: 3,
  merged: 3,
  added: 0,
  updated: 2,
  unchanged: 1,
  trashed: 0,
  conflicted: 2,
};

export function value(v: string | number | boolean | null | readonly string[]): ConflictSide {
  return { kind: 'value', value: v };
}

export function secret(length: number): ConflictSide {
  return { kind: 'secret', length };
}

export interface ConflictOverrides {
  readonly kind?: MergeConflictKind;
  readonly targetId?: string;
  readonly field?: string | null;
  readonly ours?: ConflictSide;
  readonly theirs?: ConflictSide;
  readonly base?: ConflictSide | null;
  readonly applied?: MergeConflict['applied'];
  readonly resolution?: MergeResolution;
}

/**
 * One conflict, with the id built the way the engine builds it.
 *
 * The id grammar is copied from `src/main/sync/conflict-projection.ts` rather than imported,
 * because the renderer must not import main-process code. It only has to be *shaped* like a
 * real id for these tests — nothing here parses it, which is itself part of what is asserted.
 */
export function conflict(overrides: ConflictOverrides = {}): MergeConflict {
  const kind = overrides.kind ?? 'record-field';
  const targetId = overrides.targetId ?? 'rec-1';
  const field = overrides.field === undefined ? 'title' : overrides.field;
  const id =
    kind === 'setting'
      ? `setting:${targetId}`
      : kind === 'record-delete-vs-edit'
        ? `record:${targetId}:trash`
        : kind === 'record-history'
          ? `record:${targetId}:history:${field ?? 'enabled'}`
          : kind === 'folder' || kind === 'tag'
            ? `${kind}:${targetId}:${field ?? 'name'}`
            : `record:${targetId}:field:${field ?? 'title'}`;

  return {
    id,
    kind,
    targetId,
    field,
    ours: overrides.ours ?? value('ours'),
    theirs: overrides.theirs ?? value('theirs'),
    base: overrides.base === undefined ? value('base') : overrides.base,
    applied: overrides.applied ?? 'ours',
    resolution: overrides.resolution ?? 'unresolved',
  };
}

export interface ReportOverrides {
  readonly mode?: MergeMode;
  readonly conflicts?: readonly MergeConflict[];
  readonly notes?: readonly MergeNote[];
  readonly counts?: MergeRecordCounts;
  readonly attachmentsToImport?: readonly string[];
}

/**
 * A report whose `requiresResolution` is *derived*, exactly as the engine derives it.
 *
 * Hand-setting it would let a fixture describe a state the engine cannot produce, and the
 * screen's whole gate is built on that flag being trustworthy.
 */
export function report(overrides: ReportOverrides = {}): MergeReport {
  const conflicts = overrides.conflicts ?? [];
  return {
    mode: overrides.mode ?? 'three-way',
    generatedAt: 1_700_000_000_000,
    counts: overrides.counts ?? BASE_COUNTS,
    conflicts,
    notes: overrides.notes ?? [],
    requiresResolution: conflicts.some((c) => c.resolution === 'unresolved'),
    attachmentsToImport: overrides.attachmentsToImport ?? [],
  };
}

export function preview(reportValue: MergeReport, planId = 'plan-1'): MergePreview {
  return { planId, report: reportValue, backupFileName: 'vault.pre-merge.2026-09-03.keep' };
}

export function names(): MergeTargetNames {
  return targetNamesFrom({
    records: [
      { id: 'rec-1', title: 'GitHub' },
      { id: 'rec-2', title: 'Bank' },
      { id: 'rec-3', title: 'Untitled note' },
    ],
    folders: [
      { id: 'fol-1', name: 'Work', parentId: null },
      { id: 'fol-2', name: 'Cloud', parentId: 'fol-1' },
    ],
    tags: [{ id: 'tag-1', name: 'personal' }],
    recordFolders: [
      { id: 'rec-1', folderId: 'fol-2' },
      { id: 'rec-2', folderId: null },
      { id: 'rec-3', folderId: null },
    ],
  });
}

// ── The hostile fixture ──────────────────────────────────────────────────────

/**
 * A marker no legitimate render can produce.
 *
 * Distinctive enough that a substring search cannot false-positive, and shaped like a password
 * so that a component which stringifies a side wholesale renders it verbatim.
 */
export const PLANTED_SECRET = 'ZQX-planted-secret-value-7f3a';

/**
 * A side that carries the marker in properties a leaking component would reach for.
 *
 * ## Why plant something the type cannot hold
 *
 * The required drive for the no-secrets property test is a report whose sides are all
 * length-carrying — and a `{ kind: 'secret', length }` object has **nothing in it to leak**. A
 * sweep over that DOM proves only that the component did not invent a password.
 *
 * What is actually worth proving is that the resolver renders from `kind` and a known set of
 * properties, rather than from whatever the object happens to hold. So the fixture carries
 * `value`, `secret` and `text` alongside `length`, exactly as a main process that regressed its
 * conflict projection would send them, and the test asserts none of them reaches the screen. A
 * component that ever reads `side.value` without discriminating, or renders `JSON.stringify` in
 * a debug corner, fails — which is the regression this guard exists for.
 *
 * The cast is the point of the fixture and is confined to it.
 */
export function plantedSecretSide(length: number): ConflictSide {
  return {
    kind: 'secret',
    length,
    value: PLANTED_SECRET,
    secret: PLANTED_SECRET,
    text: PLANTED_SECRET,
  } as unknown as ConflictSide;
}

/** A `custom` side whose non-secret value carries the marker — the other way a value leaks. */
export function plantedCustomSide(): ConflictSide {
  return {
    kind: 'custom',
    fields: [
      {
        id: 'cf-1',
        label: 'Recovery code',
        type: 'text',
        hidden: false,
        order: 0,
        value: PLANTED_SECRET,
        hasValue: true,
        isSecret: false,
      },
    ],
  } as unknown as ConflictSide;
}

/** A `questions` side whose answer field carries the marker, which the projection never has. */
export function plantedQuestionsSide(): ConflictSide {
  return {
    kind: 'questions',
    questions: [
      {
        id: 'sq-1',
        question: 'First pet',
        hasAnswer: true,
        answer: PLANTED_SECRET,
      },
    ],
  } as unknown as ConflictSide;
}

/**
 * A report in which every conflict hides a value, and every side carries the planted marker.
 *
 * Every secret-bearing field of the model is represented, so a leak in any one of the four
 * `ConflictSide` shapes that can hold secret material is caught.
 */
export function plantedReport(mode: MergeMode = 'two-way'): MergeReport {
  return report({
    mode,
    conflicts: [
      conflict({
        targetId: 'rec-1',
        field: 'password',
        ours: plantedSecretSide(18),
        theirs: plantedSecretSide(24),
        base: mode === 'two-way' ? null : plantedSecretSide(12),
      }),
      conflict({
        targetId: 'rec-1',
        field: 'notes',
        ours: plantedSecretSide(140),
        theirs: plantedSecretSide(3),
        base: mode === 'two-way' ? null : plantedSecretSide(9),
      }),
      conflict({
        targetId: 'rec-2',
        field: 'securityQuestions',
        ours: plantedQuestionsSide(),
        theirs: plantedQuestionsSide(),
        base: null,
      }),
      conflict({
        targetId: 'rec-2',
        field: 'custom',
        ours: plantedCustomSide(),
        theirs: plantedCustomSide(),
        base: null,
      }),
    ],
    notes: [{ kind: 'record-kept-unmatched', targetId: 'rec-3', count: null }],
  });
}
