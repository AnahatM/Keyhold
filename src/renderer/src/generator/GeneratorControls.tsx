// SPDX-License-Identifier: GPL-3.0-or-later
import { useId } from 'react';
import { Input } from '../components/Input.js';
import { GeneratorSlider } from './GeneratorSlider.js';
import {
  CAPITALISATION_LABELS,
  CAPITALISATIONS,
  MODE_DETAILS,
  limitForMode,
  type GeneratorDraft,
} from './generator-options.js';
import type { GeneratorLimitsView } from '@shared/ipc/api.js';

/**
 * The per-mode settings.
 *
 * Presentational and prop-driven on purpose: it owns no state, fetches nothing, and every
 * bound it renders was handed to it. That keeps the one rule that matters here impossible
 * to break by accident — no control in this file can offer a value the engine would refuse
 * for being out of range, because no control in this file knows a range it was not given.
 *
 * Each toggle is a real `<input type="checkbox">` inside its label, so the whole row is a
 * click target and the label is the accessible name without an `aria-label` to keep in
 * sync with it.
 */

export interface GeneratorControlsProps {
  readonly draft: GeneratorDraft;
  readonly limits: GeneratorLimitsView['limits'];
  readonly onRandomChange: (changes: Partial<GeneratorDraft['random']>) => void;
  readonly onPassphraseChange: (changes: Partial<GeneratorDraft['passphrase']>) => void;
  readonly onPronounceableChange: (changes: Partial<GeneratorDraft['pronounceable']>) => void;
  readonly onPinChange: (changes: Partial<GeneratorDraft['pin']>) => void;
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <label className="kh-checkbox">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span>
        {label}
        {hint !== undefined && <small>{hint}</small>}
      </span>
    </label>
  );
}

export function GeneratorControls({
  draft,
  limits,
  onRandomChange,
  onPassphraseChange,
  onPronounceableChange,
  onPinChange,
}: GeneratorControlsProps): React.JSX.Element {
  // A generated id: two panels can be on screen at once, and duplicate ids silently break
  // whichever `aria-labelledby` resolves second.
  const capitalisationLabelId = useId();
  const detail = MODE_DETAILS[draft.mode];
  const range = limitForMode(draft.mode, limits);

  switch (draft.mode) {
    case 'random':
      return (
        <div className="kh-gen-controls">
          <GeneratorSlider
            label="Length"
            unit={detail.unit}
            value={draft.random.length}
            range={range}
            onChange={(length) => {
              onRandomChange({ length });
            }}
          />

          <fieldset className="kh-gen-controls__classes">
            <legend className="kh-gen-controls__legend">Characters to draw from</legend>
            <Toggle
              label="Lowercase (a–z)"
              checked={draft.random.lowercase}
              onChange={(lowercase) => {
                onRandomChange({ lowercase });
              }}
            />
            <Toggle
              label="Uppercase (A–Z)"
              checked={draft.random.uppercase}
              onChange={(uppercase) => {
                onRandomChange({ uppercase });
              }}
            />
            <Toggle
              label="Digits (0–9)"
              checked={draft.random.digits}
              onChange={(digits) => {
                onRandomChange({ digits });
              }}
            />
            <Toggle
              label="Symbols"
              hint="Excludes the space, backslash, backtick and both quotes — the five that get eaten by shells, mangled by CSV exports and rejected by login forms."
              checked={draft.random.symbols}
              onChange={(symbols) => {
                onRandomChange({ symbols });
              }}
            />
          </fieldset>

          <Toggle
            label="Require one of each enabled kind"
            hint="Guarantees every class appears. It narrows the search space slightly, and the figure above already charges for that."
            checked={draft.random.requireEachClass}
            onChange={(requireEachClass) => {
              onRandomChange({ requireEachClass });
            }}
          />
          <Toggle
            label="Leave out look-alike characters"
            hint="Drops I l 1 | O 0 o — the ones misread off a screen or a printed recovery sheet. A real cost in entropy, and it is priced in above."
            checked={draft.random.excludeAmbiguous}
            onChange={(excludeAmbiguous) => {
              onRandomChange({ excludeAmbiguous });
            }}
          />

          <Input
            label="Also leave out these characters"
            value={draft.random.excludeCharacters}
            autoComplete="off"
            spellCheck={false}
            placeholder="For a site that rejects certain symbols"
            hint="Applied to the alphabet before anything is drawn, so the length you asked for is the length you get."
            onChange={(event) => {
              onRandomChange({ excludeCharacters: event.target.value });
            }}
          />
        </div>
      );

    case 'passphrase':
      return (
        <div className="kh-gen-controls">
          <GeneratorSlider
            label="Words"
            unit={detail.unit}
            value={draft.passphrase.wordCount}
            range={range}
            onChange={(wordCount) => {
              onPassphraseChange({ wordCount });
            }}
          />

          <Input
            label="Separator"
            value={draft.passphrase.separator}
            autoComplete="off"
            spellCheck={false}
            hint="Goes between the words. Leave it empty to run them together."
            onChange={(event) => {
              onPassphraseChange({ separator: event.target.value });
            }}
          />

          <div className="kh-control-row">
            <span className="kh-control-row__label" id={capitalisationLabelId}>
              Casing
            </span>
            <div className="kh-segmented" role="group" aria-labelledby={capitalisationLabelId}>
              {CAPITALISATIONS.map((capitalisation) => (
                <button
                  key={capitalisation}
                  type="button"
                  className="kh-segmented__option"
                  aria-pressed={draft.passphrase.capitalisation === capitalisation}
                  onClick={() => {
                    onPassphraseChange({ capitalisation });
                  }}
                >
                  {CAPITALISATION_LABELS[capitalisation]}
                </button>
              ))}
            </div>
          </div>

          <Toggle
            label="Add a digit to one word"
            hint="For the site that insists on a number. Worth a few bits, because both the digit and which word it lands on are chosen at random."
            checked={draft.passphrase.includeDigit}
            onChange={(includeDigit) => {
              onPassphraseChange({ includeDigit });
            }}
          />
        </div>
      );

    case 'pronounceable':
      return (
        <div className="kh-gen-controls">
          <GeneratorSlider
            label="Length"
            unit={detail.unit}
            value={draft.pronounceable.length}
            range={range}
            onChange={(length) => {
              onPronounceableChange({ length });
            }}
          />
          <Toggle
            label="Append two digits"
            hint="At a fixed position, so they are easy to remember and worth no positional entropy. Counted honestly above."
            checked={draft.pronounceable.digits}
            onChange={(digits) => {
              onPronounceableChange({ digits });
            }}
          />
          <Toggle
            label="Append a symbol"
            checked={draft.pronounceable.symbols}
            onChange={(symbols) => {
              onPronounceableChange({ symbols });
            }}
          />
        </div>
      );

    case 'pin':
      return (
        <div className="kh-gen-controls">
          <GeneratorSlider
            label="Digits"
            unit={detail.unit}
            value={draft.pin.length}
            range={range}
            onChange={(length) => {
              onPinChange({ length });
            }}
          />
        </div>
      );
  }
}
