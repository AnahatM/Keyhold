// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import type { FirstCredentialDraft } from './onboarding-state.js';
import '../vault/vault-screens.css';
import './onboarding.css';
import { Icon } from '../components/Icon.js';

/**
 * The optional one.
 *
 * A first-run flow that ends at an empty vault has taught somebody nothing about the thing
 * they installed it for. Adding one entry, with the fields on screen and named, is worth
 * more than any amount of explanation about what a credential is.
 *
 * **Skipping is exactly as easy as doing it.** Both are buttons, side by side, neither
 * emphasised over the other by size or by copy, and the skip does not ask a question first.
 * Someone who wants to import their existing vault from another manager should not be made
 * to type a throwaway entry to get past this screen — the next step is where import lives,
 * and this one is not allowed to stand in front of it.
 *
 * Nothing typed here is ever persisted by the flow. The draft is handed to the host and
 * dropped; see `onboarding-storage.ts` for the guarantee and the test that holds it.
 */

export interface FirstCredentialStepProps {
  /**
   * Saves the credential. Absent when the host has not wired vault writes into the flow —
   * in which case the step still explains itself and offers a way past.
   */
  readonly onSave?: (draft: FirstCredentialDraft) => Promise<boolean>;
  readonly onSaved: () => void;
  readonly onSkip: () => void;
  readonly busy: boolean;
  readonly error: string | null;
}

export function FirstCredentialStep({
  onSave,
  onSaved,
  onSkip,
  busy,
  error,
}: FirstCredentialStepProps): React.JSX.Element {
  const [title, setTitle] = useState('');
  const [username, setUsername] = useState('');
  const [url, setUrl] = useState('');
  const [secretPassword, setSecretPassword] = useState('');
  const [reveal, setReveal] = useState(false);

  const canSave = onSave !== undefined && !busy && title.trim() !== '';

  const submit = (): void => {
    // `canSave` already establishes that `onSave` is present; TypeScript narrows through the
    // const, so restating the check here would be a condition that can never be true.
    if (!canSave) return;
    void onSave({ title: title.trim(), username, url, secretPassword }).then((saved) => {
      if (!saved) return;
      // Dropped as soon as it has been handed over. The vault owns it now; a second copy
      // sitting in component state after the step is done has no reason to exist.
      setTitle('');
      setUsername('');
      setUrl('');
      setSecretPassword('');
      setReveal(false);
      onSaved();
    });
  };

  return (
    <form
      className="kh-onb__body"
      /*
       * Native constraint validation is off, deliberately.
       *
       * With it on, the browser refuses to fire `submit` at all when any control is invalid
       * — so a user who typed `github.com` into the optional Website field would press Save
       * and have *nothing happen* except a transient bubble, on a step whose own copy calls
       * the field optional. A silently swallowed save on the first entry someone ever puts
       * into a password manager is exactly the wrong first impression.
       *
       * The fields validate themselves and say so in the app's own error styling instead.
       */
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="kh-onb__lead">
        Optional — you can skip this and add entries whenever you like. If you already use another
        password manager, skip it: importing your existing vault is on the next screen and does the
        whole thing at once.
      </p>

      {error !== null && (
        <p className="kh-screen__error" role="alert">
          {error}
        </p>
      )}

      {onSave === undefined ? (
        <p className="kh-onb__note">
          You can add your first entry from the vault itself in a moment — the button is at the top
          of the credential list.
        </p>
      ) : (
        <>
          <Input
            label="Name"
            value={title}
            // See `OnboardingFlow`: the flow owns focus, and it puts it on the heading.
            disabled={busy}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
            hint="Whatever you would call it yourself — “GitHub”, “Home router”, “Mum’s Netflix”."
          />

          <Input
            label="Username or email"
            value={username}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => {
              setUsername(event.target.value);
            }}
          />

          {/*
           * `type="text"` with a URL keyboard hint rather than `type="url"`. A bare
           * `github.com` is what people actually type and is perfectly usable for grouping
           * entries, but it is not a valid URL, so `type="url"` would mark it invalid and —
           * with native validation on — refuse the save. The input mode gets the right
           * on-screen keyboard without importing the constraint.
           */}
          <Input
            label="Website"
            type="text"
            inputMode="url"
            value={url}
            autoComplete="off"
            disabled={busy}
            spellCheck={false}
            onChange={(event) => {
              setUrl(event.target.value);
            }}
            hint="Optional. A bare address like github.com is fine. Used to group entries and to spot reused passwords later."
          />

          <Input
            label="Password"
            type={reveal ? 'text' : 'password'}
            value={secretPassword}
            autoComplete="new-password"
            secret={reveal}
            disabled={busy}
            onChange={(event) => {
              setSecretPassword(event.target.value);
            }}
            hint="Optional now. Keyhold can generate a strong one for this entry later."
            trailing={
              <Button
                variant="ghost"
                size="sm"
                iconOnlyLabel={reveal ? 'Hide the password' : 'Show the password'}
                onClick={() => {
                  setReveal(!reveal);
                }}
              >
                {<Icon name={reveal ? 'hide' : 'reveal'} />}
              </Button>
            }
          />
        </>
      )}

      <div className="kh-onb__actions">
        {onSave !== undefined && (
          <Button variant="primary" type="submit" disabled={!canSave} loading={busy}>
            Save it
          </Button>
        )}
        {/*
         * Secondary rather than ghost, and it says what happens rather than apologising for
         * it. A skip styled as a faint link beside a filled button is a nudge, and nudging
         * someone through a step they were told was optional is exactly the pattern this
         * flow is not allowed to use.
         */}
        <Button variant="secondary" disabled={busy} onClick={onSkip}>
          {onSave === undefined ? 'Continue' : 'Skip this step'}
        </Button>
      </div>
    </form>
  );
}
