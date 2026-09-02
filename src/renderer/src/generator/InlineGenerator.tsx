// SPDX-License-Identifier: GPL-3.0-or-later
import { useId, useState } from 'react';
import { Button } from '../components/Button.js';
import { GeneratorPanel } from './GeneratorPanel.js';

/**
 * The generator, folded into a form beside a password field.
 *
 * A disclosure rather than a dialog: a modal over a half-filled credential form steals
 * focus, hides the field the result is going into, and has to be dismissed before the user
 * can check the result landed. Opening in place keeps the field visible.
 *
 * It is closed by default and **generates nothing until it is opened**, so simply editing a
 * record never produces a password nobody asked for.
 *
 * Choosing a password hands it to `onUse` and collapses — the panel's session history goes
 * with it, which is the intended lifetime: the moment the value is in the form, this
 * component has no further reason to be holding a list of secrets.
 */

export interface InlineGeneratorProps {
  /** Receives the chosen password. The caller decides what to do with it. */
  readonly onUse: (secret: string) => void;
  /** The button that opens the panel. */
  readonly openLabel?: string;
  readonly useLabel?: string;
}

export function InlineGenerator({
  onUse,
  openLabel = 'Generate a password',
  useLabel = 'Use this password',
}: InlineGeneratorProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="kh-gen-inline">
      <Button
        variant="secondary"
        size="sm"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        {open ? 'Close the generator' : openLabel}
      </Button>

      {/*
       * Unmounted rather than hidden when closed. Hiding it would keep the panel's session
       * history — a list of generated passwords — alive in memory behind a `display: none`,
       * which is exactly the lifetime this design is trying not to have.
       */}
      {open && (
        <div className="kh-gen-inline__panel" id={panelId}>
          <GeneratorPanel
            useLabel={useLabel}
            onUse={(secret) => {
              onUse(secret);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
