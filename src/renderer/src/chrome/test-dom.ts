// SPDX-License-Identifier: GPL-3.0-or-later

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * A minimal React test harness.
 *
 * `@testing-library/react` is not a dependency of this project and adding one for the
 * chrome would be the wrong trade — so the handful of behaviours that genuinely cannot be
 * asserted against pure functions (Escape closing a dialog, focus going back where it came
 * from, a timer surviving unmount) are driven through `react-dom/client` directly.
 *
 * Everything else is tested against the reducer and the timing functions, which is where
 * it belongs anyway.
 */

export interface MountedTree {
  /** The root container, already in the document — focus does not work outside it. */
  readonly container: HTMLElement;
  readonly render: (node: ReactNode) => void;
  readonly unmount: () => void;
}

export function mountReact(node: ReactNode): MountedTree {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const container = document.createElement('div');
  document.body.append(container);

  let root: Root | null = null;
  act(() => {
    root = createRoot(container);
    root.render(node);
  });

  return {
    container,
    render: (next: ReactNode): void => {
      act(() => {
        root?.render(next);
      });
    },
    unmount: (): void => {
      act(() => {
        root?.unmount();
      });
      container.remove();
    },
  };
}
