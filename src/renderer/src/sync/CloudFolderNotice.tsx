// SPDX-License-Identifier: GPL-3.0-or-later
import { useMemo } from 'react';
import { cloudFolderNotice, detectCloudProvider } from '@shared/model/cloud-folder.js';
import './sync.css';

/**
 * Tells the user their vault is inside a folder something else is syncing, and what that means.
 *
 * Keeping a `.keep` in Dropbox or iCloud is how Keyhold does multi-device without a server, and
 * it is a good arrangement — it just has one sharp edge that is invisible until it cuts. The
 * vault is **one file**, and a sync client copies whole files: two devices that both save while
 * one is offline do not produce a merged vault, they produce a winner and a conflicted copy.
 *
 * The merge engine exists precisely for that, and a user who does not know the risk also does
 * not know the remedy. So this is shown where the vault is described rather than as an alert:
 * nothing is wrong yet, and interrupting someone to tell them their setup is fine but has a
 * caveat is how a warning gets trained away before the day it matters.
 *
 * Detection is a question about a string, and the string is already here — the vault's path is
 * part of the safe projection. No channel, no round trip, and one provider table shared with
 * main rather than one on each side.
 *
 * Renders nothing when no provider is recognised, which is the ordinary case.
 */

export interface CloudFolderNoticeProps {
  /** The open vault's path, from the projection. */
  readonly vaultPath: string;
}

export function CloudFolderNotice({ vaultPath }: CloudFolderNoticeProps): React.JSX.Element | null {
  // Memoised on the path rather than recomputed per render: this sits in a panel that
  // re-renders on every status refresh, and the answer only changes when the vault does.
  const notice = useMemo(() => {
    const provider = detectCloudProvider(vaultPath);
    return provider === null ? null : cloudFolderNotice(provider);
  }, [vaultPath]);

  if (notice === null) return null;

  return (
    <section className="kh-cloud-notice" aria-labelledby={`cloud-${notice.providerId}`}>
      <h3 className="kh-cloud-notice__headline" id={`cloud-${notice.providerId}`}>
        {notice.headline}
      </h3>
      <p className="kh-cloud-notice__risk">{notice.risk}</p>
      <ul className="kh-cloud-notice__advice">
        {notice.advice.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  );
}
