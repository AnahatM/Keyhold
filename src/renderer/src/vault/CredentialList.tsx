// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CredentialProjection } from '@shared/model/credential.js';
import { Badge, EmptyState } from '../components/Feedback.js';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { useCredentials, visibleCredentials } from './credential-store.js';
import { useSession } from './session-store.js';

/**
 * The middle pane: search, filter, and the record list.
 *
 * **Virtualised.** A vault with ten thousand records is a real case — people import a
 * decade of browser passwords — and rendering ten thousand rows makes the first paint take
 * seconds and every keystroke in the search box janky. Only the rows in view plus a small
 * overscan are mounted.
 *
 * The virtualisation is hand-rolled rather than pulled from a library: it is fifty lines
 * for a fixed-height list, and a dependency inside a password manager needs to earn its
 * place. Row height comes from the density setting, so it stays correct when the user
 * changes density.
 */

/** Rows rendered above and below the viewport, so fast scrolling does not show gaps. */
const OVERSCAN = 6;

export function CredentialList(): React.JSX.Element {
  const { credentials } = useSession();
  const { selectedId, select, query, setQuery, showTrash, setShowTrash, deepMatches, setEditing } =
    useCredentials();

  const visible = useMemo(
    () => visibleCredentials(credentials, { query, showTrash, deepMatches }),
    [credentials, query, showTrash, deepMatches]
  );

  return (
    <div className="kh-list">
      <header className="kh-list__header">
        <h1 className="kh-list__title">{showTrash ? 'Trash' : 'Credentials'}</h1>
        <Badge tone="neutral">{visible.length}</Badge>
        {!showTrash && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              select(null);
              setEditing(true);
            }}
          >
            New
          </Button>
        )}
      </header>

      <div className="kh-list__search">
        <Input
          label="Search credentials"
          labelHidden
          type="search"
          placeholder="Search…"
          value={query}
          onChange={(event) => {
            void setQuery(event.target.value);
          }}
        />
        <label className="kh-list__toggle">
          <input
            type="checkbox"
            checked={showTrash}
            onChange={(event) => {
              setShowTrash(event.target.checked);
            }}
          />
          <span>Trash</span>
        </label>
      </div>

      {/*
       * Announced so a screen-reader user hears the result count change as they type.
       * Without it, filtering is a silent operation for anyone not watching the list.
       */}
      <span className="kh-visually-hidden" aria-live="polite">
        {query.trim() === ''
          ? ''
          : `${visible.length} credential${visible.length === 1 ? '' : 's'} match “${query}”`}
      </span>

      {visible.length === 0 ? (
        <EmptyState
          icon={showTrash ? '🗑' : query.trim() === '' ? '🗝' : '🔍'}
          title={
            showTrash
              ? 'Trash is empty'
              : query.trim() === ''
                ? 'No credentials yet'
                : 'Nothing matches that search'
          }
          description={
            showTrash
              ? 'Deleted records appear here and can be restored until they are purged.'
              : query.trim() === ''
                ? 'Add your first credential, or import from another password manager.'
                : 'Search covers titles, usernames, emails, tags and URLs — and, in the background, notes and hidden fields.'
          }
        />
      ) : (
        <VirtualRows items={visible} selectedId={selectedId} onSelect={select} />
      )}
    </div>
  );
}

function VirtualRows({
  items,
  selectedId,
  onSelect,
}: {
  readonly items: readonly CredentialProjection[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [rowHeight, setRowHeight] = useState(56);

  // Row height and viewport height both come from the DOM rather than being hardcoded,
  // because density and font size change them and a stale value shows gaps or overlaps.
  useEffect(() => {
    const element = viewport.current;
    if (element === null) return;

    const measure = (): void => {
      setHeight(element.clientHeight);
      const styles = getComputedStyle(document.documentElement);
      const measured = Number.parseFloat(styles.getPropertyValue('--kh-row-height'));
      // The projection shows two lines per row, so a row is taller than one control.
      if (Number.isFinite(measured) && measured > 0) setRowHeight(measured + 16);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const last = Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + OVERSCAN);
  const slice = items.slice(first, last);

  return (
    <div
      ref={viewport}
      className="kh-rows"
      onScroll={(event) => {
        setScrollTop(event.currentTarget.scrollTop);
      }}
    >
      {/*
       * A spacer of the full height keeps the scrollbar honest, so the thumb size and
       * position reflect the whole list rather than the handful of mounted rows.
       */}
      <div style={{ height: items.length * rowHeight, position: 'relative' }}>
        <ul
          style={{ position: 'absolute', top: first * rowHeight, left: 0, right: 0 }}
          role="listbox"
          aria-label="Credentials"
        >
          {slice.map((credential) => (
            <li key={credential.id}>
              <button
                type="button"
                className="kh-row"
                style={{ height: rowHeight }}
                role="option"
                aria-selected={credential.id === selectedId}
                onClick={() => {
                  onSelect(credential.id);
                }}
              >
                <span className="kh-row__mark" aria-hidden="true">
                  {iconFor(credential)}
                </span>
                <span className="kh-row__text">
                  <span className="kh-row__title">
                    {credential.title === '' ? 'Untitled' : credential.title}
                  </span>
                  <span className="kh-row__subtitle">
                    {credential.username || credential.email || primaryHost(credential) || '—'}
                  </span>
                </span>
                {credential.favorite && (
                  <span className="kh-row__flag" aria-label="Favourite">
                    ★
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** A letter or emoji stand-in. Never fetches a favicon — that would tell a server which accounts exist. */
function iconFor(credential: CredentialProjection): string {
  if (credential.icon.kind === 'emoji' && credential.icon.value !== undefined) {
    return credential.icon.value;
  }
  const source = credential.title.trim() || credential.username.trim() || '?';
  return (source[0] ?? '?').toUpperCase();
}

function primaryHost(credential: CredentialProjection): string {
  const url = credential.urls[0];
  if (url === undefined) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
