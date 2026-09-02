// SPDX-License-Identifier: GPL-3.0-or-later

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { mountReact, type MountedTree } from '../chrome/test-dom.js';
import { FakeImportGateway } from './fake-gateway.js';
import { ImportWizard, PREVIEW_DEBOUNCE_MS } from './ImportWizard.js';
import {
  ALL_PLANTED_SECRETS,
  GENERIC_SOURCE,
  PLANTED_SECRETS,
  plantedScenario,
  vaultAfterImporting,
} from './test-fixtures.js';
import { IMPORT_STOP_LABELS } from './wizard-machine.js';

/**
 * The wizard, driven through a real mount.
 *
 * `wizard-machine.test.ts` and `duplicate-decisions.test.ts` prove the *rules*. This proves
 * the components call them, and it carries the one assertion that cannot be made anywhere
 * else: **no parsed password, note body, security answer or TOTP seed reaches the screen.**
 *
 * That assertion is only worth something because the fixture behind it holds real secret
 * material and the fake gateway projects it with the real `previewRecord` — so a component
 * that started rendering `record.password` would have something to render. The sweep looks
 * at text *and* at every attribute and form value, because a leak into a `title`, a
 * `value`, or an `aria-label` is a leak that no `textContent` check would ever see.
 *
 * `@testing-library/react` is not a dependency of this project, so this drives
 * `react-dom/client` through the same `mountReact` harness the chrome and the export dialog
 * use. jsdom has no `HTMLDialogElement.showModal`, so `Modal`'s documented fallback path is
 * what runs here.
 */

const noop = (): void => undefined;

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Outwaits the mapping step's re-parse debounce as well as the microtasks after it. */
async function settlePreview(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, PREVIEW_DEBOUNCE_MS + 20));
  });
  await settle();
}

function labelOf(button: HTMLButtonElement): string {
  return button.textContent.trim();
}

function buttons(tree: MountedTree): readonly HTMLButtonElement[] {
  return [...tree.container.querySelectorAll('button')];
}

function buttonLabelled(tree: MountedTree, label: string): HTMLButtonElement {
  const found = buttons(tree).find((button) => labelOf(button) === label);
  if (found === undefined) {
    throw new Error(
      `no button labelled "${label}". Present: ${buttons(tree).map(labelOf).join(' | ')}`
    );
  }
  return found;
}

/** The primary button, whichever step we are on — its label changes with the step. */
function primary(tree: MountedTree): HTMLButtonElement {
  const found = buttons(tree).find((button) => button.className.includes('kh-button--primary'));
  if (found === undefined) throw new Error('no primary button on this step');
  return found;
}

function click(element: HTMLElement): void {
  act(() => {
    element.click();
  });
}

function currentStop(tree: MountedTree): string {
  return tree.container.querySelector('[aria-current="step"]')?.textContent ?? '';
}

/**
 * Every string this tree puts in front of a user or an assistive technology.
 *
 * Text, every attribute value, and the live `value` of every form control — the last of
 * these matters because a React-controlled input's value is a property, not an attribute,
 * so an `input value={record.password}` would be invisible to `outerHTML`.
 */
function renderedStrings(root: ParentNode): readonly string[] {
  const strings: string[] = [root.textContent ?? ''];
  for (const element of root.querySelectorAll('*')) {
    for (const attribute of element.attributes) strings.push(attribute.value);
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      strings.push(element.value);
    }
  }
  return strings;
}

function expectNoSecretsOnScreen(where: string): void {
  const strings = renderedStrings(document.body);
  for (const secret of ALL_PLANTED_SECRETS) {
    const leaked = strings.filter((rendered) => rendered.includes(secret));
    expect(
      leaked,
      `${where}: the parsed secret ${secret} reached ${String(leaked.length)} rendered string(s)`
    ).toEqual([]);
  }
}

let mounted: MountedTree | null = null;

