// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Guard: the renderer's hardening must not be weakened.
 *
 * Every control asserted here is load-bearing for decision D13 — the renderer is a
 * semi-trusted zone that must never hold the master key or secret material. These are
 * exactly the settings that get "temporarily" relaxed to make something work and then
 * never put back, and the failure is silent: the app keeps running, it is just no
 * longer safe.
 *
 * Fault injection performed: flipping each of contextIsolation, sandbox, webSecurity,
 * and nodeIntegration, and adding 'unsafe-eval' to script-src, each fails this file.
 */

vi.mock('electron', () => ({
  app: { isPackaged: false },
  session: { defaultSession: {} },
  shell: { openExternal: vi.fn() },
}));

const loadSecurity = async () => import('./security.js');

describe('hardened web preferences', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('isolates the renderer context', async () => {
    const { HARDENED_WEB_PREFERENCES } = await loadSecurity();
    expect(HARDENED_WEB_PREFERENCES.contextIsolation).toBe(true);
  });

  it('sandboxes the renderer', async () => {
    const { HARDENED_WEB_PREFERENCES } = await loadSecurity();
    expect(HARDENED_WEB_PREFERENCES.sandbox).toBe(true);
  });

  it('gives the renderer no Node access, in any frame or worker', async () => {
    const { HARDENED_WEB_PREFERENCES } = await loadSecurity();
    expect(HARDENED_WEB_PREFERENCES.nodeIntegration).toBe(false);
    expect(HARDENED_WEB_PREFERENCES.nodeIntegrationInWorker).toBe(false);
    expect(HARDENED_WEB_PREFERENCES.nodeIntegrationInSubFrames).toBe(false);
  });

  it('keeps web security on and insecure content off', async () => {
    const { HARDENED_WEB_PREFERENCES } = await loadSecurity();
    expect(HARDENED_WEB_PREFERENCES.webSecurity).toBe(true);
    expect(HARDENED_WEB_PREFERENCES.allowRunningInsecureContent).toBe(false);
    expect(HARDENED_WEB_PREFERENCES.experimentalFeatures).toBe(false);
  });

  it('disables <webview>, which would bypass every control here', async () => {
    const { HARDENED_WEB_PREFERENCES } = await loadSecurity();
    expect(HARDENED_WEB_PREFERENCES.webviewTag).toBe(false);
  });

  it('disables spellcheck, which ships typed text to a remote service on some platforms', async () => {
    const { HARDENED_WEB_PREFERENCES } = await loadSecurity();
    expect(HARDENED_WEB_PREFERENCES.spellcheck).toBe(false);
  });
});

describe('content security policy', () => {
  const directive = (csp: string, name: string): string => {
    const found = csp.split(';').find((part) => part.trim().startsWith(`${name} `));
    return found?.trim() ?? '';
  };

  it("defaults to 'none' rather than allow-by-omission", async () => {
    const { CONTENT_SECURITY_POLICY } = await loadSecurity();
    expect(directive(CONTENT_SECURITY_POLICY, 'default-src')).toBe("default-src 'none'");
  });

  it("never permits 'unsafe-eval' — the CSP is what makes an injected script inert", async () => {
    const { CONTENT_SECURITY_POLICY } = await loadSecurity();
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
  });

  it("never permits 'unsafe-inline' in script-src", async () => {
    const { CONTENT_SECURITY_POLICY } = await loadSecurity();
    expect(directive(CONTENT_SECURITY_POLICY, 'script-src')).not.toContain('unsafe-inline');
  });

  it('blocks all outbound connections — the app is offline by default (goal G2)', async () => {
    const { CONTENT_SECURITY_POLICY } = await loadSecurity();
    expect(directive(CONTENT_SECURITY_POLICY, 'connect-src')).toBe("connect-src 'none'");
  });

  it('blocks objects, frames, form submission and base-uri rewriting', async () => {
    const { CONTENT_SECURITY_POLICY } = await loadSecurity();
    expect(directive(CONTENT_SECURITY_POLICY, 'object-src')).toBe("object-src 'none'");
    expect(directive(CONTENT_SECURITY_POLICY, 'frame-src')).toBe("frame-src 'none'");
    expect(directive(CONTENT_SECURITY_POLICY, 'form-action')).toBe("form-action 'none'");
    expect(directive(CONTENT_SECURITY_POLICY, 'base-uri')).toBe("base-uri 'none'");
    expect(directive(CONTENT_SECURITY_POLICY, 'frame-ancestors')).toBe("frame-ancestors 'none'");
  });

  it('loads scripts only from the app itself', async () => {
    const { CONTENT_SECURITY_POLICY } = await loadSecurity();
    expect(directive(CONTENT_SECURITY_POLICY, 'script-src')).toBe("script-src 'self'");
  });
});

/**
 * Navigation and external-link hardening.
 *
 * These exist because an audit found the two paths had **drifted apart**: the window-open
 * handler checked a URL's scheme before handing it to `shell.openExternal`, and the
 * `will-navigate` fallback twenty lines above it did not. So `window.open('ms-msdt:...')`
 * was refused while `location.href = 'ms-msdt:...'` reached the OS with a fully
 * attacker-chosen URI — the canonical Electron step from a compromised renderer to code
 * execution. Two copies of one policy, and the weaker copy was the one in force.
 *
 * Both now go through `openExternally`. These tests are what stops them separating again.
 */
describe('handing a URL to the browser', () => {
  it('accepts http and https', async () => {
    const { openExternally } = await loadSecurity();
    expect(openExternally('https://example.com/docs')).toBe(true);
    expect(openExternally('http://example.com')).toBe(true);
  });

  it.each([
    'file:///C:/Windows/System32/calc.exe',
    'file://///attacker-host/share/payload.exe',
    'ms-msdt:-id PCWDiagnostic',
    'search-ms:query=x',
    'smb://attacker/share',
    'ms-officecmd:%7B%22id%22:3%7D',
    'javascript:alert(1)',
    'vbscript:msgbox',
    'not a url at all',
  ])('refuses %s rather than handing it to the OS', async (url) => {
    const { openExternally } = await loadSecurity();
    expect(openExternally(url)).toBe(false);
  });
});

describe('navigation allow-list', () => {
  it('refuses a file URL carrying a hostname', async () => {
    // `file://attacker-host/share/page.html` parses with protocol `file:`. Treating every
    // `file:` URL as "us" would let a renderer navigate the main window to a page of the
    // attacker's authorship — into which the preload is then injected, handing them the
    // whole `window.keyhold` bridge. A transient injection becomes a persistent one.
    const { isAllowedNavigation } = await loadSecurity();
    expect(isAllowedNavigation('file://attacker-host/share/page.html')).toBe(false);
  });

  it('refuses a file URL outside the renderer directory', async () => {
    const { isAllowedNavigation } = await loadSecurity();
    expect(isAllowedNavigation('file:///C:/Users/someone/evil.html')).toBe(false);
    expect(isAllowedNavigation('file:///etc/passwd')).toBe(false);
  });

  it('refuses a traversal that resolves outside the renderer directory', async () => {
    const { isAllowedNavigation } = await loadSecurity();
    const escaped = new URL('../../../evil.html', import.meta.url).toString();
    expect(isAllowedNavigation(escaped)).toBe(false);
  });

  it('refuses an arbitrary remote host, and anything that is not a URL', async () => {
    const { isAllowedNavigation } = await loadSecurity();
    expect(isAllowedNavigation('https://evil.example/page')).toBe(false);
    expect(isAllowedNavigation('')).toBe(false);
  });
});
