// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import {
  admitPalette,
  evaluateEscapeFloor,
  evaluatePaletteContrast,
  keepThemeFromDefinition,
  normaliseColour,
} from '@shared/theme/keeptheme.js';
import { ACCENT_PRESETS } from '@shared/theme/accent.js';
import { THEME_ERROR_CODES, type ThemeNotice } from '@shared/theme/theme-channels.js';
import {
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  findTheme,
  THEMES,
} from '@shared/theme/themes.js';
import { Button } from '../components/Button.js';
import { useAppearance } from '../theme/appearance-store.js';
import { ContrastReportPanel } from './ContrastReportPanel.js';
import { ThemePreview } from './ThemePreview.js';
import { TokenEditor } from './TokenEditor.js';
import {
  draftFromThemeId,
  draftToKeepTheme,
  hasInvalidColours,
  themeDraftReducer,
} from './theme-draft.js';
import { createThemeGateway, type ThemeImportOutcome } from './theme-gateway.js';
import './theme-studio.css';

/**
 * The theme studio: edit every token, see it on real components, and see exactly what it
 * does to contrast before anything is saved.
 *
 * ## "Never save without seeing the contrast result" is structural, not a convention
 *
 * The report is not behind a tab or a button — it is on screen beside the editor, and it
 * recomputes on every change. Beyond that, the gate below `Apply` and `Export` is derived
 * from `admitPalette`, the same function `parseKeepTheme` uses, so a failing theme cannot
 * leave this screen unless the user has ticked a box whose label names the failures. The
 * tick produces a token derived from the palette (`contrastAcknowledgement`), so it cannot
 * be a remembered preference and it goes stale the instant a colour moves.
 *
 * Below the legibility floor there is no box to tick. See `admitPalette` for that decision
 * in full; the short version is that consent to a theme you can no longer read is consent
 * you cannot revoke.
 *
 * ## Where an imported theme is judged
 *
 * **In the main process, before the studio sees it.** `parseKeepTheme` runs there over the
 * file's bytes; this screen never receives the file's text, only the projection in
 * `theme-projection.ts`. That means:
 *
 *  - A theme below the legibility floor arrives as `theme/illegible` with **no palette**. It
 *    cannot be loaded, previewed, or nudged into shape, because the one thing it must not be
 *    able to do is make the screen that changes it back unreadable.
 *  - A theme that merely fails AA arrives as `needs-review` *with* its palette, loads into
 *    the draft, and meets the same gate below that a hand-edited theme meets. The report is
 *    the point: refusing it outright would take away the failing pairs it is meant to show.
 *  - The gate below still recomputes `admitPalette` locally, and it must. The palette can be
 *    edited after an import, so a verdict computed at import time would be stale by the next
 *    keystroke. Both sides run the same function over the same canonical palette.
 */

interface StudioStatus {
  readonly tone: 'info' | 'warning' | 'danger' | 'success';
  readonly message: string;
}

/**
 * Shown when `window.keyhold.theme` is missing.
 *
 * There is deliberately no fallback to a browser file input. A worse transport that quietly
 * takes over is a transport that hides the fact the real one is not there, which is how the
 * `<input type="file">` this screen used to carry survived for as long as it did.
 */
const THEME_FILES_UNAVAILABLE =
  'Theme files are unavailable in this build — everything else on this screen still works.';

export interface ThemeStudioProps {
  /** The built-in to open with. Defaults to the app's dark default. */
  readonly initialThemeId?: string;
}