async function open(gateway: FakeImportGateway): Promise<MountedTree> {
  const tree = mountReact(<ImportWizard open gateway={gateway} onClose={noop} />);
  mounted = tree;
  await settle();
  return tree;
}

/** Choose the file and land on the format step. */
async function toFormat(tree: MountedTree): Promise<void> {
  click(buttonLabelled(tree, 'Choose a file…'));
  await settle();
}

/** Run the dry run and land on the review step. */
async function toReview(tree: MountedTree): Promise<void> {
  click(buttonLabelled(tree, 'Run the dry run'));
  await settle();
}

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
});

describe('no parsed secret reaches the renderer', () => {
  it('holds on every step of a wizard driven to a finished import', async () => {
    const gateway = new FakeImportGateway(plantedScenario());
    const tree = await open(gateway);

    expectNoSecretsOnScreen('the choose step');

    await toFormat(tree);
    // Positive control for this step: the file the user picked is named on it.
    expect(tree.container.textContent).toContain('bitwarden_export_20260902.csv');
    expectNoSecretsOnScreen('the format step');

    await toReview(tree);
    expectNoSecretsOnScreen('the review step');

    // Positive control. If the sample table rendered nothing at all, every assertion above
    // would pass for the wrong reason — so the non-secret custom value must be on screen.
    expect(tree.container.textContent).toContain('AC-11924');
    expect(tree.container.textContent).toContain('Google');

    click(primary(tree));
    await settle();
    expectNoSecretsOnScreen('the result step');
  });

  it('holds on the mapping step, where the sample table is the whole point', async () => {
    const gateway = new FakeImportGateway(plantedScenario({ source: GENERIC_SOURCE }));
    const tree = await open(gateway);

    await toFormat(tree);
    click(buttonLabelled(tree, 'Map the columns'));
    await settlePreview();

    expect(currentStop(tree)).toContain(IMPORT_STOP_LABELS.map);
    // The sample really did arrive — otherwise there is nothing here to have leaked.
    expect(tree.container.textContent).toContain('Google');
    expectNoSecretsOnScreen('the mapping step');
  });

  it('shows a password as a length, never as a value', async () => {
    const gateway = new FakeImportGateway(plantedScenario());
    const tree = await open(gateway);
    await toFormat(tree);
    await toReview(tree);

    const text = tree.container.textContent;
    // `SecretMask` speaks the length; the dots beside it are aria-hidden decoration.
    expect(text).toContain(
      `password, ${String(PLANTED_SECRETS.googlePassword.length)} characters, not shown`
    );
    expect(text).toContain('note, ');
    expect(text).toContain('hidden, otp-secret');
  });

  it('keeps the secrets out of the IPC payload as well as out of the DOM', async () => {
    // The DOM sweep catches a component that renders a secret. This catches the earlier and
    // worse failure: a secret that crossed the process boundary at all, whether or not
    // anything got round to drawing it.
    const gateway = new FakeImportGateway(plantedScenario());
    const preview = await gateway.preview({
      sourceId: 'source-1',
      formatId: 'bitwarden-csv',
      sampleSize: 5,
    });

    const payload = JSON.stringify(preview);
    for (const secret of ALL_PLANTED_SECRETS) expect(payload).not.toContain(secret);
    // Again, a positive control: the projection is not simply empty.
    expect(payload).toContain('AC-11924');
    expect(payload).toContain('"passwordLength":' + String(PLANTED_SECRETS.googlePassword.length));
  });
});

