// SPDX-License-Identifier: GPL-3.0-or-later

import type { ContentArticle } from '../content-types.js';

/**
 * The first page anyone reads.
 *
 * Scope is deliberately "create a vault and understand what you just made", not a tour.
 * Everything a new user has to be told once and cannot discover safely by clicking — that
 * there is no recovery, that saving is automatic, that locking wipes the key — is here;
 * everything else is a link.
 */
export const gettingStartedArticle: ContentArticle = {
  id: 'getting-started',
  title: 'Getting started',
  summary:
    'Create your first vault, and understand what the master password is before you choose one.',
  keywords: ['new vault', 'first time', 'setup', 'create', 'begin', 'welcome', 'install'],
  related: [
    'master-password',
    'how-your-data-is-protected',
    'backups-and-devices',
    'keyboard-shortcuts',
  ],
  body: [
    {
      kind: 'paragraph',
      text: 'Keyhold keeps your credentials in a single encrypted file on your own computer. There is no account to make and nothing to sign in to. You choose where the file lives, and a password only you know is what opens it.',
    },

    { kind: 'heading', text: 'Create a vault' },
    {
      kind: 'steps',
      items: [
        'On the welcome screen, choose to create a vault. Keyhold asks your operating system to show its own save dialog rather than picking a location for you.',
        'Pick where the file goes. Everything you store lives in that one file, so put it somewhere you would keep something you cannot afford to lose.',
        'Choose a master password. The strength meter is a real estimate of how a password-cracker would attack it, not a count of character types, and Keyhold will refuse one that is too weak.',
        'Tick the box confirming there is no recovery. It is a checkbox rather than a line of fine print because it is the single most important fact about the app.',
      ],
    },
    {
      kind: 'note',
      tone: 'danger',
      label: 'No recovery',
      text: 'Nobody can open your vault without your master password — not you, not the person who wrote Keyhold, not anyone holding the file. Nothing is stored anywhere that could be used to reset it.',
    },
    {
      kind: 'link',
      to: 'master-password',
      text: 'How to choose a master password, and why it cannot be recovered',
    },

    { kind: 'heading', text: 'Day to day' },
    {
      kind: 'list',
      items: [
        'There is no Save button to forget. Every change is written to the file straight away, and it is written in a way that a crash partway through cannot corrupt.',
        'Passwords stay hidden until you ask for them. Revealing or copying one fetches that single value from the locked half of the app, for that moment only.',
        'Copying a password starts a countdown in the sidebar. When it runs out Keyhold clears the clipboard — but only if the clipboard still holds what Keyhold put there, so it will never wipe something you copied afterwards.',
        'The vault locks itself when your computer goes idle, goes to sleep, or locks its screen. You can also lock it yourself from the sidebar or the File menu.',
        'Locking is one operation and it does everything: it destroys the key, drops the decrypted contents, clears the clipboard, and cancels any pending reveal.',
      ],
    },
    {
      kind: 'note',
      tone: 'info',
      label: 'Locking never saves',
      text: 'An automatic lock deliberately does not write anything. A lock that saved could commit a half-finished edit while you were away from the machine.',
    },

    { kind: 'heading', text: 'Unlocking is meant to feel slow' },
    {
      kind: 'paragraph',
      text: 'Turning your password into a key takes real work — around half a second on a typical machine, and longer on a slow one. That cost is the point: it is what makes guessing your password expensive for anyone who gets hold of the file. Keyhold shows a progress bar while it happens and does the work off the interface thread, so the window keeps responding.',
    },
    {
      kind: 'link',
      to: 'how-your-data-is-protected',
      text: 'What actually happens to your password when you unlock',
    },
  ],
};
