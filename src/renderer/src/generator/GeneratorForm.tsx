// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useRef, useState } from 'react';
import type { GeneratorLimitsView } from '@shared/ipc/api.js';
import type { GeneratorMode } from '@shared/model/generator.js';
import { Button } from '../components/Button.js';
import { EntropyReadout } from './EntropyReadout.js';
import { GeneratorControls } from './GeneratorControls.js';
import { SecretHistoryList } from './SecretHistoryList.js';
import { GENERATOR_MODES, MODE_DETAILS } from './generator-options.js';
import { formatBits } from './strength-band.js';
import { useGenerator } from './use-generator.js';

/**
 * The generator, as one implementation.
 *
 * The standalone screen and the inline generator inside the credential editor both render
 * this. Two copies of a password generator would eventually disagree about what a setting
 * means, which is the "no second list" rule applied to a screen.
 *
 * ## What is deliberate here
 *
 * **The live figure never generates.** The readout is fed by `generator.estimate`; a
 * password is produced only when someone asks. See `use-generator.ts`.
 *
 * **A password made with settings that have since changed says so** rather than being
 * silently re-attributed to the current ones, or being thrown away behind the user's back.
 *
 * **Switching mode regenerates; changing a setting does not.** A mode change is one
 * deliberate click, so producing one password for it is right; a slider drag is hundreds of
 * events, so producing one password per event is not.
 *
 * **Copy goes through the ordinary clipboard, and says so.** There is no `SecretRef` for a
 * password that is not in the vault yet, so Keyhold's auto-clear timer — which is keyed to a
 * stored secret — does not cover this copy. Saying that plainly is better than implying a
 * protection that is not there. See the note in the report accompanying this work for the
 * main-process channel that would close the gap.
 */

/** How long the "copied" acknowledgement stays up before it stops being true-ish. */
const COPY_ACKNOWLEDGEMENT_MS = 4000;

export interface GeneratorFormProps {
  readonly limits: GeneratorLimitsView;
  /** Given a generated password to keep. Omitted when there is nowhere to put one. */
  readonly onUse?: ((secret: string) => void) | undefined;
  readonly useLabel?: string | undefined;
  /** Produce one on mount, so the panel is never an empty box. */
  readonly autoGenerate?: boolean;
}

