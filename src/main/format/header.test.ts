// SPDX-License-Identifier: GPL-3.0-or-later
import { CIPHER_ID, KDF_ID, type KeepHeader } from '@shared/format/types.js';
import { describe, expect, it } from 'vitest';
import { VaultError } from '../crypto/errors.js';
import { newHeader, parseHeader, serialiseHeader } from './header.js';

/**
 * What a header parse failure is allowed to say.
 *
 * `container.test.ts` already covers *which* headers are rejected — that is the parser's job
 * and it is tested there. This file is about the other half: the header is the first thing this
 * app reads out of an untrusted file, and its rejection message does not stop at the parser.
 * It reaches an error dialog, and `recovery/file-inspection.ts` borrows it verbatim into the
 * diagnostic report, which exists to be pasted into an issue tracker.
 *
 * Two messages here used to interpolate a value straight out of the header:
 * `unsupported key-derivation algorithm "${alg}"` and `unsupported cipher "${cipher}"`. The
 * only thing behind them was `sanitiseDetail`'s 200-character cap, and a cap says nothing about
 * *what* those characters are. So the adversarial fixtures below are the point of this file:
 * a name carrying a quote, a name carrying newlines, and a name of 300 characters of junk.
 *
 * This is a lower-severity instance of the shape that produced a note-fragment leak in
 * `history-detail.ts` — the header is plaintext by design, so a crafted file's content is the
 * attacker's own rather than the user's secret, and what is at stake is report pollution rather
 * than disclosure. It is the same shape all the same, and the same fix applies: compose the
 * sentence, never interpolate the input.
 */

const validHeader = (): KeepHeader =>
  newHeader({
    vaultId: 'vault-0',
    deviceId: 'device-0',
    kdf: {
      alg: KDF_ID,
      memoryKib: 65_536,
      iterations: 3,
      parallelism: 1,
      salt: Buffer.alloc(16, 7).toString('base64'),
    },
    wrappedDek: {
      nonce: Buffer.alloc(12, 1).toString('base64'),
      ciphertext: Buffer.alloc(32, 2).toString('base64'),
      tag: Buffer.alloc(16, 3).toString('base64'),
    },
    now: 1_700_000_000_000,
  });

/** A header as loose JSON, so a field can hold something the type system forbids. */
function rawHeader(overrides: Readonly<Record<string, unknown>>): Uint8Array {
  const base = JSON.parse(Buffer.from(serialiseHeader(validHeader())).toString('utf8')) as Record<
    string,
    unknown
  >;
  return new Uint8Array(Buffer.from(JSON.stringify({ ...base, ...overrides }), 'utf8'));
}

/** A header whose `kdf.alg` is whatever the caller says, valid or not. */
function withKdfAlg(alg: unknown): Uint8Array {
  const base = JSON.parse(Buffer.from(serialiseHeader(validHeader())).toString('utf8')) as {
    kdf: Record<string, unknown>;
  } & Record<string, unknown>;
  return new Uint8Array(
    Buffer.from(JSON.stringify({ ...base, kdf: { ...base.kdf, alg } }), 'utf8')
  );
}

