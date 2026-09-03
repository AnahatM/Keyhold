// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MergeCommitResult, MergePreview } from '@shared/model/sync-plan.js';
import type { ConflictChoice, MergeConflict, MergeReport } from '@shared/model/sync.js';
import { applySweep, planSweep, type SweepPlan, type SweepScope } from './bulk-resolution.js';
import {
  filterCounts,
  filterGroups,
  groupConflicts,
  initiallyExpanded,
  pageOfGroups,
  type ConflictFilter,
  type ConflictGroup,
  type GroupPage,
} from './conflict-groups.js';
import type { MergeTargetNames } from './merge-targets.js';
import {
  carryOver,
  choose,
  summarise,
  toResolutions,
  type ResolutionSummary,
  type Selections,
} from './resolution-state.js';
import { SyncGatewayError, syncErrorMessage, type SyncGateway } from './sync-gateway.js';

/**
 * The resolver's state machine, kept out of the components.
 *
 * ## The one invariant this hook exists to hold
 *
 * **Nothing is written until everything is settled, and the UI's own state says so.** That is
 * not a label on a button — it is three distinct facts, and collapsing them is how a
 * half-resolved merge ends up looking applied:
 *
 *  1. the user has answered every question (`summary.remaining === 0`);
 *  2. the engine has been re-run with those answers (`!summary.needsRemerge`);
 *  3. the engine agrees there is nothing left (`!report.requiresResolution`).
 *
 * Fact 2 is the one that is easy to lose. Choosing a side changes a *local* map; the merged
 * document in the main process is still the previous one. Enabling apply the instant the last
 * radio is clicked would commit a document that never saw the last four hundred answers. So the
 * primary button is `'recheck'` until the merge has been re-run, and only then `'apply'`.
 *
 * ## Why re-checking can add work
 *
 * `mergeDocuments` re-runs from the original documents every time. Folding a choice in can
 * change what the next question is — keeping *their* record can surface a field conflict inside
 * it that our version never had. {@link MergeResolverController.lastCheck} carries that back to
 * the screen so a report that grew says so, instead of the countdown mysteriously going up.
 */

export type ResolverPhase = 'reviewing' | 'rechecking' | 'applying' | 'applied';

/** What the primary button does right now. Derived, never stored — see the invariant above. */
export type PrimaryAction = 'answer' | 'recheck' | 'apply' | 'done';

export interface CheckOutcome {
  /** Conflicts in the new report that the previous one did not have. */
  readonly appeared: number;
  /** Conflicts the previous report had that the new one does not. */
  readonly disappeared: number;
}

export interface MergeResolverOptions {
  readonly gateway: SyncGateway;
  readonly preview: MergePreview;
  readonly names: MergeTargetNames;
  readonly onApplied?: ((result: MergeCommitResult) => void) | undefined;
}

export interface MergeResolverController {
  readonly report: MergeReport;
  readonly planId: string;
  readonly backupFileName: string;
  readonly selections: Selections;
  readonly summary: ResolutionSummary;
  readonly phase: ResolverPhase;
  readonly busy: boolean;
  readonly error: string | null;
  readonly result: MergeCommitResult | null;
  readonly lastCheck: CheckOutcome | null;

  readonly groups: readonly ConflictGroup[];
  readonly visible: GroupPage;
  readonly filter: ConflictFilter;
  readonly counts: Readonly<Record<ConflictFilter, number>>;
  readonly expanded: ReadonlySet<string>;
  readonly primary: PrimaryAction;

  readonly setFilter: (filter: ConflictFilter) => void;
  readonly toggleGroup: (key: string) => void;
  readonly expandAll: () => void;
  readonly collapseAll: () => void;
  readonly showMore: () => void;

  readonly pick: (conflictId: string, choice: ConflictChoice | null) => void;
  /** Previews a sweep without performing it, so the button can state its own scope. */
  readonly previewSweep: (
    conflicts: readonly MergeConflict[],
    scope: SweepScope,
    choice: ConflictChoice
  ) => SweepPlan;
  readonly sweep: (plan: SweepPlan) => void;

  readonly recheck: () => void;
  readonly apply: () => void;
  readonly dismissError: () => void;
}

function messageOf(error: unknown): string {
  if (error instanceof SyncGatewayError) return syncErrorMessage(error);
  // Never the raw error: an unknown throw could stringify anything, and this screen holds a
  // report about two vaults. A fixed sentence is the safe floor.
  return 'The merge could not be completed. Your vault has not been changed.';
}

function idsOf(report: MergeReport): ReadonlySet<string> {
  return new Set(report.conflicts.map((conflict) => conflict.id));
}

