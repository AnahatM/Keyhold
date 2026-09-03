// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { COLOUR_TOKENS } from '../theme/tokens.js';
import {
  DEFAULT_TAG_COLOUR,
  FOLDER_DELETE_POLICIES,
  isFolderDeletePolicy,
  isTagColour,
  TAG_COLOUR_TOKENS,
} from './organisation.js';

/**
 * Guard: one vocabulary for folders and tags.
 *
 * This file exists because there were briefly two, and they disagreed in two ways that would
 * both have reached a user:
 *
 *  - the main process's tag colours and the renderer's shared only two members, so four of
 *    the colours the sidebar offered would have been **rejected by the validator** the moment
 *    the IPC channel existed. Picking "Red" would have produced an error, not a red tag.
 *  - the folder-delete policies differed in name (`unfile` against `unfile-records`) *and* in
 *    meaning. One removes the whole subtree; the other's docblock promised subfolders
 *    survived. A user choosing it on that description would have lost a folder tree they were
 *    told they were keeping.
 *
 * Neither was a careless copy — both files argued their case, at length and well. That is why
 * the rule is "no second list" rather than "be careful with second lists".
 */

describe('tag colours', () => {
  it('are all real theme tokens', () => {
    // `satisfies` already enforces this at compile time; asserting it too means a token
    // renamed in `tokens.ts` names itself in a failure rather than only in a type error,
    // which is what someone reading a diff will actually see.
    for (const colour of TAG_COLOUR_TOKENS) {
      expect(COLOUR_TOKENS as readonly string[]).toContain(colour);
    }
  });

  it('exclude the health dashboard signal colours', () => {
    // The load-bearing assertion. A decorative tag wearing the same red as "this password is
    // reused" is how a real warning stops reading as a warning, and the pressure to add these
    // is constant because they are the colours a picker most obviously wants.
    for (const signal of ['success', 'warning', 'danger']) {
      expect(TAG_COLOUR_TOKENS as readonly string[]).not.toContain(signal);
    }
  });

  it('do not default to the accent, which is the selection colour', () => {
    // A brand-new tag wearing the accent looks like it is already selected.
    expect(DEFAULT_TAG_COLOUR).not.toBe('accent');
    expect(TAG_COLOUR_TOKENS).toContain(DEFAULT_TAG_COLOUR);
  });

  it('accept only themselves', () => {
    expect(isTagColour('accent')).toBe(true);
    expect(isTagColour('danger')).toBe(false);
    expect(isTagColour('neutral')).toBe(false);
    expect(isTagColour('#ff0000')).toBe(false);
    expect(isTagColour(null)).toBe(false);
  });
});

describe('folder delete policies', () => {
  it('offer exactly two, and neither of them deletes a record', () => {
    // Three would mean someone added "delete the contents", which is the one destructive
    // path in this app with no undo. Records leave through the trash, with a tombstone.
    expect(FOLDER_DELETE_POLICIES).toEqual(['reparent', 'unfile']);
  });

  it('accept only themselves', () => {
    expect(isFolderDeletePolicy('reparent')).toBe(true);
    expect(isFolderDeletePolicy('unfile')).toBe(true);
    // The renderer's old name. Kept in the test because a revert is more likely than a typo.
    expect(isFolderDeletePolicy('unfile-records')).toBe(false);
    expect(isFolderDeletePolicy('')).toBe(false);
  });
});
