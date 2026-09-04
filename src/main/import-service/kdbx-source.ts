// SPDX-License-Identifier: GPL-3.0-or-later
import { kdbxAttachmentMarker } from '../import/keepass-xml.js';
import { readKdbx } from '../kdbx/read.js';
import { KDBX_SIGNATURE_1, KDBX_SIGNATURE_2 } from '../kdbx/types.js';
import type { PickedImportFile } from './source-store.js';

/**
 * A KeePass `.kdbx` as an import source: decrypt it, hand over the XML, stop.
 *
 * The same move as D30, which opens a `.keep` by decrypting it and handing the result to the
 * Keyhold JSON parser that already exists. Here the payload is KeePass XML, and
 * `import/keepass-xml.ts` already reads that schema — the group tree, the custom strings, the
 * recycle bin, the history it must not walk. So a KDBX import is a decrypt plus a parser that
 * was already written and already tested, rather than a second mapping for the same schema.
 *
 * **That is the whole design, and it is worth being explicit about why.** A KDBX-specific
 * record mapper would be a second implementation of "what a KeePass entry means", and the two
 * would disagree the first time one of them was fixed — rule 8's second list, in the place
 * where a disagreement silently loses a field. Everything after this function is the path
 * every other format takes: detection, the dry run, duplicate matching, the commit, the undo.
 *
 * ## Attachments
 *
 * A KDBX carries its attachments in the inner header, referenced from entries by index. They
 * are **not** imported, matching the `.1pux` importer and the `.keep` one: the importer
 * creates records, not chunks. The count is passed on so the parser can report it rather than
 * dropping files silently — a user who imported a database and lost the PDF stapled to their
 * insurance login should be told, not left to notice.
 */

/**
 * Whether these bytes are a KeePass database, decided on the signature alone.
 *
 * Read as bytes rather than by decoding, and that is the same trap `looksLikeZip` exists for:
 * UTF-8 decoding replaces every invalid sequence with U+FFFD, irreversibly, so a check that
 * ran after a decode would be looking at a file that had already been destroyed.
 *
 * The **version** is deliberately not checked here. A KDBX 3 file is a KDBX file, and routing
 * it to the reader — which refuses it by name, with the way out — is a far better answer than
 * this function saying "not a KeePass database" about something that plainly is.
 */
export function looksLikeKdbx(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (
    view.getUint32(0, true) === KDBX_SIGNATURE_1 && view.getUint32(4, true) === KDBX_SIGNATURE_2
  );
}

export interface KdbxSourceInput {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  /** Named for what it is. Used once, here, and never stored. */
  readonly secretPassphrase: string;
}

export async function readKdbxAsImportSource(input: KdbxSourceInput): Promise<PickedImportFile> {
  const database = await readKdbx(input.bytes, input.secretPassphrase);

  // Built by the parser that reads it, not composed here from a string this file owns. The
  // two used to keep separate copies of the same marker and agreed only by luck — see
  // `kdbxAttachmentMarker`.
  const marker = kdbxAttachmentMarker(database.binaries.length);

  return {
    // The `.xml` extension, not the `.kdbx` the user picked, because the extension is what
    // ranks the format candidates and what comes out of here is XML. The wizard shows the
    // file the user chose from its own state, so nothing they read changes.
    fileName: `${input.fileName.replace(/\.kdbx$/i, '')}.xml`,
    bytes: new TextEncoder().encode(database.xml + marker),
  };
}
