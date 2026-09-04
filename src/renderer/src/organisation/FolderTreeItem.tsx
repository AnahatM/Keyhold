// SPDX-License-Identifier: GPL-3.0-or-later
import {
  useEffect,
  useRef,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Icon, type IconName } from '../components/Icon.js';
import type { TreeRow } from './folder-tree-model.js';

/**
 * One `role="treeitem"`.
 *
 * ## The ARIA contract, in full
 *
 * The tree is rendered **flat** — every row is a sibling in the DOM — so the structure has
 * to be declared rather than inferred: `aria-level`, `aria-posinset` and `aria-setsize` on
 * every row, and `aria-expanded` only on rows that actually have children. A row with
 * `aria-expanded="false"` and nothing inside it is announced as a collapsed parent, which
 * sends a screen-reader user pressing Right at a folder that will never open.
 *
 * Flat rather than nested `role="group"` because the tree has to stay a single ordered list
 * for the roving tabindex and for keyboard navigation to be a pure function over an array
 * (see `tree-keyboard.ts`) — and because a virtualised tree, which this will become on a
 * large vault, cannot nest.
 *
 * ## Focus is roving, and moved imperatively
 *
 * Exactly one row is `tabIndex=0`; the rest are `-1`. Tab therefore steps past the whole
 * tree in one press instead of through every folder. When the store moves focus, this
 * component moves the DOM focus to match — but **only when the tree already had focus**,
 * which is what stops the sidebar stealing the caret from the search box on first render.
 *
 * ## Colour is never the signal
 *
 * A broken folder — one whose parent vanished, or one caught in a cycle — is marked with a
 * glyph and a real sentence in its `title`, not with a red tint. The problem list above the
 * tree says the same thing in text.
 */

export type RowDropState = 'none' | 'valid' | 'invalid';

export interface FolderTreeItemProps {
  readonly row: TreeRow;
  readonly selected: boolean;
  readonly focused: boolean;
  /** Whether the tree as a whole currently owns the DOM focus. */
  readonly treeHasFocus: boolean;
  readonly renaming: boolean;
  /** Records filed directly here. */
  readonly ownCount: number;
  /** Records here and in everything beneath. Shown when it differs from `ownCount`. */
  readonly totalCount: number;
  readonly dropState: RowDropState;
  readonly onSelect: (folderId: string) => void;
  readonly onToggle: (folderId: string) => void;
  readonly onRenameCommit: (folderId: string, name: string) => void;
  readonly onRenameCancel: () => void;
  readonly onDragStart: (folderId: string, event: ReactDragEvent<HTMLDivElement>) => void;
  /**
   * The parent decides droppability and calls `preventDefault` itself.
   *
   * It has to: only `dataTransfer.types` is readable during `dragover`, and whether a drop
   * is legal also depends on which folder is being dragged — which the row does not know.
   * Deciding here from the previous render's `dropState` would drop the first event of every
   * hover, and the browser treats a `dragover` without `preventDefault` as a refusal.
   */
  readonly onDragOver: (folderId: string, event: ReactDragEvent<HTMLDivElement>) => void;
  readonly onDragLeave: (folderId: string) => void;
  readonly onDrop: (folderId: string, event: ReactDragEvent<HTMLDivElement>) => void;
  readonly onDragEnd: () => void;
  readonly registerRow: (folderId: string, element: HTMLDivElement | null) => void;
}

/**
 * Which icon marks a broken row, keyed by how it is broken.
 *
 * Both kinds get the same warning mark on purpose — the row's `title` and the problem list
 * above the tree are where the two are told apart, and inventing a second silhouette would
 * ask a reader to learn a distinction the sentence already makes. It stays a table rather
 * than becoming a ternary so a third attachment kind is one line here, and so the absence of
 * an entry is what "this row is fine" means, in one place, for both the mark and
 * `data-broken`.
 */
const ATTACHMENT_ICON: Readonly<Record<string, IconName>> = {
  'missing-parent': 'warning',
  cycle: 'warning',
};

const ATTACHMENT_NOTE: Readonly<Record<string, string>> = {
  'missing-parent': 'This folder’s parent no longer exists, so it is shown at the top level.',
  cycle: 'This folder’s parent chain loops back on itself. Shown at the top level.',
};

