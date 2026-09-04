// SPDX-License-Identifier: GPL-3.0-or-later
import { Button } from '../components/Button.js';
import { ENCRYPTION_CLAIM } from './onboarding-copy.js';
import './onboarding.css';
import { Icon } from '../components/Icon.js';

/**
 * One screen, four facts, one button.
 *
 * Nobody reads a tour. The entire job of this step is to answer "what is this thing and
 * what is it going to do to my data" well enough that the next screen — where a genuinely
 * irreversible decision gets made — is not the first time the user is thinking about it.
 *
 * The fourth fact is the uncomfortable one, and it is here rather than only on the next
 * step on purpose: someone who is going to bounce off "there is no reset link" should find
 * that out before they have typed anything, not after.
 */
export function WelcomeStep({
  onContinue,
}: {
  readonly onContinue: () => void;
}): React.JSX.Element {
  return (
    <div className="kh-onb__body">
      <p className="kh-onb__lead">
        Keyhold stores your logins in a single encrypted file on this computer. Setting it up takes
        about a minute, and you can leave at any point.
      </p>

      <ul className="kh-onb__facts">
        <li>
          <span className="kh-onb__fact-mark" aria-hidden="true">
            <Icon name="document" size="lg" />
          </span>
          <span>
            <strong>One file, and it is yours.</strong> Copy it to a USB stick, a backup drive or a
            cloud folder. It opens anywhere Keyhold runs, with your master password.
          </span>
        </li>
        <li>
          <span className="kh-onb__fact-mark" aria-hidden="true">
            <Icon name="offline" size="lg" />
          </span>
          <span>
            <strong>No account, no server.</strong> {ENCRYPTION_CLAIM}
          </span>
        </li>
        <li>
          <span className="kh-onb__fact-mark" aria-hidden="true">
            <Icon name="free" size="lg" />
          </span>
          <span>
            <strong>Free, and open source.</strong> No subscription, no paid tier, no upsell. There
            is nothing to buy because there is nothing to run.
          </span>
        </li>
        <li>
          <span className="kh-onb__fact-mark" aria-hidden="true">
            <Icon name="warning" size="lg" />
          </span>
          <span>
            <strong>One master password, and no reset.</strong> That is what keeps the file
            unreadable to everyone else, and it is also the one real risk. The next step covers it
            properly.
          </span>
        </li>
      </ul>

      <div className="kh-onb__actions">
        <Button variant="primary" onClick={onContinue}>
          Get started
        </Button>
      </div>
    </div>
  );
}
