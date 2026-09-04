// SPDX-License-Identifier: GPL-3.0-or-later
import { credentialTypeDefinition } from '@shared/model/credential-templates.js';
import type { CredentialProjection } from '@shared/model/credential.js';
import { Icon, type IconName } from '../components/Icon.js';

/**
 * What the row's little square shows.
 *
 * Lifted out of `CredentialList` for the reason `health-presentation.ts` and
 * `breach-presentation.ts` were: it is a pure decision about what to display, the list around
 * it reads two stores, and a rule this small should be checkable without mounting a screen.
 * Nothing else changed in moving it.
 *
 * **Never fetches a favicon.** That would tell a server which accounts somebody has, one
 * request per row, which is the leak the whole product exists to refuse. The alternative — an
 * offline icon pack matched locally — is backlog E4.
 *
 * ## The order is the whole rule
 *
 * A user's own choice first, then the record's kind, then the initial.
 *
 * A type icon that overrode a chosen one would be the app overruling somebody about their own
 * record. An initial for every type would make a list of ten cards look like a list of ten of
 * anything. And `login` deliberately keeps the initial: it is the overwhelmingly common type,
 * and a column of identical key icons carries less information than a column of first letters.
 */
export function iconFor(credential: CredentialProjection): React.ReactNode {
  if (credential.icon.kind === 'emoji' && credential.icon.value !== undefined) {
    return credential.icon.value;
  }
  if (credential.type !== 'login') {
    const name = credentialTypeDefinition(credential.type).icon;
    return <Icon name={name as IconName} size="sm" />;
  }
  const source = credential.title.trim() || credential.username.trim() || '?';
  return (source[0] ?? '?').toUpperCase();
}
