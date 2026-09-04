// SPDX-License-Identifier: GPL-3.0-or-later
import { normaliseFolderPath } from '@shared/model/import.js';
import { VaultError } from '../crypto/errors.js';
import {
  addCustom,
  addNote,
  addUrls,
  finishDraft,
  newDraft,
  type DraftRecord,
} from './mapping.js';
import type { ImportWarning } from '@shared/model/import.js';
import type { ImportParser, ImportResult } from './types.js';
import { child, childText, children, parseXml, type XmlElement } from './xml-reader.js';

/**
 * KeePass and KeePassXC's plain `.xml` export.
 *
 * This is the *unencrypted* export — the one KeePassXC writes from **Database → Export → XML**
 * — and it is the richest thing KeePass will hand over without a `.kdbx`. It carries the full
 * group tree, every custom string, times, and the TOTP settings the CSV export drops on the
 * floor.
 *
 * ## The warning this format deserves
 *
 * A KeePass XML export is every password the user has, in plain text, in a file. That is worth
 * saying where they will read it, which is what `description` is for: the import wizard shows
 * it in the format list, and the file step already carries the "delete this afterwards" note
 * for exports generally.
 *
 * ## What is read, and what is not
 *
 * The schema is `KeePassFile → Root → Group*` nesting arbitrarily, with `Entry*` at any level
 * and `String` pairs inside each entry. Nothing here uses namespaces, and the reader
 * (`xml-reader.ts`, D31) refuses the parts of XML that are dangerous rather than trying to
 * survive them.
 *
 * **Protected values are not decrypted.** In a `.kdbx` the inner stream cipher protects
 * password fields; in the plain XML export KeePassXC writes them in the clear and the
 * `Protected="True"` attribute is a leftover. If a value ever arrives still protected — it
 * should not, from this export — it is skipped **and reported**, because importing a
 * base64 blob as somebody's password is worse than telling them it did not come across.
 *
 * **The recycle bin is skipped**, matching every other importer's treatment of a source's
 * trash: a record the user deleted there is not one they are asking to import here.
 */

function detect(content: string): boolean {
  // A shape check on the head of the file, not a parse: this runs once per registered format
  // for every file the user picks, and a 40 MB export must not be read twice.
  const head = content.slice(0, 4_096);
  return head.includes('<KeePassFile') || (head.includes('<Root') && head.includes('<Group'));
}

/** `Times/Expires` and friends arrive as the strings "True"/"False". */
function isTrue(value: string): boolean {
  return value.trim().toLowerCase() === 'true';
}