export function ThemeStudio({ initialThemeId }: ThemeStudioProps): React.JSX.Element {
  const [draft, dispatch] = useReducer(
    themeDraftReducer,
    initialThemeId ?? DEFAULT_DARK_THEME_ID,
    draftFromThemeId
  );
  const [status, setStatus] = useState<StudioStatus | null>(null);
  const [accentInput, setAccentInput] = useState('');
  const [accentError, setAccentError] = useState<string | null>(null);

  const updateAppearance = useAppearance((state) => state.update);

  // Created once. A new gateway per render would be harmless but pointless, and this way
  // `available` is stable across the screen's lifetime.
  const gateway = useMemo(() => createThemeGateway(), []);

  const report = useMemo(() => evaluatePaletteContrast(draft.palette), [draft.palette]);
  const floor = useMemo(() => evaluateEscapeFloor(draft.palette), [draft.palette]);
  const admission = useMemo(
    () => admitPalette(draft.palette, draft.acknowledgement),
    [draft.palette, draft.acknowledgement]
  );

  const blockedByFloor = !admission.ok && admission.reason === 'illegible';
  const needsAcknowledgement = !admission.ok && admission.reason === 'unacknowledged';
  const brokenColours = hasInvalidColours(draft);
  const canLeaveTheScreen = admission.ok && !brokenColours;

  const acknowledge = useCallback(
    (checked: boolean): void => {
      dispatch({
        type: 'acknowledge',
        acknowledgement:
          checked && !admission.ok && admission.reason === 'unacknowledged'
            ? admission.acknowledgement
            : null,
      });
    },
    [admission]
  );

  const applyAccent = useCallback((): void => {
    const normalised = normaliseColour(accentInput);
    if (!normalised.ok) {
      setAccentError('Type a colour like #3355cc or rgb(51, 85, 204).');
      return;
    }
    setAccentError(null);
    dispatch({ type: 'apply-accent', colour: normalised.hex });
    setStatus({
      tone: 'info',
      message:
        'Accent ramp derived. The shades were adjusted until the label on top clears 4.5:1, so the result may differ slightly from the colour you picked.',
    });
  }, [accentInput]);

  /**
   * Handles one import outcome, whichever route brought it.
   *
   * Shared by the Import button and by the theme the OS hands us on double-click, so the two
   * cannot drift into telling the user different things about the same file.
   */
  const receiveImport = useCallback((outcome: ThemeImportOutcome): void => {
    if (outcome.kind === 'cancelled') return;

    if (outcome.kind === 'unavailable') {
      setStatus({ tone: 'danger', message: THEME_FILES_UNAVAILABLE });
      return;
    }

    if (outcome.kind === 'failed') {
      setStatus({ tone: 'danger', message: 'That file could not be read.' });
      return;
    }

    if (outcome.kind === 'refused') {
      setStatus({
        tone: 'danger',
        // `message` is written by the main process from constants, field names and token
        // names — never from the file — so it is safe to show verbatim. See
        // `theme-projection.ts` for what that guarantee rests on.
        message:
          outcome.code === THEME_ERROR_CODES.illegible
            ? `${outcome.message} There is no way to override this one: a theme you cannot read is a theme you cannot undo.`
            : outcome.message,
      });
      return;
    }

    // Both `imported` and `needs-review` load. The second is a theme that fails AA but
    // clears the legibility floor, and loading it is the whole point — the report above
    // lists what is wrong and the gate below keeps it off the app until the user says so.
    dispatch({
      type: 'load',
      theme: outcome.theme,
      source: outcome.fileName,
      notices: outcome.notices,
    });

    if (outcome.kind === 'needs-review') {
      setStatus({
        tone: 'warning',
        message: `Imported “${outcome.theme.name}”, which fails some contrast checks. Review them below before using it.`,
      });
      return;
    }

    setStatus({
      tone: outcome.notices.length === 0 ? 'success' : 'warning',
      message:
        outcome.notices.length === 0
          ? `Imported “${outcome.theme.name}”.`
          : `Imported “${outcome.theme.name}” with ${outcome.notices.length} note${outcome.notices.length === 1 ? '' : 's'}.`,
    });
  }, []);

  const importTheme = useCallback(async (): Promise<void> => {
    receiveImport(await gateway.importTheme());
  }, [gateway, receiveImport]);

  /**
   * Collects a theme the OS handed the app, on mount and whenever one arrives.
   *
   * Both, because either alone loses a case: the event only fires while this screen is
   * mounted, and a poll only on mount would miss a file double-clicked while it is open.
   * `take` clears the slot on the main side, so the two cannot deliver the same file twice.
   */
  useEffect(() => {
    let cancelled = false;

    const collect = (): void => {
      void gateway.takeOpenedTheme().then((outcome) => {
        if (cancelled || outcome === null) return;
        receiveImport(outcome);
      });
    };

    collect();
    const unsubscribe = gateway.onFileOpened(collect);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [gateway, receiveImport]);

  const exportTheme = useCallback(async (): Promise<void> => {
    // The draft, not the palette: the main process re-validates and re-serialises it, so the
    // bytes that land in the user's file are ones Keyhold wrote. The acknowledgement travels
    // with it because a theme that fails AA is refused on the way out too — an export is how
    // a theme reaches somebody else, and it should not carry failures its author never saw.
    const outcome = await gateway.exportTheme(draftToKeepTheme(draft), draft.acknowledgement);

    if (outcome.kind === 'cancelled') return;

    if (outcome.kind === 'saved') {
      setStatus({ tone: 'success', message: `Exported as “${outcome.fileName}”.` });
      return;
    }

    setStatus({
      tone: 'danger',
      message:
        outcome.kind === 'unavailable'
          ? THEME_FILES_UNAVAILABLE
          : outcome.kind === 'failed'
            ? 'That theme could not be saved.'
            : outcome.message,
    });
  }, [gateway, draft]);

  const applyToApp = useCallback((): void => {
    const base = findTheme(draft.basedOn);
    // A custom palette takes its `color-scheme` from the named theme, not from itself
    // (`resolveAppearance`), so the pinned theme has to match the draft's scheme — otherwise
    // a light custom palette would render dark native controls.
    const themeId =
      base?.scheme === draft.scheme
        ? base.id
        : draft.scheme === 'dark'
          ? DEFAULT_DARK_THEME_ID
          : DEFAULT_LIGHT_THEME_ID;

    updateAppearance({
      customPalette: draft.palette,
      mode: 'fixed',
      themeId,
      // The draft already contains whatever accent the user derived. Leaving a stored
      // accent set would re-derive over the top of it on the next resolve.
      accentColour: null,
    });

    setStatus({
      tone: 'success',
      message: `“${draft.name}” applied.${admission.ok && admission.usedOverride ? ' It fails some contrast checks — Reset appearance in Settings puts it back.' : ''}`,
    });
  }, [admission, draft, updateAppearance]);

  return (
    <div className="kh-panel kh-studio">
      <header className="kh-panel__header">
        <h2 className="kh-panel__title">Theme studio</h2>
        <p className="kh-panel__subtitle">
          Every colour in Keyhold is one of the tokens below. Edit them, watch the preview, and read
          the contrast report — it grades the same pairs the built-in themes are held to.
        </p>
      </header>

      {/* ── Identity and starting point ─────────────────────────────────── */}
      <section className="kh-panel__section">
        <h3 className="kh-panel__heading">This theme</h3>

        <div className="kh-studio-identity">
          <label className="kh-studio-field">
            <span className="kh-studio-field__label">Name</span>
            <input
              type="text"
              className="kh-studio-field__input"
              value={draft.name}
              maxLength={80}
              onChange={(event) => {
                dispatch({ type: 'set-name', name: event.target.value });
              }}
            />
          </label>

          <label className="kh-studio-field">
            <span className="kh-studio-field__label">Description</span>
            <input
              type="text"
              className="kh-studio-field__input"
              value={draft.description}
              maxLength={240}
              onChange={(event) => {
                dispatch({ type: 'set-description', description: event.target.value });
              }}
            />
          </label>

          <div className="kh-studio-field">
            <span className="kh-studio-field__label" id="kh-studio-scheme-label">
              Scheme
            </span>
            <div className="kh-segmented" role="group" aria-labelledby="kh-studio-scheme-label">
              {(['light', 'dark'] as const).map((scheme) => (
                <button
                  key={scheme}
                  type="button"
                  className="kh-segmented__option"
                  aria-pressed={draft.scheme === scheme}
                  onClick={() => {
                    dispatch({ type: 'set-scheme', scheme });
                  }}
                >
                  {scheme}
                </button>
              ))}
            </div>
          </div>

          <label className="kh-studio-field">
            <span className="kh-studio-field__label">Start from a built-in</span>
            <select
              className="kh-studio-field__input"
              value=""
              onChange={(event) => {
                const definition = findTheme(event.target.value);
                if (definition === undefined) return;
                dispatch({
                  type: 'load',
                  theme: keepThemeFromDefinition(definition, `${definition.name} (copy)`),
                  source: definition.name,
                  notices: [],
                });
                setStatus({ tone: 'info', message: `Duplicated ${definition.name}.` });
              }}
            >
              <option value="">Duplicate a theme…</option>
              {THEMES.map((theme) => (
                <option key={theme.id} value={theme.id}>
                  {theme.name} ({theme.scheme})
                </option>
              ))}
            </select>
          </label>
        </div>

        {draft.source !== null && (
          <p className="kh-panel__hint">
            Based on <strong>{draft.source}</strong>. Any colour left out of an imported file is
            filled in from <code>{draft.basedOn}</code>.
          </p>
        )}

        {draft.notices.length > 0 && <ImportNotices notices={draft.notices} />}
      </section>

      {/* ── Derive from one accent ──────────────────────────────────────── */}
      <section className="kh-panel__section">
        <h3 className="kh-panel__heading">Derive from an accent</h3>
        <p className="kh-panel__hint">
          Rebuilds the six accent tokens from one colour, using the same derivation the accent
          picker uses — each shade is measured and nudged until its label clears 4.5:1 and it stays
          visible as a border. You may get a slightly different shade than you asked for; that is
          the guarantee working.
        </p>

        <div className="kh-studio-accent">
          <input
            type="text"
            className="kh-studio-field__input kh-studio-accent__input"
            placeholder="#3355cc"
            value={accentInput}
            aria-label="Accent colour"
            aria-invalid={accentError !== null || undefined}
            aria-describedby={accentError === null ? undefined : 'kh-studio-accent-error'}
            onChange={(event) => {
              setAccentInput(event.target.value);
              setAccentError(null);
            }}
          />
          <Button
            variant="secondary"
            onClick={() => {
              applyAccent();
            }}
          >
            Derive
          </Button>

          <div className="kh-accents" role="group" aria-label="Accent presets">
            {ACCENT_PRESETS.filter((preset) => preset.colour !== '').map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="kh-accents__swatch"
                aria-label={preset.name}
                title={preset.name}
                style={{ background: preset.colour, borderColor: preset.colour }}
                onClick={() => {
                  setAccentInput(preset.colour);
                  setAccentError(null);
                  dispatch({ type: 'apply-accent', colour: preset.colour });
                }}
              />
            ))}
          </div>
        </div>

        {accentError !== null && (
          <p className="kh-studio-token__error" id="kh-studio-accent-error" role="alert">
            {accentError}
          </p>
        )}
      </section>

      {/* ── Editor, preview and report ──────────────────────────────────── */}
      <div className="kh-studio-workspace">
        <section className="kh-panel__section" aria-labelledby="kh-studio-tokens-heading">
          <h3 className="kh-panel__heading" id="kh-studio-tokens-heading">
            Colours
          </h3>
          <TokenEditor draft={draft} dispatch={dispatch} />
        </section>

        <div className="kh-studio-column">
          <section className="kh-panel__section">
            <ThemePreview palette={draft.palette} scheme={draft.scheme} />
          </section>
          <section className="kh-panel__section">
            <ContrastReportPanel report={report} floor={floor} />
          </section>
        </div>
      </div>

      {/* ── The gate ────────────────────────────────────────────────────── */}
      <section className="kh-panel__section">
        <h3 className="kh-panel__heading">Use this theme</h3>

        {brokenColours && (
          <p className="kh-studio-gate kh-studio-gate--danger" role="alert">
            Some colours above could not be read. Fix them before applying or exporting.
          </p>
        )}

        {blockedByFloor && (
          <p className="kh-studio-gate kh-studio-gate--danger" role="alert">
            {/* `blockedByFloor` has already narrowed `admission` to the illegible case, so the
                message is the one naming the offending pairs. */}
            {admission.message} There is no way to override this one: a theme you cannot read is a
            theme you cannot undo.
          </p>
        )}

        {needsAcknowledgement && (
          <div className="kh-studio-gate kh-studio-gate--warning">
            <p>
              This theme fails <strong>{report.failures.length}</strong> of {report.findings.length}{' '}
              contrast checks, listed above. WCAG AA is a floor for most readers, not a rule about
              what is right for you — but it is your call to make with the failures in front of you,
              not a box the app ticks on your behalf.
            </p>
            <label className="kh-checkbox">
              <input
                type="checkbox"
                checked={draft.acknowledgement !== null}
                onChange={(event) => {
                  acknowledge(event.target.checked);
                }}
              />
              <span>
                Use it anyway
                <small>
                  Applies to these exact colours. Change any one of them and this resets, because
                  the failures will be different ones.
                </small>
              </span>
            </label>
          </div>
        )}

        {admission.ok && admission.usedOverride && (
          <p className="kh-studio-gate kh-studio-gate--warning">
            Accepted with {report.failures.length} contrast check
            {report.failures.length === 1 ? '' : 's'} failing. Exported files carry the same
            failures, and anyone importing this theme will be asked the same question.
          </p>
        )}

        <div className="kh-panel__footer">
          <Button
            variant="primary"
            disabled={!canLeaveTheScreen}
            onClick={() => {
              applyToApp();
            }}
          >
            Apply to Keyhold
          </Button>
          <Button
            variant="secondary"
            disabled={!canLeaveTheScreen || !gateway.available}
            onClick={() => {
              void exportTheme();
            }}
          >
            Export .keeptheme
          </Button>
          <Button
            variant="secondary"
            disabled={!gateway.available}
            onClick={() => {
              void importTheme();
            }}
          >
            Import .keeptheme
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              dispatch({ type: 'reset' });
              setStatus({ tone: 'info', message: 'Back to the theme this started from.' });
            }}
          >
            Reset
          </Button>
        </div>

        {!gateway.available && <p className="kh-panel__hint">{THEME_FILES_UNAVAILABLE}</p>}

        {/*
         * The one live region on the screen. Action outcomes are discrete and infrequent —
         * unlike the contrast summary, which recomputes on every frame of a colour drag and
         * would announce continuously if it were live.
         */}
        <p className="kh-panel__status" role="status">
          {status?.message ?? ''}
        </p>
      </section>
    </div>
  );
}

function noticeKey(notice: ThemeNotice): string {
  // Keyed off our own vocabulary rather than anything the file chose. `unknown-tokens` and
  // `unknown-base` occur at most once each — the projection collapses them — so their kind
  // alone is unique.
  return notice.kind === 'missing-token' ? `missing:${notice.token}` : notice.kind;
}

function ImportNotices({
  notices,
}: {
  readonly notices: readonly ThemeNotice[];
}): React.JSX.Element {
  return (
    <details className="kh-studio-notices">
      <summary>
        {notices.length} note{notices.length === 1 ? '' : 's'} from the imported file
      </summary>
      <ul>
        {notices.map((notice) => (
          <li key={noticeKey(notice)}>{notice.message}</li>
        ))}
      </ul>
    </details>
  );
}
