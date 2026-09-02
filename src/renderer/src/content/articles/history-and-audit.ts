// SPDX-License-Identifier: GPL-3.0-or-later

import {
  AUDIT_LEVEL_FIELDS,
  AUDIT_PRIVACY_LEVELS,
  VERSIONED_FIELDS,
  type AuditPrivacyLevel,
  type ChangeOrigin,
  type VersionedField,
} from '@shared/model/credential.js';
import { DEFAULT_VAULT_SETTINGS } from '@shared/model/vault-document.js';
import type { ContentArticle, ContentFactRow } from '../content-types.js';

/**
 * The history page, generated from the model rather than transcribed from it.
 *
 * The two lists that would otherwise be copied out by hand — which fields are versioned,
 * and which provenance each privacy level captures — are built here from
 * `VERSIONED_FIELDS` and `AUDIT_LEVEL_FIELDS`. That is hard rule 8 applied to prose: a
 * field added to the model appears on this page automatically, and one removed cannot go
 * on being described. The retention and privacy defaults come from
 * `DEFAULT_VAULT_SETTINGS` for the same reason.
 *
 * The label maps below are `Record`s over the model's own key types, so a new field with
 * no plain-English name is a compile error rather than a raw identifier printed at a user.
 */

const FIELD_LABELS: Record<VersionedField, string> = {
  title: 'title',
  username: 'username',
  email: 'email address',
  password: 'password',
  urls: 'web addresses',
  securityQuestions: 'security questions and their answers',
  notes: 'notes',
  custom: 'custom fields',
  tags: 'tags',
  folderId: 'folder',
  favorite: 'favourite mark',
  icon: 'icon',
  expiresAt: 'expiry date',
  rotationIntervalDays: 'how often it should be changed',
};

const ORIGIN_LABELS: Record<keyof ChangeOrigin, string> = {
  action: 'what happened (created, edited, restored)',
  deviceName: 'the computer’s name',
  platform: 'which operating system',
  appVersion: 'the Keyhold version',
  osUser: 'the account you were signed in as',
  networkName: 'the network you were on',
  osRelease: 'the operating system version',
  localIp: 'the machine’s address on that network',
};

const LEVEL_TITLES: Record<AuditPrivacyLevel, string> = {
  none: 'none',
  device: 'device',
  network: 'network',
  full: 'full',
};

function describeLevel(level: AuditPrivacyLevel): ContentFactRow {
  const isDefault = level === DEFAULT_VAULT_SETTINGS.auditPrivacyLevel;
  const captured = AUDIT_LEVEL_FIELDS[level].map((field) => ORIGIN_LABELS[field]).join('; ');
  return {
    term: isDefault ? `${LEVEL_TITLES[level]} — the default` : LEVEL_TITLES[level],
    description: `Records ${captured}.`,
  };
}

const versionedFieldList = VERSIONED_FIELDS.map((field) => FIELD_LABELS[field]);

const retentionSentence =
  DEFAULT_VAULT_SETTINGS.historyMaxVersions === null
    ? 'By default nothing is pruned: every version is kept.'
    : `By default the newest ${DEFAULT_VAULT_SETTINGS.historyMaxVersions} versions of a record are kept and the oldest are dropped as new ones arrive.`;

export const historyAndAuditArticle: ContentArticle = {
  id: 'history-and-audit',
  title: 'History and the audit trail',
  summary:
    'What Keyhold records about each edit, the four levels of detail you can choose between, and where all of it is stored.',
  keywords: [
    'history',
    'versions',
    'audit',
    'previous password',
    'old password',
    'what changed',
    'provenance',
    'privacy level',
    'timeline',
    'undo an edit',
  ],
  related: ['how-your-data-is-protected', 'backups-and-devices', 'getting-started'],
  body: [
    {
      kind: 'paragraph',
      text: 'Every time you change a record, Keyhold can keep what was there before — and, if you let it, a note of which computer and which network the change came from. It is the feature that answers “when did this password change, and was that me?”.',
    },

    { kind: 'heading', text: 'What a version holds' },
    {
      kind: 'paragraph',
      text: 'A version stores the values that were replaced, never the ones that replaced them. That is deliberate: the record you have now is always intact and never rebuilt from a chain of edits, and dropping the oldest versions can never break the newer ones that remain.',
    },
    { kind: 'paragraph', text: 'These fields are tracked:' },
    { kind: 'list', items: versionedFieldList },
    {
      kind: 'paragraph',
      text: `History is on by default for new records, and each record has its own switch if you would rather one of them kept nothing. ${retentionSentence}`,
    },

    { kind: 'heading', text: 'Where a change came from' },
    {
      kind: 'paragraph',
      text: 'How much Keyhold notes about the circumstances of an edit is your choice, and there are four settings. Each one is enforced when the entry is written, not when it is displayed — so anything a level does not capture is simply never in the file, and no future version of the app can decide to show it.',
    },
    { kind: 'facts', rows: AUDIT_PRIVACY_LEVELS.map(describeLevel) },
    {
      kind: 'paragraph',
      text: 'The default stops at the computer because that is the level which answers the question people actually have — was this me, on my own machine? A network name says where you were, and an address says something about the network you were on.',
    },
    {
      kind: 'note',
      tone: 'info',
      label: 'It never delays a save',
      text: 'Working out the network name means asking the operating system, which is occasionally slow and very occasionally never answers. Keyhold reads a value kept warm in the background instead of waiting, so a confused network adapter costs you a missing network name on one entry rather than a save that hangs.',
    },

    { kind: 'heading', text: 'It lives inside the encrypted file' },
    {
      kind: 'paragraph',
      text: 'History is not a separate log. It is encrypted with everything else, so it travels with the vault when you copy it, and a stolen vault file discloses none of it. Nothing about your edits is written anywhere outside the vault.',
    },
    {
      kind: 'note',
      tone: 'warning',
      label: 'Old passwords are still passwords',
      text: 'A version of a password change contains a real password you used. Keyhold treats it exactly like a current one: it is masked in the timeline, revealed one value at a time on request, and each version counts separately against the limit on how fast values can be revealed.',
    },

    { kind: 'heading', text: 'Putting something back, and clearing it' },
    {
      kind: 'list',
      items: [
        'Restoring a version returns the record to that state — and is itself recorded as a change, so a restore you did not mean can be undone from the same timeline.',
        'A restore that would change nothing writes nothing.',
        'Clearing a record’s history removes every past version of it. That one genuinely cannot be undone, so it asks first and tells you how many versions it is about to remove.',
      ],
    },
    {
      kind: 'not-built',
      feature: 'settings',
      text: 'How many versions to keep and how much provenance to record are stored in your vault and used on every save, but there is nowhere in the app to change them yet — the screen that would hold them is not built. New vaults get the defaults described above.',
    },
    {
      kind: 'link',
      to: 'how-your-data-is-protected',
      text: 'How the vault file itself is encrypted',
    },
  ],
};
