// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  CLOUD_PROVIDERS,
  PROVIDER_BY_ID,
  cloudFolderNotice,
  detectCloudProvider,
  looksLikeConflictedCopy,
  looksLikeSyncthing,
} from './cloud-folder.js';

/**
 * Recognising a vault that lives in somebody else's sync folder.
 *
 * Two kinds of failure matter here and they are not symmetric. A **miss** costs the user a
 * warning they should have had — annoying, and the situation is still recoverable because the
 * merge engine exists either way. A **false positive** costs trust: a vault sitting in a folder
 * that happens to be called `Megabytes` being told it is inside MEGA is the app being wrong
 * about something the user can see with their own eyes, and it makes every later warning
 * cheaper.
 *
 * So the segment matching is whole-segment, and most of what is asserted below is about what
 * must *not* be detected.
 *
 * Fault injection performed:
 *  1. Changing `provider.segments.includes(segment)` to `segment.includes(...)` — fails
 *     "does not mistake a folder that merely contains a provider's name".
 *  2. Removing the `slice(0, -1)` that drops the filename — fails "a vault named after a
 *     provider is not in it". It did **not**, on the first draft of that test: every case used
 *     a `.keep` extension, and `dropbox.keep` is not the segment `dropbox`, so whole-segment
 *     matching refused it anyway. The extensionless case was added for exactly that reason.
 *  3. Changing `length > prefix.length` to `>=` in the prefix match — fails "a bare prefix is
 *     not one of the generated names".
 *  4. Splitting on the platform separator only — fails "reads a Windows path on any platform".
 */

describe('the provider table', () => {
  it('claims each segment exactly once, so detection cannot depend on order', () => {
    const seen = new Map<string, string>();
    for (const provider of CLOUD_PROVIDERS) {
      for (const segment of [...provider.segments, ...(provider.prefixes ?? [])]) {
        const owner = seen.get(segment);
        expect(owner, `"${segment}" is claimed by both ${String(owner)} and ${provider.id}`).toBe(
          undefined
        );
        seen.set(segment, provider.id);
      }
    }
  });

  it('has unique ids, and the lookup covers every one', () => {
    const ids = CLOUD_PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(PROVIDER_BY_ID.size).toBe(CLOUD_PROVIDERS.length);
  });

  it('names every provider as a person would write it', () => {
    for (const provider of CLOUD_PROVIDERS) {
      expect(provider.name.trim()).not.toBe('');
      expect(provider.segments.every((segment) => segment === segment.toLowerCase())).toBe(true);
    }
  });
});

describe('what is detected', () => {
  const cases: readonly [string, string][] = [
    ['C:\\Users\\Anahat\\Dropbox\\keys\\personal.keep', 'dropbox'],
    ['/Users/anahat/Dropbox/personal.keep', 'dropbox'],
    ['C:\\Users\\Anahat\\OneDrive\\personal.keep', 'onedrive'],
    ['C:\\Users\\Anahat\\OneDrive - Contoso Ltd\\personal.keep', 'onedrive'],
    ['/Users/anahat/Library/Mobile Documents/com~apple~CloudDocs/personal.keep', 'icloud'],
    [
      '/Users/anahat/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/x.keep',
      'google-drive',
    ],
    ['G:\\My Drive\\vaults\\personal.keep', 'google-drive'],
    ['/home/anahat/Nextcloud/personal.keep', 'nextcloud'],
    ['/home/anahat/pCloudDrive/personal.keep', 'pcloud'],
    ['/home/anahat/MEGA/personal.keep', 'mega'],
  ];

  for (const [path, expected] of cases) {
    it(`recognises ${expected} in ${path}`, () => {
      expect(detectCloudProvider(path)?.id).toBe(expected);
    });
  }

  it('reads a Windows path on any platform, and a POSIX one too', () => {
    // Both separators always. A Windows path reaches a macOS build through a recent-vaults
    // list, and a detector that only knows its own separator silently answers "no".
    expect(detectCloudProvider('C:\\Users\\a\\Dropbox\\x.keep')?.id).toBe('dropbox');
    expect(detectCloudProvider('/home/a/Dropbox/x.keep')?.id).toBe('dropbox');
    expect(detectCloudProvider('C:/Users/a/Dropbox/x.keep')?.id).toBe('dropbox');
  });
});

