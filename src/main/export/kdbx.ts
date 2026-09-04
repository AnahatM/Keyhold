// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import type { Credential, CustomField } from '@shared/model/credential.js';
import { isCustomFieldValueSecret } from '@shared/model/credential.js';
import { FOLDER_PATH_SEPARATOR } from '@shared/model/import.js';
import type { VaultDocument } from '@shared/model/vault-document.js';
import { writeKdbx } from '../kdbx/write.js';
import { folderPathOf } from './flat.js';
import { selectRecords, type ExportSelection, type SelectedRecords } from './select.js';
import { encryptedExport, LossLog, type EncryptedExport } from './types.js';

/**
 * Export to KeePass's own `.kdbx`, version 4.
 *
 * The second encrypted way out, and the one that goes somewhere other than back into Keyhold.
 * A `.keepx` parcel is Keyhold talking to itself; this is the format KeePass, KeePassXC,
 * KeePassium, KeeWeb, Strongbox and every Android and iOS client read. It is what makes
 * "you can leave" true rather than a slogan — decision D11's whole point is that nothing here
 * holds anybody hostage, and an export nobody else can open would hold them anyway.
 *
 * ## Encrypted, so no plaintext warning
 *
 * This returns an `EncryptedExport`. The bytes are sealed under a passphrase the user chose,
 * so unlike the CSV and JSON exports there is nothing here that must be waved in front of
 * them before the file is written. The passphrase is theirs to keep safe; the file is not
 * dangerous on its own.
 *
 * ## The shape of the mapping, and what KeePass has no room for
 *
 * A KeePass entry is a bag of named strings, which is a good fit for most of a credential and
 * no fit at all for the rest:
 *
 * - **Title, UserName, Password, URL, Notes** map straight across.
 * - **Custom fields** keep the label the user chose, and a secret one is written
 *   `Protected="True"` so KeePass treats it as a password rather than as a visible note.
 * - **Email** becomes a custom field when it differs from the username, because KeePass has
 *   one identity slot and Keyhold has two. Writing the email into `UserName` would change
 *   what "copy username" types on the site.
 * - **Security questions** become one `Protected` field per question, labelled with the
 *   question. The answer is a secret in every sense that matters and is written as one.
 * - **Tags** go in KeePass 2.51+'s own `Tags` element.
 * - **Folders** become the group tree, rebuilt from the paths.
 * - **History is dropped**, and that is the one real loss. KeePass has a `History` element,
 *   but it holds whole prior *entries* with their own times, and Keyhold's versions record
 *   which fields changed and where the record came from. Synthesising entries from them would
 *   invent timestamps and provenance the vault never had, and an export that invents data is
 *   worse than one that admits a gap.
 * - **Attachments are dropped**, named and counted. They are encrypted chunks in the vault,
 *   and the exporter builds a document rather than reaching into chunk storage.
 * - **Origins** — the SSID and interface a password was first saved on — have nowhere to go.
 */

export const KDBX_EXPORT_ID = 'kdbx' as const;

export interface KdbxExportOptions extends ExportSelection {
  /** The passphrase the resulting database opens with. Never stored, never logged. */
  readonly secretPassword: string;
  readonly now?: number;
  /** The database's own name, as KeePass shows it. */
  readonly databaseName?: string;
  /** Overridable only so a test runs in milliseconds. */
  readonly kdf?: {
    readonly memoryKib?: number;
    readonly iterations?: number;
    readonly parallelism?: number;
  };
  readonly random?: (length: number) => Uint8Array;
}

/**
 * What a KDBX export will lose, computed without running the KDF.
 *
 * Separated from `exportKdbx` for the same reason `parcelPlan` is separated from
 * `exportEncrypted`: the preview screen has to show these losses **before** the user commits
 * to a passphrase, and it must not spend Argon2's seconds to find them out. One function, two
 * callers, so the preview cannot drift from what the export actually does — the alternative
 * is a screen that promises one thing and a file that does another.
 */
