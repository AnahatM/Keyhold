// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_ATTACHMENT_NAME,
  MAX_ATTACHMENT_NAME_BYTES,
  MAX_ATTACHMENT_NAME_LENGTH,
} from '@shared/model/attachment.js';
import {
  checkAttachmentName,
  hasExecutableExtension,
  looksDisguised,
  sanitiseAttachmentName,
} from './filename.js';

/**
 * Filename sanitisation.
 *
 * The name is inert in the vault and dangerous in exactly one place: the save dialog, where
 * it becomes a path. Everything here is about that moment.
 */

describe('paths', () => {
  it('keeps only the last component', () => {
    expect(sanitiseAttachmentName('../../../etc/passwd')).toBe('passwd');
    expect(sanitiseAttachmentName('/var/log/secure')).toBe('secure');
    expect(sanitiseAttachmentName('C:\\Windows\\System32\\drivers\\etc\\hosts')).toBe('hosts');
    // The separator of the *other* platform is stripped too: a vault written on macOS is
    // opened on Windows, and vice versa.
    expect(sanitiseAttachmentName('folder\\file.pdf')).toBe('file.pdf');
    expect(sanitiseAttachmentName('folder/file.pdf')).toBe('file.pdf');
  });

  it('never returns a name that is itself a traversal', () => {
    expect(sanitiseAttachmentName('..')).toBe(FALLBACK_ATTACHMENT_NAME);
    expect(sanitiseAttachmentName('.')).toBe(FALLBACK_ATTACHMENT_NAME);
    expect(sanitiseAttachmentName('....')).toBe(FALLBACK_ATTACHMENT_NAME);
    expect(sanitiseAttachmentName('')).toBe(FALLBACK_ATTACHMENT_NAME);
    expect(sanitiseAttachmentName('   ')).toBe(FALLBACK_ATTACHMENT_NAME);
  });

  it('drops a bare drive prefix', () => {
    expect(sanitiseAttachmentName('C:report.pdf')).toBe('report.pdf');
  });
});

describe('characters the filesystem cannot take', () => {
  it('removes control characters', () => {
    // A NUL terminates the string in every C API underneath us, so `report.pdf\0.exe` is
    // two different names depending on who is looking at it.
    expect(sanitiseAttachmentName('report.pdf\u0000.exe')).toBe('report.pdf_.exe');
    expect(sanitiseAttachmentName('two\nlines.txt')).toBe('two_lines.txt');
  });

  it('replaces the Windows-illegal punctuation', () => {
    expect(sanitiseAttachmentName('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
  });

  it('strips trailing dots and spaces', () => {
    // Windows drops these when creating the file, so two names that look different in the
    // list would collide into one file on disk.
    expect(sanitiseAttachmentName('report.pdf.')).toBe('report.pdf');
    expect(sanitiseAttachmentName('report.pdf   ')).toBe('report.pdf');
    expect(sanitiseAttachmentName('  report.pdf  ')).toBe('report.pdf');
  });

  it('escapes the reserved device names', () => {
    // `NUL.pdf` resolves to the null device, so saving it discards the file with no error.
    expect(sanitiseAttachmentName('NUL')).toBe('_NUL');
    expect(sanitiseAttachmentName('con.txt')).toBe('_con.txt');
    expect(sanitiseAttachmentName('COM1.pdf')).toBe('_COM1.pdf');
    // Not reserved — only the exact device names are.
    expect(sanitiseAttachmentName('console.txt')).toBe('console.txt');
  });
});

describe('length', () => {
  it('truncates to the filesystem limit and keeps the extension', () => {
    const long = `${'a'.repeat(400)}.pdf`;
    const result = sanitiseAttachmentName(long);

    expect(result.length).toBeLessThanOrEqual(MAX_ATTACHMENT_NAME_LENGTH);
    // Losing the extension would make the saved file unopenable in a way the user cannot
    // diagnose, so the budget comes out of the stem.
    expect(result.endsWith('.pdf')).toBe(true);
  });

  it('counts bytes as well as characters', () => {
    // NTFS counts UTF-16 characters, ext4 and APFS count UTF-8 bytes. 200 CJK characters is
    // legal on one and 600 bytes too long on the other.
    const result = sanitiseAttachmentName(`${'漢'.repeat(200)}.pdf`);
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(MAX_ATTACHMENT_NAME_BYTES);
    expect(result.endsWith('.pdf')).toBe(true);
  });

  it('cuts on whole code points', () => {
    // Half a surrogate pair is not a character, and writing one produces a replacement
    // character or an outright rejection depending on the platform.
    const result = sanitiseAttachmentName(`${'😀'.repeat(200)}.png`);
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(result).not.toMatch(loneSurrogate);
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(MAX_ATTACHMENT_NAME_BYTES);
  });

  it('leaves a name that already fits alone', () => {
    expect(sanitiseAttachmentName('passport-scan.png')).toBe('passport-scan.png');
  });
});

describe('the executable warning', () => {
  it('recognises what the OS would run', () => {
    expect(hasExecutableExtension('setup.exe')).toBe(true);
    expect(hasExecutableExtension('script.PS1')).toBe(true);
    expect(hasExecutableExtension('report.pdf')).toBe(false);
  });

  it('flags a runnable extension hiding behind a document one', () => {
    expect(looksDisguised('invoice.pdf.exe')).toBe(true);
    expect(looksDisguised('holiday.jpg.scr')).toBe(true);
  });

  it('does not flag legitimate double extensions', () => {
    // A rule that catches these is a rule nobody reads.
    expect(looksDisguised('archive.tar.gz')).toBe(false);
    expect(looksDisguised('report.2026.pdf')).toBe(false);
    expect(looksDisguised('notes.v2.md')).toBe(false);
    // Honest, so not a disguise — `executable` still says what it is.
    expect(looksDisguised('setup.exe')).toBe(false);
    expect(checkAttachmentName('setup.exe').executable).toBe(true);
  });

  it('reports the name unchanged when nothing needed cleaning', () => {
    expect(checkAttachmentName('report.pdf')).toEqual({
      sanitised: 'report.pdf',
      changed: false,
      executable: false,
      disguised: false,
    });
  });
});

describe('the invariant every caller depends on', () => {
  const hostile = [
    '../../../etc/passwd',
    'C:\\Windows\\System32\\cmd.exe',
    '..',
    '...',
    '/',
    '\\',
    '\u0000',
    'NUL',
    'a/b\\c/d',
    '   ...   ',
    `${'x'.repeat(1000)}/${'y'.repeat(1000)}.pdf`,
    '<>:"|?*',
    'report.pdf\u0000.exe',
    '.hidden',
    '😀/😀.png',
  ];

  it('never produces an empty name or one containing a separator', () => {
    for (const raw of hostile) {
      const name = sanitiseAttachmentName(raw);
      expect(name).not.toBe('');
      expect(name).not.toContain('/');
      expect(name).not.toContain('\\');
      expect(name).not.toBe('.');
      expect(name).not.toBe('..');
      expect(name.length).toBeLessThanOrEqual(MAX_ATTACHMENT_NAME_LENGTH);
      expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(MAX_ATTACHMENT_NAME_BYTES);
    }
  });

  it('is idempotent — sanitising a sanitised name changes nothing', () => {
    // Otherwise a name that survived one round trip could drift on the next, and two
    // attachments could converge onto one filename after a re-save.
    for (const raw of hostile) {
      const once = sanitiseAttachmentName(raw);
      expect(sanitiseAttachmentName(once)).toBe(once);
    }
  });
});
