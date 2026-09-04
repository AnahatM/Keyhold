// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useState } from 'react';
import type { BreachApi } from '@shared/ipc/api.js';
import type { BreachAvailability, BreachReport } from '@shared/model/breach.js';

/**
 * Asking whether the breach check can run, and running it.
 *
 * The check itself happens in the main process — it is the only place the passwords are, and
 * the only place a network transport can exist — so this hook holds three things and nothing
 * else: whether it is permitted, whether a sweep is in flight, and the last report.
 *
 * ## Why the sweep never starts on its own
 *
 * Every other panel in this app fetches on mount. This one does not, and that is the single
 * most important line in the file. A zero-network application must not make a request because
 * somebody opened a screen — the request has to be the direct consequence of a person asking
 * for it, every time, or the promise on the front of the box is being kept only in the
 * settings dialog. So `run` is called from a button and from nowhere else.
 *
 * Availability *is* fetched on mount, because it makes no request: it reads two switches.
 *
 * ## Why the report is not cached across a lock
 *
 * It is component state, so closing the dashboard drops it. That is correct rather than
 * lazy — a breach report is a list of which of your records are compromised, and keeping it
 * alive past the screen that displays it would be a small copy of the vault's worst news
 * sitting in memory for no reason. The main process drops the range cache on lock for the
 * same reason; see `src/main/breach/service.ts`.
 */

export type BreachAvailabilityQuery = BreachApi['availability'];
export type BreachRun = BreachApi['run'];

/**
 * The real bridge calls, as module-level constants.
 *
 * Stable identity matters: `availability` is an effect dependency, and a function rebuilt
 * every render would re-ask on every render.
 */
const bridgeAvailability: BreachAvailabilityQuery = () => window.keyhold.breach.availability();
const bridgeRun: BreachRun = () => window.keyhold.breach.run();

export interface BreachCheckState {
  readonly availability: BreachAvailability | null;
  readonly report: BreachReport | null;
  /** True while a sweep is in flight. Sweeps take seconds; the UI must say so. */
  readonly running: boolean;
  readonly error: string | null;
  readonly run: () => void;
  /** Re-asks the two switches. Called after the settings screen may have changed one. */
  readonly refreshAvailability: () => void;
}

export function useBreachCheck(
  availabilityQuery: BreachAvailabilityQuery = bridgeAvailability,
  runQuery: BreachRun = bridgeRun
): BreachCheckState {
  const [availability, setAvailability] = useState<BreachAvailability | null>(null);
  const [report, setReport] = useState<BreachReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availabilityNonce, setAvailabilityNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // A named function rather than an IIFE, matching `use-health-report.ts`. Not a style
    // preference: TypeScript analyses an immediately-invoked closure inline and then decides
    // `cancelled` is always false, because the only assignment is in a cleanup that has not
    // run yet — so the guard reads as dead code and the lint rule says so.
    const ask = async (): Promise<void> => {
      const result = await availabilityQuery();
      if (cancelled) return;
      setAvailability(result.ok ? result.value : null);
    };

    void ask();
    return () => {
      // Two rapid mounts must not let the first, slower answer overwrite the second — and an
      // answer arriving after unmount must not set state on a component that is gone.
      cancelled = true;
    };
  }, [availabilityQuery, availabilityNonce]);

  const refreshAvailability = useCallback(() => {
    setAvailabilityNonce((previous) => previous + 1);
  }, []);

  const run = useCallback(() => {
    void (async () => {
      setRunning(true);
      setError(null);
      try {
        const result = await runQuery();
        if (result.ok) setReport(result.value);
        else setError(result.message);
      } catch {
        // A **rejection**, not a failure result. The bridge answers with `{ ok: false }` for
        // everything it can describe, so reaching here means the call itself did not complete
        // — the channel is gone, the main process is shutting down, the preload never
        // attached. Without this the promise rejected unhandled and the panel said nothing at
        // all: the button stopped spinning, no error appeared, and the user was left to guess
        // whether a check had run. Found by a test that rejected the call deliberately.
        //
        // The message names no cause, deliberately: nothing is known about one here, and
        // inventing "the service could not be reached" would be a claim about the network
        // that this code has no basis for.
        setError('The check could not be started. Try again, or reopen the vault.');
      } finally {
        // In a `finally`, so neither branch above can leave the button spinning for the rest
        // of the session with no way back except reopening the screen.
        setRunning(false);
      }
      // The switches may have moved underneath a long sweep — the kill-switch is one click
      // away on another screen — so the answer is re-asked rather than assumed to still hold.
      setAvailabilityNonce((previous) => previous + 1);
    })();
  }, [runQuery]);

  return { availability, report, running, error, run, refreshAvailability };
}
