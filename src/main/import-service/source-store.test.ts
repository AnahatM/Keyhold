// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ImportServiceError } from './errors.js';
import { decodeSourceText, holdSource, MAX_IMPORT_FILE_BYTES } from './source-store.js';
import { bitwardenCsv, textFile } from './test-support.js';

/**
 * Holding the file.
 *
 * Two things worth a guard. **The encoding**, because a KeePass or LastPass export written
 * as UTF-16 decoded as UTF-8 becomes a string whose every other byte is a NUL — which every
 * parser in the registry correctly refuses, leaving a user staring at "this is not a CSV"
 * for a perfectly good CSV. And **the ceiling**, because the alternative to a ceiling is
 * holding an arbitrarily large plaintext buffer in the process that holds the master key.
 */

function utf16le(text: string, bom = true): Uint8Array {
  const body = Buffer.from(text, 'utf16le');
  return new Uint8Array(bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body);
}

function utf16be(text: string): Uint8Array {
  const body = Buffer.from(text, 'utf16le');
  for (let index = 0; index + 1 < body.length; index += 2) {
    const low = body[index]!;
    body[index] = body[index + 1]!;
    body[index + 1] = low;
  }
  return new Uint8Array(Buffer.concat([Buffer.from([0xfe, 0xff]), body]));
}

describe('decodeSourceText', () => {
  it('reads UTF-8, with or without a byte-order mark', () => {
    expect(decodeSourceText(new Uint8Array(Buffer.from('name,url', 'utf8')))).toBe('name,url');
    expect(decodeSourceText(new Uint8Array(Buffer.from('﻿name,url', 'utf8')))).toBe('name,url');
  });

  it('reads UTF-16 in both byte orders', () => {
    expect(decodeSourceText(utf16le('name,url\néé'))).toBe('name,url\néé');
    expect(decodeSourceText(utf16be('name,url\néé'))).toBe('name,url\néé');
  });
});

describe('holdSource', () => {
  it('detects a format and offers the header row, without keeping the path', () => {
    const held = holdSource('s1', textFile('vault-export.csv', bitwardenCsv([{ name: 'A' }])));

    expect(held.descriptor.detectedFormatId).toBe('bitwarden-csv');
    expect(held.descriptor.fileName).toBe('vault-export.csv');
    expect(held.descriptor.columns).toContain('login_username');
    expect(JSON.stringify(held.descriptor)).not.toContain('/');
    held.destroy();
  });

  it('offers no columns for a file that is not a table', () => {
    const held = holdSource('s1', textFile('export.json', '{"items":[],"encrypted":false}'));
    expect(held.descriptor.columns).toEqual([]);
    expect(held.descriptor.inferredMapping).toBeNull();
    held.destroy();
  });

  it('zeroes the bytes it was given when a file is over the ceiling', () => {
    const bytes = new Uint8Array(MAX_IMPORT_FILE_BYTES + 1).fill(0x41);
    expect(() => holdSource('s1', { fileName: 'huge.csv', bytes })).toThrow(ImportServiceError);
    // Refused, and not left lying around: the caller transferred ownership, so a refusal
    // that walks away from the buffer is a leak with a polite error message on top.
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it('refuses to be read after it is destroyed', () => {
    const held = holdSource('s1', textFile('export.csv', bitwardenCsv([{ name: 'A' }])));
    held.destroy();
    expect(() => held.readSecretText()).toThrow();
  });
});