export function useMergeResolver(options: MergeResolverOptions): MergeResolverController {
  const { gateway, preview, names, onApplied } = options;

  const [report, setReport] = useState<MergeReport>(preview.report);
  const [selections, setSelections] = useState<Selections>(() =>
    carryOver(new Map(), preview.report)
  );
  const [phase, setPhase] = useState<ResolverPhase>('reviewing');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MergeCommitResult | null>(null);
  const [lastCheck, setLastCheck] = useState<CheckOutcome | null>(null);
  const [filter, setFilter] = useState<ConflictFilter>('all');
  const [pages, setPages] = useState(1);

  const groups = useMemo(
    () => groupConflicts(report, names, selections),
    [report, names, selections]
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() =>
    initiallyExpanded(groupConflicts(preview.report, names, new Map()))
  );

  const summary = useMemo(() => summarise(report, selections), [report, selections]);
  const counts = useMemo(() => filterCounts(report, selections), [report, selections]);
  const filtered = useMemo(
    () => filterGroups(groups, filter, selections),
    [groups, filter, selections]
  );
  const visible = useMemo(() => pageOfGroups(filtered, pages), [filtered, pages]);

  /**
   * The plan holds a decrypted copy of another whole vault. It goes when this screen goes,
   * however it goes — applied, cancelled, or unmounted by a route change.
   *
   * Refs rather than dependencies, because this effect must run exactly once on unmount: a
   * dependency array containing `gateway` would discard the plan the moment the caller
   * re-created the gateway object, which is the sort of bug that only appears in production.
   */
  const gatewayRef = useRef(gateway);
  const planIdRef = useRef(preview.planId);
  // Written in an effect rather than during render: a ref mutated while rendering is a value
  // React is allowed to throw away, and this one has to survive to the teardown below.
  useEffect(() => {
    gatewayRef.current = gateway;
    planIdRef.current = preview.planId;
  });
  useEffect(() => {
    return () => {
      // A plan already dropped by a successful commit refuses politely. Swallowed on purpose:
      // an error toast during teardown is noise about work that is already finished.
      void gatewayRef.current.discard(planIdRef.current).catch(() => undefined);
    };
  }, []);

  const busy = phase === 'rechecking' || phase === 'applying';

  const pick = useCallback(
    (conflictId: string, choice: ConflictChoice | null) => {
      if (busy) return;
      setSelections((current) => choose(current, conflictId, choice));
    },
    [busy]
  );

  const previewSweep = useCallback(
    (conflicts: readonly MergeConflict[], scope: SweepScope, choice: ConflictChoice): SweepPlan =>
      planSweep(conflicts, selections, scope, choice),
    [selections]
  );

  const sweep = useCallback(
    (plan: SweepPlan) => {
      if (busy) return;
      setSelections((current) => applySweep(current, plan));
    },
    [busy]
  );

  const recheck = useCallback(() => {
    if (busy) return;
    setPhase('rechecking');
    setError(null);
    const previousIds = idsOf(report);
    void (async () => {
      try {
        const next = await gateway.resolve({
          planId: preview.planId,
          choices: toResolutions(selections, report),
        });
        const nextIds = idsOf(next);
        setLastCheck({
          appeared: [...nextIds].filter((id) => !previousIds.has(id)).length,
          disappeared: [...previousIds].filter((id) => !nextIds.has(id)).length,
        });
        setSelections((current) => carryOver(current, next));
        setReport(next);
      } catch (caught: unknown) {
        setError(messageOf(caught));
      } finally {
        setPhase('reviewing');
      }
    })();
  }, [busy, gateway, preview.planId, report, selections]);

  const apply = useCallback(() => {
    if (busy) return;
    // Belt and braces. `MergeSessionStore.commit` throws on an unsettled report, and the button
    // is disabled — but this is the call that rewrites a whole vault, so it also refuses itself.
    if (report.requiresResolution) return;
    setPhase('applying');
    setError(null);
    void (async () => {
      try {
        const committed = await gateway.commit(preview.planId);
        setResult(committed);
        setPhase('applied');
        onApplied?.(committed);
      } catch (caught: unknown) {
        setError(messageOf(caught));
        setPhase('reviewing');
      }
    })();
  }, [busy, gateway, onApplied, preview.planId, report.requiresResolution]);

  const toggleGroup = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    setExpanded(new Set(groups.map((group) => group.key)));
  }, [groups]);

  const collapseAll = useCallback(() => {
    setExpanded(new Set<string>());
  }, []);

  const showMore = useCallback(() => {
    setPages((current) => current + 1);
  }, []);

  const changeFilter = useCallback((next: ConflictFilter) => {
    setFilter(next);
    // A filter change is a new list, so the page count restarts. Keeping it would show page
    // three of a two-page list, which reads as "nothing matched".
    setPages(1);
  }, []);

  const primary: PrimaryAction =
    phase === 'applied'
      ? 'done'
      : summary.readyToApply
        ? 'apply'
        : summary.remaining === 0
          ? 'recheck'
          : 'answer';

  return {
    report,
    planId: preview.planId,
    backupFileName: preview.backupFileName,
    selections,
    summary,
    phase,
    busy,
    error,
    result,
    lastCheck,
    groups,
    visible,
    filter,
    counts,
    expanded,
    primary,
    setFilter: changeFilter,
    toggleGroup,
    expandAll,
    collapseAll,
    showMore,
    pick,
    previewSweep,
    sweep,
    recheck,
    apply,
    dismissError: useCallback(() => {
      setError(null);
    }, []),
  };
}
