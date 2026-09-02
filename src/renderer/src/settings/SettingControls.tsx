// SPDX-License-Identifier: GPL-3.0-or-later
import { useId, type ReactNode } from 'react';
import { SETTING_SCOPE, type SettingId, type SettingsScope } from '@shared/model/settings-plan.js';
import { SCOPE_LABELS, SCOPE_NOTES, SETTING_COPY, type Choice } from './settings-copy.js';
import './settings.css';

/**
 * The primitives every settings control is built from.
 *
 * One file rather than six, following `Feedback.tsx`: these are a single cohesive set that
 * is always used together, and splitting them would mean six imports at every call site
 * for no gain in clarity.
 *
 * The reason they exist at all is that three things must be true of *every* control on this
 * screen, and "remember to do it" is not a mechanism:
 *
 * 1. **A real `<label>`, associated by id.** Not a `<div>` next to the input, not a
 *    placeholder. A control whose name is only visual is unusable with a screen reader.
 * 2. **Help text wired up with `aria-describedby`.** The explanation of what a setting
 *    costs is worthless if it is announced to nobody.
 * 3. **Its scope, in words.** Whether a setting stays on this machine or rides inside the
 *    vault file is read straight out of `SETTING_SCOPE`, so it cannot be omitted or get out
 *    of step with where the value is actually stored.
 *
 * Colour is never the only carrier of anything here: the scope badge says "This computer"
 * or "Travels with the vault", and a trade-off note is prefixed with the word "Trade-off"
 * as well as a symbol.
 */

// ── Scope ────────────────────────────────────────────────────────────────────

export function ScopeBadge({ scope }: { readonly scope: SettingsScope }): React.JSX.Element {
  return (
    <span className={`kh-scope kh-scope--${scope}`} title={SCOPE_NOTES[scope]}>
      <span className="kh-scope__mark" aria-hidden="true">
        {scope === 'vault' ? '🔒' : '🖥'}
      </span>
      {SCOPE_LABELS[scope]}
    </span>
  );
}

// ── Trade-off ────────────────────────────────────────────────────────────────

export interface TradeOffNoteProps {
  readonly id: string;
  readonly text: string;
  /** False renders the sentence in plain type; true marks it as currently in effect. */
  readonly active: boolean;
}

/**
 * What a choice costs, in one sentence, beside the control.
 *
 * Rendered whether or not the looser option is currently chosen — someone deciding needs to
 * know the cost *before* they choose — but marked as in effect only when it actually is.
 * A warning that is always shouting is one nobody reads.
 */
export function TradeOffNote({ id, text, active }: TradeOffNoteProps): React.JSX.Element {
  return (
    <p id={id} className={`kh-tradeoff${active ? ' kh-tradeoff--active' : ''}`}>
      <span className="kh-tradeoff__symbol" aria-hidden="true">
        {active ? '⚠' : 'ⓘ'}
      </span>
      <span className="kh-tradeoff__label">{active ? 'In effect:' : 'Trade-off:'}</span> {text}
    </p>
  );
}

// ── The row ──────────────────────────────────────────────────────────────────

export interface SettingRowProps {
  readonly settingId: SettingId;
  /** Overrides the registry label, for the rare control that needs a different heading. */
  readonly label?: string;
  readonly controlId: string;
  readonly helpId: string;
  readonly tradeOffId: string;
  readonly tradeOffActive: boolean;
  /** Rendered under the help text — a live value, a preview, a button. */
  readonly detail?: ReactNode;
  readonly children: ReactNode;
}

/**
 * Label, control, help and scope, in the one arrangement every setting uses.
 *
 * The ids are passed in rather than generated here because the *control* has to own them —
 * a `useId` inside this component could not be attached to a `<select>` rendered by the
 * caller.
 */
export function SettingRow({
  settingId,
  label,
  controlId,
  helpId,
  tradeOffId,
  tradeOffActive,
  detail,
  children,
}: SettingRowProps): React.JSX.Element {
  const copy = SETTING_COPY[settingId];
  const scope = SETTING_SCOPE[settingId];

  return (
    <div className="kh-setting">
      <div className="kh-setting__head">
        <label className="kh-setting__label" htmlFor={controlId}>
          {label ?? copy.label}
        </label>
        <ScopeBadge scope={scope} />
      </div>

      <div className="kh-setting__control">{children}</div>

      <p id={helpId} className="kh-setting__help">
        {copy.help}
      </p>

      {copy.tradeOff !== null && (
        <TradeOffNote id={tradeOffId} text={copy.tradeOff} active={tradeOffActive} />
      )}

      {detail !== undefined && <div className="kh-setting__detail">{detail}</div>}
    </div>
  );
}

// ── A select ─────────────────────────────────────────────────────────────────