export function kdbxPlan(selected: SelectedRecords): LossLog {
  const losses = new LossLog();

  let droppedVersions = 0;
  let droppedAttachments = 0;
  let droppedOrigins = 0;

  for (const record of selected.records) {
    // `- 1` because the current version is not a loss; only the ones behind it are.
    droppedVersions += Math.max(0, record.history.versions.length - 1);
    droppedAttachments += record.attachments.length;
    // `networkName` is the part with nowhere to go — the rest of an origin is device metadata
    // KeePass also lacks, but the network a password was first saved on is the one a user
    // would notice missing, because it is the one Keyhold surfaces.
    if (record.meta.createdOrigin.networkName !== undefined) droppedOrigins += 1;
  }

  if (selected.excludedTrashed > 0) {
    losses.add(
      'excluded',
      'trashed records',
      `${String(selected.excludedTrashed)} record(s) in the trash were not exported.`,
      selected.excludedTrashed
    );
  }
  if (droppedVersions > 0) {
    losses.add(
      'dropped',
      'version history',
      `${String(droppedVersions)} earlier version(s) were not exported. KeePass stores previous entries rather than which fields changed, so writing them would invent times and origins this vault never recorded.`,
      droppedVersions
    );
  }
  if (droppedAttachments > 0) {
    losses.add(
      'dropped',
      'attachments',
      `${String(droppedAttachments)} attached file(s) were not exported. Export an encrypted parcel, or copy the vault file, if you need them.`,
      droppedAttachments
    );
  }
  if (droppedOrigins > 0) {
    losses.add(
      'dropped',
      'origins',
      `Where ${String(droppedOrigins)} record(s) were first saved was not exported. KeePass has no field for it.`,
      droppedOrigins
    );
  }

  return losses;
}

export async function exportKdbx(
  document: VaultDocument,
  options: KdbxExportOptions
): Promise<EncryptedExport> {
  const selected = selectRecords(document, options);
  const losses = kdbxPlan(selected);

  const secretXml = serialiseKdbxXml(document, selected.records, {
    now: options.now ?? Date.now(),
    databaseName: options.databaseName ?? 'Keyhold',
  });

  const bytes = await writeKdbx({
    secretXml,
    secretPassword: options.secretPassword,
    ...(options.kdf === undefined ? {} : { kdf: options.kdf }),
    ...(options.random === undefined ? {} : { random: options.random }),
  });

  return encryptedExport({
    format: KDBX_EXPORT_ID,
    extension: '.kdbx',
    bytes,
    recordCount: selected.records.length,
    losses: losses.all,
  });
}

// ── The XML ──────────────────────────────────────────────────────────────────

interface XmlOptions {
  readonly now: number;
  readonly databaseName: string;
}

/**
 * KeePass's own timestamp format for KDBX 4: base64 of the seconds since 0001-01-01 UTC,
 * little-endian, 64-bit.
 *
 * Not the ISO string KDBX 3 used. A KeePass build reading a 4 expects this, and one that
 * finds an ISO string there shows every entry as created in the year 1, which looks like data
 * loss and is really just the wrong encoding.
 */
const TICKS_TO_UNIX_EPOCH = 62_135_596_800n;

function kdbxTime(epochMs: number): string {
  const seconds = BigInt(Math.floor(epochMs / 1000)) + TICKS_TO_UNIX_EPOCH;
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(seconds);
  return buffer.toString('base64');
}

