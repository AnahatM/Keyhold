// SPDX-License-Identifier: GPL-3.0-or-later

import { useId, useMemo, useState } from 'react';
import type { CredentialProjection } from '@shared/model/credential.js';
import { AUTOFOCUS_ATTRIBUTE, Modal } from '../chrome/index.js';
import { Input } from '../components/Input.js';
import { describeCombo, formatCombo } from './key-combo.js';
import { isNavigationKey, nextIndex, resolveActiveIndex } from './list-navigation.js';
import { flattenGroups, groupPaletteItems } from './palette-groups.js';
import {
  itemDetail,
  itemTitle,
  matchReason,
  searchPalette,
  type PaletteItem,
} from './palette-search.js';
import { usePaletteStore } from './palette-store.js';
import { useRecentCommands } from './recent-commands.js';
import { shortcutById } from './shortcut-registry.js';
import type { ResolvedCommand } from './command-registry.js';
import './commands.css';

/**
 * The command palette — Ctrl/Cmd+K.
 *
 * One box that searches **commands and credentials together**, through `@shared/search`, on
 * one score, ranked. See `palette-search.ts` for why they share a scale rather than being
 * two lists stapled together.
 *
 * ## It never shows or copies a secret
 *
 * A credential row shows title and username: exactly what the safe projection already
 * carries into the renderer, and nothing more. There is no reveal, no copy, no "press Enter
 * to paste the password". This is not an oversight to be filled in later — decision D13
 * means the renderer does not have the password to show, and a fuzzy search surface where
 * the highlighted row moves as you type is the single worst place to attach an action that
 * puts a secret on the clipboard. Selecting a credential **navigates to it**. The user then
 * reveals it deliberately, from the detail pane, where they can see what they are revealing.
 *
 * ## `aria-activedescendant`, not roving tabindex
 *
 * Chosen because the user is typing. DOM focus has to stay in the text field for the next
 * keystroke to land there; a roving tabindex moves focus onto the highlighted option, and
 * then either typing stops working or every option needs its own key handling to forward
 * characters back to the input. `aria-activedescendant` is the pattern ARIA defines for
 * exactly this — a combobox whose focus never leaves the box — at the cost of one rule:
 * every option must carry a stable `id`, generated here with `useId`.
 *
 * ## Reduced motion
 *
 * Nothing here animates beyond `--kh-duration-*`, which `base.css` multiplies by
 * `--kh-motion-scale` — dropped to zero under `prefers-reduced-motion`. `commands.css`
 * states the query explicitly as well, because a palette that flies in is one of the more
 * unpleasant things to meet if motion makes you ill.
 */

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Only the commands that are actually runnable right now — see `resolveCommands`. */
  readonly commands: readonly ResolvedCommand[];
  /** The safe projection the renderer already holds. Never anything more. */
  readonly credentials: readonly CredentialProjection[];
  /** Ids the main process matched inside secret material, from the credential store. */
  readonly deepMatches?: readonly string[] | undefined;
  /** Navigates to a record. Selection only — never a reveal, never a copy. */
  readonly onSelectCredential: (credentialId: string) => void;
}

export function CommandPalette(props: CommandPaletteProps): React.JSX.Element {
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="Command palette"
      size="lg"
      // Off: the box has a half-typed query in it, and losing that to a stray click on the
      // scrim is the same annoyance as losing a half-written form.
      closeOnBackdropClick={false}
      hideCloseButton
    >
      {/*
        The content is a child component so that it **unmounts with the modal**. `Modal`
        renders nothing while closed, so the query text and the highlighted row reset by
        construction — no effect watching `open` to clear them, and therefore no `setState`
        in an effect body to get wrong.
      */}
      <PaletteContent {...props} />
    </Modal>
  );
}

