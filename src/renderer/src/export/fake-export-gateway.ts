// SPDX-License-Identifier: GPL-3.0-or-later

import {
  exportLoss,
  PLAINTEXT_EXPORT_WARNING,
  type ExportFormatDescriptor,
  type ExportLoss,
  type ExportReport,
} from '@shared/model/export.js';
import type {
  ExportOutcome,
  ExportPlan,
  ExportPreview,
  ExportPreviewRequest,
} from '@shared/model/export-plan.js';
import type { PasswordStrength } from '@shared/model/strength.js';
import type { ExportGateway } from './export-gateway.js';

/**
 * An in-memory `ExportGateway`, for tests.
 *
 * **Test support. Nothing in the app imports this**, and nothing in it produces or consumes
 * a real byte — which is the point: the export dialog's behaviour can be driven end to end
 * without Electron, without a vault, and without a readable copy of anything existing
 * anywhere.
 *
 * It records what it was asked, because most of what is worth asserting about this dialog
 * is negative: that `run` was *not* reached, that a preview was *not* requested with a
 * passphrase in it, that the plan handed over carried the confirmation the user typed.
 */

/**
 * Descriptors shaped like the engine's, and deliberately **not** a copy of it.
 *
 * The real registry lives in `src/main/export/index.ts` and reaches the renderer over IPC;
 * the renderer must not import it (it is main-process code) and must not restate it (rule
 * 8). So this fixture exists to exercise rendering, and if it drifted from the real list it
 * would prove nothing either way — which is exactly the argument for the dialog rendering
 * whatever `formats()` hands it, in the order it hands it, rather than sorting or filtering.
 */
export const SAMPLE_FORMATS: readonly ExportFormatDescriptor[] = [
  {
    id: 'keyhold-parcel',
    name: 'Encrypted parcel',
    extension: '.keepx',
    description: 'Sealed under a passphrase of its own.',
    encrypted: true,
    lossless: true,
    betaReason: null,
  },
  {
    id: 'keyhold-json',
    name: 'Keyhold JSON',
    extension: '.json',
    description: 'Everything, in readable text.',
    encrypted: false,
    lossless: true,
    betaReason: null,
  },
  {
    id: 'keyhold-csv',
    name: 'Spreadsheet (CSV)',
    extension: '.csv',
    description: 'A flat table of the vault.',
    encrypted: false,
    lossless: false,
    betaReason: null,
  },
  {
    id: 'compatible-csv',
    name: 'Other password managers (CSV)',
    extension: '.csv',
    description: 'Bitwarden’s column set.',
    encrypted: false,
    lossless: false,
    // One unverified format in the fixture, so the dialog's beta chip is actually rendered
    // by a test rather than only by production. A fixture where every format is verified
    // would let the chip be deleted with nothing failing.
    betaReason: 'No manager other than Keyhold has read one of these files yet.',
  },
];

/** A loss list with one entry of every kind, so presentation can be exercised in full. */
export const SAMPLE_LOSSES: readonly ExportLoss[] = [
  exportLoss('dropped', 'history', 'Past versions were not carried for 12 records.', 12),
  exportLoss('flattened', 'custom fields', 'Custom fields were packed into one cell.', 9),
  exportLoss(
    'altered',
    'password',
    'Two passwords were rewritten so a spreadsheet cannot run them.',
    2
  ),
];

export interface FakeExportGatewayOptions {
  readonly formats?: readonly ExportFormatDescriptor[] | undefined;
  readonly preview?: ((request: ExportPreviewRequest) => ExportPreview) | undefined;
  readonly outcome?: ((plan: ExportPlan) => ExportOutcome) | undefined;
  readonly strength?: ((password: string) => PasswordStrength | null) | undefined;
}

export interface FakeExportGateway extends ExportGateway {
  /** Every preview asked for, in order. Asserted against to prove no secret was in one. */
  readonly previewRequests: readonly ExportPreviewRequest[];
  /** Every plan actually executed. **Empty is the assertion that matters most.** */
  readonly runPlans: readonly ExportPlan[];
}

function defaultPreview(request: ExportPreviewRequest): ExportPreview {
  const descriptor = SAMPLE_FORMATS.find((format) => format.id === request.format);
  const encrypted = descriptor?.encrypted === true;
  const trashedInScope = 3;
  const base = request.scope.recordIds?.length ?? 10;

  const losses: ExportLoss[] = encrypted ? [] : [...SAMPLE_LOSSES];
  if (!request.scope.includeTrashed) {
    losses.push(
      exportLoss(
        'excluded',
        'trashed records',
        `${trashedInScope} record(s) in the Trash were not exported.`,
        trashedInScope
      )
    );
  }

  return {
    format: request.format,
    recordCount: request.scope.includeTrashed ? base : Math.max(base - trashedInScope, 0),
    trashedInScope,
    unknownIds: 0,
    containsSecrets: !encrypted,
    losses,
  };
}

function reportFor(plan: ExportPlan, preview: ExportPreview): ExportReport {
  const descriptor = SAMPLE_FORMATS.find((format) => format.id === plan.format);
  return {
    format: plan.format,
    extension: descriptor?.extension ?? '.bin',
    containsSecrets: preview.containsSecrets,
    warning: preview.containsSecrets ? PLAINTEXT_EXPORT_WARNING : null,
    recordCount: preview.recordCount,
    losses: preview.losses,
  };
}

export function fakeExportGateway(options: FakeExportGatewayOptions = {}): FakeExportGateway {
  const formats = options.formats ?? SAMPLE_FORMATS;
  const buildPreview = options.preview ?? defaultPreview;

  const previewRequests: ExportPreviewRequest[] = [];
  const runPlans: ExportPlan[] = [];

  return {
    previewRequests,
    runPlans,

    formats: () => Promise.resolve(formats),

    preview: (request) => {
      previewRequests.push(request);
      return Promise.resolve(buildPreview(request));
    },

    run: (plan) => {
      runPlans.push(plan);
      if (options.outcome !== undefined) return Promise.resolve(options.outcome(plan));

      const descriptor = formats.find((format) => format.id === plan.format);
      const preview = buildPreview({ format: plan.format, scope: plan.scope });
      return Promise.resolve({
        status: 'written',
        report: reportFor(plan, preview),
        location: {
          fileName: `vault-export${descriptor?.extension ?? '.bin'}`,
          directory: '/home/example/Documents',
          byteLength: 4096,
        },
      } satisfies ExportOutcome);
    },

    estimateStrength: (password) =>
      Promise.resolve(options.strength === undefined ? null : options.strength(password)),
  };
}

/** A strength answer good enough to pass the parcel gate. */
export function strongEnough(label = 'Strong'): PasswordStrength {
  return {
    score: 4,
    label,
    guesses: 1e12,
    crackTime: 'centuries',
    warning: null,
    suggestions: [],
    meetsMasterMinimum: true,
  };
}

/** A strength answer that must not let a parcel through. */
export function tooWeak(): PasswordStrength {
  return {
    score: 1,
    label: 'Weak',
    guesses: 100,
    crackTime: 'less than a second',
    warning: 'This is a common password.',
    suggestions: ['Use several unrelated words.'],
    meetsMasterMinimum: false,
  };
}
