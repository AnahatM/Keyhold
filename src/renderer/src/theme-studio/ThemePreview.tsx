// SPDX-License-Identifier: GPL-3.0-or-later
import { useMemo } from 'react';
import { COLOUR_TOKENS, type Palette } from '@shared/theme/tokens.js';
import { Badge, EmptyState } from '../components/Feedback.js';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

/**
 * A live preview built from the real components, not from mock rectangles.
 *
 * ## Why the preview is scoped rather than applied
 *
 * The draft palette is written as `--kh-color-*` custom properties on **this subtree only**,
 * never on `documentElement`. Two things follow, and both matter:
 *
 *  - The studio itself stays readable while you edit a theme that is not. If previewing
 *    re-themed the whole window, the moment you dragged `text` toward `bg` you would lose
 *    the contrast report, the undo button and the way out — which is precisely the trap
 *    the legibility floor exists to prevent, reintroduced as a UI behaviour.
 *  - Nothing is committed by looking. Applying is a separate, gated action.
 *
 * Custom properties inherit, so every child — including components that know nothing about
 * this screen — picks up the draft automatically. That is the whole benefit of the tokens
 * living on `:root` in the first place.
 */

export interface ThemePreviewProps {
  readonly palette: Palette;
  readonly scheme: 'light' | 'dark';
}

function previewVariables(palette: Palette, scheme: 'light' | 'dark'): React.CSSProperties {
  const style: Record<string, string> = {};
  for (const token of COLOUR_TOKENS) style[`--kh-color-${token}`] = palette[token];
  // Set alongside the colours for the same reason `appearance-store.ts` sets it globally:
  // without it the preview renders a white native caret and scrollbar on a dark palette.
  style.colorScheme = scheme;
  return style;
}

export function ThemePreview({ palette, scheme }: ThemePreviewProps): React.JSX.Element {
  const style = useMemo(() => previewVariables(palette, scheme), [palette, scheme]);

  return (
    <section aria-labelledby="kh-studio-preview-heading">
      <h3 className="kh-panel__heading" id="kh-studio-preview-heading">
        Preview
      </h3>
      <p className="kh-panel__hint">
        Real components, drawn with the draft palette. Nothing here changes the app until you apply
        it.
      </p>

      <div className="kh-studio-preview" style={style}>
        <div className="kh-studio-preview__chrome">
          <div className="kh-studio-preview__sidebar">
            <span className="kh-studio-preview__brand">Keyhold</span>
            <span className="kh-studio-preview__nav kh-studio-preview__nav--selected">
              All items
            </span>
            <span className="kh-studio-preview__nav">Favourites</span>
            <span className="kh-studio-preview__nav">Trash</span>
          </div>

          <div className="kh-studio-preview__list">
            <div className="kh-studio-preview__row kh-studio-preview__row--selected">
              <span className="kh-studio-preview__title">Bank</span>
              <span className="kh-studio-preview__meta">you@example.com</span>
            </div>
            <div className="kh-studio-preview__row kh-studio-preview__row--hover">
              <span className="kh-studio-preview__title">Email</span>
              <span className="kh-studio-preview__meta">Updated yesterday</span>
            </div>
            <div className="kh-studio-preview__row">
              <span className="kh-studio-preview__title">Router</span>
              <span className="kh-studio-preview__meta">admin</span>
            </div>
          </div>

          <div className="kh-studio-preview__detail">
            <Input
              label="Username"
              defaultValue="you@example.com"
              readOnly
              hint="Shown so the sunken surface and the subtle text are both on screen."
            />
            <Input
              label="Password"
              defaultValue="Il1O0 ·-· gT8B"
              readOnly
              secret
              error="This password appears in a known breach."
            />

            <div className="kh-studio-preview__buttons">
              <Button variant="primary">Save</Button>
              <Button variant="secondary">Copy</Button>
              <Button variant="ghost">Cancel</Button>
              <Button variant="danger">Delete</Button>
            </div>

            <div className="kh-studio-preview__badges">
              <Badge tone="success" symbol="check">
                Strong
              </Badge>
              <Badge tone="warning" symbol="warning">
                Reused
              </Badge>
              <Badge tone="danger" symbol="close">
                Breached
              </Badge>
              <Badge tone="info" symbol="info">
                Expiring
              </Badge>
            </div>

            {/* Every status tint with its own text on top — the pairs the report grades. */}
            <p className="kh-studio-preview__note kh-studio-preview__note--success">Vault saved.</p>
            <p className="kh-studio-preview__note kh-studio-preview__note--warning">
              3 passwords are older than a year.
            </p>
            <p className="kh-studio-preview__note kh-studio-preview__note--danger">
              That password was wrong.
            </p>
            <p className="kh-studio-preview__note kh-studio-preview__note--info">
              Unlocking takes a moment by design.
            </p>

            <div className="kh-studio-preview__card">
              <EmptyState
                title="Nothing here yet"
                description="Raised surfaces, muted text, and the card border, all at once."
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
