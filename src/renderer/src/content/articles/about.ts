// SPDX-License-Identifier: GPL-3.0-or-later

import type { ContentArticle } from '../content-types.js';

/**
 * The about page — licence, position, and the limits of the project itself.
 *
 * Deliberately does **not** list dependencies. The roadmap requires the third-party licence
 * list to be generated from `package.json`, and a hand-written one here would be exactly
 * the second list hard rule 8 forbids: correct on the day it is typed and wrong at the next
 * `npm install`. The absence is marked rather than papered over.
 *
 * The "no audit" paragraph is the one most likely to be edited out by someone trying to
 * make the page sound better. It should not be. A security tool that lets a reader assume
 * it has been reviewed when it has not is misleading them about the thing they most need to
 * calibrate on.
 */
export const aboutArticle: ContentArticle = {
  id: 'about',
  title: 'About Keyhold',
  summary: 'What Keyhold is, the licence it ships under, and what it deliberately does not do.',
  keywords: [
    'licence',
    'license',
    'gpl',
    'open source',
    'free',
    'credits',
    'version',
    'who made this',
    'report a bug',
    'vulnerability',
  ],
  related: ['how-your-data-is-protected', 'getting-started', 'master-password'],
  body: [
    {
      kind: 'paragraph',
      text: 'Keyhold is a free, open-source, offline credential manager for Windows and macOS. Everything it holds lives in one encrypted file on your own computer. There is no account, no server, no subscription, and nothing to host — for you or for whoever maintains it.',
    },

    { kind: 'heading', text: 'Licence' },
    {
      kind: 'paragraph',
      text: 'Keyhold is released under the GNU General Public License, version 3 or later. You may use it for anything, read the source, change it, and pass it on. If you distribute a changed version, it has to come with its source under the same licence, so nobody can take this and close it. The full licence text ships with the application as the file named LICENSE.',
    },

    { kind: 'heading', text: 'What it will never do' },
    {
      kind: 'list',
      items: [
        'Ask you to make an account, or have a server to make one on.',
        'Send usage statistics, crash reports, or an update ping. There is no analytics provider and no error-tracking service, because there is no networking code at all.',
        'Fetch site icons for your accounts. Doing so would tell a server which accounts you have.',
        'Charge for a tier, ask for a licence key, or nag for a donation.',
        'Hold your vault where you cannot get at it. The file format is documented well enough for someone else to write their own reader.',
      ],
    },

    { kind: 'heading', text: 'Credits' },
    {
      kind: 'not-built',
      feature: 'licence-list',
      text: 'Keyhold stands on a handful of open-source libraries, and each of them has its own licence and its own authors. The third-party licence list belongs here, generated from the project’s own dependency manifest so that it cannot fall out of date — writing one out by hand would be wrong within a release. It has not been built yet.',
    },

    { kind: 'heading', text: 'Reporting a security problem' },
    {
      kind: 'paragraph',
      text: 'Report it privately first, through the repository’s private vulnerability reporting, rather than opening a public issue. Say what the problem is, how to reproduce it, and what an attacker gains. Never attach a real vault file or a real password — a sanitised reproduction can be worked out instead.',
    },
    {
      kind: 'note',
      tone: 'info',
      label: 'No bug bounty',
      text: 'There is no reward programme and there is not going to be one; the project has no funding. That is stated here so nobody spends their time on the assumption that there is. Credit in the changelog is offered instead, unless you would rather stay anonymous.',
    },

    { kind: 'heading', text: 'The honest position' },
    {
      kind: 'paragraph',
      text: 'Keyhold has not had an external security audit. The cryptography is standard and dull on purpose — Argon2id, AES-256-GCM, one key wrapping another, no invented schemes — and the threat model is published including the things it does not defend against. But "standard primitives, used carefully" is not the same claim as "reviewed by someone independent", and the difference is worth knowing before you decide what to keep in here.',
    },
    {
      kind: 'note',
      tone: 'warning',
      label: 'Pre-release',
      text: 'This is not a finished release. Several parts of the app described in its own documentation are engines without screens, and are marked as such throughout this help. Your vault file is safe — the format is settled, and a version of Keyhold will never open a vault written by a newer one rather than risk mangling it — but expect gaps.',
    },
    {
      kind: 'link',
      to: 'how-your-data-is-protected',
      text: 'What Keyhold protects, and what it does not',
    },
  ],
};
