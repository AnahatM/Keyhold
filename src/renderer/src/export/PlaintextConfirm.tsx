// SPDX-License-Identifier: GPL-3.0-or-later

import { useState } from 'react';
import type { ExportLoss } from '@shared/model/export.js';
import {
  matchesPlaintextConfirmation,
  PLAINTEXT_CONFIRMATION_PHRASE,
} from '@shared/model/export-plan.js';
import { Input } from '../components/Input.js';
import { LossList } from './LossList.js';
import './export.css';

/**
 * The gate in front of a readable copy of someone's entire vault.
 *
 * ## Why this is typing and not a button
 *
 * Clicking "Export" and clicking "Cancel" are the same physical gesture aimed at different
 * pixels, and by the third dialog of the day nobody is reading either. This is the one
 * operation in Keyhold that converts an encrypted vault into a file anyone who finds it can
 * read, so it asks for the one thing a reflex cannot supply: a phrase that has to be read
 * before it can be typed. The phrase names the consequence — `EXPORT UNENCRYPTED` — rather
 * than the action, because "EXPORT" would be typed automatically by anyone who has met a
 * confirm box before.
 *
 * Matching is deliberately case- and whitespace-forgiving (see
 * `matchesPlaintextConfirmation`). The measure is here to prove deliberateness, not typing
 * accuracy, and rejecting `export unencrypted` would add nothing but resentment.
 *
 * ## Accessibility
 *
 * The warning is `role="alert"`, and it earns it: this step is mounted the moment the user
 * asks to continue, so the warning is *inserted* into the document and is therefore
 * announced at the moment the decision is being made — not merely painted red and left for
 * someone to find. The field has a real `<label>`, and its error is a `role="alert"`
 * paragraph wired through `aria-describedby` by `Input`, so a mismatch is spoken rather
 * than shown as a red outline.
 *
 * The error appears only after the field has been left, not on every keystroke: an error
 * that shouts "wrong" at the first letter of a phrase somebody is halfway through typing is
 * noise, and noise is what teaches people to ignore this exact control.
 */
export interface PlaintextConfirmProps {
  readonly warning: string;
  readonly typed: string;
  readonly losses: readonly ExportLoss[];
  readonly onChange: (typed: string) => void;
}

export function PlaintextConfirm({
  warning,
  typed,
  losses,
  onChange,
}: PlaintextConfirmProps): React.JSX.Element {
  const [visited, setVisited] = useState(false);
  const matches = matchesPlaintextConfirmation(typed);
  const showError = visited && typed !== '' && !matches;

  return (
    <div className="kh-export-confirm">
      <div className="kh-export-danger" role="alert">
        <p className="kh-export-danger__title">
          <span className="kh-export-danger__symbol" aria-hidden="true">
            ⚠
          </span>
          This file will not be encrypted.
        </p>
        {/* The engine's own sentence, not a paraphrase. It is a constant precisely so that a
            second caller cannot soften it, and rewording it here would be that second
            caller. */}
        <p className="kh-export-danger__body">{warning}</p>
      </div>

      <section className="kh-export-section">
        <h4 className="kh-export-section__heading">What this file will not carry</h4>
        <LossList
          losses={losses}
          emptyNote="Nothing is left out. Every field, every version and every origin is written to this file — in readable text."
        />
      </section>

      <Input
        label={`Type ${PLAINTEXT_CONFIRMATION_PHRASE} to confirm`}
        // Stated rather than left to default, so the field is unambiguously a text box in
        // the DOM as well as in the renderer — and so it is never mistaken for a password
        // field by a password manager looking at this window.
        type="text"
        value={typed}
        autoComplete="off"
        spellCheck={false}
        onBlur={() => {
          setVisited(true);
        }}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        hint="Capitals and extra spaces do not matter. The words do."
        {...(showError
          ? { error: `That is not the phrase. Type ${PLAINTEXT_CONFIRMATION_PHRASE}.` }
          : {})}
      />
    </div>
  );
}
