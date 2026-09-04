// SPDX-License-Identifier: GPL-3.0-or-later
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CredentialProjection } from '@shared/model/credential.js';
import { credentialTypeDefinition } from '@shared/model/credential-templates.js';
import { mountReact, type MountedTree } from '../chrome/test-dom.js';
import { CredentialEditor } from './CredentialEditor.js';
import { iconFor } from './credential-icon.js';
import { useCredentials } from './credential-store.js';

/**
 * The two places a record's **type** shows up in the interface.
 *
 * A type is a field template, not a storage shape — see
 * `docs/03-Data-Model/00-Credential-Model.md`. Both surfaces below follow from that, and both
 * fail quietly rather than loudly.
 *
 * **The picker appends; it never replaces.** Somebody who typed three fields and then realised
 * they were making a card must not lose the three. A picker that replaced them would be a
 * destructive control disguised as a display preference — the worst kind, because nothing
 * about a dropdown labelled "What is this?" warns you that it eats your work.
 *
 * **A chosen icon beats a type icon.** The order is the user's own choice, then the record's
 * kind, then an initial. A type icon overriding a chosen one would be the app overruling
 * somebody about their own record.
 *
 * ## Fault injection performed, four defects
 *
 *  1. The picker's case-insensitive `already` set removed, so changing type twice duplicates
 *     the template — failed `does not add the same template field twice`.
 *  2. The picker's append replaced with the template alone (`added` rather than
 *     `[...previous, ...added]`) — **failed nothing** on the first draft, because that draft
 *     typed into the *title*, which lives in its own state and survives a replacement. The
 *     case now adds a real custom field, which is the list the picker rewrites, and the same
 *     injection fails it.
 *  3. `iconFor`'s emoji branch moved below the type branch — failed `lets a chosen icon win`.
 *  4. The `login` special case removed, so every type takes an icon — failed `uses the initial
 *     for a login`.
 */

let mounted: MountedTree | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
});

// ── The type picker ─────────────────────────────────────────────────────────

describe('choosing a record type while creating one', () => {
  beforeEach(() => {
    // The editor reads the store on mount. Only the members it calls need to be real; the
    // picker itself touches none of them, which is why this is short.
    useCredentials.setState({
      create: vi.fn(() => Promise.resolve(null)),
      update: vi.fn(() => Promise.resolve(true)),
      setEditing: vi.fn(),
      select: vi.fn(),
      reveal: vi.fn(() => Promise.resolve(null)),
      busy: false,
    } as never);
  });

  /** The picker exists only while creating — an existing record's type is not re-templated. */
  function mountNew(): MountedTree {
    const tree = mountReact(<CredentialEditor credential={null} />);
    mounted = tree;
    return tree;
  }

  function choose(tree: MountedTree, value: string): void {
    const select = tree.container.querySelector<HTMLSelectElement>('#kh-record-type');
    expect(select, 'the type picker is not on the create screen').not.toBeNull();
    act(() => {
      if (select === null) return;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  /** Every non-empty input value on the form — the template's labels land here too. */
  const values = (tree: MountedTree): string[] =>
    [...tree.container.querySelectorAll<HTMLInputElement>('input')]
      .map((input) => input.value)
      .filter((value) => value !== '');

  /** Adds a custom field and gives it a label, which is what the picker must not eat. */
  function addCustomField(tree: MountedTree, label: string): void {
    const add = [...tree.container.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Add field')
    );
    expect(add, 'no "Add field" control on the create screen').toBeDefined();
    act(() => {
      add?.click();
    });

    const rows = [...tree.container.querySelectorAll('.kh-editor__group')];
    const last = rows.at(-1);
    const input = last?.querySelector('input');
    expect(input, 'the new custom field has no label input').toBeDefined();
    act(() => {
      if (input == null) return;
      // Through the prototype's setter, not `input.value = …`. React tracks the last value it
      // wrote on the element and skips the change event when a plain assignment leaves its
      // tracker agreeing — so the naive version types nothing and the assertion fails for a
      // reason that has nothing to do with the picker. Same approach as
      // `ExportDialogBody.test.tsx` and `OnboardingFlow.test.tsx`.
      Reflect.set(HTMLInputElement.prototype, 'value', label, input);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('is offered when creating, and adds the chosen type’s fields', () => {
    const tree = mountNew();
    choose(tree, 'card');

    const expected = credentialTypeDefinition('card').fields.map((field) => field.label);
    expect(expected.length).toBeGreaterThan(0);
    // The labels arrive as editable custom-field rows, not as static text: a template gives
    // you fields you can rename, not a fixed form.
    for (const label of expected) {
      expect(values(tree), `card template is missing "${label}"`).toContain(label);
    }
  });

  it('keeps a custom field the user already added', () => {
    // The whole reason the picker appends, and it has to be a **custom** field: the title
    // lives in its own state and survives a replacement, so a test that typed a title would
    // pass against a picker that threw every custom field away. Fault injection said exactly
    // that — replacing `[...previous, ...added]` with `added` failed nothing until this case
    // typed into the list the picker actually rewrites.
    const tree = mountNew();
    addCustomField(tree, 'Recovery email');
    choose(tree, 'card');

    expect(values(tree)).toContain('Recovery email');
  });

  it('does not add the same template field twice', () => {
    // Changing type twice, back and forth. Without the case-insensitive `already` set the
    // second pass re-appends everything the first added, and the user is looking at two
    // "Card number" boxes with no way to tell which one counts.
    const tree = mountNew();
    choose(tree, 'card');
    const label = credentialTypeDefinition('card').fields[0]?.label ?? '';
    expect(label).not.toBe('');
    const afterFirst = values(tree).filter((value) => value === label).length;

    choose(tree, 'login');
    choose(tree, 'card');

    expect(values(tree).filter((value) => value === label)).toHaveLength(afterFirst);
  });
});

// ── The row icon ────────────────────────────────────────────────────────────

describe('the icon on a row', () => {
  function projection(overrides: Partial<CredentialProjection>): CredentialProjection {
    return {
      id: 'a',
      type: 'login',
      title: 'Example',
      username: 'alice',
      icon: { kind: 'auto' },
      ...overrides,
    } as CredentialProjection;
  }

  it('uses the initial for a login, because a column of key icons says less', () => {
    expect(iconFor(projection({ title: 'Example' }))).toBe('E');
  });

  it('uses the type’s icon for anything that is not a login', () => {
    // An element rather than a letter: once a record has a kind, the kind is the more useful
    // signal, and ten cards should not look like ten of anything.
    const icon = iconFor(projection({ type: 'card' }));
    expect(typeof icon).toBe('object');
  });

  it('lets a chosen icon win over both', () => {
    // The order that matters. A type icon overriding a chosen one is the app overruling
    // somebody about their own record.
    //
    // Built from a code point rather than written as a literal, because
    // `tools/no-emoji-icons.test.ts` refuses an emoji in a renderer file — and it is right to.
    // The rule is that Keyhold never *draws* an emoji as chrome, since the OS font ignores the
    // theme and a screen reader reads it aloud. A user's chosen icon is data, not chrome, and
    // this fixture is standing in for one.
    const chosen = String.fromCodePoint(0x1f3e6);
    expect(iconFor(projection({ type: 'card', icon: { kind: 'emoji', value: chosen } }))).toBe(
      chosen
    );
  });

  it('falls back to the username, then to a question mark', () => {
    expect(iconFor(projection({ title: '   ', username: 'alice' }))).toBe('A');
    expect(iconFor(projection({ title: '', username: '' }))).toBe('?');
  });
});
