// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useState } from 'react';
import type { DiagnosticSeverity, RecoveryReport, ReportFinding } from '@shared/model/recovery.js';
import { Button } from '../components/Button.js';
import { Badge, EmptyState, type StatusTone } from '../components/Feedback.js';
import './diagnostics.css';

/**
 * "My vault will not open" — the screen that answers it.
 *
 * `src/main/recovery/` has been finished, tested and reachable from nothing: every piece is a
 * pure function over bytes, a directory listing or a document, and nothing read a folder and
 * called them. This is the surface for that engine.
 *
 * Two things it does that the rest of the app does not:
 *
 * **It works on a vault nobody can unlock.** The container is read without a password, which
 * is the whole situation it exists for — so "Diagnose a file…" is offered beside "Diagnose
 * this vault", and neither takes a path from here: the dialog opens in the main process.
 *
 * **It says what was checked, not only what failed.** A screen listing three findings leaves
 * the reader unable to tell a clean bill of health from a check that never ran. The engine
 * derives that checklist from its own code tables, so it is rendered verbatim rather than
 * summarised here.
 *
 * The report carries no user content — no secret, no record title, no folder name, no path
 * beyond a basename — which is what makes "Save report…" safe to offer, and it is offered
 * because the point of the artefact is to be attached to a bug report.
 */

const SEVERITY_TONE: Readonly<Record<DiagnosticSeverity, StatusTone>> = {
  critical: 'danger',
  warning: 'warning',
  info: 'info',
};

export interface DiagnosticsViewProps {
  readonly hideTitle?: boolean;
  /** Injectable so the screen renders without a preload bridge. */
  readonly diagnose?: () => Promise<
    { ok: true; value: RecoveryReport } | { ok: false; message: string }
  >;
  readonly diagnoseFile?: () => Promise<
    { ok: true; value: RecoveryReport | null } | { ok: false; message: string }
  >;
  readonly saveReport?: () => Promise<
    { ok: true; value: string | null } | { ok: false; message: string }
  >;
}

export function DiagnosticsView({
  hideTitle = false,
  diagnose = () => window.keyhold.recovery.diagnose(),
  diagnoseFile = () => window.keyhold.recovery.diagnoseFile(),
  saveReport = () => window.keyhold.recovery.saveReport(),
}: DiagnosticsViewProps): React.JSX.Element {
  const [report, setReport] = useState<RecoveryReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const run = useCallback(
    (which: 'open' | 'file') => {
      void (async () => {
        setBusy(true);
        setError(null);
        setSaved(null);
        try {
          const result = which === 'open' ? await diagnose() : await diagnoseFile();
          if (!result.ok) {
            setError(result.message);
            return;
          }
          // `null` from the file path means the dialog was dismissed, which is not a result
          // and must not clear the report already on screen.
          if (result.value !== null) setReport(result.value);
        } finally {
          setBusy(false);
        }
      })();
    },
    [diagnose, diagnoseFile]
  );

  return (
    <section className="kh-diagnostics">
      {!hideTitle && <h1 className="kh-diagnostics__title">Diagnose a vault</h1>}

      <p className="kh-diagnostics__intro">
        Reads a vault file without needing its password and reports what it finds — the container,
        the files beside it, and, when a vault is open, its contents. The report contains no
        passwords, no record names and no folder paths, so it is safe to attach to a bug report.
      </p>

      <div className="kh-diagnostics__actions">
        <Button
          variant="primary"
          icon="wrench"
          loading={busy}
          onClick={() => {
            run('open');
          }}
        >
          Diagnose this vault
        </Button>
        <Button
          variant="secondary"
          icon="folder"
          disabled={busy}
          onClick={() => {
            run('file');
          }}
        >
          Diagnose a file…
        </Button>
        {report !== null && (
          <Button
            variant="ghost"
            icon="save"
            disabled={busy}
            onClick={() => {
              void (async () => {
                const result = await saveReport();
                if (result.ok) setSaved(result.value);
                else setError(result.message);
              })();
            }}
          >
            Save report…
          </Button>
        )}
      </div>

      {error !== null && (
        <p className="kh-diagnostics__error" role="alert">
          {error}
        </p>
      )}
      {saved !== null && (
        <p className="kh-diagnostics__saved" role="status">
          Saved as {saved}.
        </p>
      )}

      {report === null ? (
        <EmptyState
          icon="wrench"
          title="Nothing diagnosed yet"
          description="Nothing is read until you ask. Diagnosing opens no network connection and changes no file."
        />
      ) : (
        <Report report={report} />
      )}
    </section>
  );
}

function Report({ report }: { readonly report: RecoveryReport }): React.JSX.Element {
  return (
    <>
      <section className="kh-diagnostics__block">
        <h2 className="kh-diagnostics__heading">
          {report.plan.clean ? 'Nothing wrong was found' : 'What was found'}
          {report.vaultName !== null && (
            <span className="kh-diagnostics__subject"> · {report.vaultName}</span>
          )}
        </h2>

        {report.findings.length === 0 ? (
          <p className="kh-diagnostics__clean">
            Every check below ran and none of them found a problem.
          </p>
        ) : (
          <ul className="kh-diagnostics__findings">
            {report.findings.map((finding) => (
              <Finding key={`${finding.source}:${finding.code}`} finding={finding} />
            ))}
          </ul>
        )}
      </section>

      {report.plan.actions.length > 0 && (
        <section className="kh-diagnostics__block">
          <h2 className="kh-diagnostics__heading">What to do, in order</h2>
          <ol className="kh-diagnostics__plan">
            {report.plan.actions.map((action) => (
              <li key={action.step}>
                <p className="kh-diagnostics__step">{action.summary}</p>
                <p className="kh-diagnostics__changes">{action.changes}</p>
                {action.cannotRecover !== null && (
                  <p className="kh-diagnostics__cannot">{action.cannotRecover}</p>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {report.plan.unrecoverable.length > 0 && (
        <section className="kh-diagnostics__block">
          <h2 className="kh-diagnostics__heading">What nothing can undo</h2>
          {/* Rendered as plainly as the engine states it. A screen that softened this would be
              implying a salvage that does not exist — an AEAD failure has no partial credit. */}
          <ul className="kh-diagnostics__unrecoverable">
            {report.plan.unrecoverable.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="kh-diagnostics__block">
        <h2 className="kh-diagnostics__heading">What was checked</h2>
        {/* Verbatim from the engine, which derives it from its own code tables. A screen that
            summarised it could not tell a clean result from a check that never ran. */}
        <ul className="kh-diagnostics__checked">
          {report.checked.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
    </>
  );
}

function Finding({ finding }: { readonly finding: ReportFinding }): React.JSX.Element {
  return (
    <li className="kh-diagnostics__finding">
      <div className="kh-diagnostics__finding-head">
        <Badge tone={SEVERITY_TONE[finding.severity]}>{finding.severity}</Badge>
        <span className="kh-diagnostics__finding-title">{finding.title}</span>
      </div>
      <p className="kh-diagnostics__meaning">{finding.meaning}</p>
      {finding.detail !== null && <p className="kh-diagnostics__detail">{finding.detail}</p>}
      {finding.subjects.length > 0 && (
        <p className="kh-diagnostics__subjects">{finding.subjects.join(', ')}</p>
      )}
    </li>
  );
}
