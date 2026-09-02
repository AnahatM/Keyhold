// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';

/**
 * Phase 0 placeholder. The real three-pane shell arrives in Phase 3.
 *
 * It exists now to prove the whole chain works end to end: the hardened window
 * loads, the preload bridge is reachable, and the renderer can call through it
 * without any Node access of its own.
 */
export function App(): React.JSX.Element {
  const [version, setVersion] = useState<string>('…');
  const [platform, setPlatform] = useState<string>('…');

  useEffect(() => {
    void window.keyhold.app.getVersion().then(setVersion);
    void window.keyhold.app.getPlatform().then(setPlatform);
  }, []);

  return (
    <main className="boot">
      <h1>Keyhold</h1>
      <p className="tagline">
        Your passwords, in a file you own, encrypted with a key only you have.
      </p>
      <dl className="boot-facts">
        <dt>Version</dt>
        <dd>{version}</dd>
        <dt>Platform</dt>
        <dd>{platform}</dd>
        <dt>Bridge</dt>
        <dd>{typeof window.keyhold === 'object' ? 'connected' : 'unavailable'}</dd>
      </dl>
      <p className="phase">Phase 0 — scaffold. The vault arrives in Phase 1.</p>
    </main>
  );
}
