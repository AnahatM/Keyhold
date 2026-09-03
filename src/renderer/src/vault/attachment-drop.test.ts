// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CREDENTIAL_DRAG_TYPE, FOLDER_DRAG_TYPE } from '../organisation/drag-payload.js';
import {
  IDLE_DROP_ZONE,
  dropZoneLabel,
  reduceDropZone,
  summariseDrag,
  type DragDataLike,
  type DropZoneRules,
  type DropZoneState,
} from './attachment-drop.js';

/**
 * Guard: the drop target survives its own children.
 *
 * The bug this exists to catch has one shape and it is not exotic — `dragenter` and
 * `dragleave` bubble, so crossing onto a button inside the panel delivers a `leave` to the
 * panel itself. Every naive implementation of this feature is a boolean, and every one of
 * them flickers. The sequences below are the actual event streams a browser emits, asserted
 * in order, because the failure only exists in the ordering and a single-event test cannot
 * see it.
 *
 * The other half is the boundary: a drag carrying a credential must not light a target whose
 * entire purpose is files, and neither must a drag carrying nothing.
 */

const FILE_ITEM = { kind: 'file' } as const;

function transfer(types: readonly string[], items?: readonly { kind: string }[]): DragDataLike {
  return items === undefined ? { types } : { types, items };
}

const ACCEPTING: DropZoneRules = { accepting: true };
const READ_ONLY: DropZoneRules = { accepting: false, refusal: 'read-only' };
const BUSY: DropZoneRules = { accepting: false, refusal: 'busy' };

const FILE_DRAG = summariseDrag(transfer(['Files'], [FILE_ITEM]));
const TEXT_DRAG = summariseDrag(transfer(['text/plain']));

/** Replays a stream of events the way a browser would deliver it. */
function replay(
  events: readonly Parameters<typeof reduceDropZone>[1][],
  rules: DropZoneRules = ACCEPTING,
  from: DropZoneState = IDLE_DROP_ZONE
): DropZoneState {
  return events.reduce((state, event) => reduceDropZone(state, event, rules), from);
}

describe('summariseDrag', () => {
  it('sees files on an OS file drag', () => {
    expect(summariseDrag(transfer(['Files'], [FILE_ITEM]))).toEqual({
      hasFiles: true,
      fileCount: 1,
    });
  });

  it('counts only the file items, not the string ones', () => {
    // Dragging a file out of a browser puts a URL and a text label on the same drag. Counting
    // those would tell the user they dropped three things when they dropped one.
    const summary = summariseDrag(
      transfer(
        ['Files', 'text/uri-list', 'text/plain'],
        [FILE_ITEM, { kind: 'string' }, { kind: 'string' }]
      )
    );
    expect(summary).toEqual({ hasFiles: true, fileCount: 1 });
  });

  it('reports several files', () => {
    expect(summariseDrag(transfer(['Files'], [FILE_ITEM, FILE_ITEM, FILE_ITEM])).fileCount).toBe(3);
  });

  it('still says files are present when the browser withheld the item list', () => {
    // `hasFiles` without a count is a real browser state, and treating a missing list as "no
    // files" would make the target dead on whichever platform does that.
    expect(summariseDrag(transfer(['Files']))).toEqual({ hasFiles: true, fileCount: 0 });
  });

  it('sees no files on a text drag', () => {
    expect(summariseDrag(transfer(['text/plain']))).toEqual({ hasFiles: false, fileCount: 0 });
  });

  /**
   * Both Keyhold drag types, each carrying `Files` as well.
   *
   * The `Files` is not padding, it is the entire test. Asserting on a bare
   * `[CREDENTIAL_DRAG_TYPE]` looks like it guards the internal-drag check and does not: the
   * drag fails the `Files` test anyway, so the assertion holds with the check deleted. That
   * version was written first and survived deleting the line it existed to protect — a test
   * that cannot fail, which the testing policy calls out by name. Only the overlap
   * distinguishes "an internal drag is refused" from "a non-file drag is refused".
   */
  it.each([
    ['credential', CREDENTIAL_DRAG_TYPE],
    ['folder', FOLDER_DRAG_TYPE],
  ])('refuses a %s drag even when the drag also claims to carry files', (_kind, dragType) => {
    // The record list, the folder tree and this panel are on screen together, so a credential
    // dragged towards the tree passes over the detail pane on the way. An internal drag wins
    // outright: a `Files` type riding alongside a Keyhold type cannot smuggle one gesture in
    // as the other.
    expect(summariseDrag(transfer([dragType, 'Files'], [FILE_ITEM])).hasFiles).toBe(false);
  });

  it('survives a missing dataTransfer', () => {
    expect(summariseDrag(null).hasFiles).toBe(false);
    expect(summariseDrag(undefined).hasFiles).toBe(false);
  });
});

