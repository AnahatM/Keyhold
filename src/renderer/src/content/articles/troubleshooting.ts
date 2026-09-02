// SPDX-License-Identifier: GPL-3.0-or-later

import type { ContentArticle } from '../content-types.js';

/**
 * Organised by the message or symptom a user is actually looking at, not by subsystem.
 *
 * The two failure messages that matter most — "wrong password" and "this file has changed"
 * — are separate headings on purpose. Keyhold distinguishes them for a reason, and a page
 * that lumped them together would undo that: someone whose file is damaged would spend an
 * afternoon retyping a password that was never the problem.
 */
export const troubleshootingArticle: ContentArticle = {
  id: 'troubleshooting',
  title: 'Troubleshooting',
  summary:
    'A vault that will not open, an interrupted save, a lockout after failed attempts, and a clipboard that emptied itself.',
  keywords: [
    'error',
    'will not open',
    'cannot open',
    'broken',
    'corrupt',
    'tampered',
    'wrong password',
    'stuck',
    'slow',
    'crash',
    'temp file',
    'tmp',
  ],
  related: ['master-password', 'backups-and-devices', 'how-your-data-is-protected'],
  body: [
    { kind: 'heading', text: 'Keyhold says the password is wrong' },
    {
      kind: 'paragraph',
      text: 'That message appears only after a real decryption has been attempted and failed, so it means the password produced a key that does not fit this file. Check caps lock, check the keyboard layout, and check that you are opening the vault you think you are — the path is shown above the password box.',
    },
    {
      kind: 'paragraph',
      text: 'Attempts after the first few are delayed, and the delay grows. It resets completely as soon as you get in, so waiting it out costs nothing but time.',
    },

    { kind: 'heading', text: 'Keyhold says the file has been changed or damaged' },
    {
      kind: 'paragraph',
      text: 'This is a different message from a wrong password, and the difference is informative: it means your password was demonstrably correct — it unwrapped the key — and the contents then failed their integrity check. The file has been altered since it was written, whether by a partial copy, a failing disk, a program that "cleaned" it, or genuine tampering.',
    },
    {
      kind: 'paragraph',
      text: 'Nothing is silently salvaged, because a partial read of a credential file is worse than a refusal. The route forward is the backups beside your vault: try the most recent one, which opens with the same master password.',
    },
    { kind: 'link', to: 'backups-and-devices', text: 'Where Keyhold keeps its rolling backups' },

    { kind: 'heading', text: 'The file will not open at all' },
    {
      kind: 'list',
      items: [
        'It may not be a Keyhold vault. Every .keep file begins with the same eight identifying bytes, and a file without them is refused rather than guessed at.',
        'It may have been written by a newer version of Keyhold. A newer format is refused deliberately: opening it with older rules risks discarding fields it does not understand on the next save, which is data loss.',
        'It may be truncated — a copy that was interrupted, or a file synchronised while it was being written.',
      ],
    },

    { kind: 'heading', text: 'A save was interrupted' },
    {
      kind: 'paragraph',
      text: 'Keyhold never writes over your vault directly. It writes the new version to a file ending .keep.tmp, flushes it to the disk, rotates the backups, and only then renames it into place. So a crash or a power cut at any moment leaves a complete, valid vault — either the old one or the new one, never half of each.',
    },
    {
      kind: 'paragraph',
      text: 'If a save was cut short, that .keep.tmp file is left beside your vault and the unlock screen tells you about it. Your vault opens normally; the leftover file is untouched.',
    },
    {
      kind: 'note',
      tone: 'warning',
      label: 'It is never deleted for you',
      text: 'Nothing can tell whether a leftover temporary file holds newer changes without the master password, so Keyhold leaves it alone rather than tidying it away. There is no button to inspect or recover one yet. Keep it until you are certain your vault has everything you expect, then remove it yourself.',
    },

    { kind: 'heading', text: 'Unlocking takes several seconds' },
    {
      kind: 'paragraph',
      text: 'That is the design working. Turning your password into a key is deliberately expensive, and the settings are recorded in the vault when it is created — so a vault made on a fast machine costs more work than one made on a slow machine, and opening it on the slow machine takes correspondingly longer. The progress bar keeps moving throughout; the window is not frozen, because that work happens off the interface thread.',
    },

    { kind: 'heading', text: 'A password I copied is no longer on the clipboard' },
    {
      kind: 'paragraph',
      text: 'Copying a secret starts a countdown, shown in the sidebar, after which Keyhold clears the clipboard. Locking the vault clears it immediately, and so does quitting. Keyhold only clears the clipboard if it still holds the value it put there, so copying something else afterwards is safe — your own copy will not be wiped.',
    },
    {
      kind: 'note',
      tone: 'info',
      label: 'Clipboard history is the real leak',
      text: 'Keyhold marks copied secrets so Windows clipboard history and cloud clipboard skip them, and so macOS clipboard managers treat them as concealed. Those markers are advisory: a clipboard manager that ignores them will still record the value. The countdown is the part that does not depend on anyone else’s cooperation.',
    },

    { kind: 'heading', text: 'You have forgotten the master password' },
    {
      kind: 'paragraph',
      text: 'There is nothing in the app, the file, or anywhere else that can help — and that is a property of the design rather than a missing feature.',
    },
    { kind: 'link', to: 'master-password', text: 'Why there is no recovery, and what to do next' },
  ],
};
