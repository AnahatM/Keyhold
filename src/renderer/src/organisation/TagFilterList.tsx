// SPDX-License-Identifier: GPL-3.0-or-later
import { useMemo, useRef, useState } from 'react';
import type { CredentialProjection } from '@shared/model/credential.js';
import type { Tag } from '@shared/model/vault-document.js';
import { Button } from '../components/Button.js';
import { Icon } from '../components/Icon.js';
import { countRecordsByTag } from './selection.js';
import { tagColourLabel, tagSwatchColour } from './tag-colours.js';

/**
 * The tag list: multi-select, with any/all matching.
 *
 * ## The colour is decoration; the name is the information
 *
 * Each row shows a swatch, but the swatch is `aria-hidden` and the colour is resolved from
 * a **token name** through `tag-colours.ts` — there is no path here that can paint a raw
 * colour, so a theme change moves every tag with it and the contrast guard keeps applying.
 * Selection is marked by `aria-pressed`, a tick and a filled row, never by hue alone
 * (WCAG 1.4.1). The colour name is available as text in the tooltip for anyone who wants it.
 *
 * ## Why the rows are toggle buttons rather than checkboxes
 *
 * They are a filter, not a form. `aria-pressed` says "this narrowing is on", which is what
 * is actually happening, and it keeps the row a single tab stop with a single label instead
 * of a checkbox plus a click target that do subtly different things.
 */

export interface TagFilterListProps {
  readonly tags: readonly Tag[];
  readonly records: readonly CredentialProjection[];
  readonly selectedTagIds: readonly string[];
  readonly tagMatch: 'any' | 'all';
  readonly busy: boolean;
  readonly renamingTagId: string | null;
  readonly onToggleTag: (tagId: string) => void;
  readonly onTagMatchChange: (match: 'any' | 'all') => void;
  readonly onClearTags: () => void;
  readonly onBeginRename: (tagId: string | null) => void;
  readonly onRenameTag: (tagId: string, name: string) => void;
}

export function TagFilterList({
  tags,
  records,
  selectedTagIds,
  tagMatch,
  busy,
  renamingTagId,
  onToggleTag,
  onTagMatchChange,
  onClearTags,
  onBeginRename,
  onRenameTag,
}: TagFilterListProps): React.JSX.Element | null {
  const counts = useMemo(() => countRecordsByTag(records), [records]);
  const [renameDraft, setRenameDraft] = useState('');
  const renameField = useRef<HTMLInputElement>(null);

  // Alphabetical, with a locale-aware collator so accented names sort where a reader
  // expects. Sorting by count would make the list reorder itself as records change, which
  // makes a tag impossible to find twice in a row.
  const ordered = useMemo(
    () =>
      [...tags].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [tags]
  );

  if (ordered.length === 0) {
    return (
      <section className="kh-tags" aria-labelledby="kh-tags-heading">
        <h2 className="kh-sidebar__group" id="kh-tags-heading">
          Tags
        </h2>
        <p className="kh-sidebar__note">
          No tags yet. Add tags to a record and they appear here as filters.
        </p>
      </section>
    );
  }

  return (
    <section className="kh-tags" aria-labelledby="kh-tags-heading">
      <header className="kh-tags__header">
        <h2 className="kh-sidebar__group" id="kh-tags-heading">
          Tags
        </h2>
        {selectedTagIds.length > 0 && (
          <Button variant="ghost" size="sm" onClick={onClearTags}>
            Clear
          </Button>
        )}
      </header>

      {selectedTagIds.length > 1 && (
        <fieldset className="kh-tags__match">
          <legend className="kh-visually-hidden">How to combine the selected tags</legend>
          {(['any', 'all'] as const).map((mode) => (
            <label key={mode} className="kh-tags__match-option">
              <input
                type="radio"
                name="kh-tag-match"
                checked={tagMatch === mode}
                onChange={() => {
                  onTagMatchChange(mode);
                }}
              />
              <span>{mode === 'any' ? 'Any of these' : 'All of these'}</span>
            </label>
          ))}
        </fieldset>
      )}

      <ul className="kh-tags__list">
        {ordered.map((tag) => {
          const count = counts.get(tag.id) ?? 0;
          const selected = selectedTagIds.includes(tag.id);
          const renaming = renamingTagId === tag.id;

          return (
            <li key={tag.id}>
              {renaming ? (
                <input
                  ref={renameField}
                  className="kh-tree__rename"
                  autoFocus
                  defaultValue={tag.name}
                  aria-label={`Rename the tag “${tag.name}”`}
                  onChange={(event) => {
                    setRenameDraft(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      const value = renameField.current?.value ?? renameDraft;
                      if (value.trim() === '' || value.trim() === tag.name) onBeginRename(null);
                      else onRenameTag(tag.id, value);
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      onBeginRename(null);
                    }
                  }}
                  onBlur={() => {
                    onBeginRename(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="kh-tag-row"
                  aria-pressed={selected}
                  disabled={busy}
                  title={`${tag.name} — ${tagColourLabel(tag.colour)}`}
                  onClick={() => {
                    onToggleTag(tag.id);
                  }}
                  onDoubleClick={() => {
                    onBeginRename(tag.id);
                  }}
                >
                  <span
                    className="kh-tag-row__swatch"
                    aria-hidden="true"
                    style={{ background: tagSwatchColour(tag.colour) }}
                  />
                  {/*
                    The wrapper stays even though the icon carries its own `aria-hidden`:
                    unlike the sidebar rows, this slot is empty half the time, and its fixed
                    1em width is what stops every unselected tag's name sliding left of every
                    selected one.
                  */}
                  <span className="kh-tag-row__tick">
                    {selected && <Icon name="check" size="sm" />}
                  </span>
                  <span className="kh-tag-row__name">{tag.name}</span>
                  <span className="kh-sidebar__count">
                    {count}
                    <span className="kh-visually-hidden">{` record${count === 1 ? '' : 's'}`}</span>
                  </span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
