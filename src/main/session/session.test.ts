// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Session security: clipboard hygiene, unlock throttling, auto-lock settings.
 *
 * Clock-driven behaviour is tested with an injected clock rather than by sleeping. A
 * timing test that sleeps is slow, flaky under load, and — worse — usually written with a
 * generous margin that stops it testing the boundary at all.
 */

const clipboardState = vi.hoisted(() => ({
  text: '',
  lastItems: [] as Record<string, string>[],
}));

/**
 * Electron 44's clipboard is Promise-based and MIME-keyed. `ClipboardItem` is mocked as a
 * plain record so a test can inspect exactly which formats were written *together* — the
 * atomicity of that single write is the property that matters.
 */
vi.mock('electron', () => ({
  ClipboardItem: class {
    constructor(public readonly payload: Record<string, string>) {}
  },
  clipboard: {
    write: (items: { payload: Record<string, string> }[]) => {
      clipboardState.lastItems = items.map((item) => item.payload);
      clipboardState.text = items[0]?.payload['text/plain'] ?? '';
      return Promise.resolve();
    },
    writeText: (text: string) => {
      clipboardState.text = text;
      return Promise.resolve();
    },
    readText: () => Promise.resolve(clipboardState.text),
  },
  powerMonitor: { on: vi.fn(), off: vi.fn(), getSystemIdleTime: () => 0 },
}));

const osFormat = (name: string): string => 'electron application/osclipboard;format="' + name + '"';

/** A controllable clock, so expiry can be asserted at the exact millisecond. */
function fakeClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

beforeEach(() => {
  clipboardState.text = '';
  clipboardState.lastItems = [];
  vi.resetModules();
});

describe('the secret clipboard', () => {
  it('copies the value', async () => {
    const { SecretClipboard } = await import('./clipboard.js');
    await new SecretClipboard().copySecret('hunter2');
    expect(clipboardState.text).toBe('hunter2');
  });

  it('writes the Windows markers in ONE atomic item alongside the text', async () => {
    // Writing plain text first and decorating it afterwards produces two clipboard events,
    // and Windows history captures the first, undecorated one — so the markers would
    // appear to work while achieving nothing.
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const { SecretClipboard } = await import('./clipboard.js');

    await new SecretClipboard().copySecret('hunter2');

    expect(clipboardState.lastItems).toHaveLength(1);
    const item = clipboardState.lastItems[0]!;
    expect(item['text/plain']).toBe('hunter2');
    expect(item).toHaveProperty(osFormat('ExcludeClipboardContentFromMonitorProcessing'));
    expect(item).toHaveProperty(osFormat('CanIncludeInClipboardHistory'));
    expect(item).toHaveProperty(osFormat('CanUploadToCloudClipboard'));

    vi.unstubAllGlobals();
  });

  it('marks the value concealed on macOS, in the same item', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    const { SecretClipboard } = await import('./clipboard.js');

    await new SecretClipboard().copySecret('hunter2');

    const item = clipboardState.lastItems[0]!;
    expect(item['text/plain']).toBe('hunter2');
    expect(item).toHaveProperty(osFormat('org.nspasteboard.ConcealedType'));

    vi.unstubAllGlobals();
  });

  it('clears the value it wrote', async () => {
    const { SecretClipboard } = await import('./clipboard.js');
    const board = new SecretClipboard();

    await board.copySecret('hunter2');
    await board.clear();

    expect(clipboardState.text).toBe('');
    expect(board.state.hasSecret).toBe(false);
  });

  it('does NOT clear something the user copied afterwards', async () => {
    // Without this check, copying a password and then copying a URL means the URL is wiped
    // thirty seconds later, from the user's point of view at random.
    const { SecretClipboard } = await import('./clipboard.js');
    const board = new SecretClipboard();

    await board.copySecret('hunter2');
    clipboardState.text = 'https://example.com';
    await board.clear();

    expect(clipboardState.text).toBe('https://example.com');
  });

  it('reports how long is left, for the countdown', async () => {
    const { SecretClipboard } = await import('./clipboard.js');
    const board = new SecretClipboard();

    await board.copySecret('hunter2', { clearAfterMs: 30_000 });
    const { clearsInMs } = board.state;

    expect(clearsInMs).not.toBeNull();
    expect(clearsInMs!).toBeGreaterThan(29_000);
    expect(clearsInMs!).toBeLessThanOrEqual(30_000);
  });

  it('can be told not to clear at all', async () => {
    const { SecretClipboard } = await import('./clipboard.js');
    const board = new SecretClipboard();

    await board.copySecret('hunter2', { clearAfterMs: null });
    expect(board.state.clearsInMs).toBeNull();
    expect(board.state.hasSecret).toBe(true);
  });

  it('replaces a pending clear when a second secret is copied', async () => {
    const { SecretClipboard } = await import('./clipboard.js');
    const board = new SecretClipboard();

    await board.copySecret('first', { clearAfterMs: 30_000 });
    await board.copySecret('second', { clearAfterMs: 30_000 });

    expect(clipboardState.text).toBe('second');
    expect(board.state.hasSecret).toBe(true);
  });

  it('clears on exit, so locking takes the clipboard with it', async () => {
    // A vault locked while the password it just handed out sits on the clipboard is not
    // really locked.
    const { SecretClipboard } = await import('./clipboard.js');
    const board = new SecretClipboard();

    await board.copySecret('hunter2');
    board.clearOnExit();

    // Deliberately fire-and-forget, so shutdown is never blocked on a clipboard
    // round-trip. The write lands on a later microtask.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(clipboardState.text).toBe('');
  });

  it('notifies listeners on copy and on clear', async () => {
    const { SecretClipboard } = await import('./clipboard.js');
    const board = new SecretClipboard();
    const seen: boolean[] = [];
    board.onChange((state) => seen.push(state.hasSecret));

    await board.copySecret('hunter2');
    await board.clear();

    expect(seen).toEqual([true, false]);
  });
});

