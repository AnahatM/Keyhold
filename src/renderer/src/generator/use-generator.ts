// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GeneratorLimitsView } from '@shared/ipc/api.js';
import type { GeneratorMode, GeneratorOptions } from '@shared/model/generator.js';
import { useSession } from '../vault/session-store.js';
import {
  configurationKey,
  draftFromDefaults,
  optionsFromDraft,
  type GeneratorDraft,
} from './generator-options.js';
import {
  findSecretHistoryEntry,
  pushSecretHistory,
  type SecretHistoryEntry,
} from './generation-history.js';

/**
 * The generator panel's state, in one place.
 *
 * ## The rule this hook exists to hold
 *
 * **Dragging a slider must not put a stream of discarded passwords through the bridge.**
 * The live figure comes from `generator.estimate`, which prices a configuration without
 * producing anything; `generator.generate` runs only when a person asks for a password.
 * They are different channels for exactly this reason.
 *
 * ## Three details that are easy to get wrong
 *
 * **Nothing sets state synchronously in an effect body.** "Is the figure on screen out of
 * date?" is *derived* by comparing the settled estimate's configuration key against the
 * current one, not mirrored into state by an effect watching the draft. The same key marks
 * a generated password as having been made with settings the user has since changed.
 *
 * **Estimates can land out of order.** Each settled result carries the key it describes and
 * is only adopted if the request was not cancelled first, so a slow answer for an old
 * configuration cannot overwrite a fast answer for the current one.
 *
 * **The vault locking empties everything secret.** Implemented as a store subscription
 * rather than an effect comparing the previous render's session, which is the pattern
 * `ClearToastsOnLock` established: a subscription fires on the transition, an effect fires
 * on every session change and would need a `setState` in its body to notice one.
 */

/** Long enough to swallow a drag, short enough that the readout never feels frozen. */
export const ESTIMATE_DEBOUNCE_MS = 120;

export interface GeneratedSecret {
  /** Secret material. Held for as long as the panel is open, and no longer. */
  readonly secret: string;
  readonly entropyBits: number;
  readonly mode: GeneratorMode;
  /**
   * The configuration it came from, so the panel can say when it is out of date.
   *
   * `null` for a password restored from the history: putting an earlier password back on
   * screen does not make it a product of today's settings, and the panel should keep
   * saying so rather than quietly re-attributing it.
   */
  readonly configurationKey: string | null;
}

export interface EntropyEstimate {
  /** `null` until the first estimate settles, or when the configuration was refused. */
  readonly bits: number | null;
  /** The engine's own refusal, written for a user. Shown, never swallowed. */
  readonly error: string | null;
  /** True while the settled figure describes a configuration that has since changed. */
  readonly stale: boolean;
}

export interface GeneratorController {
  readonly draft: GeneratorDraft;
  readonly options: GeneratorOptions;
  readonly estimate: EntropyEstimate;
  /** The password on screen, or `null` before the first generation. */
  readonly current: GeneratedSecret | null;
  /** True when `current` was made with settings that have since been changed. */
  readonly currentIsStale: boolean;
  readonly secretHistory: readonly SecretHistoryEntry[];
  /** A failure from `generate`, distinct from a refusal of the configuration. */
  readonly generateError: string | null;
  readonly busy: boolean;

  readonly setMode: (mode: GeneratorMode) => void;
  readonly setRandom: (changes: Partial<GeneratorDraft['random']>) => void;
  readonly setPassphrase: (changes: Partial<GeneratorDraft['passphrase']>) => void;
  readonly setPronounceable: (changes: Partial<GeneratorDraft['pronounceable']>) => void;
  readonly setPin: (changes: Partial<GeneratorDraft['pin']>) => void;

  readonly generate: () => Promise<void>;
  /** Puts an earlier password back on screen. */
  readonly restore: (id: string) => void;
  readonly forgetHistory: () => void;
}

/** A settled estimate, tagged with the configuration it describes. */
interface SettledEstimate {
  readonly key: string;
  readonly bits: number | null;
  readonly error: string | null;
}

