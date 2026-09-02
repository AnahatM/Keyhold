// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTICS,
  DOCUMENT_DIAGNOSTIC_CODES,
  FILE_DIAGNOSTIC_CODES,
} from '@shared/model/recovery.js';
import type { Credential } from '@shared/model/credential.js';
import { emptyVaultDocument, type VaultDocument } from '@shared/model/vault-document.js';
import { recordOf } from '../attachments/test-fixtures.js';
import { diagnoseDocument } from './document-diagnosis.js';
import { inspectVaultFile } from './file-inspection.js';
import { buildRecoveryReport, renderRecoveryReport } from './report.js';
import { surveyVaultFiles } from './survey.js';
import { FIXTURE_NOW, bodyOffsetOf, buildContainer, chunkId, truncatedTo } from './test-support.js';

/**
 * The report is written to be pasted into a bug report, which is what makes the no-content
 * property the most important test in this directory. Everything else here is about it saying
 * what was *checked*, not only what failed — because a reader who cannot tell "clean" from
 * "never ran" has been told nothing.
 */

const DAY = 86_400_000;

/**
 * A marker planted in every user-authored string a fixture has.
 *
 * One token, searched for once, rather than a list of forbidden words: a report that leaks
 * anything at all leaks this, and the assertion cannot rot as fields are added.
 */
const MARKER = 'ZZLEAKMARKERZZ';

/** A vault where literally every user-authored string carries the marker. */
function poisonedDocument(): VaultDocument {
  const base = recordOf('r1');
  const record: Credential = {
    ...base,
    title: `${MARKER}-title`,
    tags: [`${MARKER}-tagname`],
    fields: {
      username: `${MARKER}-username`,
      email: `${MARKER}-email`,
      password: `${MARKER}-password`,
      urls: [`https://${MARKER}.example.com`],
      securityQuestions: [
        { id: 'q1', question: `${MARKER}-question`, answer: `${MARKER}-answer` },
        { id: 'q1', question: `${MARKER}-question2`, answer: `${MARKER}-answer2` },
      ],
      notes: `${MARKER}-notes`,
      custom: [
        {
          id: 'c1',
          label: `${MARKER}-label`,
          type: 'otp-secret',
          value: `${MARKER}-seed`,
          hidden: true,
          order: 0,
        },
        {
          id: 'c1',
          label: `${MARKER}-label2`,
          type: 'password',
          value: `${MARKER}-value`,
          hidden: true,
          order: 1,
        },
      ],
    },
    attachments: [
      {
        id: chunkId('a'),
        name: `${MARKER}-payslip.pdf`,
        mime: 'application/pdf',
        size: 999,
        sha256: 'f'.repeat(64),
        addedAt: FIXTURE_NOW,
      },
    ],
    meta: { ...base.meta, updatedAt: FIXTURE_NOW + 5 * DAY },
    history: {
      enabled: true,
      maxVersions: null,
      versions: [
        {
          versionNumber: 2,
          savedAt: FIXTURE_NOW,
          changedFields: ['title'],
          snapshot: { title: `${MARKER}-old` },
          origin: { action: 'update' },
        },
        {
          versionNumber: 1,
          savedAt: FIXTURE_NOW,
          changedFields: ['title'],
          snapshot: { title: `${MARKER}-older` },
          origin: { action: 'update' },
        },
      ],
    },
    folderId: 'ghost-folder',
  };

  const duplicate: Credential = { ...record, id: 'r1' };

  return {
    ...emptyVaultDocument(),
    records: [record, duplicate],
    folders: [
      { id: 'f1', name: `${MARKER}-Work`, parentId: 'f2', order: 0 },
      { id: 'f2', name: `${MARKER}-Personal`, parentId: 'f1', order: 0 },
    ],
    tags: [
      { id: 't1', name: `${MARKER}-Employer`, colour: 'tag-slate' },
      { id: 't2', name: `${MARKER}-employer`, colour: 'tag-slate' },
    ],
  };
}

/**
 * A separate marker for the directory.
 *
 * The basename is *deliberately* kept — `RecoveryReport.vaultName` is documented as
 * "basename only", and the survey's whole product is a ranked list of filenames the user is
 * meant to go and open. The directory is the part that must never survive, because a home
 * directory is a person's real name often enough to matter. Two markers, so the test can
 * hold the real boundary instead of a stricter one the design does not claim.
 */
const DIRECTORY_MARKER = 'ZZDIRMARKERZZ';

const VAULT_DIRECTORY = `C:\\Users\\${DIRECTORY_MARKER}-person\\${DIRECTORY_MARKER}-Documents`;
const VAULT_PATH = `${VAULT_DIRECTORY}\\vault.keep`;

