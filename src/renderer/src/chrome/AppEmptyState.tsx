// SPDX-License-Identifier: GPL-3.0-or-later

import type { ReactNode } from 'react';
import { EmptyState } from '../components/Feedback.js';
import { EMPTY_STATE_PRESETS, type EmptyStateKind } from './empty-state-presets.js';
import './chrome.css';

/**
 * The app's named empty states.
 *
 * A thin layer over `EmptyState` from `components/Feedback.tsx`, not a replacement for it —
 * see the header of `empty-state-presets.ts` for why writing a second empty-state component
 * would have been the wrong move. All this adds is the registry lookup and the one visual
 * difference the registry needs: the health dashboard's empty state is good news and is
 * allowed to look like it.
 *
 * Overrides exist because two of these need a runtime detail the registry cannot hold — the
 * search term the user typed, the name of the folder they are looking at.
 */

export interface AppEmptyStateProps {
  readonly kind: EmptyStateKind;
  /** Overrides the preset heading. */
  readonly title?: string;
  /** Overrides the preset explanation — for anything that needs the user's own words in it. */
  readonly description?: string;
  /** One primary action. One: a screen with nothing on it is not the place for a menu. */
  readonly action?: ReactNode;
}

export function AppEmptyState({
  kind,
  title,
  description,
  action,
}: AppEmptyStateProps): React.JSX.Element {
  const preset = EMPTY_STATE_PRESETS[kind];

  // Spread rather than `action={action}`: under exactOptionalPropertyTypes, passing an
  // explicit `undefined` to an optional prop is an error, and "absent" is what we mean.
  const optional = action !== undefined ? { action } : {};

  return (
    <div className={`kh-empty-state kh-empty-state--${preset.tone}`} data-kind={kind}>
      <EmptyState
        icon={preset.icon}
        title={title ?? preset.title}
        description={description ?? preset.description}
        {...optional}
      />
    </div>
  );
}