export interface SettingSelectProps<T> {
  readonly settingId: SettingId;
  readonly label?: string;
  readonly choices: readonly Choice<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly disabled?: boolean;
  readonly tradeOffActive?: boolean;
  readonly detail?: ReactNode;
}

/**
 * A native `<select>`, addressed by option index rather than by value.
 *
 * Because a choice's value can legitimately be `null` — "never lock", "keep every version" —
 * and a DOM option value is always a string, mapping the value itself would turn `null` into
 * the string `"null"` and back into something else. The index is unambiguous, and the
 * `Object.is` lookup means a stored value that is not in the list shows as itself rather
 * than silently snapping to the first option.
 */
export function SettingSelect<T>({
  settingId,
  label,
  choices,
  value,
  onChange,
  disabled = false,
  tradeOffActive = false,
  detail,
}: SettingSelectProps<T>): React.JSX.Element {
  const base = useId();
  const controlId = `${base}-control`;
  const helpId = `${base}-help`;
  const tradeOffId = `${base}-tradeoff`;
  const hasTradeOff = SETTING_COPY[settingId].tradeOff !== null;

  const selectedIndex = choices.findIndex((choice) => Object.is(choice.value, value));

  return (
    <SettingRow
      settingId={settingId}
      {...(label === undefined ? {} : { label })}
      controlId={controlId}
      helpId={helpId}
      tradeOffId={tradeOffId}
      tradeOffActive={tradeOffActive}
      {...(detail === undefined ? {} : { detail })}
    >
      <select
        id={controlId}
        className="kh-select"
        disabled={disabled}
        value={selectedIndex < 0 ? '' : String(selectedIndex)}
        aria-describedby={hasTradeOff ? `${helpId} ${tradeOffId}` : helpId}
        onChange={(event) => {
          const index = Number(event.target.value);
          const choice = choices[index];
          if (choice !== undefined) onChange(choice.value);
        }}
      >
        {selectedIndex < 0 && <option value="">Currently: {String(value)}</option>}
        {choices.map((choice, index) => (
          <option key={choice.label} value={String(index)}>
            {choice.label}
          </option>
        ))}
      </select>
    </SettingRow>
  );
}

// ── A switch ─────────────────────────────────────────────────────────────────

export interface SettingSwitchProps {
  readonly settingId: SettingId;
  readonly label?: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly tradeOffActive?: boolean;
  readonly detail?: ReactNode;
  /** Shown beside the control so the state is readable without interpreting the box. */
  readonly onLabel?: string;
  readonly offLabel?: string;
}

export function SettingSwitch({
  settingId,
  label,
  checked,
  onChange,
  disabled = false,
  tradeOffActive = false,
  detail,
  onLabel = 'On',
  offLabel = 'Off',
}: SettingSwitchProps): React.JSX.Element {
  const base = useId();
  const controlId = `${base}-control`;
  const helpId = `${base}-help`;
  const tradeOffId = `${base}-tradeoff`;
  const hasTradeOff = SETTING_COPY[settingId].tradeOff !== null;

  return (
    <SettingRow
      settingId={settingId}
      {...(label === undefined ? {} : { label })}
      controlId={controlId}
      helpId={helpId}
      tradeOffId={tradeOffId}
      tradeOffActive={tradeOffActive}
      {...(detail === undefined ? {} : { detail })}
    >
      <span className="kh-switch">
        <input
          id={controlId}
          type="checkbox"
          className="kh-switch__input"
          checked={checked}
          disabled={disabled}
          aria-describedby={hasTradeOff ? `${helpId} ${tradeOffId}` : helpId}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        {/* The state in words as well as in the box, so it survives a high-contrast theme
            and reads correctly when the row is skimmed rather than inspected. */}
        <span className="kh-switch__state">{checked ? onLabel : offLabel}</span>
      </span>
    </SettingRow>
  );
}

// ── A section ────────────────────────────────────────────────────────────────

export interface SettingsSectionProps {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Marks the whole section as destructive. Carries the word, never only the colour. */
  readonly danger?: boolean;
  readonly children: ReactNode;
}

export function SettingsSection({
  id,
  title,
  description,
  danger = false,
  children,
}: SettingsSectionProps): React.JSX.Element {
  const headingId = `${id}-heading`;

  return (
    <section
      id={id}
      className={`kh-settings-section${danger ? ' kh-settings-section--danger' : ''}`}
      aria-labelledby={headingId}
      // `tabIndex={-1}` so the in-page nav can move focus here, not merely scroll to it.
      // Scrolling without moving focus leaves a keyboard user exactly where they were.
      tabIndex={-1}
    >
      <header className="kh-settings-section__head">
        <h3 id={headingId} className="kh-settings-section__title">
          {danger && <span className="kh-settings-section__danger-word">Danger zone —</span>}{' '}
          {title}
        </h3>
        <p className="kh-settings-section__description">{description}</p>
      </header>
      {children}
    </section>
  );
}