describe('reduceDropZone — the nested dragleave problem', () => {
  it('stays lit when the pointer crosses onto a child', () => {
    // THE test. Browsers fire `dragenter` on the new target before `dragleave` on the old, and
    // both bubble to the panel. A boolean flag goes dark here; a depth counter does not.
    const state = replay([
      { type: 'enter', drag: FILE_DRAG }, // panel
      { type: 'enter', drag: FILE_DRAG }, // a button inside it
      { type: 'leave' }, // the panel, left behind
    ]);
    expect(state.status).toBe('ready');
  });

  it('stays lit across a whole row of children', () => {
    // Three buttons in the attachment row. Each crossing is an enter/leave pair, and the
    // count must come back to exactly one, not drift up with each one.
    const state = replay([
      { type: 'enter', drag: FILE_DRAG },
      { type: 'enter', drag: FILE_DRAG },
      { type: 'leave' },
      { type: 'enter', drag: FILE_DRAG },
      { type: 'leave' },
      { type: 'enter', drag: FILE_DRAG },
      { type: 'leave' },
    ]);
    expect(state.status).toBe('ready');
    expect(state.depth).toBe(1);
  });

  it('goes dark when the pointer finally leaves the panel', () => {
    // The other half. A counter that only ever climbs would leave the target lit for the rest
    // of the session, which is the failure introduced by fixing the flicker carelessly.
    const state = replay([
      { type: 'enter', drag: FILE_DRAG },
      { type: 'enter', drag: FILE_DRAG },
      { type: 'leave' },
      { type: 'leave' },
    ]);
    expect(state).toEqual(IDLE_DROP_ZONE);
  });

  it('does not let dragover inflate the depth', () => {
    // `dragover` fires every few milliseconds while the pointer is still. If it counted, one
    // second of hovering would need a thousand leaves to put the target out.
    const state = replay([
      { type: 'enter', drag: FILE_DRAG },
      { type: 'over', drag: FILE_DRAG },
      { type: 'over', drag: FILE_DRAG },
      { type: 'over', drag: FILE_DRAG },
      { type: 'leave' },
    ]);
    expect(state).toEqual(IDLE_DROP_ZONE);
  });

  it('lights up from dragover alone when the enter was missed', () => {
    // A re-render mid-drag — the panel refreshes after a change and remounts — swallows the
    // `dragenter`. `dragover` keeps arriving, so it is the event that can recover.
    expect(replay([{ type: 'over', drag: FILE_DRAG }]).status).toBe('ready');
  });

  it('does not let an unmatched leave drive the count below zero', () => {
    // A leave the panel never saw the matching enter for. Left unfloored the depth goes to
    // -1, and the next genuine enter only brings it back to 0 — a target that is dark under
    // a live drag, once, unreproducibly.
    const state = replay([
      { type: 'leave' },
      { type: 'leave' },
      { type: 'enter', drag: FILE_DRAG },
    ]);
    expect(state.status).toBe('ready');
    expect(state.depth).toBe(1);
  });

  it('clears completely on drop, however deep the pointer was', () => {
    // `drop` fires on the innermost child; the matching `dragleave`s never come. Anything but
    // a full reset leaves the target lit over a panel nobody is dragging onto.
    const state = replay([
      { type: 'enter', drag: FILE_DRAG },
      { type: 'enter', drag: FILE_DRAG },
      { type: 'enter', drag: FILE_DRAG },
      { type: 'drop' },
    ]);
    expect(state).toEqual(IDLE_DROP_ZONE);
  });
});

describe('reduceDropZone — what lights up and what does not', () => {
  it('ignores a drag carrying no files', () => {
    expect(replay([{ type: 'enter', drag: TEXT_DRAG }])).toEqual(IDLE_DROP_ZONE);
  });

  it('leaves no stuck depth behind after a non-file drag crosses the panel', () => {
    // A text drag entering and being ignored must not bank a depth that a later file drag
    // inherits, or the target lights one enter early for the rest of the session.
    const afterText = replay([
      { type: 'enter', drag: TEXT_DRAG },
      { type: 'enter', drag: TEXT_DRAG },
    ]);
    expect(afterText.depth).toBe(0);
  });

  it('shows a refusal rather than nothing on a read-only record', () => {
    const state = replay([{ type: 'enter', drag: FILE_DRAG }], READ_ONLY);
    expect(state.status).toBe('refusing');
    expect(state.refusal).toBe('read-only');
  });

  it('refuses while the panel is busy', () => {
    expect(replay([{ type: 'enter', drag: FILE_DRAG }], BUSY).refusal).toBe('busy');
  });

  it('carries the file count through to the state', () => {
    const drag = summariseDrag(transfer(['Files'], [FILE_ITEM, FILE_ITEM]));
    expect(replay([{ type: 'enter', drag }]).fileCount).toBe(2);
  });
});

describe('dropZoneLabel', () => {
  it('says nothing while idle', () => {
    expect(dropZoneLabel(IDLE_DROP_ZONE)).toBe('');
  });

  it('invites the drop', () => {
    expect(dropZoneLabel(replay([{ type: 'enter', drag: FILE_DRAG }]))).toMatch(
      /release to attach/i
    );
  });

  it('reads correctly when the browser gave no count', () => {
    // The `fileCount: 0` state. "Release to attach 0 files" is the bug being prevented, and it
    // only appears on whichever platform withholds the item list.
    const drag = summariseDrag(transfer(['Files']));
    const label = dropZoneLabel(replay([{ type: 'enter', drag }]));
    expect(label).toMatch(/release to attach/i);
    expect(label).not.toMatch(/\b0\b/);
  });

  it('warns that several files need several drops', () => {
    // Without this a person drops four files, gets one, and has no way to know the other
    // three were dropped rather than never picked up.
    const drag = summariseDrag(transfer(['Files'], [FILE_ITEM, FILE_ITEM, FILE_ITEM, FILE_ITEM]));
    const label = dropZoneLabel(replay([{ type: 'enter', drag }]));
    expect(label).toMatch(/one file at a time/i);
    expect(label).toContain('4');
  });

  it('names the reason a drop is being refused', () => {
    expect(dropZoneLabel(replay([{ type: 'enter', drag: FILE_DRAG }], READ_ONLY))).toMatch(
      /trash/i
    );
    expect(dropZoneLabel(replay([{ type: 'enter', drag: FILE_DRAG }], BUSY))).toMatch(
      /last change/i
    );
  });
});
