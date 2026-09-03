// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { Modal } from '../chrome/index.js';
import { SAVED_SEARCH_NAME_MAX } from '@shared/model/saved-search.js';
import { useSavedSearches } from './saved-search-store.js';

/**
 * Saving the query currently in the box.
 *
 * Beside the query bar, and nowhere else. This is the moment somebody has just built a query
 * they will want again — a settings screen with an "add a saved search" form would ask them
 * to retype it from memory, which is the same amount of work as not having the feature.
 *
 * ## It is absent, not disabled, on an empty query
 *
 * A control that appears the instant there is something to save reads as an offer. One that
 * sits there permanently greyed out is a question the user has to answer ("why can't I click
 * this?") every time they look at the search box, and the answer is never interesting.
 *
 * ## The name is suggested, never imposed
 *
 * It opens pre-filled with the query text, because a saved search called `is:weak` is a
 * perfectly good saved search and most people will just press Save. Anyone who wants
 * "Needs attention" types over it, and the field is selected so that costs one keystroke.
 */

export interface SaveSearchButtonProps {
  /** The query text currently in the box. Blank means nothing to save. */
  readonly query: string;
}

export function SaveSearchButton({ query }: SaveSearchButtonProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);

  if (query.trim() === '') return null;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setOpen(true);
        }}
      >
        Save this search
      </Button>
      {open && (
        <SaveSearchDialog
          query={query}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function SaveSearchDialog({
  query,
  onClose,
}: {
  readonly query: string;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { busy, error, create, clearError } = useSavedSearches();
  const [name, setName] = useState(query.slice(0, SAVED_SEARCH_NAME_MAX));

  // A refusal from a previous attempt must not greet the next one. Cleared on unmount rather
  // than on open, so the message survives long enough to be read on the attempt that caused
  // it and no longer.
  useEffect(() => clearError, [clearError]);

  const submit = (): void => {
    void create(name, query).then((saved) => {
      if (saved) onClose();
    });
  };

  return (
    <Modal
      open
      title="Save this search"
      description="It is stored inside the vault, so it travels with the file to every machine that opens it."
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={name.trim() === ''} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <Input
        label="Name"
        value={name}
        autoFocus
        maxLength={SAVED_SEARCH_NAME_MAX}
        hint="Shown in the sidebar. The query itself is the tooltip, so the name is free to be a label rather than a description."
        onChange={(event) => {
          setName(event.target.value);
        }}
        {...(error === null ? {} : { error })}
      />

      <p className="kh-setting__help">
        Saving: <code className="kh-path">{query}</code>
      </p>
    </Modal>
  );
}
