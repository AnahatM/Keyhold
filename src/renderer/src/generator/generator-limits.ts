// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useState } from 'react';
import type { GeneratorLimitsView } from '@shared/ipc/api.js';

/**
 * Fetching the engine's own bounds and defaults, once.
 *
 * This channel is the whole reason the panel can exist without restating a single number.
 * `GENERATOR_LIMITS` and `GENERATOR_DEFAULTS` live beside the code that enforces them, in
 * the main process; the UI reads them across the contract. Nothing in this folder types a
 * bound, a default length, or a word count.
 *
 * The promise is cached at module scope because the limits are constants for the life of
 * the process, and the panel is mounted twice in normal use — the Generate screen and the
 * inline generator inside the credential editor. Two bridge round-trips for one pair of
 * frozen objects is waste with no upside.
 *
 * A **failure clears the cache**, so a retry is a real retry rather than a replay of the
 * rejection that is already stored.
 */

let pending: Promise<GeneratorLimitsView> | null = null;

export function loadGeneratorLimits(): Promise<GeneratorLimitsView> {
  pending ??= window.keyhold.generator
    .limits()
    .then(
      (result) => {
        if (!result.ok) throw new Error(result.message);
        return result.value;
      },
      (error: unknown) => {
        throw error instanceof Error ? error : new Error(String(error));
      }
    )
    .catch((error: unknown) => {
      pending = null;
      throw error;
    });
  return pending;
}

/** Drops the cache so the next load really asks again. */
export function resetGeneratorLimits(): void {
  pending = null;
}

export type GeneratorLimitsState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly view: GeneratorLimitsView }
  | { readonly status: 'error'; readonly message: string };

export interface GeneratorLimitsHook {
  readonly state: GeneratorLimitsState;
  readonly retry: () => void;
}

/**
 * The limits, as a view state.
 *
 * State is only ever set from an asynchronous continuation, never from the effect body —
 * a synchronous `setState` there cascades an extra render before paint and is what the
 * lint rule in this project exists to prevent.
 */
export function useGeneratorLimits(): GeneratorLimitsHook {
  const [state, setState] = useState<GeneratorLimitsState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void loadGeneratorLimits().then(
      (view) => {
        if (!cancelled) setState({ status: 'ready', view });
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Keyhold could not read the generator’s settings.',
        });
      }
    );

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    resetGeneratorLimits();
    setState({ status: 'loading' });
    setAttempt((value) => value + 1);
  }, []);

  return { state, retry };
}
