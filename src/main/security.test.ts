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
