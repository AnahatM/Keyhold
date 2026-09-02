// SPDX-License-Identifier: GPL-3.0-or-later
import {
  DEFAULT_DUPLICATE_ACTION,
  type ImportDuplicateAction,
  type ImportDuplicateGroup,
  type ImportMergeEffect,
} from '@shared/model/import-plan.js';

/**
 * What the user decided about each duplicate group, and what those decisions add up to.
 *
 * Deduplication is the wizard's whole job. Someone who imports the same export twice —
 * because the first attempt was interrupted, because they were not sure it worked, because
 * they are trying a second manager — must not end up with two of everything. So the decision
 * map is a first-class piece of state with its own arithmetic, not a set of checkbox
 * booleans read off the DOM at commit time.
 *
 * The arithmetic matters as much as the rule: the review step's headline number is
 * "**n** records will be added", and it has to be the number that actually gets added,
 * including the effect of every per-group override. A summary that disagreed with the result
 * would destroy the only thing a dry run is for.
 */

/**
 * The safe answer for every group, preserving anything the user has already chosen.
 *
 * Existing choices survive a re-preview because the mapping step re-previews on every
 * change: silently resetting a considered "merge" back to "skip" because the user fixed an
 * unrelated column would be the wizard quietly overruling them.
 */
export function defaultDecisions(
  groups: readonly ImportDuplicateGroup[],
  existing: Readonly<Record<string, ImportDuplicateAction>> = {}
): Readonly<Record<string, ImportDuplicateAction>> {
  const decisions: Record<string, ImportDuplicateAction> = {};
  for (const group of groups) {
    decisions[group.key] = existing[group.key] ?? DEFAULT_DUPLICATE_ACTION;
  }
  return decisions;
}

/** The action for one group. Absent means the default, which is what the commit assumes too. */
export function decisionFor(
  decisions: Readonly<Record<string, ImportDuplicateAction>>,
  key: string
): ImportDuplicateAction {
  return decisions[key] ?? DEFAULT_DUPLICATE_ACTION;
}

export interface DuplicateSummary {
  readonly groupCount: number;
  /** Records inside duplicate groups, across every group. */
  readonly duplicateRecordCount: number;
  readonly skippedCount: number;
  readonly importedAnywayCount: number;
  readonly mergedCount: number;
  /** Groups the user has moved off the safe default. Drives the "you changed n" note. */
  readonly overriddenGroupCount: number;
  /** True when at least one merge would overwrite a password already in the vault. */
  readonly replacesAPassword: boolean;
}

/**
 * How many records each decision accounts for.
 *
 * A group with an existing vault match and three incoming rows contributes three records:
 * `skip` skips all three, `import-anyway` adds all three, `merge` folds all three into the
 * one existing record. A group with **no** existing match is a within-file cluster, and
 * there the counting differs — see below.
 */
export function summariseDecisions(
  groups: readonly ImportDuplicateGroup[],
  decisions: Readonly<Record<string, ImportDuplicateAction>>
): DuplicateSummary {
  let duplicateRecordCount = 0;
  let skippedCount = 0;
  let importedAnywayCount = 0;
  let mergedCount = 0;
  let overriddenGroupCount = 0;
  let replacesAPassword = false;

  for (const group of groups) {
    const action = decisionFor(decisions, group.key);
    const incoming = group.incoming.length;
    duplicateRecordCount += incoming;
    if (action !== DEFAULT_DUPLICATE_ACTION) overriddenGroupCount += 1;

    // A cluster with no vault match still has to produce **one** record, not zero: the
    // account is genuinely new, it is merely written twice in the file. Skipping all of them
    // would lose an account the user has, which is the one outcome an importer may never
    // produce. So the first row lands and the rest are the duplicates.
    const redundant = group.existing === null ? incoming - 1 : incoming;
    const kept = incoming - redundant;

    switch (action) {
      case 'skip':
        skippedCount += redundant;
        break;
      case 'import-anyway':
        importedAnywayCount += incoming - kept;
        break;
      case 'merge':
        mergedCount += redundant;
        if (mergeReplacesPassword(group)) replacesAPassword = true;
        break;
    }
  }

  return {
    groupCount: groups.length,
    duplicateRecordCount,
    skippedCount,
    importedAnywayCount,
    mergedCount,
    overriddenGroupCount,
    replacesAPassword,
  };
}

/** True when merging this group would overwrite a password that is already in the vault. */
export function mergeReplacesPassword(group: ImportDuplicateGroup): boolean {
  return group.mergeableFields.some(
    (field) => field.field === 'password' && field.effect === 'replaces'
  );
}

/**
 * The final number: records that will exist in the vault that did not before.
 *
 * `newRecordCount` from the preview counts records matching nothing at all. Everything else
 * is decided here, which is why this takes both — the preview owns the matching, the user
 * owns the decisions, and neither half is the whole answer.
 */
export function recordsToAdd(
  newRecordCount: number,
  groups: readonly ImportDuplicateGroup[],
  decisions: Readonly<Record<string, ImportDuplicateAction>>
): number {
  let total = newRecordCount;
  for (const group of groups) {
    const incoming = group.incoming.length;
    // The within-file cluster's one surviving row is an addition under every decision.
    const kept = group.existing === null ? 1 : 0;
    total += decisionFor(decisions, group.key) === 'import-anyway' ? incoming : kept;
  }
  return total;
}

// ── The words ────────────────────────────────────────────────────────────────

export interface DuplicateActionCopy {
  readonly label: string;
  /** One sentence saying what it does to the vault, in the user's terms. */
  readonly help: string;
}

/**
 * One vocabulary for the three actions.
 *
 * Written down rather than inlined at the radio buttons because the same three phrases
 * appear in the group control, in the bulk control and in the review summary, and three
 * copies of "Keep what is already in the vault" drift into three slightly different promises
 * about what the button does.
 */
export const DUPLICATE_ACTION_COPY: Readonly<Record<ImportDuplicateAction, DuplicateActionCopy>> = {
  skip: {
    label: 'Skip',
    help: 'Leave the vault as it is. Nothing is added and nothing is changed.',
  },
  'import-anyway': {
    label: 'Import anyway',
    help: 'Add these as separate records, alongside the one already in the vault.',
  },
  merge: {
    label: 'Merge',
    help: 'Update the existing record with what this file has. Check what it would replace.',
  },
};

/** Plain wording for a merge effect, so a field row reads as a sentence rather than a code. */
export const MERGE_EFFECT_COPY: Readonly<Record<ImportMergeEffect, string>> = {
  'fills-empty': 'fills a field that is currently empty',
  replaces: 'replaces what is in the vault now',
  adds: 'adds to what is already there',
  unchanged: 'no change — the values already match',
};