/** Every analysis run over a thoroughly broken vault, so the report has plenty to leak. */
function poisonedReport(): ReturnType<typeof buildRecoveryReport> {
  const whole = buildContainer();
  return buildRecoveryReport({
    vaultPath: VAULT_PATH,
    generatedAt: FIXTURE_NOW,
    file: inspectVaultFile(truncatedTo(whole, bodyOffsetOf(whole) + 8)),
    survey: surveyVaultFiles({
      vaultPath: VAULT_PATH,
      entries: [
        { path: VAULT_PATH, sizeBytes: 10, modifiedAt: FIXTURE_NOW },
        {
          path: `${VAULT_PATH}.bak.1`,
          sizeBytes: 20,
          modifiedAt: FIXTURE_NOW,
          bytes: buildContainer(),
        },
        { path: `${VAULT_PATH}.tmp`, sizeBytes: 5, modifiedAt: FIXTURE_NOW },
      ],
    }),
    diagnosis: diagnoseDocument(poisonedDocument(), { now: FIXTURE_NOW, chunks: [] }),
  });
}

describe('the property that matters: no user content, anywhere', () => {
  it('does not leak the marker into the serialised report', () => {
    const serialised = JSON.stringify(poisonedReport());
    expect(serialised).not.toContain(MARKER);
  });

  it('does not leak the marker into the rendered text either', () => {
    // Rendering is a second surface: a field that is safe in the object could still be
    // interpolated into a sentence.
    expect(renderRecoveryReport(poisonedReport())).not.toContain(MARKER);
  });

  it('found plenty to report, so the sweep above is not passing on an empty report', () => {
    const report = poisonedReport();

    // Without this the no-leak test would pass trivially on a report with no findings.
    expect(report.findings.length).toBeGreaterThan(5);
    expect(report.plan.actions.length).toBeGreaterThan(3);
    const sources = new Set(report.findings.map((finding) => finding.source));
    expect(sources).toContain('file');
    expect(sources).toContain('document');
    expect(sources).toContain('organisation');
    expect(sources).toContain('attachments');
  });

  it('never lets a directory reach the report, in the object or the text', () => {
    const report = poisonedReport();
    expect(JSON.stringify(report)).not.toContain(DIRECTORY_MARKER);
    expect(renderRecoveryReport(report)).not.toContain(DIRECTORY_MARKER);
  });

  it('keeps a basename and drops the directory', () => {
    const report = buildRecoveryReport({
      vaultPath: `/home/${DIRECTORY_MARKER}-person/vault.keep`,
      generatedAt: FIXTURE_NOW,
    });
    // A home directory is a person's real name often enough to matter. The basename is the
    // deliberate exception — the user has to be told which file the report is about, and
    // the survey exists to name the copy worth opening next.
    expect(report.vaultName).toBe('vault.keep');
    expect(JSON.stringify(report)).not.toContain(DIRECTORY_MARKER);
  });

  it('structurally has no path field to leak one through', () => {
    for (const file of poisonedReport().survey?.files ?? []) {
      expect(Object.keys(file)).not.toContain('path');
    }
  });

  it('says in the report itself what it does not contain', () => {
    const text = renderRecoveryReport(poisonedReport());
    expect(text).toContain(
      'This report contains no passwords, notes, titles, names, or file paths.'
    );
  });

  it('leaks nothing when handed only a document diagnosis', () => {
    const report = buildRecoveryReport({
      generatedAt: FIXTURE_NOW,
      diagnosis: diagnoseDocument(poisonedDocument(), { now: FIXTURE_NOW }),
    });
    expect(JSON.stringify(report)).not.toContain(MARKER);
    expect(renderRecoveryReport(report)).not.toContain(MARKER);
  });
});