describe('unlock throttling', () => {
  it('does not punish the first few typos', async () => {
    const { UnlockThrottle } = await import('./unlock-throttle.js');
    const throttle = new UnlockThrottle({ now: fakeClock().now });

    for (let i = 0; i < 3; i += 1) {
      expect(throttle.recordFailure().lockedForMs).toBe(0);
      expect(throttle.canAttempt()).toBe(true);
    }
  });

  it('starts delaying after the free attempts, and doubles', async () => {
    const clock = fakeClock();
    const { UnlockThrottle } = await import('./unlock-throttle.js');
    const throttle = new UnlockThrottle({ freeAttempts: 3, baseDelayMs: 2_000, now: clock.now });

    for (let i = 0; i < 3; i += 1) throttle.recordFailure();

    expect(throttle.recordFailure().lockedForMs).toBe(2_000);
    clock.advance(2_000);
    expect(throttle.recordFailure().lockedForMs).toBe(4_000);
    clock.advance(4_000);
    expect(throttle.recordFailure().lockedForMs).toBe(8_000);
  });

  it('blocks attempts while the delay is running, and allows one after', async () => {
    const clock = fakeClock();
    const { UnlockThrottle } = await import('./unlock-throttle.js');
    const throttle = new UnlockThrottle({ freeAttempts: 0, baseDelayMs: 1_000, now: clock.now });

    throttle.recordFailure();
    expect(throttle.canAttempt()).toBe(false);

    clock.advance(999);
    expect(throttle.canAttempt()).toBe(false);

    clock.advance(1);
    expect(throttle.canAttempt()).toBe(true);
  });

  it('caps the delay, so a forgotten vault is never locked out for hours', async () => {
    const clock = fakeClock();
    const { UnlockThrottle } = await import('./unlock-throttle.js');
    const throttle = new UnlockThrottle({
      freeAttempts: 0,
      baseDelayMs: 1_000,
      maxDelayMs: 10_000,
      now: clock.now,
    });

    for (let i = 0; i < 20; i += 1) {
      const state = throttle.recordFailure();
      clock.advance(state.lockedForMs);
      expect(state.lockedForMs).toBeLessThanOrEqual(10_000);
    }
  });

  it('resets completely on a successful unlock', async () => {
    const clock = fakeClock();
    const { UnlockThrottle } = await import('./unlock-throttle.js');
    const throttle = new UnlockThrottle({ freeAttempts: 1, baseDelayMs: 5_000, now: clock.now });

    throttle.recordFailure();
    throttle.recordFailure();
    expect(throttle.canAttempt()).toBe(false);

    throttle.recordSuccess();

    expect(throttle.canAttempt()).toBe(true);
    expect(throttle.state.failedAttempts).toBe(0);
  });

  it('tells the UI what the next delay will be, before it is incurred', async () => {
    const { UnlockThrottle } = await import('./unlock-throttle.js');
    const throttle = new UnlockThrottle({
      freeAttempts: 2,
      baseDelayMs: 2_000,
      now: fakeClock().now,
    });

    expect(throttle.state.nextDelayMs).toBe(0);
    throttle.recordFailure();
    expect(throttle.state.nextDelayMs).toBe(0);
    throttle.recordFailure();
    expect(throttle.state.nextDelayMs).toBe(2_000);
  });
});

