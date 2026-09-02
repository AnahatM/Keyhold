// SPDX-License-Identifier: GPL-3.0-or-later

import { Modal } from '../chrome/index.js';
import { LoadingState } from '../components/Feedback.js';
import { describeCombo, formatCombo } from './key-combo.js';
import { usePaletteStore } from './palette-store.js';
import {
  SCOPE_DESCRIPTIONS,
  SCOPE_LABELS,
  SHORTCUT_SCOPES,
  shortcutsInScope,
  type ShortcutDefinition,
  type ShortcutId,
} from './shortcut-registry.js';
import './commands.css';

/**
 * The shortcuts sheet — Ctrl/Cmd+/.
 *
 * The discoverability half of the system. A shortcut nobody can find is a shortcut nobody
 * uses, and "press the key you do not know about to learn which keys exist" is the joke
 * every app makes accidentally — which is why this sheet is also a palette command, and why
 * its own binding is the first row in it.
 *
 * **Every row is generated from `SHORTCUTS`.** Not a hand-written table that looks like it.
 * The consequence is the point: a binding changed in the registry changes here in the same
 * commit, and a binding removed cannot linger here as a key that does nothing. Grouping is
 * by `scope` — the same field the key handler gates on — so the headings cannot claim a
 * shortcut is available somewhere it is not.
 */

export interface ShortcutsHelpProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /**
   * The shortcuts that actually have a handler mounted right now.
   *
   * The sheet shows these and no others. A shortcut in the table whose feature is not
   * mounted — because the view that owns it is not on screen, or because the wiring has not
   * landed yet — would otherwise be printed here as a key that does nothing, which is
   * precisely the lie the single registry exists to make impossible. Better a shorter
   * sheet that is true than a complete one that is not.
   */
  readonly boundIds: ReadonlySet<ShortcutId>;
}

export function ShortcutsHelp({ open, onClose, boundIds }: ShortcutsHelpProps): React.JSX.Element {
  const platform = usePaletteStore((state) => state.platform);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      description="Every shortcut Keyhold knows about, grouped by where it works."
      size="lg"
    >
      {/*
        The whole sheet is key labels, and a label is platform-specific. Rather than guess
        `Ctrl` and be wrong for every Mac user for one frame, the sheet waits — see
        `palette-store.ts`. In practice this is never seen: the platform is fetched when the
        provider mounts, long before anyone opens this.
      */}
      {platform === null ? (
        <LoadingState label="Reading your keyboard layout" rows={3} />
      ) : (
        <div className="kh-shortcuts">
          {SHORTCUT_SCOPES.map((scope) => {
            const shortcuts = shortcutsInScope(scope).filter((shortcut) =>
              boundIds.has(shortcut.id)
            );
            if (shortcuts.length === 0) return null;
            return (
              <section key={scope} className="kh-shortcuts__group">
                <h3 className="kh-shortcuts__heading">{SCOPE_LABELS[scope]}</h3>
                <p className="kh-shortcuts__note">{SCOPE_DESCRIPTIONS[scope]}</p>
                <dl className="kh-shortcuts__list">
                  {shortcuts.map((shortcut) => (
                    <ShortcutRow key={shortcut.id} shortcut={shortcut} />
                  ))}
                </dl>
              </section>
            );
          })}

          <p className="kh-shortcuts__footnote">
            Shortcuts marked <em>while locked</em> are the only ones that work before the vault is
            open. Nothing else fires while a text field has focus, so a password containing a
            shortcut’s letter can never trigger it.
          </p>
        </div>
      )}
    </Modal>
  );
}

function ShortcutRow({ shortcut }: { readonly shortcut: ShortcutDefinition }): React.JSX.Element {
  const platform = usePaletteStore((state) => state.platform);
  if (platform === null) return <></>;

  return (
    <div className="kh-shortcuts__row">
      <dt className="kh-shortcuts__description">
        {shortcut.description}
        {/*
          A word rather than a badge colour — WCAG 1.4.1, same rule as the palette's
          destructive marker. It is also genuinely useful information: these are the two
          rows that behave differently from every other row on the sheet.
        */}
        {shortcut.whenLocked && <span className="kh-shortcuts__flag"> · while locked</span>}
      </dt>
      <dd className="kh-shortcuts__keys">
        {/*
          The visible label is symbolic on macOS (`⌘K`) and a screen reader would announce
          that glyph as nothing useful, so the spoken form is supplied alongside it. Both
          are derived from the same `KeyCombo`, so they cannot disagree.
        */}
        <kbd className="kh-shortcuts__combo" aria-label={describeCombo(shortcut.combo, platform)}>
          {formatCombo(shortcut.combo, platform)}
        </kbd>
      </dd>
    </div>
  );
}
