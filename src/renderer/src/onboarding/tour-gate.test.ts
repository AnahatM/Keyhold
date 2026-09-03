// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import { COMMANDS, resolveCommands } from '../commands/command-registry.js';
import { useTourGate } from './onboarding-visibility.js';

/**
 * Guard: the setup tour can actually be reached.
 *
 * `OnboardingFlow` has taken a `mode` and behaved correctly in `revisit` for as long as the
 * mode has existed, with a full test matrix behind it — and nothing anywhere mounted it that
 * way, so none of that behaviour was reachable by a user. A component that is correct and
 * unreachable is indistinguishable from one that was never written, and no test of the
 * component can tell the difference. These check the wiring instead.
 *
 * The mount itself lives in `App.tsx` and is guarded by the smoke test, which opens the
 * palette and reads the command list out of a real window.
 */

beforeEach(() => {
  useTourGate.setState({ open: false });
});

describe('the tour gate', () => {
  it('starts closed, so nothing shows a tour nobody asked for', () => {
    // `getInitialState`, not `getState`. The `beforeEach` above resets the store to closed,
    // so reading the live state here would assert the reset rather than the declaration and
    // would pass with the store defaulting to open — which is what fault-injecting it showed.
    expect(useTourGate.getInitialState().open).toBe(false);
  });

  it('opens and closes', () => {
    useTourGate.getState().show();
    expect(useTourGate.getState().open).toBe(true);

    useTourGate.getState().close();
    expect(useTourGate.getState().open).toBe(false);
  });
});

describe('the palette command', () => {
  it('exists, and sits in Help', () => {
    const tour = COMMANDS.find((command) => command.id === 'help.tour');

    expect(tour, 'help.tour is not in the command registry').toBeDefined();
    expect(tour?.section).toBe('Help');
    // Findable by the words someone would actually reach for. They will not search "tour"
    // if they are looking for the thing that was on screen the first time they opened the app.
    expect(tour?.keywords).toContain('onboarding');
    expect(tour?.keywords).toContain('getting started');
  });

  it('does not need a record selected', () => {
    // Otherwise it would vanish from the palette whenever the list is empty — which is
    // precisely the state a new user opening the palette to find help is likely to be in.
    expect(COMMANDS.find((command) => command.id === 'help.tour')?.requiresSelection).toBe(false);
  });

  it('is offered when a handler is supplied and dropped when it is not', () => {
    // How `CommandsProvider` disables it while the vault is locked: the handler map holds
    // `undefined`, and `resolveCommands` drops the entry rather than listing a command that
    // does nothing. Three of the tour's five steps describe an open vault.
    const offered = resolveCommands({ 'help.tour': () => undefined }, { hasSelection: false });
    expect(offered.map((command) => command.definition.id)).toContain('help.tour');

    const locked = resolveCommands({}, { hasSelection: false });
    expect(locked.map((command) => command.definition.id)).not.toContain('help.tour');
  });

  it('runs the gate, rather than something that merely looks like it', () => {
    const offered = resolveCommands(
      {
        'help.tour': () => {
          useTourGate.getState().show();
        },
      },
      { hasSelection: false }
    );

    offered.find((command) => command.definition.id === 'help.tour')?.run();
    expect(useTourGate.getState().open).toBe(true);
  });
});
