// SPDX-License-Identifier: GPL-3.0-or-later
import {
  FALLBACK_ATTACHMENT_NAME,
  MAX_ATTACHMENT_NAME_BYTES,
  MAX_ATTACHMENT_NAME_LENGTH,
  type AttachmentNameCheck,
} from '@shared/model/attachment.js';

/**
 * Cleaning a filename that came from outside.
 *
 * ## What this is defending
 *
 * The stored name is inert while it sits in the vault. It becomes dangerous at exactly one
 * moment: **"save this attachment to disk"**, where it is the default filename in a save
 * dialog or, worse, is joined onto a directory to produce a path. A name of
 * `../../../.bashrc` or `C:\Windows\System32\drivers\etc\hosts` joined to a chosen folder
 * writes outside that folder, silently, with the user's own permissions. That is a path
 * traversal, and the fix has to happen where the name is *stored*, not at each of the
 * several places it is later used — one forgotten call site is the whole bug.
 *
 * So: **this module returns names, never paths.** Everything up to and including the last
 * separator is discarded, on both platforms' separators regardless of which one we are
 * running on, because a vault written on macOS is opened on Windows.
 *
 * ## `invoice.pdf.exe`
 *
 * The double extension is **flagged, not altered.** Three reasons, in order of weight:
 *
 *  - Stripping it would corrupt legitimate names. `backup.tar.gz`, `report.2026.pdf` and
 *    `notes.v2.md` are all double extensions and all fine; a rule that catches the bad one
 *    catches those too, and quietly renaming a user's file is its own kind of data loss.
 *  - The name is not what makes a file run. **Opening it is**, and Keyhold never opens an
 *    attachment — there is no `shell.openPath` on this path and there must never be. The
 *    file only becomes executable once the user has saved it and double-clicked it.
 *  - A warning at the save dialog, where the decision is actually made, is worth more than
 *    a silent rename the user never sees.
 *
 * `AttachmentNameCheck.disguised` is that warning's input.
 */

/** Everything up to and including the last separator is discarded. Both, always. */
const PATH_SEPARATORS = /^.*[/\\]/;

/** A leading `C:` or `\\?\` style prefix, in case a name arrived with no separator after it. */
const WINDOWS_PREFIX = /^[a-z]:/i;

/**
 * Characters that are illegal in a filename on Windows, plus the control range.
 *
 * The control characters matter more than the punctuation: a NUL terminates a string in
 * every C API underneath us, so `report.pdf\0.exe` is `report.pdf` to a validator and
 * something else to the filesystem, and a newline breaks any header the name is written
 * into. They are replaced rather than dropped, so two names that differed only by a control
 * character do not silently become the same name.
 *
 * The bidi and format controls go with them — N25(b). `U+202E` (right-to-left override)
 * and its relatives are legal on every filesystem, but they reverse how the rest of the
 * name *renders*: `invoice<RLO>fdp.exe` reads as `invoiceexe.pdf` in the attachment list
 * and in the save dialog, and `looksDisguised` cannot see it because there is only one
 * real extension. Replacing rather than deleting keeps both properties the class already
 * has — two different names do not converge, and a second pass changes nothing.
 */
const ILLEGAL_CHARACTERS =
  // Written as escapes rather than as the characters themselves: half of them are
  // invisible and one of them reverses the direction of everything after it, so a source
  // file carrying them literally is a source file nobody can read correctly.
  // eslint-disable-next-line no-control-regex -- the control range is exactly what is removed
  /[\u0000-\u001f\u007f<>:"/\\|?*\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * Windows drops trailing dots and spaces when it creates a file, so `report.pdf.` and
 * `report.pdf ` both land on disk as `report.pdf`. Applying the same rule here means two
 * attachments that look different in the list cannot collide into one file on save.
 *
 * A function rather than an inline replace because it has to run **twice** — N25(a):
 * truncation can cut immediately after a `.` or a space and put back exactly what the
 * first pass removed, which broke that collision property and idempotency with it.
 */
function dropWindowsTrailing(name: string): string {
  return name.trim().replace(/[. ]+$/, '');
}

/**
 * MS-DOS device names, still reserved by the Win32 API today.
 *
 * `CON`, `NUL` and friends resolve to a device rather than a file whatever extension is
 * appended, so saving `NUL.pdf` writes to the null device and the user's file vanishes with
 * no error at all. Prefixing with an underscore is the standard escape.
 */
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

/**
 * Extensions the operating system will run, or will hand to something that runs it.
 *
 * Used only to warn. It does not need to be exhaustive to be useful — it needs to cover
 * what actually arrives in a phishing attachment, which is the top of this list.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  'exe',
  'com',
  'bat',
  'cmd',
  'scr',
  'pif',
  'msi',
  'msp',
  'cpl',
  'dll',
  'sys',
  'hta',
  'jar',
  'js',
  'jse',
  'vbs',
  'vbe',
  'wsf',
  'wsh',
  'ps1',
  'psm1',
  'reg',
  'lnk',
  'scf',
  'inf',
  'chm',
  'gadget',
  'sh',
  'bash',
  'zsh',
  'command',
  'app',
  'pkg',
  'run',
  'deb',
  'rpm',
  'appimage',
]);

/**
 * Extensions that make a file look like a document. A disguise needs one of these in front
 * of the runnable one — `setup.exe` is honest, `invoice.pdf.exe` is not.
 */
const DOCUMENT_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'txt',
  'rtf',
  'csv',
  'md',
  'odt',
  'ods',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'tif',
  'tiff',
  'zip',
  'htm',
  'html',
]);

