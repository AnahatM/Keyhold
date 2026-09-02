// SPDX-License-Identifier: GPL-3.0-or-later
import type { ImportProgress, ImportProgressPhase } from '@shared/model/import-plan.js';
import { ProgressBar } from '../chrome/index.js';
import './import.css';

/**
 * The commit, while it runs.
 *
 * Determinate wherever the main process gives us a total, for the reason `ProgressBar` exists
 * at all: a still bar is indistinguishable from a hung app, and a user who concludes the app
 * has hung force-quits it — here, mid-write, on the file holding every password they own.
 *
 * The phase is named in words rather than shown as a stage of an animation. "Matching against
 * your vault" tells a user why a large import pauses before anything appears; a spinner does
 * not.
 */
const PHASE_LABELS: Readonly<Record<ImportProgressPhase, string>> = {
  parsing: 'Reading the file',
  matching: 'Checking against what you already have',
  writing: 'Adding records to your vault',
  saving: 'Saving the vault',
};

const PHASE_UNITS: Readonly<Record<ImportProgressPhase, string>> = {
  parsing: 'rows',
  matching: 'records',
  writing: 'records',
  saving: 'steps',
};

export function ImportProgressPanel({
  progress,
}: {
  readonly progress: ImportProgress | null;
}): React.JSX.Element {
  if (progress === null || progress.total <= 0) {
    return (
      <div className="kh-import-step">
        <ProgressBar
          label="Importing"
          note="Nothing is written until every record has been prepared."
          slowNote="Large exports take a moment — the vault is written once, atomically, at the end."
        />
      </div>
    );
  }

  return (
    <div className="kh-import-step">
      <ProgressBar
        label={PHASE_LABELS[progress.phase]}
        value={progress.completed}
        max={progress.total}
        unit={PHASE_UNITS[progress.phase]}
        note="You can leave this open — the vault is saved in one atomic write when it finishes."
      />
    </div>
  );
}
