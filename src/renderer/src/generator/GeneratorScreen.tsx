// SPDX-License-Identifier: GPL-3.0-or-later
import { GeneratorPanel } from './GeneratorPanel.js';

/**
 * The standalone Generate view.
 *
 * The same panel the credential editor embeds, given a heading and the page chrome of the
 * detail pane. It needs **no open vault**: generation is pure, and choosing a password
 * before you have unlocked anything is a reasonable thing to want — the two IPC channels
 * behind it are the only ones in the app that require no session.
 *
 * `onUse` is optional here on purpose. On this screen there is usually nowhere to put the
 * result, so the panel shows Regenerate and Copy and no third button promising something it
 * cannot do. A caller that *does* have somewhere to put it can pass one.
 */

export interface GeneratorScreenProps {
  /** Given a generated password to keep. Omit when there is nowhere to put one. */
  readonly onUse?: ((secret: string) => void) | undefined;
  readonly useLabel?: string | undefined;
}

export function GeneratorScreen({ onUse, useLabel }: GeneratorScreenProps): React.JSX.Element {
  return (
    <section className="kh-panel">
      <header className="kh-panel__header">
        <h2 className="kh-panel__title">Generate a password</h2>
        <p className="kh-panel__subtitle">
          Produced in the main process from the operating system’s cryptographic random source —
          never from anything in this window. The figure below is the size of the search space these
          settings define, not a guess about how long anyone would take.
        </p>
      </header>

      <GeneratorPanel onUse={onUse} useLabel={useLabel} />
    </section>
  );
}
