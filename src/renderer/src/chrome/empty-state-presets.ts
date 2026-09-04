// SPDX-License-Identifier: GPL-3.0-or-later

import type { IconName } from '../components/Icon.js';

/**
 * The app's empty states, as data.
 *
 * ## Why there is no new EmptyState component here
 *
 * There already is one — `components/Feedback.tsx` — and it is exactly icon, heading,
 * explanation, one action. Writing a second would be the duplicate-list failure hard rule 8
 * exists to prevent: two components that agree today and drift by the second theme change.
 *
 * What was actually missing is not a component, it is the *copy*. Keyhold has several
 * genuinely empty views and each one was going to grow its own hand-written string at the
 * call site, which is how an app ends up saying "No items" in one place and "Nothing here
 * yet" in another. So this file is the registry, `AppEmptyState.tsx` is the one component
 * that reads it, and `Feedback.tsx` still owns the rendering.
 *
 * ## The rule every entry follows
 *
 * **Say what to do next.** "No credentials" describes the screen the user is already
 * looking at. "Add your first credential and it is encrypted the moment you save" tells
 * them what to press and what will happen. An empty state is the only onboarding some
 * views ever get.
 */

export type EmptyStateKind =
  'no-credentials' | 'no-search-results' | 'empty-trash' | 'no-health-issues';

export interface EmptyStatePreset {
  /**
   * Which icon to draw. A name, not a glyph, and that distinction is the point.
   *
   * When this was a `string` the registry was holding a character that exactly one
   * component knew how to interpret, and only by dropping it into a `<div>` and hoping the
   * operating system had a font for it. A `IconName` is a reference into the app's own set:
   * the compiler rejects a name that does not exist, the renderer picks up the theme's
   * colour, and nothing here decides how large it is drawn or whether it is announced —
   * which are rendering questions, and belong to `Feedback.tsx`.
   */
  readonly icon: IconName;
  readonly title: string;
  readonly description: string;
  /**
   * `success` for the one empty state that is good news.
   *
   * An empty health dashboard means nothing is weak, reused, old or breached. Rendering
   * that in the same grey as "you have no credentials" throws away the only moment this
   * app gets to tell someone they are fine.
   */
  readonly tone: 'neutral' | 'success';
}

export const EMPTY_STATE_PRESETS: Readonly<Record<EmptyStateKind, EmptyStatePreset>> = {
  'no-credentials': {
    icon: 'key',
    title: 'No credentials yet',
    description:
      'Add your first one, or import from a browser or another password manager. Everything you save is encrypted into your vault file before it touches the disk.',
    tone: 'neutral',
  },
  'no-search-results': {
    icon: 'search',
    title: 'Nothing matched',
    description:
      'Try a shorter search, or clear the filters. Search covers titles, usernames, URLs, tags and notes — but never the passwords themselves.',
    tone: 'neutral',
  },
  'empty-trash': {
    icon: 'trash',
    title: 'Trash is empty',
    description:
      'Deleted credentials rest here so a mistake is recoverable. Nothing has been deleted recently.',
    tone: 'neutral',
  },
  'no-health-issues': {
    icon: 'check',
    title: 'No problems found',
    description:
      'Nothing weak, reused, expiring or breached. Keyhold re-checks whenever you change a credential.',
    tone: 'success',
  },
};

export const EMPTY_STATE_KINDS = Object.keys(EMPTY_STATE_PRESETS) as readonly EmptyStateKind[];
