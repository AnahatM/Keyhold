// SPDX-License-Identifier: GPL-3.0-or-later
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ToastProvider } from './chrome/index.js';
import { initialiseAppearance } from './theme/appearance-store.js';
import './styles/base.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root element missing from index.html — the renderer cannot mount.');
}

/**
 * Appearance is applied BEFORE React mounts, not from an effect.
 *
 * An effect runs after the first paint, which means one frame of default-theme colours —
 * a white flash on a dark theme, on every single launch. For an app people open dozens of
 * times a day, that one frame is the difference between feeling native and feeling like a
 * web page in a window.
 */
initialiseAppearance();

createRoot(container).render(
  <StrictMode>
    {/* Above <App /> so every screen — including the ones shown before a vault is open —
        can raise a toast, and so the viewport survives navigation between them. */}
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>
);
