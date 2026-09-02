// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { Button } from '../components/Button.js';
import { Modal } from '../chrome/index.js';
import type { MoveTarget } from './move-targets.js';

/**
 * The keyboard equivalent of a drag — for a folder or for a record.
 *
 * WCAG 2.2 SC 2.5.7 requires a single-pointer alternative to any dragging movement, and
 * 2.1.1 requires the whole thing be reachable by keyboard. This dialog is that path, and it
 * is deliberately the *primary* one: it is the only way to see every destination at once,
 * the only way to move something into a folder that is scrolled off screen, and the only way
 * that works on a trackpad without a steady hand.
 *
 * A radio group rather than a `<select>`: the options carry a hierarchy that indentation has
 * to show, and a native select cannot render that or say "you are here" beside the current
 * parent. Radios also make the whole list navigable with arrows, which a keyboard user gets
 * for free from the platform.
 */

export interface MoveToDialogProps {
  readonly open: boolean;
  /** What is being moved, named in the title so the dialog is unambiguous read aloud. */
  readonly subject: string;
  readonly targets: readonly MoveTarget[];
  readonly busy: boolean;
  readonly onMove: (folderId: string | null) => void;
  readonly onCancel: () => void;
}

/** Encodes `null` (top level / no folder) as a radio value, which must be a string. */
// A radio value must be a string, so "no folder" needs a sentinel that cannot collide with
// a real folder id. Ids are `[A-Za-z0-9_-]{1,128}` (see `requireId`), so a value containing
// parentheses is impossible by construction — and readable, unlike the NUL byte this used
// to be, which made the file unsearchable and would have survived into a `grep` as binary.
const ROOT_VALUE = '(no folder)';

export function MoveToDialog({
  open,
  subject,
  targets,
  busy,
  onMove,
  onCancel,
}: MoveToDialogProps): React.JSX.Element | null {
  const current = targets.find((target) => target.current);
  const [chosen, setChosen] = useState<string>(current?.folderId ?? ROOT_VALUE);

  if (!open) return null;

  return (
    <Modal
      open={open}
      title={`Move “${subject}”`}
      description="Choose where it should go. Nothing else moves."
      onClose={onCancel}
      size="sm"
      initialFocusSelector="input[type='radio']:checked, input[type='radio']"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              onMove(chosen === ROOT_VALUE ? null : chosen);
            }}
          >
            Move
          </Button>
        </>
      }
    >
      <fieldset className="kh-move">
        <legend className="kh-visually-hidden">Destination</legend>
        {targets.map((target) => {
          const value = target.folderId ?? ROOT_VALUE;
          return (
            <label
              key={value}
              className="kh-move__option"
              style={{ paddingInlineStart: `${target.depth * 14}px` }}
            >
              <input
                type="radio"
                name="kh-move-target"
                value={value}
                checked={chosen === value}
                onChange={() => {
                  setChosen(value);
                }}
              />
              <span className="kh-move__label">{target.label}</span>
              {target.current && <span className="kh-move__current">Current</span>}
              {target.path.length > 1 && (
                // Two folders can legitimately share a name in different branches, so the
                // path is what makes the choice unambiguous. Shown only where it adds
                // something — a top-level folder's path is its own name.
                <span className="kh-move__path">{target.path.slice(0, -1).join(' / ')}</span>
              )}
            </label>
          );
        })}
      </fieldset>
    </Modal>
  );
}
