// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useMemo, useReducer, useState } from 'react';
import {
  admitPalette,
  evaluateEscapeFloor,
  evaluatePaletteContrast,
  keepThemeFromDefinition,
  normaliseColour,
  parseKeepTheme,
  serialiseKeepTheme,
  suggestKeepThemeFileName,
  type KeepThemeWarning,
} from '@shared/theme/keeptheme.js';
import { ACCENT_PRESETS } from '@shared/theme/accent.js';
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
import { createThemeFileBridge } from './theme-file-bridge.js';
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
 */

interface StudioStatus {
  readonly tone: 'info' | 'warning' | 'danger' | 'success';
  readonly message: string;
}

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

  // Created once. A new bridge per render would be harmless but pointless, and this way the
  // "which transport am I on" line below is stable.
  const bridge = useMemo(() => createThemeFileBridge(), []);

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

  const importTheme = useCallback(async (): Promise<void> => {
    const opened = await bridge.openTheme();

    if (opened.kind === 'cancelled') return;
    if (opened.kind === 'too-large') {
      setStatus({ tone: 'danger', message: `“${opened.name}” is too large to be a theme file.` });
      return;
    }
    if (opened.kind === 'failed') {
      setStatus({ tone: 'danger', message: 'That file could not be read.' });
      return;
    }

    const result = parseKeepTheme(opened.file.contents);

    if (result.ok) {
      dispatch({
        type: 'load',
        theme: result.theme,
        source: opened.file.name,
        notices: result.warnings,
      });
      setStatus({
        tone: result.warnings.length === 0 ? 'success' : 'warning',
        message:
          result.warnings.length === 0
            ? `Imported “${result.theme.name}”.`
            : `Imported “${result.theme.name}” with ${result.warnings.length} note${result.warnings.length === 1 ? '' : 's'}.`,
      });
      return;
    }

    if (result.rejection.kind === 'contrast') {
      // Loaded rather than discarded: the whole point is to show the user what is wrong
      // with it. The gate below still blocks applying or exporting it until they say so.
      dispatch({
        type: 'load',
        theme: result.rejection.theme,
        source: opened.file.name,
        notices: result.rejection.warnings,
      });
      setStatus({ tone: 'warning', message: result.rejection.message });
      return;
    }

    setStatus({ tone: 'danger', message: result.rejection.message });
  }, [bridge]);

  const exportTheme = useCallback(async (): Promise<void> => {
    const theme = draftToKeepTheme(draft);
    const outcome = await bridge.saveTheme(
      suggestKeepThemeFileName(theme.name),
      serialiseKeepTheme(theme)
    );

    if (outcome === 'saved') {
      setStatus({ tone: 'success', message: `Exported “${theme.name}”.` });
    } else if (outcome === 'failed') {
      setStatus({ tone: 'danger', message: 'That theme could not be saved.' });
    }
  }, [bridge, draft]);

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
            disabled={!canLeaveTheScreen}
            onClick={() => {
              void exportTheme();
            }}
          >
            Export .keeptheme
          </Button>
          <Button
            variant="secondary"
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

function ImportNotices({
  notices,
}: {
  readonly notices: readonly KeepThemeWarning[];
}): React.JSX.Element {
  return (
    <details className="kh-studio-notices">
      <summary>
        {notices.length} note{notices.length === 1 ? '' : 's'} from the imported file
      </summary>
      <ul>
        {notices.map((notice) => (
          <li
            key={`${notice.kind}:${notice.kind === 'unknown-base' ? notice.requested : notice.token}`}
          >
            {notice.message}
          </li>
        ))}
      </ul>
    </details>
  );
}
