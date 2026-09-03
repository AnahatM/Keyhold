// SPDX-License-Identifier: GPL-3.0-or-later
import { Button } from '../components/Button.js';
import { useTourGate } from '../onboarding/index.js';
import { SettingsSection } from './SettingControls.js';

/**
 * Getting help, and seeing the setup tour again.
 *
 * The tour has always been re-runnable in principle — `OnboardingFlow` takes a `mode` and
 * writes nothing in `revisit` — and reachable in practice from nowhere at all. The palette
 * carries the same command, but the palette is for people who already know a thing exists.
 * This is the entry point for everyone else, which is why it is a button on a screen people
 * open when they are looking for something rather than a chord.
 *
 * There is no setting here to turn the tour off. It shows once, on a machine that has never
 * opened a vault, and closing it is one click — a preference for suppressing something that
 * cannot happen twice would be a control with nothing to control.
 */
export function HelpSection(): React.JSX.Element {
  const showTour = useTourGate((state) => state.show);

  return (
    <SettingsSection
      id="kh-settings-help"
      title="Help"
      description="Everything Keyhold knows how to explain is inside the app. Nothing here needs a connection."
    >
      <div className="kh-setting">
        <div className="kh-setting__head">
          <span className="kh-setting__label">The setup tour</span>
        </div>
        <p className="kh-setting__control">
          <Button variant="secondary" onClick={showTour}>
            Show the setup tour again
          </Button>
        </p>
        <p className="kh-setting__help">
          The five screens shown when Keyhold is first opened. Re-running it starts past the screens
          that create a vault, since yours exists, and changes nothing — it is a tour, not a setup
          wizard.
        </p>
      </div>
    </SettingsSection>
  );
}