export function FolderTreeItem({
  row,
  selected,
  focused,
  treeHasFocus,
  renaming,
  ownCount,
  totalCount,
  dropState,
  onSelect,
  onToggle,
  onRenameCommit,
  onRenameCancel,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  registerRow,
}: FolderTreeItemProps): React.JSX.Element {
  const element = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // Focus follows the store, but only once the tree already has it. Focusing on mount would
  // yank the caret out of whatever the user was typing in.
  useEffect(() => {
    if (!focused || !treeHasFocus || renaming) return;
    const node = element.current;
    if (node !== null && document.activeElement !== node) node.focus();
  }, [focused, treeHasFocus, renaming]);

  useEffect(() => {
    if (!renaming) return;
    const field = input.current;
    if (field === null) return;
    field.focus();
    field.select();
  }, [renaming]);

  const mark = ATTACHMENT_ICON[row.node.attachment];
  const note = ATTACHMENT_NOTE[row.node.attachment];
  const hiddenBelow = totalCount - ownCount;

  const commit = (): void => {
    const value = input.current?.value ?? '';
    // An unchanged or emptied name is a cancel, not a rename. Sending it would ask the vault
    // to reject it and show an error for something the user plainly meant as "never mind".
    if (value.trim() === '' || value.trim() === row.node.folder.name) onRenameCancel();
    else onRenameCommit(row.id, value);
  };

  const onRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    // The tree owns the arrow keys; while a field is open it must not.
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onRenameCancel();
    }
  };

  return (
    <div
      ref={(node) => {
        element.current = node;
        registerRow(row.id, node);
      }}
      role="treeitem"
      aria-level={row.level}
      aria-posinset={row.posInSet}
      aria-setsize={row.setSize}
      aria-selected={selected}
      {...(row.hasChildren ? { 'aria-expanded': row.expanded } : {})}
      tabIndex={focused ? 0 : -1}
      className="kh-tree__item"
      data-selected={selected || undefined}
      data-drop={dropState === 'none' ? undefined : dropState}
      data-broken={mark === undefined ? undefined : true}
      style={{ paddingInlineStart: `calc(var(--kh-space-2) + ${(row.level - 1) * 14}px)` }}
      title={note}
      draggable={!renaming}
      onClick={() => {
        if (!renaming) onSelect(row.id);
      }}
      onDragStart={(event) => {
        onDragStart(row.id, event);
      }}
      onDragOver={(event) => {
        onDragOver(row.id, event);
      }}
      onDragLeave={() => {
        onDragLeave(row.id);
      }}
      onDrop={(event) => {
        onDrop(row.id, event);
      }}
      onDragEnd={onDragEnd}
    >
      <span
        className="kh-tree__chevron"
        data-open={row.expanded || undefined}
        data-leaf={row.hasChildren ? undefined : true}
        aria-hidden="true"
        onClick={(event) => {
          // A click on the twisty opens the folder; it must not also select it, or every
          // attempt to peek inside changes what the list is showing.
          event.stopPropagation();
          if (row.hasChildren) onToggle(row.id);
        }}
      >
        {/* The wrapper keeps the rotation and the transition, because the state and the
            animation belong to the control rather than to the drawing. The icon is one
            chevron pointing right; `[data-open]` turns it. */}
        <Icon name="chevron" size="sm" />
      </span>

      {renaming ? (
        <input
          ref={input}
          className="kh-tree__rename"
          defaultValue={row.node.folder.name}
          aria-label={`Rename “${row.node.folder.name}”`}
          onKeyDown={onRenameKeyDown}
          onBlur={commit}
          onClick={(event) => {
            event.stopPropagation();
          }}
        />
      ) : (
        <>
          <span className="kh-tree__label">{row.node.folder.name}</span>
          {mark !== undefined && <Icon name={mark} className="kh-tree__flag" size="sm" />}
          <span className="kh-tree__count">
            {ownCount}
            <span className="kh-visually-hidden">
              {` record${ownCount === 1 ? '' : 's'}`}
              {hiddenBelow > 0 ? `, ${hiddenBelow} more in subfolders` : ''}
            </span>
          </span>
          {hiddenBelow > 0 && (
            <span className="kh-tree__subcount" aria-hidden="true">
              +{hiddenBelow}
            </span>
          )}
        </>
      )}
    </div>
  );
}
