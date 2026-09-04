// SPDX-License-Identifier: GPL-3.0-or-later
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { CredentialProjection } from '@shared/model/credential.js';
import { Button } from '../components/Button.js';
import { countRecordsByFolder } from './folder-counts.js';
import { flattenVisible, type FolderTree as FolderTreeModel } from './folder-tree-model.js';
import { FolderTreeItem, type RowDropState } from './FolderTreeItem.js';
import { canDropFolder } from './move-targets.js';
import {
  dragKindFromTypes,
  readDragPayload,
  writeDragPayload,
  type DragKind,
} from './drag-payload.js';
import { isHandledTreeKey, treeKeyAction } from './tree-keyboard.js';
import { Icon } from '../components/Icon.js';

/**
 * The folder tree: an ARIA tree, a keyboard-first action bar, and drag-to-file.
 *
 * ## Why the actions are a toolbar and not a button on every row
 *
 * `role="treeitem"` is not supposed to contain focusable children — a per-row menu button
 * puts a second tab stop inside every row and breaks the roving tabindex that makes a tree
 * navigable in the first place. So Rename / Move / Delete / New live in one toolbar that
 * acts on the selected folder and names it out loud. That is better for the keyboard *and*
 * for the mouse: the actions are always in the same place instead of appearing on hover,
 * which is a target that does not exist for anyone using touch or a screen reader.
 *
 * ## Drag-and-drop is the shortcut, not the mechanism
 *
 * Every drop this accepts has a keyboard equivalent in the toolbar (WCAG 2.2 SC 2.5.7,
 * Dragging Movements). Nothing can only be done by dragging.
 *
 * The dragged folder's id is held in component state rather than read from the drag: during
 * `dragover` the browser exposes only `dataTransfer.types`, deliberately, so "would this
 * drop create a cycle?" cannot be answered from the event alone. The types tell us *what* is
 * being dragged; this state tells us *which*.
 */

export interface FolderTreeProps {
  readonly tree: FolderTreeModel;
  readonly records: readonly CredentialProjection[];
  readonly expanded: ReadonlySet<string>;
  readonly selectedFolderId: string | null;
  readonly focusedFolderId: string | null;
  readonly renamingFolderId: string | null;
  readonly draftParentId: string | null | undefined;
  readonly busy: boolean;
  readonly onSelectFolder: (folderId: string) => void;
  readonly onSetExpanded: (expanded: ReadonlySet<string>) => void;
  readonly onToggleExpanded: (folderId: string) => void;
  readonly onFocusFolder: (folderId: string | null) => void;
  readonly onBeginCreate: (parentId: string | null) => void;
  readonly onBeginRename: (folderId: string) => void;
  readonly onCancelEditing: () => void;
  readonly onCreateFolder: (name: string, parentId: string | null) => void;
  readonly onRenameFolder: (folderId: string, name: string) => void;
  readonly onMoveFolder: (folderId: string, parentId: string | null) => void;
  readonly onRequestMove: (folderId: string) => void;
  readonly onRequestDelete: (folderId: string) => void;
  readonly onFileCredential: (credentialId: string, folderId: string | null) => void;
}

interface DragState {
  readonly kind: DragKind | null;
  readonly folderId: string | null;
  /** The row being hovered, or `'root'` for the top-level strip. */
  readonly overId: string | null;
}

const NO_DRAG: DragState = { kind: null, folderId: null, overId: null };

