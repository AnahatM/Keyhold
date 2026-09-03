// SPDX-License-Identifier: GPL-3.0-or-later
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { mountReact, type MountedTree } from '../chrome/test-dom.js';
import { FakeSyncGateway } from './fake-sync-gateway.js';
import { MergeResolver } from './MergeResolver.js';
import {
  conflict,
  names,
  plantedReport,
  preview,
  report,
  secret,
  value,
  PLANTED_SECRET,
} from './test-fixtures.js';

/**
 * The resolver, driven through a real mount.
 *
 * The pure modules prove the *rules*. This proves the components call them, and it carries the
 * two assertions that cannot be made anywhere else:
 *
 *  - **no secret value reaches the screen**, driven from a report whose sides are all
 *    length-carrying *and* carry a planted value the real projection would never send; and
 *  - **nothing is written until everything is settled**, driven all the way to the gateway,
 *    which refuses a commit on an unsettled report exactly as `MergeSessionStore` does.
 *
 * `@testing-library/react` is not a dependency of this project, so this drives
 * `react-dom/client` through the same `mountReact` harness the chrome, the export dialog and the
 * import wizard use.
 *
 * Fault injections performed against this file:
 *
 *  1. Rendering `{JSON.stringify(conflict)}` inside `ConflictRow` — fails "no planted secret
 *     reaches the screen, in text or in any attribute".
 *  2. `ConflictSideCard` rendering `(side as { value?: string }).value` in its body — fails the
 *     same assertion, from the other direction.
 *  3. `MergeResolver` enabling apply on `summary.remaining === 0` — fails "will not apply while
 *     the engine has not seen the answers" (the fake gateway refuses, so the vault is not
 *     written and the assertion is on the gateway, not on a disabled attribute).
 *  4. `use-merge-resolver` sending only the newest choice to `resolve` — fails "sends the whole
 *     accumulated choice map, not a delta".
 *  5. Dropping the unmount `discard` effect — fails "drops the plan, and the decrypted copy of
 *     the other vault, on unmount".
 *  6. `ConflictGroupCard` rendering `group.targetId` instead of `group.target.name` — fails "names
 *     records by title and never by conflict id".
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
  });
}

/**
 * Everything the screen puts in front of a user: text, every attribute value, and every form
 * value. A leak into a `title`, an `aria-label` or a `value` is a leak no `textContent` check
 * would ever see.
 */
function everythingRendered(root: HTMLElement): string {
  const parts: string[] = [root.textContent, document.body.textContent];
  for (const element of root.querySelectorAll('*')) {
    for (const attribute of element.attributes) parts.push(attribute.value);
    if (element instanceof HTMLInputElement) parts.push(element.value);
    if (element instanceof HTMLTextAreaElement) parts.push(element.value);
  }
  return parts.join('\n');
}

function radiosFor(root: HTMLElement, conflictId: string): readonly HTMLInputElement[] {
  return [...root.querySelectorAll<HTMLInputElement>(`input[type="radio"]`)].filter(
    (input) => input.name === conflictId
  );
}

function buttonLabelled(root: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    [...root.querySelectorAll('button')].find((button) => button.textContent.includes(text)) ?? null
  );
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

const noop = (): void => undefined;

describe('no secret reaches the screen', () => {
  it('no planted secret reaches the screen, in text or in any attribute', async () => {
    const source = plantedReport('two-way');
    const gateway = new FakeSyncGateway(preview(source));

    tree = mountReact(
      <MergeResolver gateway={gateway} preview={preview(source)} names={names()} onClose={noop} />
    );
    await settle();

    const rendered = everythingRendered(tree.container);
    expect(rendered).not.toContain(PLANTED_SECRET);
    // And the sweep is only worth something if it saw a populated screen.
    expect(rendered).toContain('GitHub');
    expect(rendered).toContain('Password');
  });

  it('renders the length of a hidden value, which is all that crossed the bridge', async () => {
    const source = plantedReport('three-way');
    tree = mountReact(
      <MergeResolver
        gateway={new FakeSyncGateway(preview(source))}
        preview={preview(source)}
        names={names()}
        onClose={noop}
      />
    );
    await settle();

    const rendered = tree.container.textContent;
    expect(rendered).toContain('Hidden — 18 characters');
    expect(rendered).toContain('Hidden — 24 characters');
  });

  it('offers no control anywhere that reveals a value', async () => {
    const source = plantedReport('two-way');
    tree = mountReact(
      <MergeResolver
        gateway={new FakeSyncGateway(preview(source))}
        preview={preview(source)}
        names={names()}
        onClose={noop}
        onOpenRecord={noop}
      />
    );
    await settle();

    const labels = [...tree.container.querySelectorAll('button')].map((button) =>
      button.textContent.toLowerCase()
    );
    expect(labels.some((label) => label.includes('reveal'))).toBe(false);
    expect(labels.some((label) => label.includes('show password'))).toBe(false);
    // The one route to a value is the record's own view, which reveals one item at a time.
    expect(labels.some((label) => label.includes('open github in the vault'))).toBe(true);
  });
});

