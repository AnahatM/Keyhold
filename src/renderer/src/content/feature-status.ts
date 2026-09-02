// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Features the help text has to talk about but the app does not have yet.
 *
 * ## Why this exists at all
 *
 * A help page that describes a button which is not there is worse than a missing help
 * page: the reader concludes they are looking in the wrong place, or that the app is
 * broken. But the alternative — never mentioning anything unbuilt — produces help that
 * cannot answer "can I export my vault?", which is exactly the question people arrive
 * with.
 *
 * So unbuilt features are named, and marked. This registry is what makes the marking
 * enforceable rather than a habit: `content-registry.test.ts` walks every article's prose
 * for each `phrases` entry below and fails if the article mentions the feature without
 * carrying its `not-built` block. Adding a sentence about exports to any article and
 * forgetting the marker is a failing test, not a support ticket.
 *
 * **Deleting an entry from here is how a feature graduates.** When the export dialog
 * lands, its entry is removed, every `not-built` block naming it becomes a type error, and
 * the article that described it has to be revisited. That is the intended failure mode.
 *
 * Statuses below are read from `docs/12-Roadmap/00-Master-Checklist.md` and confirmed
 * against the code; where the two disagreed, the code won.
 */

export interface UnbuiltFeature {
  /** Shown in the callout, after "Not built yet". Sentence case, no trailing full stop. */
  readonly label: string;
  /** Where it lives on the roadmap, so the callout is a status rather than an apology. */
  readonly roadmap: string;
  /**
   * Word sequences that count as "this article mentions the feature".
   *
   * Matched **word by word, not as substrings** — `articleMentions` folds the prose and
   * splits it on anything that is not a letter or digit. That distinction is load-bearing:
   * a substring search for `import` also fires on the word *important*, which would force
   * a bogus callout onto an article that never mentioned importing anything. Inflections
   * are therefore listed out rather than approximated with a prefix match, because
   * `import*` has exactly the same problem.
   *
   * Deliberately narrow for the same reason: a wall of callouts reads as an unfinished app
   * rather than an honest one.
   */
  readonly phrases: readonly string[];
}

export const UNBUILT_FEATURES = {
  settings: {
    label: 'the Settings screen',
    roadmap: 'Phase 14',
    // Appearance is adjustable today; nothing else is. "Settings" is the word people look
    // for, so any article that says it has to say that the screen is not there yet.
    phrases: ['settings screen', 'in settings'],
  },
  'master-password-change': {
    label: 'changing your master password from inside the app',
    roadmap: 'Phase 14',
    phrases: [
      'change your master password',
      'changing your master password',
      'change the master password',
      'changing the master password',
      'master password change',
    ],
  },
  import: {
    label: 'importing from another password manager',
    roadmap: 'Phase 10',
    phrases: ['import', 'imports', 'imported', 'importing'],
  },
  export: {
    label: 'exporting your vault',
    roadmap: 'Phase 11',
    phrases: ['export', 'exports', 'exported', 'exporting'],
  },
  parcel: {
    label: 'creating a .keepx transfer parcel',
    roadmap: 'Phase 11',
    phrases: ['keepx'],
  },
  sync: {
    label: 'syncing and merging two copies of a vault',
    roadmap: 'Phase 12',
    phrases: ['sync', 'synced', 'syncing', 'merge', 'merged', 'merging'],
  },
  /**
   * Built but not wired in. The registry, handler, palette and sheet all exist in
   * `src/renderer/src/commands/`; nothing mounts `CommandsProvider` in the app shell, so
   * none of it fires. Delete this entry the moment it is mounted — the article marked with
   * it says exactly that, so the callout explains its own expiry.
   */
  shortcuts: {
    label: 'keyboard shortcuts being wired into the app window',
    roadmap: 'Phase 15',
    phrases: ['shortcuts sheet', 'command palette'],
  },
  'breach-check': {
    label: 'the optional Have I Been Pwned breach check',
    roadmap: 'Phase 13',
    phrases: ['have i been pwned', 'breach check'],
  },
  'licence-list': {
    label: 'the generated third-party licence list',
    roadmap: 'Phase 16',
    phrases: ['third-party licence list'],
  },
} as const satisfies Record<string, UnbuiltFeature>;

export type UnbuiltFeatureId = keyof typeof UNBUILT_FEATURES;

export const UNBUILT_FEATURE_IDS = Object.keys(UNBUILT_FEATURES) as readonly UnbuiltFeatureId[];