describe('what was checked, not only what failed', () => {
  it('lists every file check by name when the bytes were inspected', () => {
    const report = buildRecoveryReport({
      generatedAt: FIXTURE_NOW,
      file: inspectVaultFile(buildContainer()),
    });

    // Derived from the code table rather than written out again, so a check added without
    // appearing here is not possible.
    for (const code of FILE_DIAGNOSTIC_CODES) {
      expect(report.checked.join('\n')).toContain(DIAGNOSTICS[code].title);
    }
  });

  it('lists every document check by name when the vault was unlocked', () => {
    const report = buildRecoveryReport({
      generatedAt: FIXTURE_NOW,
      diagnosis: diagnoseDocument(emptyVaultDocument(), { now: FIXTURE_NOW }),
    });

    for (const code of DOCUMENT_DIAGNOSTIC_CODES) {
      expect(report.checked.join('\n')).toContain(DIAGNOSTICS[code].title);
    }
  });

  it('says plainly which analyses did not run', () => {
    const report = buildRecoveryReport({ generatedAt: FIXTURE_NOW });
    const checked = report.checked.join('\n');

    // "Nothing found" and "never looked" must never read the same.
    expect(checked).toContain('was not inspected');
    expect(checked).toContain('was not surveyed');
    expect(checked).toContain('were not diagnosed');
  });

  it('warns loudly when the attachment reconciliation was skipped', () => {
    const report = buildRecoveryReport({
      generatedAt: FIXTURE_NOW,
      diagnosis: diagnoseDocument(emptyVaultDocument(), { now: FIXTURE_NOW }),
    });

    // This is the check most easily skipped and the one whose absence is least visible.
    expect(report.checked.join('\n')).toContain('NOT reconciled');
  });

  it('distinguishes a reconciled run from a skipped one', () => {
    const report = buildRecoveryReport({
      generatedAt: FIXTURE_NOW,
      diagnosis: diagnoseDocument(emptyVaultDocument(), { now: FIXTURE_NOW, chunks: [] }),
    });
    expect(report.checked.join('\n')).not.toContain('NOT reconciled');
  });
});

describe('the findings list', () => {
  it('sorts critical before warning before info', () => {
    const report = poisonedReport();
    const rank = { critical: 0, warning: 1, info: 2 } as const;

    const ranks = report.findings.map((finding) => rank[finding.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('gives every finding a title and a meaning, never an empty label', () => {
    for (const finding of poisonedReport().findings) {
      expect(finding.title.length).toBeGreaterThan(0);
      expect(finding.meaning.length).toBeGreaterThan(0);
    }
  });

  it('titles an organisation finding from its kind rather than a second list', () => {
    const finding = poisonedReport().findings.find((entry) => entry.source === 'organisation');
    expect(finding?.title[0]).toBe(finding?.title[0]?.toUpperCase());
    expect(finding?.title).not.toContain('-');
  });

  it('reports nothing found on a clean vault, and says so in words', () => {
    const report = buildRecoveryReport({
      generatedAt: FIXTURE_NOW,
      file: inspectVaultFile(buildContainer()),
      diagnosis: diagnoseDocument(emptyVaultDocument(), { now: FIXTURE_NOW, chunks: [] }),
    });

    expect(report.findings).toEqual([]);
    const text = renderRecoveryReport(report);
    expect(text).toContain('Nothing. Every check above passed.');
    expect(text).toContain('No action is proposed');
  });
});

describe('rendering', () => {
  it('is plain text, not Markdown', () => {
    const text = renderRecoveryReport(poisonedReport());
    // Pasted into terminals, mail and issue trackers that treat backticks and asterisks
    // differently; a report that renders wrongly in half of them is worse than plain.
    expect(text).not.toContain('```');
    expect(text).not.toMatch(/\*\*/);
    expect(text).not.toMatch(/^#{1,6} /m);
  });

  it('says what cannot be recovered before it says what to do', () => {
    const text = renderRecoveryReport(poisonedReport());
    expect(text.indexOf('WHAT CANNOT BE RECOVERED')).toBeLessThan(text.indexOf('WHAT TO DO'));
  });

  it('labels the plan as proposals that have not been carried out', () => {
    const text = renderRecoveryReport(poisonedReport());
    expect(text).toContain('Proposals only. Nothing below has been done');
  });

  it('wraps to a readable width and ends with exactly one newline', () => {
    const text = renderRecoveryReport(poisonedReport());
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(120);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('renders identically twice, because nothing in it reads a clock', () => {
    const report = poisonedReport();
    expect(renderRecoveryReport(report)).toBe(renderRecoveryReport(report));
  });

  it('renders a report with every analysis missing rather than throwing', () => {
    const text = renderRecoveryReport(buildRecoveryReport({ generatedAt: FIXTURE_NOW }));
    expect(text).toContain('KEYHOLD VAULT DIAGNOSTICS');
    expect(text).toContain('not named');
  });

  it('names the stop offset in bytes, which is the whole point of the exercise', () => {
    const whole = buildContainer();
    const text = renderRecoveryReport(
      buildRecoveryReport({
        generatedAt: FIXTURE_NOW,
        file: inspectVaultFile(truncatedTo(whole, bodyOffsetOf(whole) + 8)),
      })
    );

    expect(text).toMatch(/Stopped at: byte [\d,]+, during "body-bytes"/);
    expect(text).toContain('Read as far as: body-length');
  });
});
