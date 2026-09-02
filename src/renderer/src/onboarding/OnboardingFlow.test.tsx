// SPDX-License-Identifier: GPL-3.0-or-later
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PasswordStrength } from '@shared/model/strength.js';
// `@testing-library/react` is not a dependency of this project and is not being added for
// this. The chrome already owns a twenty-line `react-dom/client` harness for exactly the
// handful of behaviours that cannot be asserted against a pure function; this reuses it
// rather than introducing a second way to mount a component.
import { mountReact } from '../chrome/test-dom.js';
import { OnboardingFlow } from './OnboardingFlow.js';
import { NO_RECOVERY_ACKNOWLEDGEMENT } from './onboarding-copy.js';
import type { OnboardingState } from './onboarding-state.js';
import { ONBOARDING_STEPS, type OnboardingStepId } from './onboarding-steps.js';
import { writeProgress } from './onboarding-storage.js';

/**
 * The three guarantees that only exist once the components are actually rendering.
 *
 * Everything else about this flow is tested as pure functions in `onboarding-state.test.ts`
 * and `onboarding-storage.test.ts`, which is where it belongs. What is left is exactly the
 * set of things a reducer cannot prove:
 *
 * 1. **The acknowledgement gate holds against the form, not just against the button.**
 *    A disabled button is a suggestion; submitting the form directly is what an Enter key,
 *    a stale render or a future refactor actually does.
 * 2. **Nothing typed into any field reaches `localStorage`.** Asserted with a marker
 *    planted in every input on the two steps that have inputs, and checked against every
 *    stored value rather than against the record the flow thinks it wrote.
 * 3. **Skip is reachable from every step.** Including steps added later — the loop is over
 *    `ONBOARDING_STEPS`, not over a hand-written list.
 */

const VAULT_KEY = 'vault-test-0001';
const VAULT_PATH = 'C:\\Users\\test\\Documents\\test.keep';

/** Planted in every field. If this ever appears in storage, the flow has leaked. */
const MARKER = 'MARKER-copper-lantern-drift-oyster';

const STRONG: PasswordStrength = {
  score: 4,
  label: 'Very strong',
  guesses: 1e14,
  crackTime: 'thousands of years',
  warning: null,
  suggestions: [],
  meetsMasterMinimum: true,
};

const noop = (): void => undefined;

afterEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = '';
});

function seed(stepId: OnboardingStepId, overrides: Partial<OnboardingState> = {}): void {
  const pastCreation = stepId !== 'welcome' && stepId !== 'master-password';
  writeProgress(VAULT_KEY, {
    stepId,
    acknowledgedNoRecovery: pastCreation,
    vaultCreated: pastCreation,
    firstCredentialSaved: false,
    outcome: 'active',
    ...overrides,
  });
}

interface Handlers {
  readonly estimateStrength: ReturnType<typeof vi.fn>;
  readonly onCreateVault: ReturnType<typeof vi.fn>;
  readonly onCreateFirstCredential: ReturnType<typeof vi.fn>;
  readonly onExit: ReturnType<typeof vi.fn>;
}

function handlers(): Handlers {
  return {
    estimateStrength: vi.fn(() => Promise.resolve(STRONG)),
    onCreateVault: vi.fn(() => Promise.resolve(true)),
    onCreateFirstCredential: vi.fn(() => Promise.resolve(true)),
    onExit: vi.fn(),
  };
}

function mount(api: Handlers): ReturnType<typeof mountReact> {
  return mountReact(
    <OnboardingFlow
      vaultKey={VAULT_KEY}
      vaultPath={VAULT_PATH}
      estimateStrength={api.estimateStrength as never}
      onCreateVault={api.onCreateVault as never}
      onCreateFirstCredential={api.onCreateFirstCredential as never}
      busy={false}
      error={null}
      onExit={api.onExit as never}
    />
  );
}

/** Lets React's effects, the strength debounce and its promise all settle. */
async function settle(ms = 320): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/**
 * Sets a controlled input the way a user would.
 *
 * React installs its own value setter on the element, so assigning `.value` directly is
 * swallowed. Calling the prototype setter and then dispatching `input` is what actually
 * reaches an `onChange` handler.
 */
function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    // Looks the accessor up on the prototype and invokes it with the element as the
    // receiver, which steps around the `value` property React defines on the instance. A
    // plain `input.value = …` would go through React's own setter, update its change
    // tracker, and leave `onChange` with nothing to report.
    Reflect.set(HTMLInputElement.prototype, 'value', value, input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * Ticks a checkbox the way a person does.
 *
 * Deliberately a real `click()` rather than assigning `.checked` and dispatching events.
 * React installs a value tracker over the `checked` property, so an assignment updates the
 * tracker, React then sees no change on the following event, and `onChange` never fires —
 * the control looks ticked in the DOM while the component still believes it is not. A
 * `click()` toggles the element's internal checkedness underneath that tracker, which is
 * exactly what a user's click does.
 */
function toggle(checkbox: HTMLInputElement): void {
  act(() => {
    checkbox.click();
  });
}

function textInputs(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll('input')).filter(
    (input) => input.type !== 'checkbox'
  );
}

function buttonWith(container: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent.includes(text)
    ) ?? null
  );
}

function allStoredText(): string {
  return Object.keys(window.localStorage)
    .map((key) => `${key}\u0000${window.localStorage.getItem(key) ?? ''}`)
    .join('\n');
}

