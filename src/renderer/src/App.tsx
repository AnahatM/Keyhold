// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import { DENSITIES, FONT_FAMILIES, FONT_SCALES } from '@shared/theme/appearance.js';
import { ACCENT_PRESETS } from '@shared/theme/accent.js';
import { THEMES } from '@shared/theme/themes.js';
import { Badge, EmptyState } from './components/Feedback.js';
import { Button } from './components/Button.js';
import { AppShell } from './shell/AppShell.js';
import { useAppearance } from './theme/appearance-store.js';
import './App.css';

/**
 * Phase 3 shell.
 *
 * The vault UI arrives in Phases 4–5; what this renders today is the three-pane layout
 * with a working appearance panel, which is deliberately the first real screen. Building
 * the theme controls before the features they colour is what forces every later component
 * to be token-driven from the start — retrofitting theming onto a finished UI is how
 * hardcoded colours get everywhere.
 */
export function App(): React.JSX.Element {
  const { settings, resolved, update, reset } = useAppearance();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [version, setVersion] = useState('…');
  const [bridgeOk, setBridgeOk] = useState<boolean | null>(null);

  useEffect(() => {
    void window.keyhold.app
      .getVersion()
      .then((value) => {
        setVersion(value);
        setBridgeOk(true);
      })
      .catch(() => {
        setBridgeOk(false);
      });
  }, []);

  return (
    <AppShell
      sidebarCollapsed={sidebarCollapsed}
      onSidebarCollapsedChange={setSidebarCollapsed}
      sidebar={
        <div className="kh-sidebar">
          <header className="kh-sidebar__header">
            <span className="kh-sidebar__mark" aria-hidden="true">
              🔐
            </span>
            <div>
              <div className="kh-sidebar__name">Keyhold</div>
              <div className="kh-sidebar__version">v{version}</div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              iconOnlyLabel="Collapse the sidebar"
              onClick={() => {
                setSidebarCollapsed(true);
              }}
            >
              ‹
            </Button>
          </header>

          <nav className="kh-sidebar__nav">
            <div className="kh-sidebar__group">Vault</div>
            {[
              { label: 'All items', count: 0 },
              { label: 'Favourites', count: 0 },
              { label: 'Trash', count: 0 },
            ].map((item) => (
              <button key={item.label} type="button" className="kh-sidebar__item" disabled>
                <span>{item.label}</span>
                <span className="kh-sidebar__count">{item.count}</span>
              </button>
            ))}
            <p className="kh-sidebar__note">Folders and tags arrive in Phase 7.</p>
          </nav>
        </div>
      }
      list={
        <div className="kh-list">
          <header className="kh-list__header">
            <h1 className="kh-list__title">Credentials</h1>
            <Badge tone="info" symbol="●">
              Phase 3
            </Badge>
          </header>
          <EmptyState
            icon="🗝"
            title="No vault open yet"
            description="Creating and unlocking vaults arrives in Phase 4. The crypto and storage underneath are already built and tested."
          />
        </div>
      }
      detail={
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
                  Always on if your system asks for it — this can only add restraint, never remove
                  it.
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
              Secrets always use a monospace face, whatever the body font is set to —<code> l</code>
              , <code>1</code>, <code>I</code>, <code>0</code> and <code>O</code> have to stay
              distinguishable when someone retypes a password by eye.
            </p>
          </section>

          <footer className="kh-panel__footer">
            <Button variant="secondary" onClick={reset}>
              Reset appearance
            </Button>
            <span className="kh-panel__status">
              {resolved.theme.name} · {resolved.scheme} · bridge{' '}
              {bridgeOk === null ? 'checking' : bridgeOk ? 'connected' : 'unavailable'}
            </span>
          </footer>
        </div>
      }
    />
  );
}
