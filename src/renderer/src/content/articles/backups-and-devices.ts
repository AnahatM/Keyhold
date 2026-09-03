// SPDX-License-Identifier: GPL-3.0-or-later

import type { ContentArticle } from '../content-types.js';

/**
 * Backups, portability, and the sentence this page exists to deliver: importing an export
 * is not a restore.
 *
 * That distinction is the one people get wrong with every password manager, and getting it
 * wrong here costs record identity and the entire edit history. It is stated plainly rather
 * than left implicit in a table of what each format loses.
 *
 * Backup counts and file paths are described by shape rather than by number: the rolling
 * backup count lives in the main process, which this half of the app cannot import, and a
 * number retyped here would be a second copy nobody would think to update.
 */
export const backupsAndDevicesArticle: ContentArticle = {
  id: 'backups-and-devices',
  title: 'Backups and moving between devices',
  summary:
    'How Keyhold keeps rolling backups, how to move a vault to another computer, and why an export is not a backup.',
  keywords: [
    'backup',
    'restore',
    'copy',
    'usb',
    'transfer',
    'move',
    'another computer',
    'second device',
    'laptop',
    'keepx',
    'parcel',
  ],
  related: ['getting-started', 'troubleshooting', 'history-and-audit'],
  body: [
    {
      kind: 'paragraph',
      text: 'Your whole vault is one file. That makes backing it up and moving it simple: copy the file. Everything below is detail on top of that.',
    },

    { kind: 'heading', text: 'Keyhold keeps rolling backups for you' },
    {
      kind: 'paragraph',
      text: 'Every successful save copies the previous version of the vault to a numbered backup beside it — yourvault.keep.bak.1 is the most recent, and older ones shift down as new saves happen. A few generations are kept. They are ordinary vault files: encrypted the same way, opened with the same master password.',
    },
    {
      kind: 'paragraph',
      text: 'A save that fails does not consume a backup slot, so a run of failed saves cannot quietly push your last good copy off the end.',
    },
    {
      kind: 'note',
      tone: 'warning',
      label: 'These are not off-site backups',
      text: 'Rolling backups sit in the same folder as the vault. They protect against a bad edit or an interrupted save. They do nothing about a failed disk, a deleted folder, a lost laptop, or a forgotten master password. Keep a copy somewhere else as well.',
    },

    { kind: 'heading', text: 'Moving a vault to another computer' },
    {
      kind: 'paragraph',
      text: 'Copy the .keep file. Nothing about the computer it was made on goes into the encryption, so the file opens anywhere the app runs, given the master password. A USB stick, an external drive, or a folder that a cloud service replicates all work — a cloud provider only ever holds the encrypted file.',
    },
    {
      kind: 'list',
      items: [
        'Quick unlock does not travel. It is a separately encrypted copy of the vault’s key held by the operating system on the machine you enrolled it on. Turn it on again on the new machine.',
        'Appearance choices and the list of recently opened vaults stay behind too. Those live per-machine, outside the vault, and hold nothing secret.',
        'Anything that describes the data itself — how many past versions to keep, how much provenance to record, how long the trash is kept — lives inside the encrypted file and travels with it.',
      ],
    },
    {
      kind: 'note',
      tone: 'danger',
      label: 'Do not edit the same vault from two machines at once',
      text: 'Keyhold cannot yet reconcile two versions of the same vault that both changed. Whichever copy is saved last wins outright, and the other machine’s edits are gone. Until that changes, treat the vault as something one machine has open at a time.',
    },
    {
      kind: 'not-built',
      feature: 'sync',
      text: 'Keyhold now watches the vault file and notices when something else changes it — another device, or a sync client. What it does not do yet is offer to merge the two: the engine that does that field by field is written and tested, and the conflict resolver you would use to settle the disagreements is not. So today you are told, and the merge is still scheduled work.',
    },

    { kind: 'heading', text: 'An export is not a backup' },
    {
      kind: 'paragraph',
      text: 'Restoring a vault means copying the .keep file back into place. That is lossless because it is the same bytes. Reading a plain-text export back in is a different operation with a different result, and it is worth understanding before you rely on one.',
    },
    {
      kind: 'facts',
      rows: [
        {
          term: 'Keyhold JSON',
          description:
            'Loses nothing — every field, folder, tag and vault setting, and the full edit history with its origins. It is also plain text, so anyone who reads the file reads your passwords.',
        },
        {
          term: 'Keyhold CSV',
          description:
            'Loses edit history, attachments, icons, custom-field types, and each record’s identity.',
        },
        {
          term: 'Bitwarden-compatible CSV',
          description:
            'All of the above, plus every date and whether a record was in the trash. It exists so you can leave for another manager cleanly.',
        },
        {
          term: 'Encrypted .keepx parcel',
          description:
            'Loses nothing, and is the only one of the four that is safe to hand to someone. It carries only the records you chose and opens with its own passphrase, not your master password.',
        },
      ],
    },
    {
      kind: 'paragraph',
      text: 'Reading any of these back creates new records. It cannot do otherwise: identity, timestamps and history belong to the vault that made them, and a file being read in was not made by this vault. So a re-import gives you records with new identities and empty histories, and it skips anything that was in the trash rather than resurrecting deletions nobody asked to undo.',
    },
    {
      kind: 'note',
      tone: 'warning',
      label: 'Plain-text exports',
      text: 'A JSON or CSV export is your passwords, readable by anything that opens the file, including whatever indexes your documents folder. If you make one, use it and destroy it.',
    },
    {
      kind: 'not-built',
      feature: 'export',
      text: 'All four formats are written and tested, but there is no dialog to produce one from yet, and the File menu’s Export item does nothing when clicked. Nothing in the app writes a file to disk in any of these formats today.',
    },
    {
      kind: 'not-built',
      feature: 'parcel',
      text: 'The encrypted .keepx parcel has the same status: the format works and round-trips, but choosing records and setting its passphrase needs a screen that does not exist yet.',
    },
    {
      kind: 'not-built',
      feature: 'import',
      text: 'Reading files from eleven other password managers is built and tested, and so is reading Keyhold’s own JSON back. What is missing is everything after parsing — the mapping wizard, the preview, duplicate detection and the undo — so there is no way to bring a file in from the app yet.',
    },
  ],
};
