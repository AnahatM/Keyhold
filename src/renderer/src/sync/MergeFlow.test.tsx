// SPDX-License-Identifier: GPL-3.0-or-later
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { mountReact, type MountedTree } from '../chrome/test-dom.js';
import { FakeSyncGateway } from './fake-sync-gateway.js';
import { MergeFlow } from './MergeFlow.js';
import { SyncGatewayError } from './sync-gateway.js';
import type { KdfProgressView } from '@shared/model/kdf-progress.js';
import { names, preview, report } from './test-fixtures.js';

/**
 * The step in front of the resolver.
 *
 * `MergeResolver` is handed a prepared preview, so none of its tests can reach the three
 * states that exist before one is available: waiting on `prepare`, a dismissed file dialog,
 * and a file that would not open. Those are three different screens, and this is the only
 * place any of them is rendered.
 *
 * The fourth case is not a screen at all and is the reason this file matters most: the vault
 * locking, or the user cancelling, while Argon2 is still running. `prepare` then lands on an
 * unmounted component holding a decrypted copy of another whole vault. Nothing about that is
 * visible, so only a test can hold it.
 *
 * Fault injection performed, one per test:
 *  1. Deleting the `preview === null` branch so a dismissed dialog falls through — fails
 *     "closes without a screen when the file dialog is dismissed" (the flow renders the
 *     resolver against a null preview and throws instead of closing).
 *  2. Swallowing the `catch` without setting a phase — fails both tests in "a file that would
 *     not open": the flow sits on the waiting screen forever, so neither the message nor the
 *     retry button is ever rendered.
 *  3. Removing the `if (!isLive())` discard — fails "discards a plan that arrives after the
 *     screen has gone" with `discardCalls: []`. This test was written first and failed
 *     against the original implementation, which put the discard in the effect's teardown:
 *     that runs at unmount, before `prepare` has returned an id, so it discarded nothing.
 *  4. Removing `setAttempt` from the retry button — fails "asks again when told to choose
 *     another file", `prepareCalls` staying at 1.
 */

let tree: MountedTree | null = null;

afterEach(() => {
  tree?.unmount();
  tree = null;
});

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const noop = (): void => undefined;

/** No bridge in a unit test, and no reports either: the bar simply never appears. */
const noKdfProgress = (): (() => void) => () => undefined;

function textOf(container: HTMLElement): string {
  return container.textContent;
}

describe('waiting for prepare', () => {
  it('says what the wait is for while the bar has nothing to report yet', async () => {
    const gateway = new FakeSyncGateway(preview(report()));
    // Held open, so the waiting state is the one on screen when the assertion runs.
    gateway.prepareGate = new Promise<void>(() => undefined);

    tree = mountReact(
      <MergeFlow
        gateway={gateway}
        names={names()}
        onClose={noop}
        subscribeToKdfProgress={noKdfProgress}
      />
    );
    await settle();

    // The sentence is there from the first frame. The bar is not, and that is deliberate: it
    // appears when the main process has something to report rather than showing a position
    // nothing has reported yet.
    expect(textOf(tree.container)).toContain('backing this one up');
    expect(tree.container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('shows the shared Argon2 bar once the main process reports one', async () => {
    const gateway = new FakeSyncGateway(preview(report()));
    gateway.prepareGate = new Promise<void>(() => undefined);

    let emit: ((progress: KdfProgressView) => void) | null = null;
    tree = mountReact(
      <MergeFlow
        gateway={gateway}
        names={names()}
        onClose={noop}
        subscribeToKdfProgress={(listener) => {
          emit = listener;
          return () => undefined;
        }}
      />
    );
    await settle();

    await act(async () => {
      emit?.({ fraction: 0.42, elapsedMs: 420, estimatedMs: 1_000, overdue: false });
      await Promise.resolve();
    });

    const bar = tree.container.querySelector('[role="progressbar"]');
    expect(bar).not.toBeNull();
    // The position is the predicted one, as a percentage, because the bar speaks its value.
    expect(bar?.getAttribute('aria-valuenow')).toBe('42');
    expect(textOf(tree.container)).toContain('Reading the other copy');
  });
});

describe('a dismissed file dialog', () => {
  it('closes without a screen, because nothing happened', async () => {
    let closed = 0;
    const gateway = new FakeSyncGateway(preview(report()));
    gateway.prepareOutcome = 'cancelled';

    tree = mountReact(
      <MergeFlow
        gateway={gateway}
        names={names()}
        subscribeToKdfProgress={noKdfProgress}
        onClose={() => {
          closed += 1;
        }}
      />
    );
    await settle();

    expect(closed).toBe(1);
    // Not an error screen, and not an empty resolver: changing your mind in a file dialog is
    // not a failure and must not be reported as one.
    expect(textOf(tree.container)).not.toContain('could not be merged');
    expect(gateway.discardCalls).toEqual([]);
  });
});

describe('a file that would not open', () => {
  it('explains it in terms of the thing the user got wrong', async () => {
    const gateway = new FakeSyncGateway(preview(report()));
    gateway.prepareOutcome = {
      error: new SyncGatewayError('sync/unreadable', 'That file could not be decrypted.', true),
    };

    tree = mountReact(
      <MergeFlow
        gateway={gateway}
        names={names()}
        onClose={noop}
        subscribeToKdfProgress={noKdfProgress}
      />
    );
    await settle();

    const text = textOf(tree.container);
    expect(text).toContain('could not be merged');
    expect(text).toContain('That file could not be decrypted.');
    // The likely cause, stated: a merge is between two copies of one vault, and picking
    // somebody else's vault is the mistake this message exists to name.
    expect(text).toContain('same master password');
  });

  it('asks again when told to choose another file', async () => {
    const gateway = new FakeSyncGateway(preview(report()));
    gateway.prepareOutcome = {
      error: new SyncGatewayError('sync/unreadable', 'Not a vault.', true),
    };

    tree = mountReact(
      <MergeFlow
        gateway={gateway}
        names={names()}
        onClose={noop}
        subscribeToKdfProgress={noKdfProgress}
      />
    );
    await settle();
    expect(gateway.prepareCalls).toBe(1);

    const retry = [...tree.container.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Choose another file')
    );
    expect(retry).toBeDefined();

    gateway.prepareOutcome = 'preview';
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    await settle();

    expect(gateway.prepareCalls).toBe(2);
    // And it got somewhere: the second attempt succeeded, so the resolver is on screen.
    expect(textOf(tree.container)).toContain('Settle this merge');
  });
});

describe('unmounting while Argon2 is still running', () => {
  it('discards a plan that arrives after the screen has gone', async () => {
    // The leak: `prepare` holds a decrypted copy of another whole vault from the moment it
    // returns. If the vault auto-locks — or the user cancels — during the KDF, the component
    // that would have owned that plan no longer exists, and nothing else knows the id.
    let release = (): void => undefined;
    const gateway = new FakeSyncGateway(preview(report(), 'plan-left-behind'));
    gateway.prepareGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    tree = mountReact(
      <MergeFlow
        gateway={gateway}
        names={names()}
        onClose={noop}
        subscribeToKdfProgress={noKdfProgress}
      />
    );
    await settle();
    expect(gateway.discardCalls).toEqual([]);

    tree.unmount();
    tree = null;

    // Argon2 finishes after the screen is gone.
    await act(async () => {
      release();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(gateway.discardCalls).toEqual(['plan-left-behind']);
  });
});
