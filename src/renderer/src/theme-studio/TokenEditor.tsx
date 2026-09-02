// SPDX-License-Identifier: GPL-3.0-or-later
import { useId } from 'react';
import { describeColourRejection, type ColourRejectionReason } from '@shared/theme/keeptheme.js';
import type { ColourToken } from '@shared/theme/tokens.js';
import { TOKEN_GROUPS } from './token-groups.js';
import type { ThemeDraft, ThemeDraftAction } from './theme-draft.js';

/**
 * Every token, editable, grouped by what it is for.
 *
 * Two controls per token — a swatch and a text field — because they answer different
 * questions. The swatch is how you find a colour; the text field is how you paste the one
 * you already have, and the only one of the two that can express `rgb()` notation or be
 * read out by a screen reader.
 *
 * The raw inputs are deliberate rather than a use of `Input`: this is a three-column grid of
 * forty controls, and `Input`'s stacked label-above-control layout is right for a form and
 * wrong for a dense table. The parts that matter — a real `<label>` bound by `htmlFor`, an
 * `aria-describedby` error, `role="alert"` on it — are kept.
 */

export interface TokenEditorProps {
  readonly draft: ThemeDraft;
  readonly dispatch: (action: ThemeDraftAction) => void;
}

interface TokenRowProps {
  readonly token: ColourToken;
  readonly value: string;
  readonly typed: string | undefined;
  readonly invalid: ColourRejectionReason | undefined;
  readonly dispatch: (action: ThemeDraftAction) => void;
}

function TokenRow({ token, value, typed, invalid, dispatch }: TokenRowProps): React.JSX.Element {
  const id = useId();
  const errorId = `${id}-error`;
  // The text field shows what the user typed while they are typing, and the committed value
  // otherwise — so a half-finished `#3` is not overwritten under the caret.
  const text = typed ?? value;

  return (
    <div className="kh-studio-token">
      <label className="kh-studio-token__name" htmlFor={id}>
        <code>{token}</code>
      </label>

      <input
        type="color"
        className="kh-studio-token__swatch"
        // `type="color"` accepts only `#rrggbb`, which is exactly the canonical form the
        // palette holds — so the swatch never disagrees with the text field.
        value={value}
        aria-label={`${token} colour picker`}
        onChange={(event) => {
          dispatch({ type: 'set-colour', token, text: event.target.value });
        }}
      />

      <input
        id={id}
        type="text"
        className="kh-studio-token__text kh-secret"
        value={text}
        spellCheck={false}
        autoComplete="off"
        inputMode="text"
        aria-invalid={invalid !== undefined || undefined}
        aria-describedby={invalid === undefined ? undefined : errorId}
        onChange={(event) => {
          dispatch({ type: 'set-colour', token, text: event.target.value });
        }}
        onBlur={() => {
          // Leaving the field with something unparseable in it puts the committed value
          // back, so the editor never sits in a state the preview cannot reflect.
          if (invalid !== undefined) dispatch({ type: 'revert-colour', token });
        }}
      />

      {invalid !== undefined && (
        <p className="kh-studio-token__error" id={errorId} role="alert">
          That {describeColourRejection(invalid)}.
        </p>
      )}
    </div>
  );
}

export function TokenEditor({ draft, dispatch }: TokenEditorProps): React.JSX.Element {
  return (
    <div className="kh-studio-tokens">
      {TOKEN_GROUPS.map((group) => (
        <fieldset key={group.id} className="kh-studio-group">
          <legend className="kh-studio-group__legend">{group.label}</legend>
          <p className="kh-studio-group__description">{group.description}</p>

          {group.tokens.map((token) => (
            <TokenRow
              key={token}
              token={token}
              value={draft.palette[token]}
              typed={draft.typing[token]}
              invalid={draft.invalid[token]}
              dispatch={dispatch}
            />
          ))}
        </fieldset>
      ))}
    </div>
  );
}
