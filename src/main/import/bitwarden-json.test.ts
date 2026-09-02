// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VaultError } from '../crypto/errors.js';
import { bitwardenJsonParser } from './bitwarden-json.js';
import { loadFixture } from './fixtures/load.js';

/**
 * Bitwarden JSON field mapping, plus the refusal of the encrypted variants.
 *
 * The interesting difference from the CSV is that this format keeps Bitwarden's own **field
 * types**, so a hidden field arrives hidden rather than being guessed at, and cards and
 * identities arrive as structured data rather than not at all.
 */

const result = bitwardenJsonParser.parse(loadFixture('bitwarden.json'));
const byTitle = (title: string): (typeof result.records)[number] | undefined =>
  result.records.find((record) => record.title === title);

describe('bitwarden JSON', () => {
  it('maps a login, its multiple URIs and its TOTP', () => {
    const mail = byTitle('Example Mail');
    expect(mail?.username).toBe('ada@example.com');
    expect(mail?.password).toBe('hunter2');
    expect(mail?.urls).toEqual(['https://mail.example.com', 'https://webmail.example.com']);
    expect(mail?.favorite).toBe(true);
    expect(mail?.custom?.[0]).toMatchObject({ label: 'One-time password', type: 'otp-secret' });
  });

  it('trusts Bitwarden’s own field type for a hidden field instead of re-guessing it', () => {
    // A hidden field is secret because Bitwarden says so. Guessing from the label would call
    // "Support PIN" a pin, which is also secret — but a hidden field named "Nickname" would
    // come out as plain text and reach the renderer.
    const mail = byTitle('Example Mail');
    const support = mail?.custom?.find((field) => field.label === 'Support PIN');
    expect(support?.type).toBe('password');
    const boolean = mail?.custom?.find((field) => field.label === 'Two-factor enabled');
    expect(boolean?.type).toBe('boolean');
  });

  it('resolves folder ids to names, and lists ancestors for the caller to create', () => {
    expect(result.folders).toEqual(['Personal', 'Work', 'Work/Clients']);
    expect(byTitle('Example Admin')?.folderId).toBe('import-folder:Work/Clients');
  });

  it('imports a card as custom fields, with the number and code as secret types', () => {
    const card = byTitle('Example Card');
    const typed = Object.fromEntries(card?.custom?.map((f) => [f.label, f.type]) ?? []);
    expect(typed['Card number']).toBe('password');
    expect(typed['Security code']).toBe('pin');
    expect(typed['Expiry month']).toBe('number');
  });

  it('imports an identity, giving its email and username their proper homes', () => {
    const identity = byTitle('Example Identity');
    expect(identity?.email).toBe('ada@example.com');
    expect(identity?.username).toBe('ada');
    const typed = Object.fromEntries(identity?.custom?.map((f) => [f.label, f.type]) ?? []);
    expect(typed['Social security number']).toBe('password');
    expect(typed.Honorific).toBe('text');
  });

  it('leaves an item in Bitwarden’s trash in the trash, and says so', () => {
    expect(byTitle('Deleted Login')).toBeUndefined();
    expect(result.warnings.some((warning) => warning.kind === 'skipped-row')).toBe(true);
  });

  it('names everything it could not carry: reprompt, passkeys and password history', () => {
    const messages = result.warnings.map((warning) => warning.message).join(' ');
    expect(messages).toContain('re-prompt');
    expect(messages).toContain('passkey');
    expect(messages).toContain('password history');
  });

  it('refuses an encrypted export and says which checkbox to change', () => {
    // The one case where throwing is right: there is no partial answer to give.
    const encrypted = loadFixture('bitwarden-encrypted.json');
    expect(() => bitwardenJsonParser.parse(encrypted)).toThrow(VaultError);
    expect(() => bitwardenJsonParser.parse(encrypted)).toThrow(/password-protected/);
  });

  it('refuses an account-encrypted export with a different, accurate reason', () => {
    const accountEncrypted = '{"encrypted":true,"items":[]}';
    expect(() => bitwardenJsonParser.parse(accountEncrypted)).toThrow(/account key/);
  });

  it('throws a VaultError, not a SyntaxError, for a file that is not JSON', () => {
    expect(() => bitwardenJsonParser.parse('{not json')).toThrow(VaultError);
  });

  it('survives an item whose shape is wrong, rather than abandoning the file', () => {
    const damaged = '{"encrypted":false,"items":[null,{"type":1,"name":"Kept"}]}';
    const salvaged = bitwardenJsonParser.parse(damaged);
    expect(salvaged.records.map((record) => record.title)).toEqual(['Kept']);
    expect(salvaged.warnings.some((warning) => warning.kind === 'skipped-row')).toBe(true);
  });
});
