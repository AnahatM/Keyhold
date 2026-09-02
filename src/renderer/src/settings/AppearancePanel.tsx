// SPDX-License-Identifier: GPL-3.0-or-later
import { ACCENT_PRESETS } from '@shared/theme/accent.js';
import { DENSITIES, FONT_FAMILIES, FONT_SCALES } from '@shared/theme/appearance.js';
import { THEMES } from '@shared/theme/themes.js';
import { Badge } from '../components/Feedback.js';
import { Button } from '../components/Button.js';
import { useAppearance } from '../theme/appearance-store.js';

/**
 * The appearance settings panel.
 *
 * Built before the features it colours, deliberately: having the theme controls in place
 * from the start is what forces every later component to be token-driven. Retrofitting
 * theming onto a finished UI is how hardcoded colours get everywhere.
 *
 * Extracted from `App` in Phase 4 so the root could become a plain screen router. It moves
 * into the full Settings surface in Phase 14 unchanged.
 */
export function AppearancePanel(): React.JSX.Element {
  const { settings, resolved, update, reset } = useAppearance();

  return (
    <div className="kh-panel">
      <header className="kh-panel__header">
        <h2 className="kh-panel__title">Appearance</h2>
        <p className="kh-panel__subtitle">
          Every colour in Keyhold is a token, and every theme is contrast-checked to WCAG AA
          automatically. Nothing here can produce an unreadable interface.
        </p>
      </header>

      <section className="kh-panel__section">
        <h3 className="kh-panel__heading">Theme</h3>

        <div className="kh-segmented" role="group" aria-label="Theme mode">
          {(
            [
              ['system', 'Follow system'],
              ['light', 'Light'],
              ['dark', 'Dark'],
              ['fixed', 'Always this one'],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              className="kh-segmented__option"
              aria-pressed={settings.mode === mode}
              onClick={() => {
                update({ mode });
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="kh-theme-grid">
          {THEMES.map((theme) => {
            const selected =
              settings.mode === 'fixed'
                ? settings.themeId === theme.id
                : theme.scheme === 'light'
                  ? settings.lightThemeId === theme.id
                  : settings.darkThemeId === theme.id;

            return (
              <button
                key={theme.id}
                type="button"
                className="kh-theme-card"
                aria-pressed={selected}
                title={theme.description}
                onClick={() => {
                  update(
                    settings.mode === 'fixed'
                      ? { themeId: theme.id }
                      : theme.scheme === 'light'
                        ? { lightThemeId: theme.id }
                        : { darkThemeId: theme.id }
                  );
                }}
              >
                <span
                  className="kh-theme-card__swatch"
                  aria-hidden="true"
                  style={{ background: theme.palette.bg }}
                >
                  <i style={{ background: theme.palette.accent }} />
                  <i style={{ background: theme.palette.text }} />
                  <i style={{ background: theme.palette.success }} />
                  <i style={{ background: theme.palette.danger }} />
                </span>
                <span className="kh-theme-card__name">{theme.name}</span>
                <span className="kh-theme-card__scheme">{theme.scheme}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="kh-panel__section">
        <h3 className="kh-panel__heading">Accent</h3>
        <p className="kh-panel__hint">
          Pick any colour. The shades around it are derived and adjusted until the text on top
          clears 4.5:1 — so an unfortunate choice changes the shade, never the readability.
        </p>
        <div className="kh-accents" role="group" aria-label="Accent colour">
          {ACCENT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="kh-accents__swatch"
              aria-label={preset.name}
              aria-pressed={(settings.accentColour ?? '') === preset.colour}
              title={preset.name}
              style={
                preset.colour === ''
                  ? undefined
                  : { background: preset.colour, borderColor: preset.colour }
              }
              onClick={() => {
                update({ accentColour: preset.colour === '' ? null : preset.colour });
              }}
            >
              {preset.colour === '' ? '⟲' : ''}
            </button>
          ))}
        </div>
      </section>

      <section className="kh-panel__section">
        <h3 className="kh-panel__heading">Density &amp; type</h3>

        <div className="kh-control-row">
          <span className="kh-control-row__label" id="kh-density-label">
            Density
          </span>
          <div className="kh-segmented" role="group" aria-labelledby="kh-density-label">
            {DENSITIES.map((density) => (
              <button
                key={density}
                type="button"
                className="kh-segmented__option"
                aria-pressed={settings.density === density}
                onClick={() => {
                  update({ density });
                }}
              >
                {density}
              </button>
            ))}
          </div>
        </div>

        <div className="kh-control-row">
          <span className="kh-control-row__label" id="kh-scale-label">
            Text size
          </span>
          <div className="kh-segmented" role="group" aria-labelledby="kh-scale-label">
            {FONT_SCALES.map((scale) => (
              <button
                key={scale}
                type="button"
                className="kh-segmented__option"
                aria-pressed={settings.fontScale === scale}
                onClick={() => {
                  update({ fontScale: scale });
                }}
              >
                {Math.round(scale * 100)}%
              </button>
            ))}
          </div>
        </div>

        <div className="kh-control-row">
          <span className="kh-control-row__label" id="kh-font-label">
            Font
          </span>
          <div className="kh-segmented" role="group" aria-labelledby="kh-font-label">
            {FONT_FAMILIES.map((family) => (
              <button
                key={family}
                type="button"
                className="kh-segmented__option"
                aria-pressed={settings.fontFamily === family}
                onClick={() => {
                  update({ fontFamily: family });
                }}
              >
                {family}
              </button>
            ))}
          </div>
        </div>

        <label className="kh-checkbox">
          <input
            type="checkbox"
            checked={settings.reduceMotion}
            onChange={(event) => {
              update({ reduceMotion: event.target.checked });
            }}
          />
          <span>
            Reduce motion
            <small>
              Always on if your system asks for it — this can only add restraint, never remove it.
            </small>
          </span>
        </label>
      </section>

      <section className="kh-panel__section">
        <h3 className="kh-panel__heading">Sample</h3>
        <div className="kh-sample">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Delete</Button>
          <Badge tone="success" symbol="✓">
            Strong
          </Badge>
          <Badge tone="warning" symbol="!">
            Reused
          </Badge>
          <Badge tone="danger" symbol="✕">
            Breached
          </Badge>
          <code className="kh-secret kh-sample__secret">Il1O0 ·-· gT8B</code>
        </div>
        <p className="kh-panel__hint">
          Secrets always use a monospace face, whatever the body font is set to —<code> l</code>,{' '}
          <code>1</code>, <code>I</code>, <code>0</code> and <code>O</code> have to stay
          distinguishable when someone retypes a password by eye.
        </p>
      </section>

      <footer className="kh-panel__footer">
        <Button variant="secondary" onClick={reset}>
          Reset appearance
        </Button>
        <span className="kh-panel__status">
          {resolved.theme.name} · {resolved.scheme}
        </span>
      </footer>
    </div>
  );
}
