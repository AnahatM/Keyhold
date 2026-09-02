// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';

/**
 * The current time, as state that ticks.
 *
 * `Date.now()` called during render is an impure read: two renders in the same commit can
 * disagree, and React's lint rule rejects it for exactly that reason. But a timeline
 * genuinely does need the current time — "5 minutes ago" has to become "6 minutes ago"
 * eventually, and a value frozen at mount would sit there wrong for as long as the pane is
 * open.
 *
 * So the clock is state, advanced by an interval, and every component reading it re-renders
 * together. One minute rather than one second: the coarsest unit this app displays is a
 * minute, so a faster tick would re-render the tree for no visible change.
 *
 * The interval is cleared on unmount. A timer that outlives its component is the leak that
 * turns a long session into a slow one.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      window.clearInterval(timer);
    };
  }, [intervalMs]);

  return now;
}
