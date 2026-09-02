// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useState } from 'react';
import type { HealthApi } from '@shared/ipc/api.js';
import {
  DEFAULT_HEALTH_RULE_TOGGLES,
  type HealthRuleId,
  type VaultHealthReport,
} from '@shared/model/health.js';

/**
 * Running the analysis and holding which checks are switched on.
 *
 * The analysis itself happens in the main process — it is the only place the passwords are —
 * so this is a request, a result, and the toggle state that shapes the next request. There
 * is no client-side filtering of the report: asking the engine again with a different rule
 * set is the only way to get a score that is correct for that rule set, because the score is
 * an average over records, not a sum this side could subtract from.
 */

export type AnalyseHealth = HealthApi['analyse'];

/**
 * The real bridge call, as a module-level constant.
 *
 * Stable identity matters: this is an effect dependency, and a function rebuilt every render
 * would re-run the analysis on every render — an expensive loop over the whole vault, in a
 * loop.
 */
const bridgeAnalyse: AnalyseHealth = (options) => window.keyhold.health.analyse(options);

export type RuleToggles = Readonly<Record<HealthRuleId, boolean>>;

export interface HealthReportState {
  readonly report: VaultHealthReport | null;
  readonly error: string | null;
  /** True while an analysis is in flight, including the first one. */
  readonly pending: boolean;
  readonly enabledRules: RuleToggles;
  readonly setRuleEnabled: (rule: HealthRuleId, enabled: boolean) => void;
  readonly resetRules: () => void;
  readonly refresh: () => void;
}

export function useHealthReport(analyse: AnalyseHealth = bridgeAnalyse): HealthReportState {
  const [report, setReport] = useState<VaultHealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Starts true because the first analysis begins on mount. A dashboard that flashes "no
  // issues" before the report lands is worse than one that says it is still looking.
  const [pending, setPending] = useState(true);
  const [enabledRules, setEnabledRules] = useState<RuleToggles>(() => ({
    ...DEFAULT_HEALTH_RULE_TOGGLES,
  }));

  useEffect(() => {
    let cancelled = false;

    // Every `setState` here is behind an `await`, never in the effect body. Setting state
    // synchronously while an effect runs cascades an extra render pass, and the lint rule
    // that forbids it is right: `pending` is turned on by the interaction that causes the
    // work, which is where the user's intent actually is.
    const run = async (): Promise<void> => {
      try {
        const result = await analyse({ enabledRules });
        if (cancelled) return;
        if (result.ok) {
          setReport(result.value);
          setError(null);
        } else {
          // The failure message from the main process is already scrubbed — see `IpcFailure`.
          setError(result.message);
        }
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : 'The health check could not run.');
      } finally {
        if (!cancelled) setPending(false);
      }
    };

    void run();
    return () => {
      // A toggle flipped twice quickly must not let the first, slower report overwrite the
      // second. Cancelling here rather than aborting the IPC is enough: the work is pure and
      // cheap to discard, and the analysis has no side effects to unwind.
      cancelled = true;
    };
  }, [analyse, enabledRules]);

  const setRuleEnabled = useCallback((rule: HealthRuleId, enabled: boolean): void => {
    setPending(true);
    setEnabledRules((previous) => ({ ...previous, [rule]: enabled }));
  }, []);

  const resetRules = useCallback((): void => {
    setPending(true);
    setEnabledRules({ ...DEFAULT_HEALTH_RULE_TOGGLES });
  }, []);

  const refresh = useCallback((): void => {
    setPending(true);
    // A fresh object with the same contents. The effect keys off identity, so this re-runs
    // the analysis without needing a second "nonce" piece of state that means nothing on
    // its own.
    setEnabledRules((previous) => ({ ...previous }));
  }, []);

  return { report, error, pending, enabledRules, setRuleEnabled, resetRules, refresh };
}