export function FolderTree(props: FolderTreeProps): React.JSX.Element {
  const {
    tree,
    records,
    expanded,
    selectedFolderId,
    focusedFolderId,
    renamingFolderId,
    draftParentId,
    busy,
  } = props;

  const [treeHasFocus, setTreeHasFocus] = useState(false);
  const [drag, setDrag] = useState<DragState>(NO_DRAG);
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const draftInput = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => flattenVisible(tree, expanded), [tree, expanded]);
  const counts = useMemo(() => countRecordsByFolder(records, tree), [records, tree]);

  // The row that owns the single tab stop. Falling back to the first row means the tree is
  // always reachable by Tab, even before anything has been focused or selected.
  const activeId = focusedFolderId ?? selectedFolderId ?? rows[0]?.id ?? null;

  const registerRow = useCallback((folderId: string, element: HTMLDivElement | null): void => {
    if (element === null) rowElements.current.delete(folderId);
    else rowElements.current.set(folderId, element);
  }, []);

  const moveFocus = (folderId: string): void => {
    props.onFocusFolder(folderId);
    // Focused imperatively as well as through state: the row already exists in the DOM for
    // every move the key map can produce, and waiting a render would let the browser scroll
    // the old row back into view first.
    rowElements.current.get(folderId)?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!isHandledTreeKey(event.key)) return;
    const action = treeKeyAction(rows, activeId, event.key);
    if (action.kind === 'none') return;

    event.preventDefault();
    event.stopPropagation();

    switch (action.kind) {
      case 'focus':
        moveFocus(action.id);
        break;
      case 'expand':
      case 'collapse':
        props.onToggleExpanded(action.id);
        props.onFocusFolder(action.id);
        break;
      case 'expand-siblings': {
        const next = new Set(expanded);
        for (const id of action.ids) next.add(id);
        props.onSetExpanded(next);
        break;
      }
      case 'select':
        props.onSelectFolder(action.id);
        break;
    }
  };

  // ── Dropping ───────────────────────────────────────────────────────────────

  const dropStateFor = (targetId: string | null): RowDropState => {
    if (drag.kind === null) return 'none';
    const key = targetId ?? 'root';
    if (drag.overId !== key) return 'none';
    if (drag.kind === 'credential') return 'valid';
    if (drag.folderId === null) return 'invalid';
    return canDropFolder(tree.folders, drag.folderId, targetId) ? 'valid' : 'invalid';
  };

  const allows = (targetId: string | null, kind: DragKind | null): boolean => {
    if (kind === null) return false;
    if (kind === 'credential') return true;
    return drag.folderId !== null && canDropFolder(tree.folders, drag.folderId, targetId);
  };

  const handleDragOver = (targetId: string | null, event: ReactDragEvent<HTMLElement>): void => {
    const kind = dragKindFromTypes([...event.dataTransfer.types]);
    if (kind === null) return;
    if (allows(targetId, kind)) {
      // Calling preventDefault is what makes this a drop target at all. Without it the
      // browser refuses the drop and shows a "no entry" cursor over every folder.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }
    setDrag((current) => ({ ...current, kind, overId: targetId ?? 'root' }));
  };

  const handleDrop = (targetId: string | null, event: ReactDragEvent<HTMLElement>): void => {
    event.preventDefault();
    const payload = readDragPayload(event.dataTransfer);
    setDrag(NO_DRAG);
    if (payload === null) return;

    if (payload.kind === 'credential') {
      props.onFileCredential(payload.id, targetId);
      return;
    }
    if (canDropFolder(tree.folders, payload.id, targetId)) {
      props.onMoveFolder(payload.id, targetId);
    }
  };

  const commitDraft = (): void => {
    const value = draftInput.current?.value ?? '';
    if (value.trim() === '') props.onCancelEditing();
    else props.onCreateFolder(value, draftParentId ?? null);
  };

  const selectedName =
    selectedFolderId === null ? null : (tree.byId.get(selectedFolderId)?.folder.name ?? null);

  return (
    <section className="kh-tree" aria-labelledby="kh-tree-heading">
      <header className="kh-tree__header">
        <h2 className="kh-sidebar__group" id="kh-tree-heading">
          Folders
        </h2>
        <Button
          variant="ghost"
          size="sm"
          iconOnlyLabel="New top-level folder"
          disabled={busy}
          onClick={() => {
            props.onBeginCreate(null);
          }}
        >
          +
        </Button>
      </header>

      {tree.problems.length > 0 && (
        // Surfaced, never silently repaired. A cycle or a missing parent means something
        // went wrong in a merge or a restore, and the user is the only one who can decide
        // what the folder was supposed to be.
        <div className="kh-tree__problems" role="status">
          <p className="kh-tree__problems-title">
            <Icon name="warning" size="sm" />
            {tree.problems.length} folder{tree.problems.length === 1 ? '' : 's'} could not be placed
          </p>
          <ul>
            {tree.problems.map((problem) => (
              <li key={`${problem.kind}:${problem.folderId}`}>{problem.detail}</li>
            ))}
          </ul>
        </div>
      )}

      <div
        className="kh-tree__rows"
        role="tree"
        aria-label="Folders"
        aria-multiselectable={false}
        onKeyDown={onKeyDown}
        onFocus={() => {
          setTreeHasFocus(true);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setTreeHasFocus(false);
        }}
      >
        {rows.length === 0 && draftParentId === undefined && (
          <p className="kh-sidebar__note">
            No folders yet. Create one, then drag records onto it — or use Move to… from a record.
          </p>
        )}

        {rows.map((row) => (
          <FolderTreeItem
            key={row.id}
            row={row}
            selected={row.id === selectedFolderId}
            focused={row.id === activeId}
            treeHasFocus={treeHasFocus}
            renaming={row.id === renamingFolderId}
            ownCount={counts.own.get(row.id) ?? 0}
            totalCount={counts.total.get(row.id) ?? 0}
            dropState={dropStateFor(row.id)}
            onSelect={props.onSelectFolder}
            onToggle={props.onToggleExpanded}
            onRenameCommit={props.onRenameFolder}
            onRenameCancel={props.onCancelEditing}
            onDragStart={(folderId, event) => {
              writeDragPayload(event.dataTransfer, { kind: 'folder', id: folderId });
              setDrag({ kind: 'folder', folderId, overId: null });
            }}
            onDragOver={handleDragOver}
            onDragLeave={(folderId) => {
              setDrag((current) =>
                current.overId === folderId ? { ...current, overId: null } : current
              );
            }}
            onDrop={handleDrop}
            onDragEnd={() => {
              setDrag(NO_DRAG);
            }}
            registerRow={registerRow}
          />
        ))}

        {draftParentId !== undefined && (
          <div className="kh-tree__draft">
            <input
              ref={draftInput}
              className="kh-tree__rename"
              autoFocus
              aria-label={
                draftParentId === null
                  ? 'Name for the new top-level folder'
                  : `Name for the new folder inside “${tree.byId.get(draftParentId)?.folder.name ?? ''}”`
              }
              placeholder="Folder name"
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitDraft();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  props.onCancelEditing();
                }
              }}
              onBlur={commitDraft}
            />
          </div>
        )}

        {/*
         * The top-level drop strip. Without it there is no way to drag a nested folder back
         * out to the root — the only target would be another folder, and every one of those
         * makes it deeper.
         */}
        <div
          className="kh-tree__root-drop"
          data-drop={dropStateFor(null) === 'none' ? undefined : dropStateFor(null)}
          onDragOver={(event) => {
            handleDragOver(null, event);
          }}
          onDragLeave={() => {
            setDrag((current) =>
              current.overId === 'root' ? { ...current, overId: null } : current
            );
          }}
          onDrop={(event) => {
            handleDrop(null, event);
          }}
        >
          <span aria-hidden="true">Drop here for no folder</span>
        </div>
      </div>

      {/*
       * The keyboard path for everything the drag does, plus the things it cannot do.
       * `aria-label` names the folder so the toolbar's buttons are unambiguous when read out
       * of context — "Rename" alone tells a screen-reader user nothing about what.
       */}
      <div
        className="kh-tree__toolbar"
        role="toolbar"
        aria-label={
          selectedName === null ? 'Folder actions' : `Actions for the folder “${selectedName}”`
        }
      >
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || selectedFolderId === null}
          onClick={() => {
            if (selectedFolderId !== null) props.onBeginCreate(selectedFolderId);
          }}
        >
          New inside
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || selectedFolderId === null}
          onClick={() => {
            if (selectedFolderId !== null) props.onBeginRename(selectedFolderId);
          }}
        >
          Rename
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || selectedFolderId === null}
          onClick={() => {
            if (selectedFolderId !== null) props.onRequestMove(selectedFolderId);
          }}
        >
          Move to…
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || selectedFolderId === null}
          onClick={() => {
            if (selectedFolderId !== null) props.onRequestDelete(selectedFolderId);
          }}
        >
          Delete
        </Button>
      </div>

      {counts.unresolved > 0 && (
        <p className="kh-tree__orphans" role="status">
          {counts.unresolved} record{counts.unresolved === 1 ? '' : 's'} point at a folder that no
          longer exists. They appear under All items but in no folder view.
        </p>
      )}

      <p className="kh-tree__hint" id="kh-tree-hint">
        <span aria-hidden="true">↑↓</span> move, <span aria-hidden="true">→←</span> open and close.
        Records can be dragged onto a folder, or filed with Move to…
      </p>
    </section>
  );
}
