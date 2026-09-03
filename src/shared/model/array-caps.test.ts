// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { MAX_CUSTOM_FIELDS, MAX_SECURITY_QUESTIONS, MAX_TAGS, MAX_URLS } from './credential.js';
import { requireCredentialInput } from '../ipc/credential-validation.js';

/**
 * Guard: the array caps actually fire, at both layers, at the number the model declares.
 *
 * This exists because of what happened when the caps were folded into one constant. They had
 * been declared twice — once in `credential-validation.ts` and once in `credential-ops.ts` —
 * and a guard parsed both files out of the source to check the two numbers agreed. Folding
 * them into one exported constant made that guard vacuous, so it was deleted. Setting the
 * surviving constant to 2 and running the whole suite then failed **nothing**: the parity
 * guard had been the only thing in the repo that mentioned these caps at all, and it had
 * never checked that either layer rejected anything.
 *
 * So the caps had a guard about their consistency and none about their effect. Both layers
 * could have stopped enforcing entirely and every test would still have passed.
 *
 * Driven from the constants rather than from literals, deliberately. A test that says "65
 * tags is rejected" stops testing the cap the moment someone raises it to 128 — it becomes a
 * test that 65 is more than some other number. Building `cap + 1` means raising the cap moves
 * the test with it, and the assertion stays "one more than the limit is refused".
 *
 * The ops layer got its own half of this in `credential-ops.test.ts`, beside the rest of
 * `assertValidCredential`, in the same pass and for the same reason; this file covers the IPC
 * boundary and the shared numbers.
 *
 * Fault injection performed: deleting the `value.length > max` check in `requireArray` fails
 * all four tests here; raising only one layer is no longer expressible, which was the point
 * of folding the constants.
 */

const CHANNEL = 'kh:test:caps';

function inputWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { title: 'A record', ...overrides };
}

function repeat<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_unused, index) => make(index));
}

describe('the IPC boundary refuses an over-long array', () => {
  it('refuses one more URL than the cap, and accepts the cap itself', () => {
    const atCap = repeat(MAX_URLS, (index) => `https://example.com/${String(index)}`);
    expect(() => requireCredentialInput(CHANNEL, inputWith({ urls: atCap }))).not.toThrow();

    const overCap = [...atCap, 'https://example.com/one-too-many'];
    expect(() => requireCredentialInput(CHANNEL, inputWith({ urls: overCap }))).toThrow(
      /urls has more than/
    );
  });

  it('refuses one more tag than the cap, and accepts the cap itself', () => {
    const atCap = repeat(MAX_TAGS, (index) => `tag-${String(index)}`);
    expect(() => requireCredentialInput(CHANNEL, inputWith({ tags: atCap }))).not.toThrow();

    expect(() =>
      requireCredentialInput(CHANNEL, inputWith({ tags: [...atCap, 'one-too-many'] }))
    ).toThrow(/tags has more than/);
  });

  it('refuses one more custom field than the cap, and accepts the cap itself', () => {
    const atCap = repeat(MAX_CUSTOM_FIELDS, (index) => ({
      id: `field-${String(index)}`,
      label: `Field ${String(index)}`,
      value: 'x',
      type: 'text',
      hidden: false,
      order: index,
    }));
    expect(() => requireCredentialInput(CHANNEL, inputWith({ custom: atCap }))).not.toThrow();

    const overCap = [
      ...atCap,
      {
        id: 'extra',
        label: 'Extra',
        value: 'x',
        type: 'text',
        hidden: false,
        order: MAX_CUSTOM_FIELDS,
      },
    ];
    expect(() => requireCredentialInput(CHANNEL, inputWith({ custom: overCap }))).toThrow(
      /custom has more than/
    );
  });

  it('refuses one more security question than the cap, and accepts the cap itself', () => {
    const atCap = repeat(MAX_SECURITY_QUESTIONS, (index) => ({
      id: `question-${String(index)}`,
      question: `Question ${String(index)}?`,
      answer: 'an answer',
    }));
    expect(() =>
      requireCredentialInput(CHANNEL, inputWith({ securityQuestions: atCap }))
    ).not.toThrow();

    const overCap = [...atCap, { id: 'extra', question: 'One more?', answer: 'no' }];
    expect(() =>
      requireCredentialInput(CHANNEL, inputWith({ securityQuestions: overCap }))
    ).toThrow(/securityQuestions has more than/);
  });
});