export function GeneratorForm({
  limits,
  onUse,
  useLabel = 'Use this password',
  autoGenerate = true,
}: GeneratorFormProps): React.JSX.Element {
  const generator = useGenerator(limits);
  const { draft, estimate, current, currentIsStale, secretHistory, generateError, busy, generate } =
    generator;

  /*
   * Generated ids, not literals. The Generate screen and the inline generator can be on
   * screen at the same moment, and two elements sharing an id silently breaks whichever
   * `aria-labelledby` resolves second.
   */
  const outputLabelId = useId();
  const modeLabelId = useId();

  const [masked, setMasked] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  /*
   * Generate on mount, and again whenever the MODE changes — never on an ordinary setting
   * change. `null` marks "not yet mounted", which is what separates the first run from a
   * genuine mode switch without a second flag.
   */
  const shownMode = useRef<GeneratorMode | null>(null);
  useEffect(() => {
    const first = shownMode.current === null;
    if (shownMode.current === draft.mode) return;
    shownMode.current = draft.mode;
    if (first && !autoGenerate) return;
    void generate();
  }, [autoGenerate, draft.mode, generate]);

  /* The acknowledgement is a moment, not a state someone should find still on screen. */
  useEffect(() => {
    if (copied === null) return;
    const timer = window.setTimeout(() => {
      setCopied(null);
    }, COPY_ACKNOWLEDGEMENT_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [copied]);

  const copy = async (secret: string, description: string): Promise<void> => {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(description);
    } catch {
      // Never echo the value into the failure. A clipboard error is about the clipboard.
      setCopyError('Keyhold could not reach the clipboard.');
    }
  };

  const detail = MODE_DETAILS[draft.mode];

  /*
   * The engine refuses an over-restrictive configuration with a message written for a user
   * that never echoes their exclusion string back, so it is shown verbatim. A refusal for
   * settings the user has already moved on from is suppressed rather than left shouting.
   */
  const configurationError = estimate.stale ? null : estimate.error;
  const errors = [configurationError, generateError, copyError].filter(
    (message, index, all): message is string => message !== null && all.indexOf(message) === index
  );

  const entropyCaveat =
    draft.mode === 'random' && draft.random.requireEachClass
      ? 'With “require one of each kind” on, this is an upper bound: the engine subtracts what the constraint costs, and the true figure is a hair lower still.'
      : (detail.caveat ?? undefined);

  return (
    <div className="kh-gen">
      <div className="kh-gen__output">
        <span className="kh-gen__output-label" id={outputLabelId}>
          Generated password
        </span>

        <div className="kh-gen__secret-wrap">
          {current === null ? (
            <span className="kh-gen__secret kh-gen__secret--empty">
              {busy ? 'Generating…' : 'Nothing generated yet.'}
            </span>
          ) : (
            <span
              className="kh-secret kh-gen__secret"
              data-selectable="true"
              aria-labelledby={outputLabelId}
            >
              {masked ? '•'.repeat(Math.min(current.secret.length, 64)) : current.secret}
            </span>
          )}

          <Button
            variant="ghost"
            size="sm"
            // Kept alongside the visible word so the accessible name says *which* password
            // — "Show" alone is meaningless read out of context. WCAG 2.5.3 is satisfied
            // because the visible label is the start of the accessible one.
            iconOnlyLabel={masked ? 'Show the generated password' : 'Hide the generated password'}
            onClick={() => {
              setMasked((value) => !value);
            }}
          >
            {/*
              Words, not an eye emoji.

              This was `👁` / `🙈`, which looks like one consistent toggle on macOS and does
              not on Windows: U+1F441 has *text* presentation by default, so Chromium drew
              it from Segoe UI Symbol as a hairline monochrome outline roughly half the
              height of the colour monkey it alternated with — a nearly invisible control in
              the state where it matters most, the one hiding a password. A U+FE0F selector
              did not move it. Two short words render identically on every platform, need no
              emoji font, and match every other button on this panel.
            */}
            {masked ? 'Show' : 'Hide'}
          </Button>
        </div>

        <div className="kh-gen__actions">
          <Button
            variant={onUse === undefined ? 'primary' : 'secondary'}
            loading={busy}
            onClick={() => {
              void generate();
            }}
          >
            Regenerate
          </Button>
          <Button
            disabled={current === null}
            onClick={() => {
              if (current !== null) void copy(current.secret, 'The generated password');
            }}
          >
            Copy
          </Button>
          {onUse !== undefined && (
            <Button
              variant="primary"
              disabled={current === null}
              onClick={() => {
                if (current !== null) onUse(current.secret);
              }}
            >
              {useLabel}
            </Button>
          )}
        </div>

        {currentIsStale && current !== null && (
          <p className="kh-gen__stale">
            This one was made with earlier settings ({formatBits(current.entropyBits)} bits).
            Regenerate to use the settings below.
          </p>
        )}
      </div>

      <EntropyReadout bits={estimate.bits} stale={estimate.stale} caveat={entropyCaveat} />

      {errors.map((message) => (
        <p key={message} className="kh-screen__error" role="alert">
          {message}
        </p>
      ))}

      <div className="kh-gen__modes">
        <span className="kh-control-row__label" id={modeLabelId}>
          Kind
        </span>
        <div className="kh-segmented" role="group" aria-labelledby={modeLabelId}>
          {GENERATOR_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className="kh-segmented__option"
              aria-pressed={draft.mode === mode}
              onClick={() => {
                generator.setMode(mode);
              }}
            >
              {MODE_DETAILS[mode].label}
            </button>
          ))}
        </div>
      </div>

      <p className="kh-gen__summary">{detail.summary}</p>

      <GeneratorControls
        draft={draft}
        limits={limits.limits}
        onRandomChange={generator.setRandom}
        onPassphraseChange={generator.setPassphrase}
        onPronounceableChange={generator.setPronounceable}
        onPinChange={generator.setPin}
      />

      <SecretHistoryList
        entries={secretHistory}
        onRestore={generator.restore}
        onCopy={(secret, position) => {
          void copy(secret, `Password ${position} from this session`);
        }}
        onForget={generator.forgetHistory}
      />

      {copied !== null && (
        <p className="kh-gen__clipboard-note">
          Keyhold’s clipboard auto-clear covers passwords it has stored. A password copied before it
          is saved to a record is on your clipboard until something else replaces it.
        </p>
      )}

      {/* Polite: a copy is an action the user just took, not something to interrupt them with. */}
      <span className="kh-visually-hidden" aria-live="polite">
        {copied === null ? '' : `${copied} copied to the clipboard.`}
      </span>
    </div>
  );
}
