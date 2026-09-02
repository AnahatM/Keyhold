// SPDX-License-Identifier: GPL-3.0-or-later

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PLAINTEXT_CONFIRMATION_PHRASE } from '@shared/model/export-plan.js';
import { mountReact, type MountedTree } from '../chrome/test-dom.js';
import { ExportDialogBody } from './ExportDialogBody.js';
import {
  fakeExportGateway,
  strongEnough,
  tooWeak,
  type FakeExportGateway,
} from './fake-export-gateway.js';
import { STRENGTH_DEBOUNCE_MS } from './use-export-dialog.js';

/**
 * The wiring, through a real mount.
 *
 * `export-steps.test.ts` proves the *rules*. This proves the components actually call them
 * — which is the half a pure test cannot cover and the half that breaks when someone adds a
 * button. `@testing-library/react` is not a dependency of this project, so this drives
 * `react-dom/client` through the same `mountReact` harness the chrome uses.
 *
 * The assertion that matters is negative and appears twice: `gateway.runPlans` is **empty**
 * until the confirmation phrase has actually been typed. A regression that re-enabled the
 * button, skipped the step, or pre-filled the field would show up here as a plan that
 * exists when it should not.
 *
 * jsdom does not implement `HTMLDialogElement.showModal`, so this runs against `Modal`'s
 * documented fallback path — the focus trap is the platform's and is not covered here.
 */

const noop = (): void => undefined;

/** Flushes the microtasks the gateway's promises resolve in. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Flushes the passphrase meter's debounce as well as the microtasks.
 *
 * The parcel gate is the one control in this dialog that waits on a *timer* rather than on
 * a promise: `useExportDialog` debounces `estimateStrength` by `STRENGTH_DEBOUNCE_MS` so a
 * dictionary pass does not run per keystroke. `settle()` alone therefore leaves `strength`
 * at `null` and the Create button correctly — but uninterestingly — disabled, which would
 * make this test pass for the wrong reason if it were ever inverted.
 */
async function settleStrength(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, STRENGTH_DEBOUNCE_MS + 20));
  });
  await settle();
}

/**
 * Sets a controlled input's value the way a user would.
 *
 * React installs its own `value` setter on the element, so assigning `input.value` directly
 * updates the DOM without React ever hearing about it. Going through the prototype's setter
 * and dispatching `input` is what makes React's `onChange` fire.
 */
function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    // `Reflect.set` with the element as the *receiver* runs the prototype's setter against
    // it, rather than pulling the setter out of a property descriptor and calling it —
    // which is the unbound-method shape the linter is right to ask about everywhere else.
    Reflect.set(HTMLInputElement.prototype, 'value', value, input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function labelOf(button: HTMLButtonElement): string {
  return button.textContent.trim();
}

function buttonLabelled(tree: MountedTree, label: string): HTMLButtonElement {
  const buttons = [...tree.container.querySelectorAll('button')];
  const found = buttons.find((button) => labelOf(button) === label);
  if (found === undefined) {
    throw new Error(`no button labelled "${label}". Present: ${buttons.map(labelOf).join(' | ')}`);
  }
  return found;
}

function radioFor(tree: MountedTree, formatId: string): HTMLInputElement {
  const found = tree.container.querySelector<HTMLInputElement>(`input[value="${formatId}"]`);
  if (found === null) throw new Error(`no format radio for ${formatId}`);
  return found;
}

function click(element: HTMLElement): void {
  act(() => {
    element.click();
  });
}

let mounted: MountedTree | null = null;

async function open(gateway: FakeExportGateway): Promise<MountedTree> {
  const tree = mountReact(
    <ExportDialogBody gateway={gateway} selectedIds={['a', 'b']} onClose={noop} />
  );
  mounted = tree;
  await settle();
  return tree;
}

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
});

