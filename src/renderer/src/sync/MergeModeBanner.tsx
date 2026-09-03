// SPDX-License-Identifier: GPL-3.0-or-later
import type { MergeReport } from '@shared/model/sync.js';
import { countsSentence, modeNotice } from './merge-mode.js';

/**
 * Which merge this was, said before anybody starts clicking.
 *
 * Above the list, not below it and not behind a disclosure. A user facing four hundred conflicts
 * is in a different situation from one facing four, and *why* the number is four hundred is the
 * first thing they need — after the fact it is an excuse, before the fact it is context.
 *
 * The backup line sits here for the same reason. "Your vault was copied to X first" is the
 * sentence that makes the rest of the screen safe to engage with, and it is worth nothing if it
 * is discovered afterwards.
 */

export interface MergeModeBannerProps {
  readonly report: MergeReport;
  readonly backupFileName: string;
}

export function MergeModeBanner({
  report,
  backupFileName,
}: MergeModeBannerProps): React.JSX.Element {
  const notice = modeNotice(report.mode);

  return (
    <section
      className={`kh-merge-mode kh-merge-mode--${notice.tone}`}
      aria-label={notice.modeLabel}
      data-mode={report.mode}
    >
      <span className="kh-merge-mode__symbol" aria-hidden="true">
        {notice.symbol}
      </span>
      <div className="kh-merge-mode__text">
        <h2 className="kh-merge-mode__headline">{notice.headline}</h2>
        <p className="kh-merge-mode__explanation">{notice.explanation}</p>
        {notice.consequence !== null && (
          <p className="kh-merge-mode__consequence">{notice.consequence}</p>
        )}
        <p className="kh-merge-mode__counts">{countsSentence(report)}</p>
        <p className="kh-merge-mode__backup">
          Your vault was copied to{' '}
          <span className="kh-merge-mode__backup-name">{backupFileName}</span> before any of this.
          Nothing below has been written yet.
        </p>
      </div>
    </section>
  );
}
