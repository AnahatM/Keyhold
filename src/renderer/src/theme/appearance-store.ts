// SPDX-License-Identifier: GPL-3.0-or-later
import { create } from 'zustand';
import {
  coerceAppearance,
  DEFAULT_APPEARANCE,
  resolveAppearance,
  toCssVariables,
  type AppearanceSettings,
  type ResolvedAppearance,
} from '@shared/theme/appearance.js';

/**
 * Appearance state, and the code that pushes it into the DOM.
 *
 * Kept out of React's render path on purpose. Theme changes are applied by setting CSS
 * custom properties on `documentElement`, so switching theme re-paints without
 * re-rendering a single component — which matters because the alternative (threading
 * colours through props or context) makes every component re-render on a theme change and
 * makes it far too easy to hardcode a colour "just here".
 *
 * Persistence is `localStorage`: appearance is a per-machine preference, it contains
 * nothing secret, and it must be readable before the first paint. Every access is wrapped
 * because storage throws outright in some contexts, and a theme preference is never worth
 * failing to start over.
 */

const STORAGE_KEY = 'keyhold.appearance';

function readStored(): AppearanceSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_APPEARANCE : coerceAppearance(JSON.parse(raw));
  } catch {
    // Private windows, cleared site data, storage disabled by policy. Not an error.
    return DEFAULT_APPEARANCE;
  }
}

function writeStored(settings: AppearanceSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // The app works fine without persistence; it just forgets. Never surface this.
  }
}

function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Writes the resolved appearance to the document.
 *
 * `color-scheme` is set alongside the custom properties so native form controls, the
 * caret and default scrollbars follow the theme. Without it a dark app renders a white
 * dropdown, which is the single most common way a themed Electron app gives itself away.
 */
export function applyToDocument(resolved: ResolvedAppearance): void {
  const root = document.documentElement;

  for (const [name, value] of Object.entries(toCssVariables(resolved))) {
    root.style.setProperty(name, value);
  }

  root.style.colorScheme = resolved.scheme;
  root.dataset.theme = resolved.theme.id;
  root.dataset.scheme = resolved.scheme;
  root.dataset.density = resolved.density;
}

interface AppearanceState {
  readonly settings: AppearanceSettings;
  readonly resolved: ResolvedAppearance;
  update: (patch: Partial<AppearanceSettings>) => void;
  reset: () => void;
  /** Re-resolves against the current OS preferences. Called when the OS changes. */
  refreshFromSystem: () => void;
}

function resolveNow(settings: AppearanceSettings): ResolvedAppearance {
  return resolveAppearance(settings, prefersDark(), prefersReducedMotion());
}

export const useAppearance = create<AppearanceState>((set, get) => ({
  settings: DEFAULT_APPEARANCE,
  resolved: resolveAppearance(DEFAULT_APPEARANCE, false, false),

  update: (patch) => {
    const settings = { ...get().settings, ...patch };
    const resolved = resolveNow(settings);
    applyToDocument(resolved);
    writeStored(settings);
    set({ settings, resolved });
  },

  reset: () => {
    const resolved = resolveNow(DEFAULT_APPEARANCE);
    applyToDocument(resolved);
    writeStored(DEFAULT_APPEARANCE);
    set({ settings: DEFAULT_APPEARANCE, resolved });
  },

  refreshFromSystem: () => {
    const resolved = resolveNow(get().settings);
    applyToDocument(resolved);
    set({ resolved });
  },
}));

/**
 * Loads and applies stored appearance, then watches the OS for changes.
 *
 * Called once from the entry point, **before React mounts** rather than from an effect.
 * An effect runs after the first paint, which means one frame of default-theme colours —
 * a white flash on a dark theme, on every launch. For an app people open dozens of times
 * a day that is the difference between feeling native and feeling like a web page.
 *
 * Returns a teardown for the media-query listeners.
 */
export function initialiseAppearance(): () => void {
  const settings = readStored();
  const resolved = resolveNow(settings);
  applyToDocument(resolved);
  useAppearance.setState({ settings, resolved });

  const onSystemChange = (): void => {
    useAppearance.getState().refreshFromSystem();
  };

  const colourScheme = window.matchMedia('(prefers-color-scheme: dark)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  colourScheme.addEventListener('change', onSystemChange);
  reducedMotion.addEventListener('change', onSystemChange);

  return () => {
    colourScheme.removeEventListener('change', onSystemChange);
    reducedMotion.removeEventListener('change', onSystemChange);
  };
}