describe('the export dialog', () => {
  it('renders the formats the gateway returned, in the order it returned them', async () => {
    const gateway = fakeExportGateway();
    const tree = await open(gateway);

    const values = [...tree.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
      .map((radio) => radio.value)
      .filter((value) => value !== '');

    // The encrypted parcel is first because the engine puts it first. The dialog does not
    // sort, and this is what would catch it starting to.
    expect(values.slice(0, 4)).toEqual([
      'keyhold-parcel',
      'keyhold-json',
      'keyhold-csv',
      'compatible-csv',
    ]);
  });

  it('will not continue until a format is chosen', async () => {
    const gateway = fakeExportGateway();
    const tree = await open(gateway);

    expect(buttonLabelled(tree, 'Continue').disabled).toBe(true);

    click(radioFor(tree, 'keyhold-csv'));
    await settle();

    expect(buttonLabelled(tree, 'Continue').disabled).toBe(false);
  });

  it('never asks the engine to write a plaintext file before the phrase is typed', async () => {
    const gateway = fakeExportGateway();
    const tree = await open(gateway);

    click(radioFor(tree, 'keyhold-csv'));
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();

    // On the confirm step. The button is present, named after the consequence, and dead.
    const exportButton = buttonLabelled(tree, 'Export unencrypted');
    expect(exportButton.disabled).toBe(true);

    // Pressing it anyway must do nothing at all.
    click(exportButton);
    await settle();
    expect(gateway.runPlans).toHaveLength(0);

    // So must a near-miss.
    const field = tree.container.querySelector<HTMLInputElement>('input[type="text"]');
    expect(field).not.toBeNull();
    typeInto(field!, 'export');
    await settle();
    expect(buttonLabelled(tree, 'Export unencrypted').disabled).toBe(true);
    click(buttonLabelled(tree, 'Export unencrypted'));
    await settle();
    expect(gateway.runPlans).toHaveLength(0);

    // And the phrase itself must.
    typeInto(field!, PLAINTEXT_CONFIRMATION_PHRASE);
    await settle();
    expect(buttonLabelled(tree, 'Export unencrypted').disabled).toBe(false);
    click(buttonLabelled(tree, 'Export unencrypted'));
    await settle();

    expect(gateway.runPlans).toHaveLength(1);
    const plan = gateway.runPlans[0]!;
    expect(plan.kind).toBe('plaintext');
    expect(plan.format).toBe('keyhold-csv');
    expect(plan.scope.includeTrashed).toBe(false);
  });

  it('shows the engine’s warning and its itemised losses on the confirm step', async () => {
    const gateway = fakeExportGateway();
    const tree = await open(gateway);

    click(radioFor(tree, 'keyhold-csv'));
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();

    const text = tree.container.textContent;
    expect(text).toContain('This file will not be encrypted.');
    expect(text).toContain('cloud sync');
    expect(text).toContain('Not in the file');
    expect(text).toContain('history');

    // The warning is announced, not merely coloured.
    const alert = tree.container.querySelector('.kh-export-danger[role="alert"]');
    expect(alert).not.toBeNull();
  });

  it('marks the current step with aria-current and moves focus onto its heading', async () => {
    const gateway = fakeExportGateway();
    const tree = await open(gateway);

    const current = (): string | null =>
      tree.container.querySelector('[aria-current="step"]')?.textContent ?? null;

    expect(current()).toContain('Format');

    click(radioFor(tree, 'keyhold-csv'));
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();

    expect(current()).toContain('What to include');
    expect(document.activeElement).toBe(tree.container.querySelector('.kh-export-step__heading'));
  });

  it('starts with trashed records out, and states the count in both directions', async () => {
    const gateway = fakeExportGateway();
    const tree = await open(gateway);

    click(radioFor(tree, 'keyhold-csv'));
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();

    const checkbox = tree.container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(false);
    expect(tree.container.textContent).toContain('3 records in the Trash will be left out.');

    click(checkbox!);
    await settle();

    expect(tree.container.textContent).toContain(
      '3 records in the Trash will be included in this file.'
    );
  });

  it('carries the trash decision into the plan when it is turned on', async () => {
    const gateway = fakeExportGateway();
    const tree = await open(gateway);

    click(radioFor(tree, 'keyhold-csv'));
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();
    click(tree.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();

    typeInto(
      tree.container.querySelector<HTMLInputElement>('input[type="text"]')!,
      PLAINTEXT_CONFIRMATION_PHRASE
    );
    await settle();
    click(buttonLabelled(tree, 'Export unencrypted'));
    await settle();

    expect(gateway.runPlans[0]?.scope.includeTrashed).toBe(true);
  });

  it('forgets a typed confirmation when the format changes', async () => {
    const gateway = fakeExportGateway();
    const tree = await open(gateway);

    click(radioFor(tree, 'keyhold-csv'));
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();

    typeInto(
      tree.container.querySelector<HTMLInputElement>('input[type="text"]')!,
      PLAINTEXT_CONFIRMATION_PHRASE
    );
    await settle();
    expect(buttonLabelled(tree, 'Export unencrypted').disabled).toBe(false);

    // Back to the format step, choose a different plaintext format, and forward again. A
    // confirmation carried across a format change would mean confirming one file and
    // writing another.
    click(buttonLabelled(tree, 'Back'));
    await settle();
    click(buttonLabelled(tree, 'Back'));
    await settle();
    click(radioFor(tree, 'keyhold-json'));
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();

    expect(buttonLabelled(tree, 'Export unencrypted').disabled).toBe(true);
    expect(gateway.runPlans).toHaveLength(0);
  });

  it('gates the parcel on a passphrase entered twice and strong enough', async () => {
    const gateway = fakeExportGateway({ strength: () => strongEnough() });
    const tree = await open(gateway);

    click(radioFor(tree, 'keyhold-parcel'));
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();

    const create = (): HTMLButtonElement => buttonLabelled(tree, 'Create parcel');
    expect(create().disabled).toBe(true);

    const fields = [...tree.container.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    expect(fields).toHaveLength(2);

    // One field filled is not a passphrase entered twice, however strong it scores.
    typeInto(fields[0]!, 'correct horse battery staple');
    await settleStrength();
    expect(create().disabled).toBe(true);

    typeInto(fields[1]!, 'correct horse battery stapl');
    await settleStrength();
    expect(create().disabled).toBe(true);
    expect(tree.container.textContent).toContain('The two passphrases do not match.');

    typeInto(fields[1]!, 'correct horse battery staple');
    await settleStrength();
    expect(create().disabled).toBe(false);

    click(create());
    await settle();
    expect(gateway.runPlans).toHaveLength(1);
    expect(gateway.runPlans[0]?.kind).toBe('encrypted');
  });

  it('refuses a parcel whose passphrase is the only thing protecting it and is weak', async () => {
    // Same flow, same two matching fields — only the engine's verdict differs. A parcel
    // under a guessable passphrase is a plaintext export with extra steps, so the gate has
    // to be the strength answer and not merely "the two boxes agree".
    const gateway = fakeExportGateway({ strength: () => tooWeak() });
    const tree = await open(gateway);

    click(radioFor(tree, 'keyhold-parcel'));
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();

    const fields = [...tree.container.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    typeInto(fields[0]!, 'password1');
    typeInto(fields[1]!, 'password1');
    await settleStrength();

    expect(buttonLabelled(tree, 'Create parcel').disabled).toBe(true);
    expect(tree.container.textContent).toContain('not strong enough');

    click(buttonLabelled(tree, 'Create parcel'));
    await settle();
    expect(gateway.runPlans).toHaveLength(0);
  });

  it('reports where the file went, and that deleting it does not erase it', async () => {
    const gateway = fakeExportGateway();
    const tree = await open(gateway);

    click(radioFor(tree, 'keyhold-csv'));
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();
    typeInto(
      tree.container.querySelector<HTMLInputElement>('input[type="text"]')!,
      PLAINTEXT_CONFIRMATION_PHRASE
    );
    await settle();
    click(buttonLabelled(tree, 'Export unencrypted'));
    await settle();

    const text = tree.container.textContent;
    expect(text).toContain('vault-export.csv');
    expect(text).toContain('/home/example/Documents');
    expect(text).toContain('Deleting this file will not erase it.');
    // No promise we do not keep.
    expect(text).not.toContain('securely delete');
    expect(text).not.toContain('shredded');
  });

  it('treats a cancelled save dialog as no export at all', async () => {
    const gateway = fakeExportGateway({ outcome: () => ({ status: 'cancelled' }) });
    const tree = await open(gateway);

    click(radioFor(tree, 'keyhold-csv'));
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();
    typeInto(
      tree.container.querySelector<HTMLInputElement>('input[type="text"]')!,
      PLAINTEXT_CONFIRMATION_PHRASE
    );
    await settle();
    click(buttonLabelled(tree, 'Export unencrypted'));
    await settle();

    // Still on the confirm step, with everything intact and an honest explanation.
    expect(tree.container.textContent).toContain('nothing was written');
    expect(buttonLabelled(tree, 'Export unencrypted')).toBeDefined();
  });

  it('never sends a passphrase in a preview request', async () => {
    const gateway = fakeExportGateway({ strength: () => strongEnough() });
    const tree = await open(gateway);

    click(radioFor(tree, 'keyhold-parcel'));
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();
    click(buttonLabelled(tree, 'Continue'));
    await settle();

    const fields = [...tree.container.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    typeInto(fields[0]!, 'correct horse battery staple');
    typeInto(fields[1]!, 'correct horse battery staple');
    await settle();

    expect(gateway.previewRequests.length).toBeGreaterThan(0);
    for (const request of gateway.previewRequests) {
      expect(Object.keys(request).sort()).toEqual(['format', 'scope']);
      expect(JSON.stringify(request)).not.toContain('correct horse');
    }
  });
});
