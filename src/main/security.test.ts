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

/**
 * Hoisted so the handler tests below can assert on the same function the module under test
 * calls. Reaching for it as `vi.mocked(shell.openExternal)` would work, but pulling a method
 * off an object detaches it from its receiver, which the lint config rightly objects to.
 */
const openExternalMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: { isPackaged: false },
  session: { defaultSession: {} },
  shell: { openExternal: openExternalMock },
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
 * The development relaxation.
 *
 * This section exists because `npm run dev` opened a **blank window** and nothing in the
 * repository could see it. `@vitejs/plugin-react` injects its React Refresh preamble as an
 * inline `<script type="module">`; `script-src 'self'` blocked it, every component module
 * threw `can't detect preamble`, and React never mounted. Every gate stayed green throughout,
 * because the suite runs in Node and `npm run test:smoke` launches the *built* app from
 * `file:` — where there is no dev server, and so no preamble to block.
 *
 * So these tests are written from both sides, and the second side is the one that matters:
 *
 *  1. The dev policy must permit exactly what the Vite dev server needs. That is the guard
 *     against the blank window coming back on the next tightening.
 *  2. The dev policy must be **unreachable** without a dev server URL, and the shipped
 *     policy must be unchanged by anything here. That is the guard against the far worse
 *     failure — a convenience relaxation quietly shipping to users.
 *
 * Fault injection performed: dropping `'unsafe-inline'` from the dev `script-src` fails (1);
 * returning the dev policy when `devServerUrl` is undefined fails (2); hardcoding
 * `localhost:5173` in `connect-src` fails the moved-port test.
 */
describe('the policy served while the vite dev server is the renderer origin', () => {
  const DEV_URL = 'http://localhost:5173';

  const directive = (csp: string, name: string): string => {
    const found = csp.split(';').find((part) => part.trim().startsWith(`${name} `));
    return found?.trim() ?? '';
  };

  it('permits the inline React Refresh preamble, or the window renders nothing at all', async () => {
    const { contentSecurityPolicyFor } = await loadSecurity();
    expect(directive(contentSecurityPolicyFor(DEV_URL), 'script-src')).toBe(
      "script-src 'self' 'unsafe-inline'"
    );
  });

  it('permits the HMR websocket back to the dev server, and nothing else', async () => {
    const { contentSecurityPolicyFor } = await loadSecurity();
    expect(directive(contentSecurityPolicyFor(DEV_URL), 'connect-src')).toBe(
      'connect-src http://localhost:5173 ws://localhost:5173'
    );
  });

  it('follows the dev server to whatever port vite actually took', async () => {
    // Vite moves on when 5173 is busy. A hardcoded port here would reinstate the blocked
    // socket on the one machine that had something else listening — silently.
    const { contentSecurityPolicyFor } = await loadSecurity();
    expect(directive(contentSecurityPolicyFor('http://localhost:5199'), 'connect-src')).toBe(
      'connect-src http://localhost:5199 ws://localhost:5199'
    );
  });

  it("still refuses 'unsafe-eval' — the relaxation is inline scripts, not evaluated ones", async () => {
    const { contentSecurityPolicyFor } = await loadSecurity();
    expect(contentSecurityPolicyFor(DEV_URL)).not.toContain('unsafe-eval');
  });

  it('leaves every other directive exactly as shipped', async () => {
    const { contentSecurityPolicyFor, CONTENT_SECURITY_POLICY } = await loadSecurity();
    const dev = contentSecurityPolicyFor(DEV_URL);
    for (const name of ['default-src', 'object-src', 'frame-src', 'form-action', 'base-uri']) {
      expect(directive(dev, name)).toBe(directive(CONTENT_SECURITY_POLICY, name));
    }
  });

  it('is not reachable without a dev server URL', async () => {
    const { contentSecurityPolicyFor, CONTENT_SECURITY_POLICY } = await loadSecurity();
    expect(contentSecurityPolicyFor(undefined)).toBe(CONTENT_SECURITY_POLICY);
    expect(contentSecurityPolicyFor('')).toBe(CONTENT_SECURITY_POLICY);
  });

  it('does not weaken itself for a URL it cannot parse', async () => {
    const { contentSecurityPolicyFor, CONTENT_SECURITY_POLICY } = await loadSecurity();
    expect(contentSecurityPolicyFor('not a url')).toBe(CONTENT_SECURITY_POLICY);
  });
});

/**
 * The gate on the dev server URL itself, which is audit finding S3.
 *
 * A packaged build must ignore `ELECTRON_RENDERER_URL` completely. Honouring it would let
 * anyone who can set an environment variable choose both what the main window loads and how
 * far the CSP relaxes for it — with the preload bridge attached. One function answers that
 * question for `window.ts` and for `applySessionHardening`, so the two cannot drift.
 */
