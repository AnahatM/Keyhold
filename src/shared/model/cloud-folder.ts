// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Recognises when a vault is living inside a folder that something else is syncing.
 *
 * A `.keep` in a cloud folder is how Keyhold does multi-device without a server, and it is a
 * genuinely good arrangement — but it has one sharp edge the user cannot see coming. The vault
 * is **one file**. A cloud client syncs whole files, so two devices that both save while
 * offline do not produce a merged vault: they produce a winner and a "conflicted copy", and
 * whichever one the client picks silently becomes the whole truth.
 *
 * That is exactly the failure the merge engine exists for, and the user has no way of knowing
 * either the risk or the remedy exists unless they are told. So this detects the situation and
 * the app says so, once, where the vault is described.
 *
 * **Pure, and platform-agnostic by parameter.** Detection is a question about a string, and
 * making it one keeps every provider testable on every platform — the alternative is a module
 * that can only be tested on the OS it happens to be running on, which in practice means the
 * Windows paths are the only ones ever exercised.
 *
 * **Nothing here touches the filesystem, and it lives in `shared` for that reason.** A path is
 * enough, and the vault's path is already in the safe projection — so the renderer answers this
 * question itself rather than asking over IPC. A channel would have been a round trip, a
 * validator and a second place for the provider table to live, all to re-derive something from
 * a string the renderer was already holding. Syncthing is the one provider that
 * cannot be recognised this way — it syncs any folder you point it at and leaves a `.stfolder`
 * marker rather than using a fixed location — so it is handled separately, by
 * `syncthingMarkerNames`, for a caller that is willing to look.
 */

export type CloudProviderId =
  | 'dropbox'
  | 'onedrive'
  | 'icloud'
  | 'google-drive'
  | 'nextcloud'
  | 'owncloud'
  | 'pcloud'
  | 'mega'
  | 'box'
  | 'syncthing';

export interface CloudProvider {
  readonly id: CloudProviderId;
  /** As the user would name it. Appears in a sentence, so it is capitalised as a proper noun. */
  readonly name: string;
  /**
   * Path segments that identify the provider, lower-cased.
   *
   * Matched against whole segments rather than as substrings: a folder called `Dropboxes` or
   * a record named `megabank` in the path must not be read as a sync root. A prefix match is
   * allowed only where the provider genuinely generates suffixed names — `OneDrive - Contoso`
   * and `GoogleDrive-someone@example.com` are what those clients actually create.
   */
  readonly segments: readonly string[];
  /** Segments where the provider's real folder starts with this and continues. */
  readonly prefixes?: readonly string[];
}

/**
 * The providers, in one table.
 *
 * A registry, so it gets the uniqueness guard hard rule 9 asks for — two entries claiming the
 * same segment would make detection depend on array order, which is the kind of thing that
 * works until somebody sorts the list.
 */
export const CLOUD_PROVIDERS: readonly CloudProvider[] = [
  { id: 'dropbox', name: 'Dropbox', segments: ['dropbox'] },
  {
    id: 'onedrive',
    name: 'OneDrive',
    segments: ['onedrive'],
    // `OneDrive - Contoso` is what the business client creates, one per tenant.
    prefixes: ['onedrive - '],
  },
  {
    id: 'icloud',
    name: 'iCloud Drive',
    // The second is what macOS shows in Finder; the first is where the files actually are.
    segments: ['com~apple~clouddocs', 'icloud drive', 'iclouddrive'],
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    // `My Drive` is the folder inside the mount on Windows, where the drive letter itself
    // carries no useful name.
    segments: ['google drive', 'googledrive', 'my drive'],
    // macOS Ventura and later: `~/Library/CloudStorage/GoogleDrive-someone@example.com`.
    prefixes: ['googledrive-'],
  },
  { id: 'nextcloud', name: 'Nextcloud', segments: ['nextcloud'] },
  { id: 'owncloud', name: 'ownCloud', segments: ['owncloud'] },
  { id: 'pcloud', name: 'pCloud', segments: ['pcloud', 'pclouddrive'] },
  { id: 'mega', name: 'MEGA', segments: ['mega', 'megasync'] },
  { id: 'box', name: 'Box', segments: ['box', 'box sync'], prefixes: ['box-'] },
  {
    id: 'syncthing',
    name: 'Syncthing',
    // Deliberately empty: Syncthing syncs whatever folder it is pointed at, so there is no
    // name to look for. It is recognised by its marker directory instead — see
    // `SYNCTHING_MARKERS` — and is in this table so it can be *named* once found.
    segments: [],
  },
];

/** Directories Syncthing leaves in a folder it manages. Their presence is the detection. */
export const SYNCTHING_MARKERS: readonly string[] = ['.stfolder', '.stversions'];

