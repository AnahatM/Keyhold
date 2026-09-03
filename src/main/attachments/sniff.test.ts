// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { checkMimeClaim, normaliseMimeClaim, previewKindForMime, sniffFormat } from './sniff.js';

/**
 * Format detection.
 *
 * What is being tested is not "can it recognise a PNG" — it is that **the claim never wins**.
 * The claimed type decides which viewer renders the bytes, and it is the one field an
 * attacker fully controls, so every case here is really the same case: what gets stored when
 * the two disagree.
 */

function bytesOf(...values: number[]): Uint8Array {
  return new Uint8Array([...values, ...new Array<number>(16).fill(0)]);
}

function ascii(text: string, ...trailing: number[]): Uint8Array {
  return new Uint8Array([...Buffer.from(text, 'ascii'), ...trailing]);
}

const PNG = bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = bytesOf(0xff, 0xd8, 0xff, 0xe0);
const GIF = ascii('GIF89a', 0, 0, 0, 0);
const PDF = ascii('%PDF-1.7', 0, 0, 0, 0);
const ZIP = bytesOf(0x50, 0x4b, 0x03, 0x04);
const WEBP = new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')]);
const NOTHING = bytesOf(0x00, 0x01, 0x02, 0x03);

describe('sniffing', () => {
  it('recognises the formats the app previews', () => {
    expect(sniffFormat(PNG)).toEqual({ mime: 'image/png', kind: 'image' });
    expect(sniffFormat(JPEG)).toEqual({ mime: 'image/jpeg', kind: 'image' });
    expect(sniffFormat(GIF)).toEqual({ mime: 'image/gif', kind: 'image' });
    expect(sniffFormat(PDF)).toEqual({ mime: 'application/pdf', kind: 'pdf' });
    expect(sniffFormat(ZIP)).toEqual({ mime: 'application/zip', kind: 'archive' });
  });

  it('checks every part of a multi-part signature', () => {
    // RIFF alone is also AVI and WAV. Matching on the first four bytes would call those WebP.
    expect(sniffFormat(WEBP)).toEqual({ mime: 'image/webp', kind: 'image' });
    expect(
      sniffFormat(new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('AVI ')]))
    ).toBeNull();
  });

  it('returns null for anything it does not know', () => {
    expect(sniffFormat(NOTHING)).toBeNull();
    expect(sniffFormat(new Uint8Array(0))).toBeNull();
    // A truncated signature is not a signature.
    expect(sniffFormat(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe('the claimed type', () => {
  it('is confirmed when the bytes agree', () => {
    const check = checkMimeClaim('image/png', PNG);
    expect(check.status).toBe('confirmed');
    expect(check.stored).toBe('image/png');
    expect(check.kind).toBe('image');
  });

  it('accepts a different spelling of the same format', () => {
    // A browser saying `image/jpg` is not lying, and reporting it as a mismatch would train
    // the user to ignore the warning.
    expect(checkMimeClaim('image/jpg', JPEG).status).toBe('confirmed');
    expect(
      checkMimeClaim('application/vnd.openxmlformats-officedocument.wordprocessingml.document', ZIP)
        .status
    ).toBe('confirmed');
  });

  it('stores what the bytes are when the claim disagrees', () => {
    const check = checkMimeClaim('application/pdf', PNG);
    expect(check.status).toBe('mismatch');
    expect(check.claimed).toBe('application/pdf');
    expect(check.detected).toBe('image/png');
    // The whole point: the stored type is the detected one, so nothing downstream renders
    // this file with a PDF parser because its name ended in `.pdf`.
    expect(check.stored).toBe('image/png');
  });

  it('keeps an unrecognised file out of every parser', () => {
    const check = checkMimeClaim('application/vnd.acme.thing', NOTHING);
    expect(check.status).toBe('unknown');
    expect(check.detected).toBeNull();
    expect(check.kind).toBe('other');
  });

  it('refuses a parser-selecting claim whose signature is simply absent', () => {
    // N8. `mismatch` needs the bytes to match some *other* known format; bytes matching
    // nothing fall to `unknown`, and the claim was previously believed there — so a file
    // that fails every signature test still selected the PDF or image viewer on its name.
    // A signature-bearing format with no signature is a lie, not an unknown.
    for (const claim of [
      'application/pdf',
      'application/x-pdf',
      'image/png',
      'image/jpg',
      'application/zip',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]) {
      const check = checkMimeClaim(claim, NOTHING);
      expect(check.status).toBe('unknown');
      expect(check.kind).toBe('other');
      // Not merely the kind: the *stored* type must not carry the lie either, or the next
      // reader of `AttachmentMeta.mime` resurrects the parser through `previewKindForMime`.
      expect(check.stored).toBe('application/octet-stream');
    }
  });

  it('still believes a claim no signature could have confirmed', () => {
    // The other half of the same rule: a type that is not in the registry has no signature
    // to be missing, so keeping it costs nothing and loses no information.
    const check = checkMimeClaim('image/svg+xml', NOTHING);
    expect(check.stored).toBe('image/svg+xml');
    expect(check.kind).toBe('other');
  });

  it('sniffs a PDF only from its first bytes, and says so by storing nothing else', () => {
    // Detection reads SNIFF_BYTES; pdf.js scans the first 1024 for `%PDF-`. A PDF behind a
    // 100-byte prefix is therefore unrecognised here — and must be stored as unrecognised
    // rather than as the caller's `application/pdf`.
    const buried = new Uint8Array([...new Uint8Array(100), ...ascii('%PDF-1.7')]);
    const check = checkMimeClaim('application/pdf', buried);
    expect(check.detected).toBeNull();
    expect(check.stored).toBe('application/octet-stream');
    expect(check.kind).toBe('other');
  });

  it('still previews plain text, which has no signature', () => {
    const check = checkMimeClaim('text/plain', ascii('recovery codes'));
    expect(check.status).toBe('unknown');
    // Safe to believe: text is rendered as text and executes nothing. A claim that would
    // select a parser cannot reach this branch, because those formats have signatures.
    expect(check.kind).toBe('text');
  });

  it('refuses to believe a claim it cannot parse', () => {
    expect(normaliseMimeClaim('text/plain; charset=utf-8')).toBe('text/plain');
    expect(normaliseMimeClaim('IMAGE/PNG')).toBe('image/png');
    expect(normaliseMimeClaim('not a mime type')).toBe('application/octet-stream');
    expect(normaliseMimeClaim('text/plain\r\nX-Injected: yes')).toBe('application/octet-stream');
    expect(normaliseMimeClaim('')).toBe('application/octet-stream');
    expect(normaliseMimeClaim(`text/${'x'.repeat(500)}`)).toBe('application/octet-stream');
  });
});

describe('preview kinds', () => {
  it('reads the same registry detection does', () => {
    expect(previewKindForMime('image/png')).toBe('image');
    expect(previewKindForMime('application/pdf')).toBe('pdf');
    expect(previewKindForMime('application/zip')).toBe('archive');
    expect(previewKindForMime('text/plain')).toBe('text');
  });

  it('gives script-bearing text formats no preview at all', () => {
    // Both are text with no reliable signature and both can carry script, so they are
    // deliberately absent from the registry rather than handled specially.
    expect(previewKindForMime('image/svg+xml')).toBe('other');
    expect(previewKindForMime('text/html')).toBe('other');
  });
});