/** A KeePass UUID: 16 bytes, base64. Derived from the record id so an id survives a round trip. */
function kdbxUuid(id: string): string {
  return createHash('sha256').update(id).digest().subarray(0, 16).toString('base64');
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * One `String` pair.
 *
 * `protect` writes the value **in the clear** with `Protected="True"` on it, because
 * `writeKdbx` is what encrypts protected values — in document order, over the finished
 * string. That is the seam, and it is why nothing in this file touches a keystream.
 */
function stringField(key: string, value: string, protect: boolean): string {
  const attribute = protect ? ' Protected="True"' : '';
  return `<String><Key>${escapeText(key)}</Key><Value${attribute}>${escapeText(value)}</Value></String>`;
}

/**
 * A group tree built from folder paths.
 *
 * Rebuilt from the paths rather than from the folder records, so the shape matches exactly
 * what `folderPathOf` produces and what Keyhold's own importers read back. Two sources for
 * the same tree is rule 8's second list, and here it would show up as an export whose folders
 * do not survive a round trip.
 */
interface GroupNode {
  readonly name: string;
  readonly children: Map<string, GroupNode>;
  readonly entries: string[];
}

function newGroup(name: string): GroupNode {
  return { name, children: new Map(), entries: [] };
}

function serialiseGroup(group: GroupNode, path: string): string {
  const children = [...group.children.values()]
    .map((child) => serialiseGroup(child, `${path}/${child.name}`))
    .join('');
  return [
    '<Group>',
    `<UUID>${kdbxUuid(`folder:${path}`)}</UUID>`,
    `<Name>${escapeText(group.name)}</Name>`,
    children,
    group.entries.join(''),
    '</Group>',
  ].join('');
}

export function serialiseKdbxXml(
  document: VaultDocument,
  records: readonly Credential[],
  options: XmlOptions
): string {
  const root = newGroup(options.databaseName);

  for (const record of records) {
    const path = folderPathOf(document.folders, record.folderId);
    let group = root;
    if (path !== '') {
      for (const segment of path.split(FOLDER_PATH_SEPARATOR)) {
        const existing = group.children.get(segment);
        const child = existing ?? newGroup(segment);
        if (existing === undefined) group.children.set(segment, child);
        group = child;
      }
    }
    group.entries.push(serialiseEntry(record, options));
  }

  return [
    '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
    '<KeePassFile>',
    '<Meta>',
    '<Generator>Keyhold</Generator>',
    `<DatabaseName>${escapeText(options.databaseName)}</DatabaseName>`,
    `<DatabaseNameChanged>${kdbxTime(options.now)}</DatabaseNameChanged>`,
    // Off, and said explicitly. A database with the recycle bin enabled and no bin group is
    // one KeePass will silently create a group in on first delete; declaring it off keeps the
    // file describing exactly what is in it.
    '<RecycleBinEnabled>False</RecycleBinEnabled>',
    '</Meta>',
    '<Root>',
    serialiseGroup(root, ''),
    '</Root>',
    '</KeePassFile>',
  ].join('');
}

function serialiseEntry(record: Credential, options: XmlOptions): string {
  const fields = record.fields;
  const strings: string[] = [
    stringField('Title', record.title, false),
    stringField('UserName', fields.username, false),
    stringField('Password', fields.password, true),
    stringField('URL', fields.urls[0] ?? '', false),
    stringField('Notes', fields.notes, true),
  ];

  // Every URL after the first. KeePass's `URL` is singular, and dropping the rest silently
  // would lose a real field on any record with more than one address.
  fields.urls.slice(1).forEach((url, index) => {
    strings.push(stringField(`URL ${String(index + 2)}`, url, false));
  });

  if (fields.email !== '' && fields.email !== fields.username) {
    strings.push(stringField('Email', fields.email, false));
  }

  for (const field of [...fields.custom].sort((a, b) => a.order - b.order)) {
    strings.push(stringField(field.label, field.value, isSecretField(field)));
  }

  for (const question of fields.securityQuestions) {
    // The question in the label, the answer protected. An answer is a credential — it is what
    // a support line accepts instead of a password — and writing it as visible text would put
    // it on screen in KeePass's entry list.
    strings.push(stringField(`Security question: ${question.question}`, question.answer, true));
  }

  const tags = record.tags.length === 0 ? '' : `<Tags>${escapeText(record.tags.join(';'))}</Tags>`;

  return [
    '<Entry>',
    `<UUID>${kdbxUuid(record.id)}</UUID>`,
    tags,
    `<Times><CreationTime>${kdbxTime(record.meta.createdAt)}</CreationTime>`,
    `<LastModificationTime>${kdbxTime(record.meta.updatedAt)}</LastModificationTime>`,
    `<LastAccessTime>${kdbxTime(options.now)}</LastAccessTime>`,
    '<Expires>False</Expires><UsageCount>0</UsageCount>',
    `<LocationChanged>${kdbxTime(record.meta.updatedAt)}</LocationChanged></Times>`,
    strings.join(''),
    '</Entry>',
  ].join('');
}

/**
 * Whether a field is written protected.
 *
 * `isCustomFieldValueSecret` rather than a local rule, and the attribute follows it exactly:
 * the model already decides which fields never cross into the renderer, and a KDBX file that
 * disagreed would be this app publishing a different answer to the same question — the second
 * list again, in the one place where getting it wrong means a password rendered as plain text
 * in somebody else's app.
 */
function isSecretField(field: CustomField): boolean {
  return isCustomFieldValueSecret(field);
}
