// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import {
  TotpError,
  hotpNotSupported,
  invalidParameter,
  invalidSeed,
  invalidUri,
  unsupportedOtpType,
} from './errors.js';

/**
 * The guard `errors.ts` says exists.
 *
 * Its docblock promises that no seed, URI or code can reach an error message. That promise
 * was enforced only for base32 — this file makes it hold for the whole module, and adds the
 * source-level check that catches the one channel a runtime test cannot see.
 *
 * ## Why a source sweep and not only behaviour
 *
 * `TotpError`'s constructor accepts `options.cause`. A chained cause is serialised by most
 * loggers and crash reporters, and `URL`'s own error message quotes the input — which, for
 * an `otpauth:` link, *is* the seed. No factory passes one today; `uri.ts` explicitly drops
 * it with a comment saying why. Nothing but a check over the source keeps it that way, since
 * a cause added tomorrow would not change any behaviour asserted below.
 */

const FACTORIES = [
  ['invalidSeed', () => invalidSeed('it is empty')],
  ['invalidUri', () => invalidUri('it is not a well-formed link')],
  ['hotpNotSupported', () => hotpNotSupported()],
  ['unsupportedOtpType', () => unsupportedOtpType()],
  ['invalidParameter', () => invalidParameter('the period must be positive')],
] as const;

describe('every error this module can raise', () => {
  it.each(FACTORIES)('%s is a TotpError with a code and a message', (_name, make) => {
    const error = make();

    expect(error).toBeInstanceOf(TotpError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('TotpError');
    expect(error.code.length).toBeGreaterThan(0);
    expect(error.message.length).toBeGreaterThan(0);
  });

  it.each(FACTORIES)('%s carries no cause, which is the channel that would leak', (_name, make) => {
    // A cause is what a logger expands. `undefined` here is the whole point.
    expect(make().cause).toBeUndefined();
  });

  it('says out loud that the value is withheld, so the omission looks deliberate', () => {
    // A user reporting a bug needs to know the app is not simply failing to tell them
    // something — otherwise the next step is pasting the seed in by hand.
    expect(invalidSeed('it is empty').message).toContain('deliberately not shown');
    expect(invalidUri('it is malformed').message).toContain('deliberately not shown');
  });
});

describe('no factory can be handed a secret to interpolate', () => {
  it('never passes a cause anywhere in the module', () => {
    // The runtime tests above cover today's factories; this covers tomorrow's edit.
    const directory = new URL('.', import.meta.url);
    const sources = readdirSync(directory)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => [name, readFileSync(new URL(name, directory), 'utf8')] as const);

    expect(sources.length).toBeGreaterThan(0);
    for (const [name, source] of sources) {
      // Matched as the object property it would have to be written as (`cause:`), not as
      // the bare word — several of these messages contain "because", and a guard that
      // fires on its own prose is a guard that gets deleted.
      const passesCause = /\bnew TotpError\((?:[^()]|\([^()]*\))*?\bcause\s*:/s.test(source);
      expect(passesCause, `${name} passes a cause into a TotpError`).toBe(false);
    }
  });

  it('keeps the URL constructor’s message out of the thrown error', () => {
    // `URL` quotes its input, and for an otpauth link the input is the seed. `uri.ts` must
    // keep swallowing it rather than chaining it.
    const source = readFileSync(new URL('./uri.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/catch\s*\(\s*\w+\s*\)\s*\{[^}]*cause:/s);
  });
});
