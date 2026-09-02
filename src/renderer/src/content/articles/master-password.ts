// SPDX-License-Identifier: GPL-3.0-or-later

import type { ContentArticle } from '../content-types.js';

/**
 * The page that prevents the worst conversation this project can have.
 *
 * It is written to be findable in a panic — "forgot", "lost", "reset" and "recover" are all
 * keywords — and to answer the question in the first two sentences rather than after a
 * preamble about cryptography. Someone reading this has already lost the password; the
 * explanation of *why* is what stops them spending a week looking for a way round it.
 */
export const masterPasswordArticle: ContentArticle = {
  id: 'master-password',
  title: 'The master password',
  summary:
    'Why it cannot be recovered, what happens if it is lost, and how to choose one you will not lose.',
  keywords: [
    'forgot',
    'forgotten',
    'lost',
    'reset',
    'recover',
    'recovery',
    'locked out',
    'cannot get in',
    'strength',
    'passphrase',
  ],
  related: ['how-your-data-is-protected', 'troubleshooting', 'backups-and-devices'],
  body: [
    {
      kind: 'paragraph',
      text: 'Your master password is not a login. Nothing checks it against a stored copy, because no copy exists anywhere. It is the ingredient your vault’s encryption key is made from — so a wrong password does not produce a rejection, it produces a key that does not open the file.',
    },
    {
      kind: 'note',
      tone: 'danger',
      label: 'There is no recovery',
      text: 'If you forget your master password, the vault cannot be opened. Not by you, not by the person who wrote Keyhold, and not by anyone holding the file. There is no reset link, no recovery email, no support address that can help, and no back door. Your backups do not help either — every one of them is encrypted with the same password.',
    },

    { kind: 'heading', text: 'Why it works this way' },
    {
      kind: 'paragraph',
      text: 'A password manager that can recover your vault is a password manager that can open your vault, which means so can anyone who compels or compromises whoever holds the recovery mechanism. Keyhold has no server and no account, so there is nowhere for such a mechanism to live even in principle. The absence of a way back in is the same property as the absence of a way for anyone else in.',
    },

    { kind: 'heading', text: 'Choosing one' },
    {
      kind: 'list',
      items: [
        'Length beats complexity. A phrase of four or five unusual words you can actually picture is stronger, and far more memorable, than eight scrambled characters you will write on a sticky note.',
        'The strength meter models how a real cracker guesses — dictionary words, names, dates, keyboard runs, the usual letter-to-symbol swaps — rather than counting character types. That is why something like "P@ssw0rd1!" scores badly, correctly.',
        'There is a minimum length on top of the score, because a short password can still look patternless to a rater while having a small enough search space to be worth attacking.',
        'Words connected to this app — keyhold, vault, master, password — are treated as already known to an attacker, and so are simple mutations of them.',
        'It must be unique. This is the one password in your life that cannot be reused anywhere else, because it is the one that guards all the others.',
      ],
    },
    {
      kind: 'paragraph',
      text: 'Keyhold asks for a strong password rather than a maximum-strength one. Demanding perfection pushes people towards writing something unmemorable on a note beside the machine, which is a worse outcome than a strong passphrase they can recall.',
    },

    { kind: 'heading', text: 'Write it down' },
    {
      kind: 'paragraph',
      text: 'This is genuine advice, not a fallback. The realistic risk to a personal vault is forgetting the password, not a burglar reading a piece of paper in your home. Write the passphrase down once, store it physically somewhere safe and away from the computer, and you have removed the only failure this design cannot recover from.',
    },

    { kind: 'heading', text: 'Guessing at the unlock screen' },
    {
      kind: 'paragraph',
      text: 'Wrong attempts cost nothing for the first few, because typos are normal. After that each attempt makes the next one wait longer, doubling up to a ceiling, and the whole thing resets the moment you get in.',
    },
    {
      kind: 'note',
      tone: 'warning',
      label: 'What that delay is and is not for',
      text: 'It protects the running app from someone sitting at your machine. It does nothing for the file itself: anyone who copies your vault can attack it offline at whatever speed their hardware allows, and no delay inside Keyhold touches that. The only defence there is the cost of Argon2id and the strength of your password.',
    },

    {
      kind: 'not-built',
      feature: 'master-password-change',
      text: 'Changing your master password is written and tested underneath — it re-wraps 32 bytes and never rewrites your records — but there is no screen to run it from yet, so today the password you chose when you created the vault is the password it has.',
    },
    {
      kind: 'link',
      to: 'how-your-data-is-protected',
      text: 'What your password is turned into, step by step',
    },
  ],
};
