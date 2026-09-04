// SPDX-License-Identifier: GPL-3.0-or-later
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BREACH_CHECK_SETTINGS } from '@shared/model/breach.js';
import { DEFAULT_MACHINE_SETTINGS } from '@shared/model/settings-plan.js';
import { DEFAULT_VAULT_SETTINGS } from '@shared/model/vault-document.js';
import type { ConfigurableVaultSettings } from '@shared/model/settings-plan.js';
import { mountReact, type MountedTree } from '../chrome/test-dom.js';
import { SecuritySessionSection } from './SecuritySessionSection.js';
import { SETTING_COPY } from './settings-copy.js';
import type { SettingId } from '@shared/model/settings-plan.js';
import type { SettingsController } from './use-settings.js';

/**
 * The breach opt-in row, and the consent step it is gated behind.
 *
 * This is the only switch in Keyhold that grants the application a capability it does not
 * otherwise have — permission to make a network request about the user's passwords. The
 * dialog in front of it is the consent, and there are three claims about it worth defending,
 * because each fails silently:
 *
 *  1. **Turning it on does not take effect until the dialog is confirmed.** A switch that
 *     writes the setting first and asks afterwards is not asking.
 *  2. **The dialog says what is actually revealed.** k-anonymity is the reassuring half; that
 *     a check reveals Keyhold is in use from this network address, each time, is the half that
 *     is a real cost and the half a page could quietly omit.
 *  3. **Turning it off takes no dialog at all.** The asymmetry is deliberate — making somebody
 *     confirm that they want *less* exposure only teaches them to click through dialogs, which
 *     is exactly how the confirmation in the other direction stops meaning anything.
 *
 * ## Fault injection performed, three defects
 *
 *  1. The `setPendingBreachCheck(true)` branch replaced with a direct `updateVault` — failed
 *     `does not turn the check on until the dialog is confirmed`, with the setting written on
 *     the click.
 *  2. The dialog's `consequence` line deleted — failed `says what a check actually reveals`.
 *  3. The off direction routed through the dialog too — failed `turns off immediately`.
 */

let mounted: MountedTree | null = null;

interface Recorded {
  readonly patch: Partial<ConfigurableVaultSettings>;
  readonly announce: string;
}

let vaultUpdates: Recorded[] = [];

function controller(): SettingsController {
  const stub: Partial<SettingsController> = {
    snapshot: null,
    loading: false,
    loadError: null,
    saveError: null,
    busy: false,
    announcement: { text: '', seq: 0 },
    updateMachine: () => undefined,
    updateVault: (patch: Partial<ConfigurableVaultSettings>, announce: string) => {
      vaultUpdates.push({ patch, announce });
    },
    chooseMirrorDirectory: () => Promise.resolve(),
    resetMachine: () => undefined,
    resetVault: () => undefined,
  };
  // The section reads a handful of these; the rest exist so the shape is honest about what a
  // real controller carries. Cast once, here, rather than at each member.
  return stub as SettingsController;
}

function mount(enabled: boolean): MountedTree {
  const tree = mountReact(
    <SecuritySessionSection
      controller={controller()}
      machine={DEFAULT_MACHINE_SETTINGS}
      vault={{
        ...DEFAULT_VAULT_SETTINGS,
        breachCheck: { ...DEFAULT_BREACH_CHECK_SETTINGS, enabled },
      }}
      quickUnlock={{
        available: false,
        enrolled: false,
        promptsForBiometrics: false,
        description: 'Not available',
      }}
      hasVault
    />
  );
  mounted = tree;
  return tree;
}

/**
 * The checkbox for one setting, found by the row's own label copy.
 *
 * By label rather than by an id: `SettingRow` renders no `data-setting-id`, and adding one to
 * production markup so a test can find it would be the test dictating the DOM. The copy comes
 * from `SETTING_COPY`, so this cannot drift from the label a user actually sees — if the
 * wording changes, this stops finding the row and says so, which is the correct outcome for a
 * consent control whose wording is the feature.
 */
function switchFor(tree: MountedTree, settingId: SettingId): HTMLInputElement | undefined {
  const row = [...tree.container.querySelectorAll('.kh-setting')].find((candidate) =>
    candidate.textContent.includes(SETTING_COPY[settingId].label)
  );
  return row?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? undefined;
}

function click(element: HTMLElement): void {
  act(() => {
    element.click();
  });
}

/** The confirm dialog's own button, wherever it is rendered. */
function dialogButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((button) =>
    button.textContent.includes(label)
  );
}

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vaultUpdates = [];
  document.body.innerHTML = '';
});

describe('the breach check opt-in', () => {
  it('does not turn the check on until the dialog is confirmed', () => {
    const tree = mount(false);
    const control = switchFor(tree, 'breachCheck.enabled');
    expect(control, 'the breach opt-in row is not on the settings screen').toBeDefined();

    click(control!);

    // The click opened a dialog and wrote nothing. This is the assertion the whole consent
    // step rests on: a switch that saves first and asks afterwards has not asked.
    expect(vaultUpdates).toEqual([]);
    expect(dialogButton('Turn the check on')).toBeDefined();
  });

  it('says what a check actually reveals, not only what it protects', () => {
    const tree = mount(false);
    click(switchFor(tree, 'breachCheck.enabled')!);

    const text = document.body.textContent;
    // The reassuring half.
    expect(text).toContain('never sent');
    // The half that is a real cost, and the one a marketing-shaped dialog would drop.
    expect(text).toContain('network address');
    expect(text).toContain('stored in the vault file');
  });

  it('turns the check on once, and only after confirming', () => {
    const tree = mount(false);
    click(switchFor(tree, 'breachCheck.enabled')!);
    click(dialogButton('Turn the check on')!);

    expect(vaultUpdates).toHaveLength(1);
    expect(vaultUpdates[0]?.patch.breachCheck?.enabled).toBe(true);
  });

  it('writes nothing when the dialog is cancelled', () => {
    const tree = mount(false);
    click(switchFor(tree, 'breachCheck.enabled')!);
    click(dialogButton('Cancel')!);

    expect(vaultUpdates).toEqual([]);
  });

  it('turns off immediately, with no dialog', () => {
    // The asymmetry, deliberately. Confirming that you want *less* exposure teaches people to
    // click through dialogs, and the dialog in the other direction is the one that matters.
    const tree = mount(true);
    click(switchFor(tree, 'breachCheck.enabled')!);

    expect(vaultUpdates).toHaveLength(1);
    expect(vaultUpdates[0]?.patch.breachCheck?.enabled).toBe(false);
  });
});