export function useGenerator(limits: GeneratorLimitsView): GeneratorController {
  const [draft, setDraft] = useState<GeneratorDraft>(() => draftFromDefaults(limits.defaults));
  const [current, setCurrent] = useState<GeneratedSecret | null>(null);
  const [secretHistory, setSecretHistory] = useState<readonly SecretHistoryEntry[]>([]);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settled, setSettled] = useState<SettledEstimate>({ key: '', bits: null, error: null });

  const options = useMemo(() => optionsFromDraft(draft, limits.limits), [draft, limits.limits]);
  const key = useMemo(() => configurationKey(options), [options]);

  /*
   * The live figure.
   *
   * Debounced so a drag produces one request rather than one per pixel, and cancelled on
   * every change so a superseded answer is dropped rather than adopted late. State is set
   * only from the asynchronous continuation.
   */
  useEffect(() => {
    let cancelled = false;

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await window.keyhold.generator.estimate(options);
          if (cancelled) return;
          setSettled(
            result.ok
              ? { key, bits: result.value, error: null }
              : { key, bits: null, error: result.message }
          );
        } catch {
          if (cancelled) return;
          // The bridge itself failed, which is not the engine refusing a configuration.
          setSettled({ key, bits: null, error: 'Keyhold could not measure these settings.' });
        }
      })();
    }, ESTIMATE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [key, options]);

  /*
   * Everything secret goes when the vault locks.
   *
   * A subscription rather than an effect watching session state: this fires on the
   * transition itself, and needs no `setState` in an effect body to detect it.
   */
  useEffect(
    () =>
      useSession.subscribe((state, previous) => {
        const wasOpen = previous.status?.state === 'unlocked';
        const isOpen = state.status?.state === 'unlocked';
        if (!wasOpen || isOpen) return;
        setSecretHistory([]);
        setCurrent(null);
      }),
    []
  );

  /** Ids for the history list. A counter, because a key must never be derived from a secret. */
  const nextEntryId = useRef(0);

  const generate = useCallback(async (): Promise<void> => {
    setBusy(true);
    setGenerateError(null);
    try {
      const result = await window.keyhold.generator.generate(options);
      if (!result.ok) {
        setGenerateError(result.message);
        return;
      }

      nextEntryId.current += 1;
      const entry: SecretHistoryEntry = {
        id: `generated-${nextEntryId.current}`,
        secret: result.value.password,
        entropyBits: result.value.entropyBits,
        mode: result.value.mode,
      };

      setCurrent({
        secret: entry.secret,
        entropyBits: entry.entropyBits,
        mode: entry.mode,
        configurationKey: key,
      });
      setSecretHistory((history) => pushSecretHistory(history, entry));
    } catch {
      setGenerateError('Keyhold could not reach the generator.');
    } finally {
      setBusy(false);
    }
  }, [options, key]);

  const restore = useCallback(
    (id: string): void => {
      const entry = findSecretHistoryEntry(secretHistory, id);
      if (entry === null) return;
      setCurrent({
        secret: entry.secret,
        entropyBits: entry.entropyBits,
        mode: entry.mode,
        configurationKey: null,
      });
    },
    [secretHistory]
  );

  const forgetHistory = useCallback((): void => {
    setSecretHistory([]);
  }, []);

  const setMode = useCallback((mode: GeneratorMode): void => {
    setDraft((previous) => ({ ...previous, mode }));
  }, []);

  const setRandom = useCallback((changes: Partial<GeneratorDraft['random']>): void => {
    setDraft((previous) => ({ ...previous, random: { ...previous.random, ...changes } }));
  }, []);

  const setPassphrase = useCallback((changes: Partial<GeneratorDraft['passphrase']>): void => {
    setDraft((previous) => ({ ...previous, passphrase: { ...previous.passphrase, ...changes } }));
  }, []);

  const setPronounceable = useCallback(
    (changes: Partial<GeneratorDraft['pronounceable']>): void => {
      setDraft((previous) => ({
        ...previous,
        pronounceable: { ...previous.pronounceable, ...changes },
      }));
    },
    []
  );

  const setPin = useCallback((changes: Partial<GeneratorDraft['pin']>): void => {
    setDraft((previous) => ({ ...previous, pin: { ...previous.pin, ...changes } }));
  }, []);

  const estimate: EntropyEstimate = {
    bits: settled.bits,
    error: settled.error,
    stale: settled.key !== key,
  };

  return {
    draft,
    options,
    estimate,
    current,
    currentIsStale: current !== null && current.configurationKey !== key,
    secretHistory,
    generateError,
    busy,
    setMode,
    setRandom,
    setPassphrase,
    setPronounceable,
    setPin,
    generate,
    restore,
    forgetHistory,
  };
}