describe('the dry run is what gets committed', () => {
  it('commits the plan id the review step was showing, and nothing it describes itself', async () => {
    const gateway = new FakeImportGateway(plantedScenario());
    const tree = await open(gateway);
    await toFormat(tree);
    await toReview(tree);

    click(primary(tree));
    await settle();

    // The commit names a plan the gateway minted. There is no shape the renderer could hand
    // over that describes records — it can only approve a parse the main process is holding.
    const commit = gateway.calls.find((call) => call.startsWith('commit:'));
    const previewed = gateway.calls.find((call) => call.startsWith('preview:'));
    expect(previewed).toBe('preview:bitwarden-csv');
    expect(commit).toBe('commit:plan-1');
  });

  it('states the same number on the button, on the headline, and in the result', async () => {
    const gateway = new FakeImportGateway(plantedScenario());
    const tree = await open(gateway);
    await toFormat(tree);
    await toReview(tree);

    // One new record, plus the surviving row of the within-file Google cluster.
    expect(labelOf(primary(tree))).toBe('Import 2 records');
    expect(tree.container.textContent).toContain('2 records will be added to your vault.');

    click(primary(tree));
    await settle();
    expect(tree.container.textContent).toContain('2');
  });

  it('adds nothing when the file has already been imported once', async () => {
    // The wizard's whole job, on screen: the same file, against a vault that already has it.
    const gateway = new FakeImportGateway(plantedScenario({ existing: vaultAfterImporting() }));
    const tree = await open(gateway);
    await toFormat(tree);
    await toReview(tree);

    expect(labelOf(primary(tree))).toBe('Import 0 records');
    expect(tree.container.textContent).toContain('0 records will be added to your vault.');
  });

  it('warns before a merge that would overwrite a password already in the vault', async () => {
    const gateway = new FakeImportGateway(plantedScenario());
    const tree = await open(gateway);
    await toFormat(tree);
    await toReview(tree);

    // Nothing is said until a merge is actually chosen — the note is a consequence, not decor.
    expect(tree.container.textContent).not.toContain('would replace a password');

    click(buttonLabelled(tree, 'Merge all'));
    await settle();

    expect(tree.container.textContent).toContain('would replace a password');
    expect(tree.container.querySelector('.kh-import-note--danger[role="alert"]')).not.toBeNull();
  });
});

describe('cancelling changes nothing', () => {
  it('writes nothing and drops the file, from whichever step it is cancelled on', async () => {
    // Every step before the commit, cancelled in turn. The invariant is not that a flag
    // stayed false: it is that `commit` was never reached and `discard` always was.
    const stops = ['choose', 'format', 'review'] as const;

    for (const stop of stops) {
      const gateway = new FakeImportGateway(plantedScenario());
      const tree = await open(gateway);
      mounted = tree;

      if (stop !== 'choose') await toFormat(tree);
      if (stop === 'review') await toReview(tree);

      click(buttonLabelled(tree, 'Cancel'));
      await settle();

      expect(gateway.committed, `cancelled on the ${stop} step`).toBe(false);
      if (stop !== 'choose') {
        expect(gateway.calls, `cancelled on the ${stop} step`).toContain('discard:source-1');
      }

      tree.unmount();
      mounted = null;
      document.body.innerHTML = '';
    }
  });

  it('drops the file the main process was holding even after a finished import', async () => {
    // The vault has been written by then, so "nothing changed" no longer applies — but the
    // plaintext dump the main process is still holding must stop being held.
    const gateway = new FakeImportGateway(plantedScenario());
    const tree = await open(gateway);
    await toFormat(tree);
    await toReview(tree);
    click(primary(tree));
    await settle();

    click(buttonLabelled(tree, 'Close'));
    await settle();
    expect(gateway.calls).toContain('discard:source-1');
  });

  it('treats a dismissed file dialog as a cancellation, not as a failure', async () => {
    const gateway = new FakeImportGateway(plantedScenario({ cancelFileDialog: true }));
    const tree = await open(gateway);

    click(buttonLabelled(tree, 'Choose a file…'));
    await settle();

    // Still on the first step, with no error shouted at someone who pressed Cancel.
    expect(currentStop(tree)).toContain(IMPORT_STOP_LABELS.choose);
    expect(tree.container.querySelector('[role="alert"]')).toBeNull();
  });
});