function PaletteContent({
  commands,
  credentials,
  deepMatches,
  onClose,
  onSelectCredential,
}: CommandPaletteProps): React.JSX.Element {
  const [text, setText] = useState('');
  /** The *key* of the highlighted row, not its index — see `resolveActiveIndex`. */
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const platform = usePaletteStore((state) => state.platform);
  const recentKeys = useRecentCommands((state) => state.keys);
  const remember = useRecentCommands((state) => state.remember);

  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number): string => `${baseId}-option-${index}`;

  const { groups, items, indexByKey } = useMemo(() => {
    const result = searchPalette(text, {
      commands,
      credentials,
      recentKeys,
      deepMatches,
    });
    const grouped = groupPaletteItems(result.items, {
      queryIsEmpty: result.query.isEmpty,
      recentKeys,
    });
    // Flattened from the groups, so Down-arrow order is display order.
    const flat = flattenGroups(grouped);
    return {
      groups: grouped,
      items: flat,
      // Precomputed rather than an `indexOf` per row: the flat order is what
      // `aria-activedescendant` indexes into, and rebuilding it inside the render loop
      // would be quadratic in the result count for no reason.
      indexByKey: new Map(flat.map((item, index) => [item.key, index])),
    };
  }, [text, commands, credentials, recentKeys, deepMatches]);

  const activeIndex = resolveActiveIndex(
    items.map((item) => item.key),
    activeKey
  );
  const activeItem = activeIndex === -1 ? undefined : items[activeIndex];

  const openCombo = shortcutById('palette.open').combo;
  const hint =
    platform === null
      ? 'Search commands and records. Enter to run, Esc to close.'
      : `${formatCombo(openCombo, platform)} to close · ↑ ↓ to move · Enter to run`;

  const run = (item: PaletteItem): void => {
    remember(item.key);
    // Closed first, so focus is already on its way back to the opener before anything the
    // command does can move it somewhere else.
    onClose();
    if (item.kind === 'command') {
      // No `void` and nothing to await: `CommandHandler` is synchronous by construction, so
      // an action doing asynchronous work has already taken responsibility for its failure.
      item.command.run();
    } else {
      onSelectCredential(item.record.id);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (isNavigationKey(event.key)) {
      event.preventDefault();
      const target = nextIndex(activeIndex, items.length, event.key);
      setActiveKey(target === -1 ? null : (items[target]?.key ?? null));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (activeItem !== undefined) run(activeItem);
    }
    // Escape is left alone: `Modal` owns it, closes the topmost surface only, and stops it
    // from reaching anything behind. Handling it here as well would be a second answer.
  };

  return (
    <div className="kh-palette">
      <Input
        label="Search commands and records"
        labelHidden
        type="text"
        value={text}
        placeholder="Type a command or a record name…"
        autoComplete="off"
        spellCheck={false}
        hint={hint}
        className="kh-palette__field"
        role="combobox"
        aria-expanded
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeIndex === -1 ? undefined : optionId(activeIndex)}
        aria-keyshortcuts={platform === null ? undefined : describeCombo(openCombo, platform)}
        // The chrome's focus helper looks for this when the dialog opens. Preferred over
        // `autofocus`, which fires once at parse time — the wrong moment for a dialog that
        // opens and closes repeatedly.
        {...{ [AUTOFOCUS_ATTRIBUTE]: '' }}
        onChange={(event) => {
          setText(event.target.value);
          // Back to the top on a new query. The highlight is keyed, so an unchanged row
          // keeps it; this only matters when the previous row has gone.
          setActiveKey(null);
        }}
        onKeyDown={onKeyDown}
      />

      {/*
        Polite, so it queues behind whatever the user is doing rather than interrupting
        every keystroke. It carries the count only — a screen-reader user arrowing through
        the list hears each option from `aria-activedescendant`, and repeating the first
        result here would read it to them twice.
      */}
      <div className="kh-visually-hidden" role="status" aria-live="polite">
        {resultAnnouncement(items.length)}
      </div>

      {items.length === 0 ? (
        <p className="kh-palette__empty">
          {text.trim() === ''
            ? 'No commands are available here yet.'
            : `Nothing matches “${text.trim()}”. Try a shorter word, or part of a record’s title.`}
        </p>
      ) : (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Commands and records"
          className="kh-palette__list"
        >
          {groups.map((group) => {
            const headingId = `${baseId}-${group.id}`;
            return (
              <div key={group.id} role="group" aria-labelledby={headingId}>
                <div className="kh-palette__heading" id={headingId}>
                  {group.label}
                </div>
                {group.items.map((item) => {
                  const index = indexByKey.get(item.key) ?? -1;
                  return (
                    <PaletteRow
                      key={item.key}
                      id={optionId(index)}
                      item={item}
                      active={index === activeIndex}
                      onActivate={() => {
                        run(item);
                      }}
                      onHover={() => {
                        setActiveKey(item.key);
                      }}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function resultAnnouncement(count: number): string {
  if (count === 0) return 'No results';
  return `${count} result${count === 1 ? '' : 's'}`;
}

interface PaletteRowProps {
  readonly id: string;
  readonly item: PaletteItem;
  readonly active: boolean;
  readonly onActivate: () => void;
  readonly onHover: () => void;
}

/**
 * One result.
 *
 * A `div`, not a `button`. Options in an `aria-activedescendant` listbox must not be
 * focusable — a button inside would put itself in the tab order and let a keyboard user
 * Tab out of the text field into the middle of the list, where typing no longer reaches
 * the query. `onMouseDown` rather than `onClick` so the row acts before the browser moves
 * focus out of the input.
 */
function PaletteRow({ id, item, active, onActivate, onHover }: PaletteRowProps): React.JSX.Element {
  const reason = matchReason(item);
  const destructive = item.kind === 'command' && item.command.definition.destructive;

  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      className={`kh-palette__row${active ? ' kh-palette__row--active' : ''}`}
      onMouseDown={(event) => {
        event.preventDefault();
        onActivate();
      }}
      onMouseMove={onHover}
    >
      {/*
        A chevron, not `⌘`. The command glyph is the macOS modifier key, and on Windows it
        sat in the same row as a chip reading "Ctrl+S" — one row claiming two platforms.
        `aria-hidden` because the row's own title already says what it is; the icon is a
        shape that separates a command from a record at a glance, and nothing more.
      */}
      <span className="kh-palette__kind" aria-hidden="true">
        {item.kind === 'command' ? '›' : '🔑'}
      </span>

      <span className="kh-palette__text">
        <span className="kh-palette__title">
          {itemTitle(item)}
          {/*
            A word, not a colour. WCAG 1.4.1: the destructive row is otherwise identical to
            its neighbours, and tinting it red would be the only signal — useless to anyone
            who cannot see the tint, and invisible against a user's custom theme.
          */}
          {destructive && <span className="kh-palette__flag"> · destructive</span>}
        </span>
        <span className="kh-palette__detail">
          {itemDetail(item)}
          {reason !== null && <span className="kh-palette__reason"> · {reason}</span>}
        </span>
      </span>

      {item.kind === 'command' && <CommandShortcutHint command={item.command} />}
    </div>
  );
}

/** The row's key hint, read out of the shortcut table — never restated on the command. */
function CommandShortcutHint({
  command,
}: {
  readonly command: ResolvedCommand;
}): React.JSX.Element | null {
  const platform = usePaletteStore((state) => state.platform);
  const shortcutId = command.definition.shortcutId;
  if (shortcutId === undefined || platform === null) return null;

  const shortcut = shortcutById(shortcutId);
  return (
    <kbd className="kh-palette__combo" aria-label={describeCombo(shortcut.combo, platform)}>
      {formatCombo(shortcut.combo, platform)}
    </kbd>
  );
}
