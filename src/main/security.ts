// SPDX-License-Identifier: GPL-3.0-or-later
import { app, session, shell, type BrowserWindow, type WebContents } from 'electron';

/**
 * Process-wide security hardening.
 *
 * Keyhold's threat model (docs/00-Overview/03-Threat-Model.md) treats the renderer
 * as SEMI-TRUSTED: it runs React and npm dependencies, and it must never hold the
 * master key or any secret material (decision D13). Everything here exists to make
 * that boundary hold even if a dependency turns hostile.
 *
 * Nothing in this file is optional and nothing here is a default we inherited —
 * each control is set explicitly so that an Electron upgrade changing a default
 * cannot silently weaken us.
 */

/** Keyhold makes no network requests at all unless the user opts into the HIBP check. */
const ALLOWED_REMOTE_HOSTS: readonly string[] = [];

/**
 * Content-Security-Policy for the renderer.
 *
 * `script-src 'self'` with no `unsafe-inline` and no `unsafe-eval` is the load-bearing
 * part: it is what makes an injected `<script>` inert. `connect-src 'none'` means the
 * renderer cannot originate a request even if something tries — all network activity
 * (of which there is one opt-in feature) happens in the main process where it can be
 * gated by a setting.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  // Vite injects a <style> tag for HMR and for CSS-in-JS-free stylesheets; unsafe-inline
  // for styles cannot execute script, so this is a materially different risk to script-src.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'self' blob:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Window options every Keyhold BrowserWindow must be created with. */
export const HARDENED_WEB_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  spellcheck: false,
  /** No devtools in production. See applyWebContentsHardening for enforcement. */
  devTools: !app.isPackaged,
} as const;

function isAllowedNavigation(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  // In dev the renderer is served over http from the vite server; in production it
  // is loaded from disk. Both are "us"; nothing else is.
  if (url.protocol === 'file:') return true;
  if (!app.isPackaged && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return true;
  }
  return ALLOWED_REMOTE_HOSTS.includes(url.host);
}

/**
 * Locks down a WebContents: no in-app navigation away from our own pages, no popups,
 * no new windows, no permissions, and no devtools once packaged.
 *
 * Opening an external link is not forbidden — it is redirected to the user's real
 * browser, which is both what they expect and outside our trust boundary.
 */
export function applyWebContentsHardening(contents: WebContents): void {
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    // Never let the renderer spawn a window we did not configure — a window without
    // our hardened webPreferences would be a hole straight through this whole file.
    if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  if (app.isPackaged) {
    contents.on('devtools-opened', () => {
      contents.closeDevTools();
    });
  }
}

/**
 * Session-level hardening: the CSP header, and a blanket denial of every web
 * permission. An offline password manager needs none of camera, microphone,
 * geolocation, notifications or clipboard-read.
 */
export function applySessionHardening(): void {
  const ses = session.defaultSession;

  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });

  ses.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });

  ses.setPermissionCheckHandler(() => false);
}

/** Applies every hardening control to a freshly created window. */
export function hardenWindow(window: BrowserWindow): void {
  applyWebContentsHardening(window.webContents);
}

/** The CSP string, exported so the guard test can assert its shape. */
export const CONTENT_SECURITY_POLICY = CSP;
