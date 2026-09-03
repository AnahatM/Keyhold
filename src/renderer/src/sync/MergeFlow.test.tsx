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

describe('the conflicted copies found beside the vault', () => {
  /*
   * The reason merging exists at all, in practice: a sync client wrote a second file because
   * two devices saved the same vault. Making the user find that file in a dialog — under a name
   * their client invented, in a folder they did not choose — is asking them to do the app's job,
   * and it is the step at which somebody decides the copy is clutter and deletes it.
   *
   * The property that matters is **which copy gets merged**. The renderer holds ids, never
   * paths, so picking the wrong row means merging the wrong vault with no way to tell from
   * anything on screen.
   *
   * Fault injection performed:
   *  1. Passing no id to `prepare` from the row's button — fails "merges the copy that was
   *     picked, by its id".
   *  2. Not clearing `chosenId` on either route out of a chosen copy — fails "a failed copy is
   *     not the one retried". This injection failed **nothing** at first: the only test for it
   *     went to the dialog without ever picking a copy, so the id was already `undefined` and
   *     the clearing could not matter. Looking for a path where it *could* found a real bug —
   *     the failure screen's "Choose another file" re-prepared the copy that had just failed,
   *     while saying otherwise. Both routes now clear it, and this is the test.
   *  3. Removing the `found.length > 0` gate — fails "goes straight to the dialog when there is
   *     nothing beside the vault", showing an empty picker.
   */

  const candidate = (id: string, fileName: string, modifiedAt = 1_700_000_000_000) => ({
    id,
    fileName,
    modifiedAt,
    recordCount: 12,
    generation: 9,
  });

  const withCandidates = (
    gateway: FakeSyncGateway,
    ...items: ReturnType<typeof candidate>[]
  ): FakeSyncGateway => {
    gateway.candidateList.push(...items);
    return gateway;
  };

  it('offers what was found, named and dated', async () => {
    const gateway = withCandidates(
      new FakeSyncGateway(preview(report())),
      candidate('c1', "personal (Anahat's conflicted copy 2026-09-03).keep")
    );
    // Held open so that, if the picker were skipped, the test would sit on the waiting screen
    // rather than racing through to the resolver and passing for the wrong reason.
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

    const text = textOf(tree.container);
    expect(text).toContain("personal (Anahat's conflicted copy 2026-09-03).keep");
    expect(text).toContain('12 items');
    // Nothing has been read yet: the picker is built from headers, and `prepare` is what
    // decrypts.
    expect(gateway.prepareCalls).toBe(0);
  });

  it('merges the copy that was picked, by its id', async () => {
    const gateway = withCandidates(
      new FakeSyncGateway(preview(report())),
      candidate('first', 'a.keep'),
      candidate('second', 'b.keep')
    );

    tree = mountReact(
      <MergeFlow
        gateway={gateway}
        names={names()}
        onClose={noop}
        subscribeToKdfProgress={noKdfProgress}
      />
    );
    await settle();

    // The second row, not the first. The renderer holds ids and never paths, so picking the
    // wrong one merges the wrong vault with nothing on screen to say so.
    const buttons = [...tree.container.querySelectorAll('button')].filter((button) =>
      button.textContent.includes('Merge this one')
    );
    expect(buttons).toHaveLength(2);

    await act(async () => {
      buttons[1]?.click();
      await Promise.resolve();
    });
    await settle();

    expect(gateway.preparedFrom).toEqual(['second']);
  });

  it('a failed copy is not the one retried, however the retry is reached', async () => {
    // The path that made the clearing load-bearing. Pick a copy, have `prepare` refuse it, then
    // press the button labelled "Choose another file" — which has to mean the dialog, not the
    // copy that just failed.
    const gateway = withCandidates(
      new FakeSyncGateway(preview(report())),
      candidate('bad', 'broken.keep')
    );
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

    await act(async () => {
      [...tree!.container.querySelectorAll('button')]
        .find((button) => button.textContent.includes('Merge this one'))
        ?.click();
      await Promise.resolve();
    });
    await settle();
    expect(gateway.preparedFrom).toEqual(['bad']);

    gateway.prepareOutcome = 'preview';
    await act(async () => {
      [...tree!.container.querySelectorAll('button')]
        .find((button) => button.textContent.includes('Choose another file'))
        ?.click();
      await Promise.resolve();
    });
    await settle();

    expect(gateway.preparedFrom).toEqual(['bad', undefined]);
  });

  it('forgets the copy when the user asks for the dialog instead', async () => {
    const gateway = withCandidates(
      new FakeSyncGateway(preview(report())),
      candidate('c1', 'a.keep')
    );

    tree = mountReact(
      <MergeFlow
        gateway={gateway}
        names={names()}
        onClose={noop}
        subscribeToKdfProgress={noKdfProgress}
      />
    );
    await settle();

    const instead = [...tree.container.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Choose a different file instead')
    );
    expect(instead).toBeDefined();

    await act(async () => {
      instead?.click();
      await Promise.resolve();
    });
    await settle();

    // `undefined`, which is the dialog. A stale id here would merge the copy just declined.
    expect(gateway.preparedFrom).toEqual([undefined]);
  });

  it('goes straight to the dialog when there is nothing beside the vault', async () => {
    // The ordinary case, and it gets no screen of its own — a picker listing nothing would be
    // a step the user has to dismiss before doing what they asked for.
    const gateway = new FakeSyncGateway(preview(report()));

    tree = mountReact(
      <MergeFlow
        gateway={gateway}
        names={names()}
        onClose={noop}
        subscribeToKdfProgress={noKdfProgress}
      />
    );
    await settle();

    expect(textOf(tree.container)).not.toContain('sitting next to it');
    expect(gateway.preparedFrom).toEqual([undefined]);
  });

  it('goes to the dialog when the scan itself fails', async () => {
    // A directory that cannot be listed is not a reason to refuse to merge. The user asked for
    // something; the fallback is the thing that always worked.
    const gateway = new FakeSyncGateway(preview(report()));
    gateway.candidates = () => Promise.reject(new Error('EACCES'));

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
  });
});