describe('honouring the dev server URL', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.ELECTRON_RENDERER_URL;
  });

  it('is honoured in development', async () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173';
    const { devRendererUrl } = await loadSecurity();
    expect(devRendererUrl()).toBe('http://localhost:5173');
  });

  it('is undefined when unset, so the window loads from disk', async () => {
    const { devRendererUrl } = await loadSecurity();
    expect(devRendererUrl()).toBeUndefined();
  });

  it('is ignored entirely in a packaged build', async () => {
    vi.doMock('electron', () => ({
      app: { isPackaged: true },
      session: { defaultSession: {} },
      shell: { openExternal: openExternalMock },
    }));
    process.env.ELECTRON_RENDERER_URL = 'http://evil.example';
    const { devRendererUrl, contentSecurityPolicyFor, CONTENT_SECURITY_POLICY } =
      await loadSecurity();
    expect(devRendererUrl()).toBeUndefined();
    // And therefore the shipped policy is what a packaged build serves, whatever is set.
    expect(contentSecurityPolicyFor(devRendererUrl())).toBe(CONTENT_SECURITY_POLICY);
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

/**
 * The handlers actually installed on a WebContents — not the configuration object.
 *
 * This is the gap the audit found: every test above asserts a value in
 * `HARDENED_WEB_PREFERENCES` or the CSP string, and none of them could see that
 * `window.ts` was installing a *second* `setWindowOpenHandler` twenty lines after
 * `hardenWindow`, replacing the hardened one and dropping its scheme check. A defect of
 * that shape leaves every assertion above green. These tests invoke what was registered.
 *
 * Fault injection performed: calling `shell.openExternal(url)` directly in the window-open
 * handler instead of `openExternally(url)` fails "never hands a non-http(s) URI to the OS
 * from the window-open handler"; returning `{ action: 'allow' }` fails "denies every popup";
 * dropping `event.preventDefault()` from `will-attach-webview` fails "prevents a webview
 * from ever attaching".
 */
describe('the handlers applyWebContentsHardening actually installs', () => {
  interface FakeContents {
    handlers: Map<string, (...args: unknown[]) => void>;
    openHandler: ((details: { url: string }) => { action: string }) | null;
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    setWindowOpenHandler: (handler: (details: { url: string }) => { action: string }) => void;
    closeDevTools: () => void;
  }

  const fakeContents = (): FakeContents => {
    const contents: FakeContents = {
      handlers: new Map(),
      openHandler: null,
      on(event, listener) {
        contents.handlers.set(event, listener);
      },
      setWindowOpenHandler(handler) {
        contents.openHandler = handler;
      },
      closeDevTools: vi.fn(),
    };
    return contents;
  };

  const hardened = async () => {
    const security = await loadSecurity();
    const contents = fakeContents();
    security.applyWebContentsHardening(
      contents as unknown as Parameters<typeof security.applyWebContentsHardening>[0]
    );
    return contents;
  };

  it('denies every popup, whatever the URL', async () => {
    const contents = await hardened();
    for (const url of ['https://example.com', 'ms-msdt:-id X', 'not a url']) {
      expect(contents.openHandler?.({ url })).toEqual({ action: 'deny' });
    }
  });

  it('never hands a non-http(s) URI to the OS from the window-open handler', async () => {
    openExternalMock.mockClear();

    const contents = await hardened();
    for (const url of ['ms-msdt:-id PCWDiagnostic', 'file:///C:/Windows/System32/calc.exe', '~']) {
      contents.openHandler?.({ url });
    }
    expect(openExternalMock).not.toHaveBeenCalled();

    contents.openHandler?.({ url: 'https://keyhold.example/docs' });
    expect(openExternalMock).toHaveBeenCalledExactlyOnceWith('https://keyhold.example/docs');
  });

  it('never hands a non-http(s) URI to the OS from will-navigate either', async () => {
    openExternalMock.mockClear();

    const contents = await hardened();
    const willNavigate = contents.handlers.get('will-navigate');
    expect(willNavigate).toBeDefined();

    const event = { preventDefault: vi.fn() };
    // The two paths had drifted once; `location.href = 'ms-msdt:…'` was the hole.
    willNavigate?.(event, 'ms-msdt:-id PCWDiagnostic');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('prevents a webview from ever attaching', async () => {
    const contents = await hardened();
    const event = { preventDefault: vi.fn() };
    contents.handlers.get('will-attach-webview')?.(event);
    expect(event.preventDefault).toHaveBeenCalled();
  });
});

/**
 * Web permissions.
 *
 * There is exactly one exception to the blanket denial and it is written down in
 * `security.ts`: `clipboard-sanitized-write` is write-only and sanitised, it cannot read
 * what the user copied elsewhere, and denying it silently broke the non-secret copy button.
 * Everything that could exfiltrate — `clipboard-read` above all — stays denied.
 *
 * Fault injection performed: adding `'clipboard-read'` to `ALLOWED_PERMISSIONS` fails
 * "denies every permission that could read or capture anything".
 */
describe('web permissions', () => {
  it('allows exactly one permission, and it is write-only', async () => {
    const { isPermissionAllowed } = await loadSecurity();
    expect(isPermissionAllowed('clipboard-sanitized-write')).toBe(true);
  });

  it.each([
    'clipboard-read',
    'media',
    'geolocation',
    'notifications',
    'midiSysex',
    'display-capture',
    'idle-detection',
    'window-management',
    'openExternal',
    'unknown',
  ])('denies %s', async (permission) => {
    const { isPermissionAllowed } = await loadSecurity();
    expect(isPermissionAllowed(permission)).toBe(false);
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