describe('the acknowledgement gate, as rendered', () => {
  it('will not create a vault from a submitted form until the box is ticked', async () => {
    seed('master-password');
    const api = handlers();
    const tree = mount(api);
    await settle(0);

    const [secret, confirm] = textInputs(tree.container);
    typeInto(secret!, 'copper-lantern-drift-oyster');
    typeInto(confirm!, 'copper-lantern-drift-oyster');
    await settle();

    const create = buttonWith(tree.container, 'Create my vault');
    expect(create?.disabled).toBe(true);

    // Submitting the form directly, not clicking the button — an Enter key in a text field
    // does exactly this, and a gate that only lives on `disabled` would not stop it.
    const form = tree.container.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(api.onCreateVault).not.toHaveBeenCalled();

    const acknowledgement =
      tree.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    toggle(acknowledgement);
    await settle(0);

    expect(buttonWith(tree.container, 'Create my vault')?.disabled).toBe(false);

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(api.onCreateVault).toHaveBeenCalledTimes(1);

    tree.unmount();
  });

  it('states the acknowledgement in the words it is stored under', async () => {
    seed('master-password');
    const api = handlers();
    const tree = mount(api);
    await settle(0);

    // The one sentence the user is agreeing to, asserted against the constant rather than
    // against a copy of the string — so rewording it in two places is impossible.
    expect(tree.container.textContent).toContain(NO_RECOVERY_ACKNOWLEDGEMENT);
    tree.unmount();
  });
});

describe('nothing typed is ever written to storage', () => {
  it('holds for the master-password step', async () => {
    seed('master-password');
    const api = handlers();
    const tree = mount(api);
    await settle(0);

    for (const input of textInputs(tree.container)) typeInto(input, MARKER);
    toggle(tree.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await settle();

    expect(textInputs(tree.container).every((input) => input.value === MARKER)).toBe(true);
    expect(allStoredText()).not.toContain(MARKER);

    tree.unmount();
  });

  it('holds for the first-credential step', async () => {
    seed('first-credential');
    const api = handlers();
    const tree = mount(api);
    await settle(0);

    const inputs = textInputs(tree.container);
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) typeInto(input, MARKER);
    await settle(0);

    expect(allStoredText()).not.toContain(MARKER);

    // And still not after it has been handed to the host and the step has moved on.
    await act(async () => {
      buttonWith(tree.container, 'Save it')?.click();
      await Promise.resolve();
    });
    await settle(0);

    expect(api.onCreateFirstCredential).toHaveBeenCalledTimes(1);
    expect(allStoredText()).not.toContain(MARKER);

    tree.unmount();
  });
});

describe('skip', () => {
  it('is on screen at every step', async () => {
    for (const step of ONBOARDING_STEPS) {
      window.localStorage.clear();
      seed(step.id);
      const api = handlers();
      const tree = mount(api);
      await settle(0);

      const skip = buttonWith(tree.container, 'Skip setup');
      expect(skip, `no skip control on step "${step.id}"`).not.toBeNull();
      expect(skip?.disabled).toBe(false);

      tree.unmount();
    }
  });

  it('exits without completing, and without claiming anything was acknowledged', async () => {
    seed('welcome');
    const api = handlers();
    const tree = mount(api);
    await settle(0);

    await act(async () => {
      buttonWith(tree.container, 'Skip setup')?.click();
      await Promise.resolve();
    });

    expect(api.onExit).toHaveBeenCalledWith('dismissed');
    expect(api.onCreateVault).not.toHaveBeenCalled();
    expect(allStoredText()).toContain('"outcome":"dismissed"');
    expect(allStoredText()).toContain('"acknowledgedNoRecovery":false');

    tree.unmount();
  });
});

describe('focus', () => {
  it('lands on the step heading, and moves with the step', async () => {
    seed('welcome');
    const api = handlers();
    const tree = mount(api);
    await settle(0);

    const heading = tree.container.querySelector<HTMLHeadingElement>('h1')!;
    expect(document.activeElement).toBe(heading);
    const firstText = heading.textContent;

    await act(async () => {
      buttonWith(tree.container, 'Get started')?.click();
      await Promise.resolve();
    });
    await settle(0);

    const next = tree.container.querySelector<HTMLHeadingElement>('h1')!;
    expect(next.textContent).not.toBe(firstText);
    expect(document.activeElement).toBe(next);

    tree.unmount();
  });
});

describe('resumption', () => {
  it('opens on the step the last session left, and survives a corrupt record', async () => {
    seed('vault-file');
    const api = handlers();
    const tree = mount(api);
    await settle(0);
    expect(tree.container.textContent).toContain('Where your vault lives');
    tree.unmount();

    window.localStorage.setItem(
      Object.keys(window.localStorage)[0] ?? 'keyhold.onboarding.x',
      '{{{ not json'
    );
    const fresh = mountReact(
      <OnboardingFlow
        vaultKey={VAULT_KEY}
        vaultPath={null}
        estimateStrength={api.estimateStrength as never}
        onCreateVault={api.onCreateVault as never}
        busy={false}
        error={null}
        onExit={noop}
      />
    );
    await settle(0);
    expect(fresh.container.querySelector('h1')?.textContent).toContain('Keyhold keeps your');
    fresh.unmount();
  });
});