function messageFor(bytes: Uint8Array): string {
  try {
    parseHeader(bytes);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the header was expected to be rejected and was not');
}

describe('a header this build can read', () => {
  it('round-trips through serialise and parse', () => {
    const header = validHeader();
    expect(parseHeader(serialiseHeader(header))).toEqual(header);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The algorithm names, reported from an allow-list
// ─────────────────────────────────────────────────────────────────────────────

describe('an unsupported key-derivation algorithm', () => {
  it('names the one on the allow-list, because it helps and it is ours', () => {
    // The useful case, and the one the allow-list exists to preserve: `argon2i` is a real
    // thing a real file might claim, and naming it is what tells a user their file came from
    // somewhere else rather than being damaged.
    const message = messageFor(withKdfAlg('argon2i'));

    expect(message).toContain('unsupported key-derivation algorithm');
    expect(message).toContain('"argon2i"');
    expect(message).toContain(`"${KDF_ID}"`);
  });

  it('does not reproduce a name it does not recognise', () => {
    const message = messageFor(withKdfAlg('totally-made-up-kdf'));

    expect(message).not.toContain('totally-made-up-kdf');
    expect(message).toContain('does not recognise');
    expect(message).toContain('19 character(s)');
  });

  it('does not reproduce a name carrying a quote', () => {
    // The shape that defeated the scrubber in `text.ts`: the value supplies its own quotes,
    // presenting any quoted-run scanner with pairs it is perfectly happy about.
    const alg = 'argon2id" is fine, and so is "password';
    const message = messageFor(withKdfAlg(alg));

    expect(message).not.toContain(alg);
    expect(message).not.toContain('is fine');
    expect(message).toContain('does not recognise');
  });

  it('does not reproduce a name carrying newlines', () => {
    // A newline in a report is not cosmetic: the renderer wraps and indents, so an injected
    // line break lets a crafted file forge what looks like another finding under a real one.
    const alg = 'argon2id\n\nCRITICAL: your vault has been seized\n';
    const message = messageFor(withKdfAlg(alg));

    expect(message).not.toContain('seized');
    expect(message).not.toContain('\n');
    expect(message).toContain('does not recognise');
  });

  it('does not reproduce 300 characters of junk, and is not merely truncated', () => {
    // The old failure mode was a 200-character cap, which is a bound and not a defence: it
    // still reproduces 200 characters of whatever the file chose. The message must be short
    // *because it was composed*, not because something cut it off.
    const alg = 'Z'.repeat(300);
    const message = messageFor(withKdfAlg(alg));

    expect(message).not.toContain('ZZZZ');
    expect(message).toContain('300 character(s)');
    expect(message.length).toBeLessThan(200);
    expect(message).not.toContain('…');
  });

  it('reports an empty name as empty rather than saying nothing', () => {
    const message = messageFor(withKdfAlg(''));

    expect(message).toContain('0 character(s)');
  });

  it('counts code points, not UTF-16 units', () => {
    // Three emoji is three characters to the person counting them, not six.
    const message = messageFor(withKdfAlg('🙂🙂🙂'));

    expect(message).toContain('3 character(s)');
  });

  it('rejects a non-string alg before it can be interpolated at all', () => {
    // `requireString` fires first, and its message quotes only the field-name literal.
    const message = messageFor(withKdfAlg({ toString: () => 'argon2id' }));

    expect(message).toContain('"alg" is not a string');
  });
});

describe('an unsupported cipher', () => {
  it('names the one on the allow-list', () => {
    const message = messageFor(rawHeader({ cipher: 'ChaCha20-Poly1305' }));

    expect(message).toContain('unsupported cipher');
    expect(message).toContain('"ChaCha20-Poly1305"');
    expect(message).toContain(`"${CIPHER_ID}"`);
  });

  it('does not reproduce an unrecognised name, however it is spelled', () => {
    for (const cipher of [
      'ROT13',
      'AES-256-GCM" — trust me, "unlocked',
      'AES\n\nnothing to see here',
      'Q'.repeat(300),
    ]) {
      const message = messageFor(rawHeader({ cipher }));

      expect(message, cipher.slice(0, 12)).toContain('does not recognise');
      expect(message, cipher.slice(0, 12)).not.toContain(cipher);
      expect(message.length, cipher.slice(0, 12)).toBeLessThan(200);
    }
  });

  it('is case-sensitive, because the format is', () => {
    // `aes-256-gcm` is not `AES-256-GCM`. Matching loosely here would mean a message that
    // claims the file is fine in a case where the parser has just refused it.
    const message = messageFor(rawHeader({ cipher: 'aes-256-gcm' }));

    expect(message).toContain('does not recognise');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The property the two rules above are instances of
// ─────────────────────────────────────────────────────────────────────────────

describe('no header field reaches a message', () => {
  /**
   * A marker planted into every field in turn, asserting it never comes back out.
   *
   * Written as a sweep rather than a case per field deliberately: the two interpolations this
   * file was repaired for were the ones somebody had a reason to write, and the next one will
   * be too. A per-field test only ever covers the fields somebody remembered.
   */
  const MARKER = 'MARKERMARKERMARKER';

  const FIELDS: readonly string[] = [
    'vaultId',
    'deviceId',
    'cipher',
    'formatVersion',
    'createdAt',
    'modifiedAt',
    'generation',
    'recordCount',
    'attachmentCount',
    'wrappedDek',
    'kdf',
  ];

  it('holds for a marker planted in any single field', () => {
    for (const field of FIELDS) {
      // `vaultId` and `deviceId` are strings a valid header may legitimately carry, so those
      // two do not throw at all; the assertion is only ever about what a *message* contains.
      let message: string | null = null;
      try {
        parseHeader(rawHeader({ [field]: MARKER }));
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      if (message !== null) expect(message, field).not.toContain(MARKER);
    }
  });

  it('holds for a marker planted in any kdf sub-field', () => {
    for (const field of ['alg', 'memoryKib', 'iterations', 'parallelism', 'salt']) {
      const base = JSON.parse(Buffer.from(serialiseHeader(validHeader())).toString('utf8')) as {
        kdf: Record<string, unknown>;
      } & Record<string, unknown>;
      const bytes = new Uint8Array(
        Buffer.from(JSON.stringify({ ...base, kdf: { ...base.kdf, [field]: MARKER } }), 'utf8')
      );

      expect(messageFor(bytes), field).not.toContain(MARKER);
    }
  });

  it('holds for a marker planted in any wrappedDek sub-field', () => {
    for (const field of ['nonce', 'ciphertext', 'tag']) {
      const base = JSON.parse(Buffer.from(serialiseHeader(validHeader())).toString('utf8')) as {
        wrappedDek: Record<string, unknown>;
      } & Record<string, unknown>;
      const bytes = new Uint8Array(
        Buffer.from(
          JSON.stringify({ ...base, wrappedDek: { ...base.wrappedDek, [field]: MARKER } }),
          'utf8'
        )
      );

      expect(messageFor(bytes), field).not.toContain(MARKER);
    }
  });

  it('holds for a header that is not an object at all', () => {
    for (const raw of [`"${MARKER}"`, `[${JSON.stringify(MARKER)}]`, `{${MARKER}`]) {
      const message = messageFor(new Uint8Array(Buffer.from(raw, 'utf8')));

      expect(message, raw.slice(0, 12)).not.toContain(MARKER);
    }
  });

  it('holds for an unknown extra field, which is ignored rather than described', () => {
    // A header may carry a field this build has never heard of — a future version writing one
    // is the whole reason `formatVersion` exists. Ignoring it silently is correct; naming it
    // in a message would put an attacker-chosen key into the report.
    const bytes = rawHeader({ [MARKER]: MARKER, cipher: 'not-a-cipher' });
    const message = messageFor(bytes);

    expect(message).not.toContain(MARKER);
  });
});

describe('the content hash field', () => {
  const base = {
    formatVersion: 1,
    vaultId: 'v',
    deviceId: 'd',
    // The real ids, from the constants, so this fixture cannot drift from what the parser
    // accepts — the point here is the one field being added, not the eleven around it.
    kdf: { alg: KDF_ID, memoryKib: 19_456, iterations: 2, parallelism: 1, salt: 'AAAA' },
    cipher: CIPHER_ID,
    wrappedDek: { nonce: 'AAAA', ciphertext: 'AAAA', tag: 'AAAA' },
    createdAt: 1,
    modifiedAt: 1,
    generation: 1,
    recordCount: 0,
    attachmentCount: 0,
  };

  const parse = (raw: Record<string, unknown>): unknown =>
    parseHeader(new Uint8Array(Buffer.from(JSON.stringify(raw), 'utf8')));

  it('accepts a real digest', () => {
    expect(parse({ ...base, contentHash: 'a'.repeat(64) })).toMatchObject({
      contentHash: 'a'.repeat(64),
    });
  });

  it('accepts a header that has none', () => {
    // Every vault written before the field existed. A required field here would have broken
    // all of them, silently, at the moment of opening.
    //
    // `not.toHaveProperty` rather than `toMatchObject({ contentHash: undefined })`: with
    // `exactOptionalPropertyTypes`, absent and present-but-undefined are different things,
    // and only the first serialises back to the bytes the tag was computed over.
    expect(parse(base)).not.toHaveProperty('contentHash');
  });

  it('refuses anything that is not a digest', () => {
    // The header is plaintext and whoever hands you a `.keep` chose every byte of it. The
    // value is only ever compared against one we compute, so a wrong shape can only mean
    // "does not match" — checking it here reports a malformed field instead of a spurious
    // content difference that would send someone into a merge for nothing.
    for (const bad of [
      '',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      `${'a'.repeat(63)}z`,
      `${'a'.repeat(62)}

`,
      42,
      null,
      ['a'.repeat(64)],
    ]) {
      expect(() => parse({ ...base, contentHash: bad }), JSON.stringify(bad)).toThrow(VaultError);
    }
  });
});