export const PROVIDER_BY_ID: ReadonlyMap<CloudProviderId, CloudProvider> = new Map(
  CLOUD_PROVIDERS.map((provider) => [provider.id, provider])
);

/**
 * Splits a path into lower-cased segments, on either separator.
 *
 * Both separators always, on every platform: a Windows path can reach a macOS build through a
 * synced settings file or a recent-vaults list, and a detector that only understands its own
 * platform's separator silently answers "no" for the other one.
 */
function segmentsOf(path: string): readonly string[] {
  return path
    .split(/[\\/]+/)
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment !== '');
}

function matches(provider: CloudProvider, segment: string): boolean {
  if (provider.segments.includes(segment)) return true;
  return (provider.prefixes ?? []).some(
    // `length >` rather than `>=`: a segment that is exactly the prefix and nothing else is
    // not one of the generated names this is looking for.
    (prefix) => segment.startsWith(prefix) && segment.length > prefix.length
  );
}

/**
 * Which provider, if any, appears to be syncing the folder this path is in.
 *
 * Returns the **first** match in table order when a path somehow contains two — a vault at
 * `~/Dropbox/OneDrive/…` is a folder somebody named oddly rather than two clients, and
 * answering with one name is more useful than refusing to answer.
 */
export function detectCloudProvider(vaultPath: string): CloudProvider | null {
  const segments = segmentsOf(vaultPath);
  // The last segment is the file itself. A vault named `dropbox.keep` is not in Dropbox.
  const directories = segments.slice(0, -1);

  for (const provider of CLOUD_PROVIDERS) {
    if (directories.some((segment) => matches(provider, segment))) return provider;
  }
  return null;
}

/**
 * Whether a directory listing looks like a folder Syncthing manages.
 *
 * Separate from {@link detectCloudProvider} because it needs a listing rather than a string,
 * and the caller is the one that can afford the read.
 */
export function looksLikeSyncthing(entryNames: readonly string[]): boolean {
  const lower = new Set(entryNames.map((name) => name.toLowerCase()));
  return SYNCTHING_MARKERS.some((marker) => lower.has(marker));
}

export interface CloudFolderNotice {
  readonly providerId: CloudProviderId;
  readonly providerName: string;
  /** One sentence: what was noticed. */
  readonly headline: string;
  /** What is actually risky about it, in terms of what the user would experience. */
  readonly risk: string;
  /** What to do, in the order worth doing it. */
  readonly advice: readonly string[];
}

/**
 * The guidance, built from the provider rather than written once per provider.
 *
 * The risk is identical for all of them because it comes from the shape of the arrangement —
 * one file, whole-file sync — and not from anything a particular client does. Writing it per
 * provider would be nine copies of one paragraph, and nine places for it to drift.
 */
export function cloudFolderNotice(provider: CloudProvider): CloudFolderNotice {
  return {
    providerId: provider.id,
    providerName: provider.name,
    headline: `This vault is inside a folder ${provider.name} is syncing.`,
    risk:
      'A vault is one file, and a sync client copies whole files. If two devices both save ' +
      'while one of them is offline, the client does not merge them — it picks a winner and ' +
      'keeps the other as a conflicted copy, and the edits on the losing side are only in ' +
      'that copy.',
    advice: [
      'Let one device finish syncing before you edit on another.',
      'If a conflicted copy appears, do not delete it — use Merge another copy of this vault, ' +
        'which keeps both sides and asks about anything that disagrees.',
      'Keyhold takes a backup of this vault before every merge, so the copy you started with ' +
        'always still exists.',
    ],
  };
}

/**
 * Filenames a sync client generates for the losing side of a conflict.
 *
 * Matched case-insensitively against the file's own name. These are the actual conventions —
 * Dropbox writes "(Anahat's conflicted copy 2026-09-03)", OneDrive writes "-DESKTOP-ABC123",
 * Syncthing writes ".sync-conflict-20260903-120000-ABCDEFG", Nextcloud writes
 * "(conflicted copy 2026-09-03 120000)".
 *
 * Deliberately a *hint* rather than a rule. A file that matches is offered as a merge
 * candidate; a file that does not is not excluded from anything. The cost of a false positive
 * is one unnecessary suggestion, and the cost of a false negative is a suggestion that does not
 * appear — so the patterns are allowed to be generous.
 */
const CONFLICT_PATTERNS: readonly RegExp[] = [
  /\bconflicted copy\b/i,
  /\.sync-conflict-\d/i,
  /\bconflict\b.*\d{4}-\d{2}-\d{2}/i,
  /-desktop-[a-z0-9]+\./i,
];

export function looksLikeConflictedCopy(fileName: string): boolean {
  return CONFLICT_PATTERNS.some((pattern) => pattern.test(fileName));
}