describe('what is not detected, which is the half that costs trust', () => {
  it('leaves an ordinary path alone', () => {
    expect(detectCloudProvider('C:\\Users\\Anahat\\Documents\\personal.keep')).toBeNull();
    expect(detectCloudProvider('/home/anahat/vaults/personal.keep')).toBeNull();
  });

  it('does not mistake a folder that merely contains a provider’s name', () => {
    // The whole-segment rule. Someone with a folder called `Megabytes` being told their vault
    // is inside MEGA is the app being wrong about something they can see.
    expect(detectCloudProvider('/home/a/Megabytes/x.keep')).toBeNull();
    expect(detectCloudProvider('/home/a/Dropboxes/x.keep')).toBeNull();
    expect(detectCloudProvider('/home/a/my-dropbox-notes/x.keep')).toBeNull();
    expect(detectCloudProvider('/home/a/boxing/x.keep')).toBeNull();
  });

  it('a vault named after a provider is not in it', () => {
    expect(detectCloudProvider('/home/a/vaults/dropbox.keep')).toBeNull();
    expect(detectCloudProvider('/home/a/vaults/OneDrive.keep')).toBeNull();
    // The extensionless case is the one that makes dropping the filename load-bearing rather
    // than merely tidy: with an extension the whole-segment rule already refuses, because
    // `dropbox.keep` is not `dropbox`. A file named exactly `Dropbox` is not, and this was
    // found by injecting the removal and watching nothing fail.
    expect(detectCloudProvider('/home/a/vaults/Dropbox')).toBeNull();
    expect(detectCloudProvider('C:\\vaults\\OneDrive')).toBeNull();
  });

  it('a bare prefix is not one of the generated names', () => {
    // `googledrive-` on its own is not a folder Google's client makes; `googledrive-me@…` is.
    expect(detectCloudProvider('/home/a/googledrive-/x.keep')).toBeNull();
    expect(detectCloudProvider('/home/a/googledrive-me@example.com/x.keep')?.id).toBe(
      'google-drive'
    );
  });

  it('is not confused by trailing separators or repeated ones', () => {
    expect(detectCloudProvider('C:\\\\Users\\\\a\\\\Dropbox\\\\x.keep')?.id).toBe('dropbox');
    expect(detectCloudProvider('/home//a///Dropbox//x.keep')?.id).toBe('dropbox');
  });
});

describe('syncthing, which has no folder name to look for', () => {
  it('is recognised by the marker directory it leaves', () => {
    expect(looksLikeSyncthing(['personal.keep', '.stfolder'])).toBe(true);
    expect(looksLikeSyncthing(['personal.keep', '.stversions'])).toBe(true);
    expect(looksLikeSyncthing(['.STFOLDER'])).toBe(true);
  });

  it('is not claimed by an ordinary folder', () => {
    expect(looksLikeSyncthing(['personal.keep', 'notes.txt'])).toBe(false);
    expect(looksLikeSyncthing([])).toBe(false);
  });
});

describe('the guidance', () => {
  it('names the provider and says what the actual risk is', () => {
    const provider = PROVIDER_BY_ID.get('dropbox');
    expect(provider).toBeDefined();
    const notice = cloudFolderNotice(provider!);

    expect(notice.headline).toContain('Dropbox');
    // The risk is the one that comes from the shape of the arrangement, not from anything a
    // particular client does — which is why it is built rather than written nine times.
    expect(notice.risk).toContain('one file');
    expect(notice.risk).toContain('conflicted copy');
    expect(notice.advice.length).toBeGreaterThan(0);
    // The remedy has to be named, or the warning is just something to worry about.
    expect(notice.advice.join(' ')).toContain('Merge another copy of this vault');
  });

  it('is available for every provider in the table', () => {
    for (const provider of CLOUD_PROVIDERS) {
      const notice = cloudFolderNotice(provider);
      expect(notice.providerId).toBe(provider.id);
      expect(notice.headline).toContain(provider.name);
    }
  });
});

describe('spotting a conflicted copy by its name', () => {
  it('recognises what the real clients actually write', () => {
    expect(looksLikeConflictedCopy("personal (Anahat's conflicted copy 2026-09-03).keep")).toBe(
      true
    );
    expect(looksLikeConflictedCopy('personal.sync-conflict-20260903-120000-ABCDEFG.keep')).toBe(
      true
    );
    expect(looksLikeConflictedCopy('personal (conflicted copy 2026-09-03 120000).keep')).toBe(true);
    expect(looksLikeConflictedCopy('personal-DESKTOP-A1B2C3.keep')).toBe(true);
  });

  it('leaves an ordinary vault name alone', () => {
    expect(looksLikeConflictedCopy('personal.keep')).toBe(false);
    expect(looksLikeConflictedCopy('work-2026.keep')).toBe(false);
    expect(looksLikeConflictedCopy('personal.keep.bak.1')).toBe(false);
  });
});
