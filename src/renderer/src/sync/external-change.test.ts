// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { VaultChangedExternally } from '@shared/model/vault-change.js';
import {
  EXTERNAL_CHANGE_LABELS,
  promptForExternalChange,
  type ExternalChangeAction,
} from './external-change.js';

/**
 * The decision, not the banner.
 *
 * Every test here is really the same assertion: **`reload` is offered only when reloading
 * loses nothing.** It is the obvious response to "the file changed" and it is wrong in three
 * of the four situations that produce that event, in a way that leaves no trace — a reload
 * replaces the in-memory document wholesale, and a record that was never written has no
 * tombstone, no history entry and no undo.
 *
 * The last test is the one that matters most, because it is the one that keeps holding as
 * cases are added: it enumerates every combination of the flags and asserts the invariant
 * over all of them, rather than trusting that the four written out above stay exhaustive.
 *
 * Fault injection performed:
 *  1. Moving the `differentVault` branch below `wentBackwards` — fails "a replaced vault
 *     outranks everything else", which builds a change with both flags set.
 *  2. Deleting the `hasUnsavedChanges` branch — fails "never offers reload when reloading
 *     would lose something", with `reload` offered alongside unsaved edits.
 *  3. Adding `'reload'` to the `wentBackwards` branch — fails the same test.
 */

const change = (overrides: Partial<VaultChangedExternally> = {}): VaultChangedExternally => ({
  knownGeneration: 4,
  currentGeneration: 5,
  differentVault: false,
  wentBackwards: false,
  ...overrides,
});

const offers = (action: ExternalChangeAction, prompt: { actions: readonly string[] }): boolean =>
  prompt.actions.includes(action);

describe('a replaced vault', () => {
  it('offers neither reload nor merge, because both would mix two vaults', () => {
    const prompt = promptForExternalChange(change({ differentVault: true }), false);
    expect(prompt.tone).toBe('danger');
    expect(offers('reload', prompt)).toBe(false);
    expect(offers('merge', prompt)).toBe(false);
    expect(prompt.actions[0]).toBe('lock');
  });

  it('outranks everything else, including unsaved changes and a backwards step', () => {
    const prompt = promptForExternalChange(
      change({ differentVault: true, wentBackwards: true }),
      true
    );
    expect(prompt.tone).toBe('danger');
    expect(prompt.headline).toContain('different vault');
  });
});

describe('an older file on disk', () => {
  it('offers merge instead of reload, and says why', () => {
    const prompt = promptForExternalChange(
      change({ wentBackwards: true, currentGeneration: 3 }),
      false
    );
    expect(offers('reload', prompt)).toBe(false);
    expect(prompt.actions[0]).toBe('merge');
    expect(prompt.withheld).toContain('older');
  });
});

describe('a newer file on disk', () => {
  it('offers reload first when there is nothing in memory to lose', () => {
    const prompt = promptForExternalChange(change(), false);
    expect(prompt.tone).toBe('info');
    expect(prompt.actions[0]).toBe('reload');
    // Merge stays available: someone who wants to see what changed should not have to reload
    // first and lose the ability to.
    expect(offers('merge', prompt)).toBe(true);
    // Nothing is being withheld, so nothing is explained away.
    expect(prompt.withheld).toBeUndefined();
  });

  it('withholds reload when there are unsaved changes', () => {
    const prompt = promptForExternalChange(change(), true);
    expect(offers('reload', prompt)).toBe(false);
    expect(prompt.actions[0]).toBe('merge');
    expect(prompt.withheld).toContain('unsaved');
  });
});

describe('the invariant, over every combination', () => {
  const flags = [false, true];

  it('never offers reload when reloading would lose something', () => {
    for (const differentVault of flags) {
      for (const wentBackwards of flags) {
        for (const hasUnsavedChanges of flags) {
          const prompt = promptForExternalChange(
            change({ differentVault, wentBackwards }),
            hasUnsavedChanges
          );
          const safeToReload = !differentVault && !wentBackwards && !hasUnsavedChanges;
          expect(
            offers('reload', prompt),
            `differentVault=${String(differentVault)} ` +
              `wentBackwards=${String(wentBackwards)} ` +
              `hasUnsavedChanges=${String(hasUnsavedChanges)}`
          ).toBe(safeToReload);
        }
      }
    }
  });

  it('always offers a way out, and always explains a withheld reload', () => {
    for (const differentVault of flags) {
      for (const wentBackwards of flags) {
        for (const hasUnsavedChanges of flags) {
          const prompt = promptForExternalChange(
            change({ differentVault, wentBackwards }),
            hasUnsavedChanges
          );
          // Dismiss is always there: a banner with no way to close it is a modal wearing a
          // different shape, and the user may be mid-sentence.
          expect(offers('dismiss', prompt)).toBe(true);
          // A missing button with no explanation reads as a bug, and sends the user looking
          // for another way to do the thing being prevented.
          if (!offers('reload', prompt)) expect(prompt.withheld).toBeDefined();
          // Every action can be labelled.
          for (const action of prompt.actions) {
            expect(EXTERNAL_CHANGE_LABELS[action]).toBeTruthy();
          }
        }
      }
    }
  });
});
