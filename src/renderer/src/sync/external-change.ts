// SPDX-License-Identifier: GPL-3.0-or-later
import type { VaultChangedExternally } from '@shared/model/vault-change.js';

/**
 * What to offer when the vault file changed underneath the app.
 *
 * Pure, and separate from the banner that renders it, because the interesting part is not the
 * markup — it is that **the wrong offer here destroys data silently**. "The file changed" has
 * an obvious response, and the obvious response is wrong in three of the four cases below.
 * Reloading discards whatever is only in memory; reloading an older file discards the newer
 * one; reloading a *different* vault puts two people's credentials behind one master password.
 *
 * So the decision is a table rather than a chain of conditions in a component, and it is
 * tested directly. A component test would prove the button rendered, not that the right button
 * was chosen.
 *
 * Dismissing is always offered and never resolves anything: it hides the banner and leaves the
 * two copies exactly as they were. It is there because the user may be mid-sentence, and a
 * modal demand to decide right now is how people learn to click the first button.
 */

export type ExternalChangeAction =
  /** Re-read the file, keeping the key. Only ever offered when nothing would be lost. */
  | 'reload'
  /** Open the merge flow, which keeps both sides and asks about every disagreement. */
  | 'merge'
  /** Lock the vault. The only safe move when the file is not this vault any more. */
  | 'lock'
  /** Hide the banner and change nothing. */
  | 'dismiss';

export type ExternalChangeTone = 'info' | 'warning' | 'danger';

export interface ExternalChangePrompt {
  readonly tone: ExternalChangeTone;
  readonly headline: string;
  /** What happened, in terms of the user's own situation rather than the file format. */
  readonly detail: string;
  /**
   * Why the obvious action is not on offer, when it is not. Absent when it is.
   *
   * Written out because a missing button with no explanation reads as a bug, and the user
   * then goes looking for another way to do the thing being prevented.
   */
  readonly withheld?: string;
  /** In the order they should be shown; the first is the recommended one. */
  readonly actions: readonly ExternalChangeAction[];
}

export function promptForExternalChange(
  change: VaultChangedExternally,
  hasUnsavedChanges: boolean
): ExternalChangePrompt {
  // Checked first, and it outranks everything else including unsaved changes. A different
  // `vaultId` at this path is not a version of this vault at all — it was replaced, or a
  // backup of something unrelated was restored over it. There is no reading of it that is
  // safe, so neither reload nor merge is offered at any priority.
  if (change.differentVault) {
    return {
      tone: 'danger',
      headline: 'A different vault is now at this file’s path',
      detail:
        'The file this vault was opened from has been replaced by a different vault — not a ' +
        'newer copy of this one. Nothing has been read from it.',
      withheld:
        'Neither reloading nor merging is offered: both would mix two unrelated vaults into ' +
        'one file. Lock, then find out what wrote there before opening anything.',
      actions: ['lock', 'dismiss'],
    };
  }

  // Older on disk than in memory: a restored backup, or a sync client that lost a race and
  // put a stale copy back. Reloading is the natural reading of "the file changed" and is
  // exactly wrong — it would replace what this session has with something that predates it.
  if (change.wentBackwards) {
    return {
      tone: 'warning',
      headline: 'The file on disk is older than what is open',
      detail:
        'Something replaced the vault file with an earlier version of it — a restored backup, ' +
        'or a sync client putting back a stale copy.',
      withheld:
        'Reloading is not offered, because it would replace what you have with the older ' +
        'file. Merging keeps both and asks about anything that disagrees.',
      actions: ['merge', 'dismiss'],
    };
  }

  // Newer on disk, and edits in memory that are not in any file. Reloading would delete them
  // with no undo and no tombstone; saving would write over the other device's work. Merge is
  // the only move that keeps both, which is why it is the only one offered.
  if (hasUnsavedChanges) {
    return {
      tone: 'warning',
      headline: 'Another copy of this vault was saved, and you have unsaved changes',
      detail:
        'The file has moved on since it was opened here, and this window is holding edits that ' +
        'have not been written yet.',
      withheld:
        'Reloading is not offered, because it would discard your unsaved edits. Merging keeps ' +
        'both sides and asks about anything that disagrees.',
      actions: ['merge', 'dismiss'],
    };
  }

  // The straightforward case, and the only one where reload is safe: newer on disk, nothing
  // in memory that is not already in a file. Merge is still offered second — reloading is
  // simpler and correct here, but a user who wants to see what changed should not have to
  // reload first and lose the ability to.
  return {
    tone: 'info',
    headline: 'Another copy of this vault was saved',
    detail:
      'The file has been updated since it was opened here, and this window has no unsaved ' +
      'changes. Reloading picks up the newer version.',
    actions: ['reload', 'merge', 'dismiss'],
  };
}

/** The button label for each action. One place, so the banner and its tests cannot disagree. */
export const EXTERNAL_CHANGE_LABELS: Readonly<Record<ExternalChangeAction, string>> = {
  reload: 'Reload from disk',
  merge: 'Merge the two copies',
  lock: 'Lock the vault',
  dismiss: 'Dismiss',
};
