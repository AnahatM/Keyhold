// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  ChangeOrigin,
  CredentialProjection,
  VersionedValuesProjection,
} from '@shared/model/credential.js';

/**
 * One credential's audit trail, as a file somebody can keep, send or attach to a ticket.
 *
 * **Provenance, not passwords.** Decision D27. Every secret is a length here, and that is not a
 * filter applied on the way out — it is what the input already is. This builds from
 * `CredentialProjection`, the same safe projection the renderer receives, whose version
 * snapshots carry `passwordLength` and `notesLength` and never a value. There is no code path
 * from this function to a secret, which is why the export needs no type-to-confirm, no shred
 * reminder and no warning: those exist for the full export, which really does write plaintext.
 *
 * Every field is **named** on the way out rather than spread. See `pickSnapshot` — the first
 * draft passed the snapshot through, and the planted-secret test caught it immediately.
 *
 * A record's history is the one place a vault keeps passwords the user has *stopped* using —
 * the ones most likely to be reused elsewhere and least likely to have been rotated since. A
 * plaintext file of every password an account has ever had is a worse artefact than one of the
 * passwords it has now, and the full export already covers anybody who wants the latter.
 *
 * JSON rather than CSV, because a history is nested — a version has changed fields, an origin,
 * and a snapshot — and flattening it either loses the structure or invents a column per field
 * per version. It is written to be read by a person as much as parsed by a tool: keys are
 * spelled out, timestamps carry both the epoch value and an ISO string, and the file says what
 * it deliberately omits so a reader does not go looking for it.
 */

/** Bumped only when the shape changes in a way a consumer could trip on. */
export const HISTORY_EXPORT_VERSION = 1;

export interface HistoryExportOptions {
  /** Stamped into the file so a reader knows which build wrote it. */
  readonly appVersion: string;
  readonly exportedAt: number;
}

const iso = (at: number): string => new Date(at).toISOString();

/**
 * A filename that identifies the record without leaking it into a directory listing.
 *
 * The title is used, because a folder of `history-1.json`, `history-2.json` is unusable — but
 * it is sanitised to the characters every filesystem accepts, and a title that reduces to
 * nothing falls back to the record's id rather than to an empty name.
 */
export function historyExportFileName(credential: CredentialProjection, at: number): string {
  const safe = credential.title
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);

  const stamp = iso(at).slice(0, 10);
  return `${safe === '' ? credential.id : safe}-history-${stamp}.json`;
}

export function serialiseCredentialHistory(
  credential: CredentialProjection,
  options: HistoryExportOptions
): string {
  const document = {
    format: 'keyhold-credential-history',
    version: HISTORY_EXPORT_VERSION,
    exportedAt: options.exportedAt,
    exportedAtIso: iso(options.exportedAt),
    appVersion: options.appVersion,

    // Said in the file, not only in the docs. Someone reading this six months from now, looking
    // for the old password, should find the answer here rather than concluding it was lost.
    contains:
      'The audit trail for one credential: what changed, when, and from where. Secret values ' +
      'are recorded as lengths only and are never included in this file — see decision D27. ' +
      'Use the encrypted vault export if you need the values themselves.',

    credential: {
      id: credential.id,
      title: credential.title,
      createdAt: credential.meta.createdAt,
      createdAtIso: iso(credential.meta.createdAt),
      updatedAt: credential.meta.updatedAt,
      updatedAtIso: iso(credential.meta.updatedAt),
      createdOrigin: pickOrigin(credential.meta.createdOrigin),
      historyEnabled: credential.historyEnabled,
    },

    // Oldest first. A file is read top to bottom, and a history read that way is a story; the
    // timeline reverses it on screen because a screen is scanned rather than read.
    versions: [...credential.history]
      .sort((a, b) => a.versionNumber - b.versionNumber)
      .map((version) => ({
        versionNumber: version.versionNumber,
        savedAt: version.savedAt,
        savedAtIso: iso(version.savedAt),
        changedFields: version.changedFields,
        // Which of the changed fields hold a secret, so a reader can tell "this field is absent
        // because nothing changed" from "this field is absent because it is a secret".
        secretFields: version.secretFields,
        origin: pickOrigin(version.origin),
        snapshot: pickSnapshot(version.snapshot),
      })),
  };

  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * The snapshot, field by field, rather than passed through.
 *
 * Spreading `version.snapshot` was the first version of this, and it was wrong in a way that is
 * only visible under the planted-secret test: it copies whatever the input happens to hold. The
 * safe projection carries lengths today, so the output was correct — by coincidence of the
 * input's shape rather than by anything this file does.
 *
 * Naming the fields makes the guarantee structural. A future change that widens
 * `VersionedValuesProjection`, or a caller that passes a `Credential` because "it has more in
 * it", adds nothing to this file: an unlisted field is simply not copied. The cost is that a
 * genuinely new non-secret field has to be added here to appear — which is the right way round,
 * because that is a decision someone should make deliberately.
 */
function pickSnapshot(snapshot: VersionedValuesProjection): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  const copy = (key: keyof VersionedValuesProjection): void => {
    if (snapshot[key] !== undefined) picked[key] = snapshot[key];
  };

  copy('title');
  copy('username');
  copy('email');
  copy('urls');
  copy('tags');
  copy('folderId');
  copy('favorite');
  copy('icon');
  copy('expiresAt');
  copy('rotationIntervalDays');
  // Prompts only; the answers are secret and are not in the projection.
  copy('securityQuestions');
  // Labels, types, and non-secret values only.
  copy('custom');
  // Lengths, never values. These are the two that make the file honest about what changed
  // without saying what it changed to.
  copy('passwordLength');
  copy('notesLength');

  return picked;
}

/** The origin, field by field, for the same reason. All of it is metadata; none of it is a value. */
function pickOrigin(origin: ChangeOrigin): Record<string, unknown> {
  const picked: Record<string, unknown> = { action: origin.action };
  const copy = (key: keyof ChangeOrigin): void => {
    if (origin[key] !== undefined) picked[key] = origin[key];
  };

  copy('deviceName');
  copy('osUser');
  copy('platform');
  copy('osRelease');
  copy('appVersion');
  copy('networkName');
  copy('localIp');

  return picked;
}