describe('auto-lock settings', () => {
  it('defaults sensibly: idle and sleep on, minimise and blur off', async () => {
    const { DEFAULT_AUTO_LOCK } = await import('./auto-lock.js');

    expect(DEFAULT_AUTO_LOCK.idleMinutes).toBeGreaterThan(0);
    expect(DEFAULT_AUTO_LOCK.lockOnSleep).toBe(true);
    expect(DEFAULT_AUTO_LOCK.lockOnScreenLock).toBe(true);
    // Minimising to check something else is not walking away. Locking on it makes the app
    // feel paranoid and trains people to turn auto-lock off entirely.
    expect(DEFAULT_AUTO_LOCK.lockOnMinimise).toBe(false);
    expect(DEFAULT_AUTO_LOCK.lockOnBlur).toBe(false);
  });

  it('coerces junk to the defaults', async () => {
    const { coerceAutoLockSettings, DEFAULT_AUTO_LOCK } = await import('./auto-lock.js');

    expect(coerceAutoLockSettings(null)).toEqual(DEFAULT_AUTO_LOCK);
    expect(coerceAutoLockSettings('nonsense')).toEqual(DEFAULT_AUTO_LOCK);
  });

  it('accepts null as "never lock on idle"', async () => {
    const { coerceAutoLockSettings } = await import('./auto-lock.js');
    expect(coerceAutoLockSettings({ idleMinutes: null }).idleMinutes).toBeNull();
  });

  it('rejects a nonsensical idle time rather than locking instantly', async () => {
    const { coerceAutoLockSettings, DEFAULT_AUTO_LOCK } = await import('./auto-lock.js');

    expect(coerceAutoLockSettings({ idleMinutes: 0 }).idleMinutes).toBe(
      DEFAULT_AUTO_LOCK.idleMinutes
    );
    expect(coerceAutoLockSettings({ idleMinutes: -5 }).idleMinutes).toBe(
      DEFAULT_AUTO_LOCK.idleMinutes
    );
    expect(coerceAutoLockSettings({ idleMinutes: Number.NaN }).idleMinutes).toBe(
      DEFAULT_AUTO_LOCK.idleMinutes
    );
  });

  it('caps an absurd idle time at a day', async () => {
    const { coerceAutoLockSettings } = await import('./auto-lock.js');
    expect(coerceAutoLockSettings({ idleMinutes: 999_999 }).idleMinutes).toBe(1_440);
  });

  it('keeps each boolean the user actually set', async () => {
    const { coerceAutoLockSettings } = await import('./auto-lock.js');
    const settings = coerceAutoLockSettings({
      idleMinutes: 5,
      lockOnSleep: false,
      lockOnMinimise: true,
    });

    expect(settings.idleMinutes).toBe(5);
    expect(settings.lockOnSleep).toBe(false);
    expect(settings.lockOnMinimise).toBe(true);
    expect(settings.lockOnScreenLock).toBe(true);
  });
});