describe('naming what is in dispute', () => {
  it('names records by title and never by conflict id', async () => {
    const source = report({
      conflicts: [
        conflict({ targetId: 'rec-1', field: 'password', ours: secret(4), theirs: secret(6) }),
      ],
    });
    tree = mountReact(
      <MergeResolver
        gateway={new FakeSyncGateway(preview(source))}
        preview={preview(source)}
        names={names()}
        onClose={noop}
      />
    );
    await settle();

    const text = tree.container.textContent;
    expect(text).toContain('GitHub');
    expect(text).toContain('Password');
    expect(text).not.toContain('record:rec-1:field:password');
  });
});

describe('two-way is presented as its own situation', () => {
  it('explains the mode before the list, and says nothing was deleted', async () => {
    const source = report({ mode: 'two-way', conflicts: [conflict()] });
    tree = mountReact(
      <MergeResolver
        gateway={new FakeSyncGateway(preview(source))}
        preview={preview(source)}
        names={names()}
        onClose={noop}
      />
    );
    await settle();

    const banner = tree.container.querySelector('[data-mode="two-way"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('never been merged before');
    expect(banner?.textContent).toContain('Nothing has been deleted');
  });

  it('shows no ancestor line in two-way mode, and one in three-way', async () => {
    // `base` is deliberately *not* null here, though the engine documents that it always is in
    // two-way mode. A first draft used `base: null` and so proved nothing: the row's own
    // null-check hid the line, and deleting the mode guard entirely still passed. Supplying a
    // base the engine could never send is what makes the mode guard the thing under test.
    const twoWay = report({
      mode: 'two-way',
      conflicts: [conflict({ base: value('impossible'), ours: value('a'), theirs: value('b') })],
    });
    tree = mountReact(
      <MergeResolver
        gateway={new FakeSyncGateway(preview(twoWay))}
        preview={preview(twoWay)}
        names={names()}
        onClose={noop}
      />
    );
    await settle();
    expect(tree.container.querySelector('.kh-conflict__base')).toBeNull();
    tree.unmount();

    const threeWay = report({ conflicts: [conflict()] });
    tree = mountReact(
      <MergeResolver
        gateway={new FakeSyncGateway(preview(threeWay))}
        preview={preview(threeWay)}
        names={names()}
        onClose={noop}
      />
    );
    await settle();
    expect(tree.container.querySelector('.kh-conflict__base')?.textContent).toContain(
      'last agreed'
    );
  });
});

describe('nothing is written until everything is settled', () => {
  const twoConflicts = () =>
    report({
      conflicts: [
        conflict({
          targetId: 'rec-1',
          field: 'title',
          ours: value('Git'),
          theirs: value('GitHub'),
        }),
        conflict({ targetId: 'rec-2', field: 'username', ours: value('a'), theirs: value('b') }),
      ],
    });

  it('will not apply while the engine has not seen the answers', async () => {
    const source = twoConflicts();
    const gateway = new FakeSyncGateway(preview(source));
    tree = mountReact(
      <MergeResolver gateway={gateway} preview={preview(source)} names={names()} onClose={noop} />
    );
    await settle();

    // Answer both, but do not re-check.
    for (const c of source.conflicts) {
      const radios = radiosFor(tree.container, c.id);
      await click(radios[0]!);
    }

    expect(buttonLabelled(tree.container, 'Apply merge')).toBeNull();
    expect(buttonLabelled(tree.container, 'Check the merge')).not.toBeNull();
    expect(gateway.commitCalls).toEqual([]);
    expect(gateway.latest.requiresResolution).toBe(true);
  });

  it('sends the whole accumulated choice map, not a delta', async () => {
    const source = twoConflicts();
    const gateway = new FakeSyncGateway(preview(source));
    tree = mountReact(
      <MergeResolver gateway={gateway} preview={preview(source)} names={names()} onClose={noop} />
    );
    await settle();

    await click(radiosFor(tree.container, source.conflicts[0]!.id)[0]!);
    await click(radiosFor(tree.container, source.conflicts[1]!.id)[1]!);
    await click(buttonLabelled(tree.container, 'Check the merge')!);
    await settle();

    expect(gateway.resolveCalls).toHaveLength(1);
    expect(gateway.resolveCalls[0]?.choices).toEqual({
      [source.conflicts[0]!.id]: 'ours',
      [source.conflicts[1]!.id]: 'theirs',
    });
  });

  it('applies only after the merge has been re-run, and applies once', async () => {
    const source = twoConflicts();
    const gateway = new FakeSyncGateway(preview(source));
    tree = mountReact(
      <MergeResolver gateway={gateway} preview={preview(source)} names={names()} onClose={noop} />
    );
    await settle();

    for (const c of source.conflicts) {
      await click(radiosFor(tree.container, c.id)[0]!);
    }
    await click(buttonLabelled(tree.container, 'Check the merge')!);
    await settle();

    const apply = buttonLabelled(tree.container, 'Apply merge');
    expect(apply).not.toBeNull();
    expect(apply?.disabled).toBe(false);

    await click(apply!);
    await settle();

    expect(gateway.commitCalls).toEqual(['plan-1']);
    expect(tree.container.textContent).toContain('The merge has been applied');
  });

  it('a merge with nothing to settle can be applied straight away', async () => {
    const source = report();
    const gateway = new FakeSyncGateway(preview(source));
    tree = mountReact(
      <MergeResolver gateway={gateway} preview={preview(source)} names={names()} onClose={noop} />
    );
    await settle();

    expect(tree.container.textContent).toContain('Nothing to settle');
    const apply = buttonLabelled(tree.container, 'Apply merge');
    expect(apply?.disabled).toBe(false);
  });
});

describe('a re-merge that changes the questions', () => {
  it('keeps answers by conflict id and says when new questions appeared', async () => {
    const first = report({
      conflicts: [
        conflict({ targetId: 'rec-1', field: 'title', ours: value('a'), theirs: value('b') }),
      ],
    });
    const gateway = new FakeSyncGateway(preview(first));
    // Folding the answer in surfaces a second question inside the record that was kept.
    gateway.scripted.push(
      report({
        conflicts: [
          conflict({
            targetId: 'rec-1',
            field: 'title',
            resolution: 'user',
            applied: 'ours',
            ours: value('a'),
            theirs: value('b'),
          }),
          conflict({ targetId: 'rec-1', field: 'username', ours: value('c'), theirs: value('d') }),
        ],
      })
    );

    tree = mountReact(
      <MergeResolver gateway={gateway} preview={preview(first)} names={names()} onClose={noop} />
    );
    await settle();

    await click(radiosFor(tree.container, first.conflicts[0]!.id)[0]!);
    await click(buttonLabelled(tree.container, 'Check the merge')!);
    await settle();

    expect(tree.container.textContent).toContain('1 new question appeared');
    // The original answer survived the round trip, so only the new one is outstanding.
    expect(tree.container.textContent).toContain('1 of 2 disagreements still to answer.');
    expect(radiosFor(tree.container, first.conflicts[0]!.id)[0]?.checked).toBe(true);
  });
});

describe('the bulk line, on screen', () => {
  it('refuses to sweep hidden values across records, and says how many it left', async () => {
    const source = plantedReport('two-way');
    tree = mountReact(
      <MergeResolver
        gateway={new FakeSyncGateway(preview(source))}
        preview={preview(source)}
        names={names()}
        onClose={noop}
      />
    );
    await settle();

    const bulk = tree.container.querySelector('.kh-merge-bulk');
    expect(bulk?.textContent).toContain('None of these can be answered together');
    expect(bulk?.textContent).toContain('4 conflicts here are left out');
    expect(buttonLabelled(tree.container, 'Keep this device for')).toBeNull();
  });

  it('offers a sweep only for the conflicts whose values are shown', async () => {
    const source = report({
      mode: 'two-way',
      conflicts: [
        conflict({ targetId: 'rec-1', field: 'title', ours: value('a'), theirs: value('b') }),
        conflict({ targetId: 'rec-2', field: 'password', ours: secret(3), theirs: secret(9) }),
      ],
    });
    tree = mountReact(
      <MergeResolver
        gateway={new FakeSyncGateway(preview(source))}
        preview={preview(source)}
        names={names()}
        onClose={noop}
      />
    );
    await settle();

    const sweep = buttonLabelled(tree.container, 'Keep this device for 1');
    expect(sweep).not.toBeNull();

    await click(sweep!);
    // The visible one is answered; the password is untouched and still counted.
    expect(tree.container.textContent).toContain('1 of 2 differences still to answer.');
    expect(radiosFor(tree.container, source.conflicts[1]!.id)[0]?.checked).toBe(false);
  });
});

describe('the decrypted copy of the other vault', () => {
  it('drops the plan, and the decrypted copy of the other vault, on unmount', async () => {
    const source = report({ conflicts: [conflict()] });
    const gateway = new FakeSyncGateway(preview(source));
    tree = mountReact(
      <MergeResolver gateway={gateway} preview={preview(source)} names={names()} onClose={noop} />
    );
    await settle();
    expect(gateway.discardCalls).toEqual([]);

    tree.unmount();
    tree = null;
    await act(async () => {
      await Promise.resolve();
    });

    expect(gateway.discardCalls).toEqual(['plan-1']);
  });
});
