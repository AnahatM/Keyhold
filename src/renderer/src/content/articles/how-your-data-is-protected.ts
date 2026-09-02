// SPDX-License-Identifier: GPL-3.0-or-later

import { DEFAULT_KDF_PARAMS } from '@shared/format/types.js';
import type { ContentArticle } from '../content-types.js';

/**
 * The security page, written from `docs/00-Overview/03-Threat-Model.md` and
 * `docs/02-Security/00-Cryptography.md`.
 *
 * Two rules govern every sentence here. **Say the actual primitive** — "military-grade
 * encryption" is marketing for "AES", and a reader who is told the real name can go and
 * look it up. And **the limits get as much room as the guarantees**, because a page that
 * only lists strengths is not believed the second time it is read.
 *
 * The Argon2 numbers are read from `DEFAULT_KDF_PARAMS` rather than typed out, so this
 * page cannot quietly go stale when the defaults are raised.
 */

const DEFAULT_MEMORY_MIB = DEFAULT_KDF_PARAMS.memoryKib / 1024;

export const howYourDataIsProtectedArticle: ContentArticle = {
  id: 'how-your-data-is-protected',
  title: 'How your data is protected',
  summary:
    'The actual encryption Keyhold uses, what a locked vault file still gives away, and what none of it defends against.',
  keywords: [
    'encryption',
    'security',
    'argon2',
    'aes',
    'threat model',
    'safe',
    'how secure',
    'cryptography',
    'privacy',
  ],
  related: ['master-password', 'history-and-audit', 'about'],
  body: [
    {
      kind: 'paragraph',
      text: 'Keyhold uses standard, widely analysed cryptography and nothing invented for this project. This page names each piece, so you can check the claims rather than take them on trust.',
    },

    { kind: 'heading', text: 'The chain, in order' },
    {
      kind: 'steps',
      items: [
        `Your master password goes through Argon2id, a function designed to be slow and to need a lot of memory. By default it uses ${DEFAULT_MEMORY_MIB} MiB of memory and ${DEFAULT_KDF_PARAMS.iterations} passes over it. Those settings are recorded inside your vault file, so an old vault keeps opening the way it always has even if the defaults are raised later.`,
        'What comes out is a key that exists only to unlock one other key. It is never written to disk, and it is destroyed the moment it has done that job.',
        'It unwraps the data key: 32 random bytes generated when the vault was created, and stored only in encrypted form.',
        'The data key encrypts the contents of your vault with AES-256-GCM, after compressing them. AES-256-GCM both encrypts and authenticates, so a tampered file fails loudly instead of decrypting into plausible nonsense.',
      ],
    },
    {
      kind: 'paragraph',
      text: 'The two-key arrangement exists so that replacing the outer key never means rewriting the vault: it re-encrypts 32 bytes, so it cannot fail halfway through and lose anything. It is also what lets an extra way to unlock — Touch ID, for instance — be its own separate wrapping of the same data key, added and revoked on its own.',
    },

    { kind: 'heading', text: 'What a locked vault file still gives away' },
    {
      kind: 'paragraph',
      text: 'Part of the file has to be readable without your password, because it is what says how to turn your password into the key. That part is small, and it is worth knowing exactly what it holds.',
    },
    {
      kind: 'facts',
      rows: [
        {
          term: 'Readable by anyone holding the file',
          description:
            'The format version; an identifier for the vault and for the computer that last saved it; the Argon2 settings; the encrypted data key; when the file was created and last saved; how many times it has been saved; and how many records and attachments it contains.',
        },
        {
          term: 'Not readable without the password',
          description:
            'Everything else — every title, username, email address, web address, note, tag, folder, edit-history entry and password.',
        },
      ],
    },
    {
      kind: 'note',
      tone: 'info',
      label: 'Readable is not editable',
      text: 'That plaintext part is covered by the same authentication tag as the encrypted contents. Changing a single bit of it — including the record count or the saved-at time — makes the whole file fail to open rather than open with a lie in it.',
    },

    { kind: 'heading', text: 'What never reaches the window you are looking at' },
    {
      kind: 'paragraph',
      text: 'Keyhold is split in two. The half that draws the interface holds only titles, usernames, email addresses, web addresses, tags, folders and dates. Passwords, note bodies, security-question answers, one-time-password seeds and attachment contents are never kept there. Each one is fetched individually, at the moment you press reveal or copy, and only one at a time.',
    },
    {
      kind: 'paragraph',
      text: 'This is the design decision the project is most confident about. Most password managers built this way decrypt everything into the interface layer, where one bad user-interface dependency reaches every secret at once. Keyhold does not have them there to leak.',
    },
    {
      kind: 'note',
      tone: 'warning',
      label: 'The accepted cost',
      text: 'The interface half does hold your record titles and usernames while the vault is open. Something that compromised it would learn which accounts you have, though not their passwords. That is a real residual risk, written down here rather than left out.',
    },

    { kind: 'heading', text: 'The network' },
    {
      kind: 'paragraph',
      text: "Keyhold makes no network requests. The window it renders in is configured so it cannot originate one even if a dependency tried: its content security policy sets connect-src to 'none'. Nothing is fetched — not icons for your accounts, not fonts, not update checks, and not usage statistics, which do not exist.",
    },
    {
      kind: 'not-built',
      feature: 'breach-check',
      text: 'The privacy policy shipped with the source describes an optional check against the Have I Been Pwned password list, off by default. It is not built. There is no networking code in Keyhold at all today, not even switched off, so treat that section as a plan rather than a description.',
    },

    { kind: 'heading', text: 'What this does not protect against' },
    {
      kind: 'paragraph',
      text: 'Encryption protects a file. It does not protect a computer. If any of the following is true, Keyhold cannot help, and saying otherwise would leave you trusting it in situations where it does not hold.',
    },
    {
      kind: 'list',
      items: [
        'A compromised computer. Anything already running with your privileges can read what you can read.',
        'A keylogger. You type the master password on the same keyboard as everything else.',
        'Anything reading Keyhold’s memory while the vault is unlocked. While it is open, the key and your decrypted records are in memory by necessity — that is what open means.',
        'A screen recorder while a value is on screen. Revealed means visible.',
        'Anyone who knows your master password. There is no second gate behind it.',
        'Someone sitting at your unlocked machine while the vault is open. Automatic locking exists for exactly this, and a short timeout is worth the annoyance.',
      ],
    },
    {
      kind: 'paragraph',
      text: 'Two things do help against most of that: lock the vault when you step away, and keep the machine itself trustworthy and encrypted.',
    },
    {
      kind: 'link',
      to: 'master-password',
      text: 'Why a forgotten master password cannot be recovered',
    },
  ],
};
