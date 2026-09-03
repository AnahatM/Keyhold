// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import type { KdfProgressView } from '@shared/model/kdf-progress.js';
import { ProgressBar } from '../chrome/ProgressBar.js';

/**
 * The Argon2 bar, for every screen that waits on a key.
 *
 * `CLAUDE.md` asks for determinate progress during Argon2 and calls a frozen window a bug. The
 * difficulty is that Argon2 has no progress to give: one call that returns when it is done,
 * and a memory-hard construction that cannot be decomposed into steps. So the position is
 * predicted from how long derivations have taken on this machine, and corrected by every one
 * that finishes — the whole argument is in `src/main/crypto/kdf-estimate.ts`.
 *
 * **The copy never claims to know how long is left.** It says what is happening and why it is
 * slow; the bar carries the estimate. Past the estimate it says so, because a bar that has
 * stopped moving with no explanation is worse than no bar — it reads as a hang, which is the
 * thing this exists to prevent.
 *
 * Renders nothing until the first report arrives, and **is mounted only while the wait is
 * on** — there is no `active` prop, deliberately. It cannot decide for itself when a
 * derivation ends, because the estimate never reaches 1: "finished" is a fact only the caller
 * has. Letting the caller mount and unmount makes that the same act as clearing the state, so
 * a previous attempt's position can never flash up at the start of the next one.
 */

export interface KdfProgressBarProps {
  /** What is being waited on: "Unlocking your vault", "Reading the other copy". */
  readonly label: string;
  /**
   * Subscribes, and returns its own unsubscribe.
   *
   * Injected rather than reached for through `window.keyhold`, so this can be driven in a test
   * without a preload bridge.
   */
  readonly subscribe: (listener: (progress: KdfProgressView) => void) => () => void;
}

export function KdfProgressBar({
  label,
  subscribe,
}: KdfProgressBarProps): React.JSX.Element | null {
  const [progress, setProgress] = useState<KdfProgressView | null>(null);

  useEffect(() => {
    return subscribe((next) => {
      setProgress(next);
    });
    // `subscribe` is rebuilt by the caller on every render; depending on it would tear the
    // subscription down and up on each one and drop whatever landed in between.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Nothing until the first report. The runner emits one as the derivation starts, so this is
  // a single IPC hop rather than a visible gap — and an empty space is better than a bar
  // showing a position nothing has reported yet.
  if (progress === null) return null;

  return (
    <ProgressBar
      label={label}
      // Percent, because `ProgressBar` speaks the value aloud and "43 percent" is a sentence
      // where "0.43 of 1" is not.
      value={Math.round(progress.fraction * 100)}
      max={100}
      unit="percent"
      note="Argon2id is deliberately slow — that is what makes a stolen vault file expensive to attack."
      // Spread rather than a conditional prop: under `exactOptionalPropertyTypes` an explicit
      // `undefined` is a different type from an absent key, and `ProgressBar` declares the
      // latter.
      {...(progress.overdue
        ? {
            slowNote:
              'This is taking longer than it usually does on this computer. Nothing is wrong ' +
              '— the estimate comes from previous unlocks, and something else may be busy.',
          }
        : {})}
    />
  );
}