/** Lower-cased extensions, outermost last. `a.tar.gz` → `['tar', 'gz']`. */
function extensionsOf(name: string): string[] {
  const parts = name.split('.');
  return parts.length < 2 ? [] : parts.slice(1).map((part) => part.toLowerCase());
}

/** Whether the operating system would treat this name as something to run. */
export function hasExecutableExtension(name: string): boolean {
  const extensions = extensionsOf(name);
  const last = extensions[extensions.length - 1];
  return last !== undefined && EXECUTABLE_EXTENSIONS.has(last);
}

/**
 * The `invoice.pdf.exe` shape: runnable, wearing a document extension in front of it.
 *
 * Narrower than "has two extensions" on purpose — `archive.tar.gz` and `report.2026.pdf`
 * must not trip it, or the warning becomes noise and stops being read.
 */
export function looksDisguised(name: string): boolean {
  const extensions = extensionsOf(name);
  if (extensions.length < 2) return false;

  const last = extensions[extensions.length - 1];
  if (last === undefined || !EXECUTABLE_EXTENSIONS.has(last)) return false;

  return extensions.slice(0, -1).some((extension) => DOCUMENT_EXTENSIONS.has(extension));
}

/**
 * Shortens to the filesystem limit while keeping the extension.
 *
 * Both limits are enforced: NTFS counts UTF-16 characters, ext4 and APFS count UTF-8 bytes,
 * so a 200-character CJK name is legal on one and 600 bytes too long on the other. Cutting
 * happens on whole code points, because half a surrogate pair is not a character and would
 * be written to disk as a replacement character or rejected outright.
 *
 * The extension is preserved because it is what decides which application opens the file
 * after a save — truncating `scan-of-a-very-long-name….pdf` into something with no `.pdf`
 * makes the saved file useless in a way the user will not understand.
 */
function truncate(name: string): string {
  if (name.length <= MAX_ATTACHMENT_NAME_LENGTH && utf8Length(name) <= MAX_ATTACHMENT_NAME_BYTES) {
    return name;
  }

  const lastDot = name.lastIndexOf('.');
  // A leading dot is not an extension, it is a hidden file. An "extension" longer than 16
  // characters is almost certainly not one either, and keeping it would eat the whole budget.
  const extension = lastDot > 0 && name.length - lastDot <= 17 ? name.slice(lastDot) : '';
  const stemBudgetChars = MAX_ATTACHMENT_NAME_LENGTH - extension.length;
  const stemBudgetBytes = MAX_ATTACHMENT_NAME_BYTES - utf8Length(extension);

  // When the tail was too long to count as an extension it stays part of the stem, so the
  // budget is spent on the name the user actually sees rather than silently thrown away.
  const stemSource = extension === '' ? name : name.slice(0, lastDot);

  let stem = '';
  let bytes = 0;
  for (const character of stemSource) {
    const size = utf8Length(character);
    if (stem.length + character.length > stemBudgetChars || bytes + size > stemBudgetBytes) break;
    stem += character;
    bytes += size;
  }

  const result = `${stem}${extension}`;
  return result === extension ? FALLBACK_ATTACHMENT_NAME : result;
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Turns whatever arrived into a name that is safe to store, show, and later hand to a save
 * dialog.
 *
 * Never returns an empty string and never returns something containing a separator, so a
 * caller cannot accidentally build a path that escapes its directory. That is the invariant
 * the property test asserts.
 */
export function sanitiseAttachmentName(raw: string): string {
  // Strip the directory first, so `../../etc/passwd` becomes `passwd` before anything else
  // gets a chance to interpret the dots.
  let name = raw.replace(PATH_SEPARATORS, '').replace(WINDOWS_PREFIX, '');

  name = name.replace(ILLEGAL_CHARACTERS, '_');
  name = dropWindowsTrailing(name);

  // What is left of `.` or `..` after the trailing-dot strip is nothing, but a name that was
  // *only* dots is worth naming explicitly rather than falling through the empty check.
  if (name === '' || /^\.+$/.test(name)) return FALLBACK_ATTACHMENT_NAME;

  const stem = (name.split('.')[0] ?? '').toLowerCase();
  if (RESERVED_NAMES.has(stem)) name = `_${name}`;

  // Applied to the truncated *result* as well as to the input, because the cut can land
  // immediately after a `.` or a space — see `dropWindowsTrailing`, N25(a).
  const shortened = dropWindowsTrailing(truncate(name));
  return shortened === '' || /^\.+$/.test(shortened) ? FALLBACK_ATTACHMENT_NAME : shortened;
}

/** The sanitised name plus the two facts a save dialog needs to warn about. */
export function checkAttachmentName(raw: string): AttachmentNameCheck {
  const sanitised = sanitiseAttachmentName(raw);
  return {
    sanitised,
    changed: sanitised !== raw,
    executable: hasExecutableExtension(sanitised),
    disguised: looksDisguised(sanitised),
  };
}