function parse(content: string): ImportResult {
  const document = parseXml(content);

  const root = child(document, 'Root') ?? (document.name === 'Root' ? document : null);
  if (root === null) {
    // The contract's sanctioned throw: not this format at all. Every other failure below is a
    // warning, because refusing 3,000 entries over one odd one is how somebody ends up
    // retyping their vault by hand.
    throw new VaultError(
      'MALFORMED',
      'This is not a KeePass XML export — it has no <Root> section. Re-export the database as plain XML and try again.'
    );
  }

  const warnings: ImportWarning[] = [];
  const folders = new Set<string>();
  const records: ReturnType<typeof finishDraft>[] = [];

  /** The uuid of the group KeePass uses as its recycle bin, when the file names one. */
  const recycleBin = childText(child(document, 'Meta') ?? document, 'RecycleBinUUID').trim();

  let protectedSkipped = 0;
  let expiring = 0;

  const readEntry = (entry: XmlElement, path: string): void => {
    const draft: DraftRecord = newDraft();
    draft.folderPath = path === '' ? null : normaliseFolderPath(path);

    for (const pair of children(entry, 'String')) {
      const key = childText(pair, 'Key').trim();
      const valueNode = child(pair, 'Value');
      if (key === '' || valueNode === null) continue;

      // `Protected="True"` with a value still means the value is in the clear in this export.
      // A protected value with **no** text is the case that matters: the exporter withheld it.
      if (isTrue(valueNode.attributes.Protected ?? '') && valueNode.text === '') {
        protectedSkipped += 1;
        continue;
      }

      const value = valueNode.text;
      if (value === '') continue;

      switch (key) {
        case 'Title':
          draft.title = value;
          break;
        case 'UserName':
          draft.username = value;
          break;
        case 'Password':
          draft.password = value;
          break;
        case 'URL':
          addUrls(draft, value);
          break;
        case 'Notes':
          addNote(draft, value);
          break;
        default:
          // Everything else keeps its own name. KeePass users put a great deal in these —
          // recovery codes, account numbers, second passwords — and a custom field with the
          // label the user chose is the only honest home for it.
          //
          // The type is left to `guessCustomFieldType`, which is the authority on it for
          // every format. This originally passed `otp-secret` explicitly for an `otpauth://`
          // value — correct, and a restatement of a rule that already lives there, which is
          // rule 8's second list. A fault injection is what exposed it: replacing the
          // special case with `false` failed nothing, because the shared function checks
          // `looksLikeOtpUri` first and had been doing the work all along.
          addCustom(draft, key, value);
          break;
      }
    }

    // Counted, not warned per entry: a database where every record expires would otherwise
    // produce one warning line per record, which is a report nobody reads.
    if (isTrue(childText(child(entry, 'Times') ?? entry, 'Expires'))) expiring += 1;

    const finished = finishDraft(draft);
    if (finished !== null) {
      records.push(finished);
      if (draft.folderPath !== null && draft.folderPath !== '') folders.add(draft.folderPath);
    }
  };

  /**
   * Walks the group tree iteratively.
   *
   * The reader already caps nesting, so recursion would be bounded — but an explicit queue
   * costs nothing and means the depth limit lives in exactly one place rather than being a
   * property two files have to agree about.
   */
  const queue: {
    readonly group: XmlElement;
    readonly path: string;
    /** True only for `<Root>` itself, whose child group is the database rather than a folder. */
    readonly isDocumentRoot: boolean;
  }[] = [{ group: root, path: '', isDocumentRoot: true }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;

    for (const group of children(current.group, 'Group')) {
      const uuid = childText(group, 'UUID').trim();
      if (recycleBin !== '' && uuid === recycleBin) {
        // Matches every other importer: a source's trash is not something the user is asking
        // to bring across.
        warnings.push({
          kind: 'skipped-row',
          message: 'KeePass’s recycle bin was skipped, along with everything in it.',
        });
        continue;
      }

      const name = childText(group, 'Name').trim();
      // The single group directly under `<Root>` is the database itself, not a folder.
      // KeePass names it after the file ("Passwords", by default), and letting that become a
      // folder would file the user's entire vault one level deep under a word that means
      // nothing here — and then every other import would sit beside it at the top level.
      const path =
        current.isDocumentRoot || name === ''
          ? current.path
          : `${current.path}/${name}`.replace(/^\//, '');
      if (path !== '') {
        const normalised = normaliseFolderPath(path);
        if (normalised !== null && normalised !== '') folders.add(normalised);
      }

      queue.push({ group, path, isDocumentRoot: false });
    }

    for (const entry of children(current.group, 'Entry')) {
      // A `History` element holds previous versions of the *same* entry. Its children are
      // `Entry` nodes too, so walking them would import a record's history as records —
      // silently multiplying the vault by however many times each password was changed.
      readEntry(entry, current.path);
    }
  }

  if (expiring > 0) {
    // Reported rather than mapped. `NewCredentialInput` does have an `expiresAt`, but
    // KeePass's expiry is a flag *plus* an `ExpiryTime`, and importing one already in the past
    // would flag the record in the health dashboard on day one — a vault that arrives looking
    // broken because of how it was imported.
    warnings.push({
      kind: 'dropped-value',
      message: `${String(expiring)} entr${expiring === 1 ? 'y was' : 'ies were'} marked as expiring in KeePass. The expiry dates were not imported.`,
    });
  }

  if (protectedSkipped > 0) {
    warnings.push({
      kind: 'dropped-value',
      message: `${String(protectedSkipped)} value(s) were still encrypted in the export and could not be read. Re-export the database as plain XML, which writes them in the clear.`,
    });
  }

  return {
    records: records.filter((record): record is NonNullable<typeof record> => record !== null),
    warnings,
    folders: [...folders].sort(),
  };
}

export const keepassXmlParser: ImportParser = {
  id: 'keepass-xml',
  name: 'KeePass or KeePassXC (XML)',
  extensions: ['.xml'],
  description:
    'KeePassXC’s plain XML export. Keeps the full group tree and every custom field — and is unencrypted, so delete it afterwards.',
  needsMapping: false,
  detect,
  parse,
};
