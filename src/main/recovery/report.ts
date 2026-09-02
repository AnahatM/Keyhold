// SPDX-License-Identifier: GPL-3.0-or-later
import { basename } from 'node:path';
import {
  ATTACHMENT_DIAGNOSTICS,
  DIAGNOSTICS,
  DIAGNOSTIC_SEVERITIES,
  DOCUMENT_DIAGNOSTIC_CODES,
  FILE_DIAGNOSTIC_CODES,
  type DocumentDiagnosis,
  type RecoveryReport,
  type ReportFinding,
  type VaultFileInspection,
  type VaultFileSurvey,
} from '@shared/model/recovery.js';
import { planRepairs } from './repair-plan.js';
import { formatCount, wrapText } from './text.js';

/**
 * The shareable artefact: what was checked, what was found, and what to do about it.
 *
 * Written for a bug report. That governs two things about it.
 *
 * **It contains no user content.** Not a password, a note body, a security answer, a TOTP
 * seed or an attachment byte — and also not a record title, a folder name, a tag name, or a
 * filename beyond a basename. The upstream analyses already refuse to produce those: the
 * survey carries basenames and has no path field, `document-diagnosis.ts` drops the
 * organisation checker's `name` and withholds the record validator's message, and
 * `file-inspection.ts` reports the salt and the wrapped key as lengths. This module adds no
 * new sources of string. `report.test.ts` proves it by planting a marker in every secret,
 * every name and every directory of its fixture and sweeping the serialised result.
 *
 * **It says what was checked, not only what failed.** A report listing three findings and
 * nothing else leaves the reader unable to tell a clean bill of health from a check that
 * never ran — which matters most for the attachment reconciliation, which is silently skipped
 * when the caller has no chunk list. The checklist is derived from the code tables rather
 * than written out again, so a check added without appearing here is not possible.
 */

export interface RecoveryReportInput {
  /** Only the basename is used, and only the basename is kept. */
  readonly vaultPath?: string | undefined;
  /** Supplied rather than read, so two runs over the same inputs render identically. */
  readonly generatedAt: number;
  readonly file?: VaultFileInspection | null | undefined;
  readonly survey?: VaultFileSurvey | null | undefined;
  readonly diagnosis?: DocumentDiagnosis | null | undefined;
}

/** `folder-cycle` → `Folder cycle`. Derived, so a kind never needs a second list to be titled. */
function humanise(code: string): string {
  const words = code.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function checklistFor(input: RecoveryReportInput): readonly string[] {
  const checked: string[] = [];

  if (input.file != null) {
    checked.push('The container file, read without a password:');
    for (const code of FILE_DIAGNOSTIC_CODES) checked.push(`  · ${DIAGNOSTICS[code].title}`);
  } else {
    checked.push('The container file was not inspected — no bytes were supplied.');
  }

  if (input.survey != null) {
    checked.push(
      `The files beside it: ${formatCount(input.survey.files.length)} classified and ranked, including ${formatCount(input.survey.backupCount)} backup(s) and ${formatCount(input.survey.orphanedTempCount)} interrupted write(s).`
    );
  } else {
    checked.push('The surrounding folder was not surveyed — no directory listing was supplied.');
  }

  if (input.diagnosis != null) {
    checked.push('The decrypted contents:');
    for (const code of DOCUMENT_DIAGNOSTIC_CODES) checked.push(`  · ${DIAGNOSTICS[code].title}`);
    checked.push('  · Folder and tag coherence — cycles, missing parents, undeclared tags');
    if (input.diagnosis.attachments === null) {
      checked.push(
        '  · Attachment metadata was NOT reconciled against the chunks — the chunk list was not supplied, so a missing or unreferenced attachment would not have been noticed.'
      );
    } else {
      checked.push('  · Attachment metadata against the chunks the file actually holds');
    }
  } else {
    checked.push('The contents were not diagnosed — the vault was not unlocked.');
  }

  return checked;
}

function collectFindings(input: RecoveryReportInput): readonly ReportFinding[] {
  const findings: ReportFinding[] = [];

  for (const issue of input.file?.issues ?? []) {
    const definition = DIAGNOSTICS[issue.code];
    findings.push({
      source: 'file',
      severity: issue.severity,
      code: issue.code,
      title: definition.title,
      meaning: definition.meaning,
      detail: issue.detail,
      subjects: [],
    });
  }

  for (const issue of input.diagnosis?.issues ?? []) {
    const definition = DIAGNOSTICS[issue.code];
    findings.push({
      source: 'document',
      severity: issue.severity,
      code: issue.code,
      title: definition.title,
      meaning: definition.meaning,
      detail: issue.detail,
      subjects: [...new Set([issue.credentialId, issue.subjectId].filter(isPresent))],
    });
  }

  for (const finding of input.diagnosis?.organisation ?? []) {
    findings.push({
      source: 'organisation',
      severity: finding.severity,
      code: finding.kind,
      title: humanise(finding.kind),
      // The organisation checker's own message is the explanation, and it is content-free by
      // that module's rule. Restating it here would be a second copy that drifts.
      meaning: finding.message,
      detail: null,
      subjects: [...finding.folderIds, ...finding.recordIds, ...finding.tagIds],
    });
  }

  for (const issue of input.diagnosis?.attachments?.issues ?? []) {
    const definition = ATTACHMENT_DIAGNOSTICS[issue.code];
    findings.push({
      source: 'attachments',
      severity: definition.severity,
      code: issue.code,
      title: definition.title,
      meaning: definition.meaning,
      detail: issue.detail,
      subjects: [issue.chunkId, ...(issue.credentialId === null ? [] : [issue.credentialId])],
    });
  }

  // Loudest first, and stable within a severity so two runs over one vault are comparable.
  const rank = (severity: ReportFinding['severity']): number =>
    DIAGNOSTIC_SEVERITIES.indexOf(severity);
  return [...findings].sort((a, b) => rank(a.severity) - rank(b.severity));
}

function isPresent(value: string | null): value is string {
  return value !== null;
}

export function buildRecoveryReport(input: RecoveryReportInput): RecoveryReport {
  const vaultName =
    input.vaultPath === undefined ? (input.survey?.vaultName ?? null) : basename(input.vaultPath);

  return {
    generatedAt: input.generatedAt,
    vaultName,
    checked: checklistFor(input),
    file: input.file ?? null,
    survey: input.survey ?? null,
    diagnosis: input.diagnosis ?? null,
    findings: collectFindings(input),
    plan: planRepairs(input),
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

const WIDTH = 96;

function paragraph(lines: string[], text: string, indent: string): void {
  for (const line of wrapText(text, WIDTH - indent.length)) lines.push(`${indent}${line}`);
}

function heading(lines: string[], title: string): void {
  lines.push('');
  lines.push(title);
  lines.push('─'.repeat(Math.min(title.length, WIDTH)));
}

function renderFile(lines: string[], file: VaultFileInspection): void {
  heading(lines, 'THE FILE');
  lines.push(`  Size: ${formatCount(file.sizeBytes)} bytes`);
  lines.push(`  Read as far as: ${file.reachedStage ?? 'nothing at all'}`);

  const stop = file.stoppedAt;
  if (stop === null) {
    lines.push('  Stopped at: nowhere — the whole container parsed');
  } else {
    const expected = stop.expectedBytes === null ? 'n/a' : formatCount(stop.expectedBytes);
    lines.push(
      `  Stopped at: byte ${formatCount(stop.offset)}, during "${stop.stage}" — expected ${expected} bytes, ${formatCount(stop.availableBytes)} available`
    );
  }

  const header = file.header;
  if (header !== null) {
    lines.push(
      `  Header: format v${formatCount(header.formatVersion)}, generation ${formatCount(header.generation)}, ${formatCount(header.recordCount)} record(s), ${formatCount(header.attachmentCount)} attachment(s)`
    );
    lines.push(
      `  Argon2id: ${formatCount(header.kdf.memoryKib)} KiB, ${formatCount(header.kdf.iterations)} iteration(s), ${formatCount(header.kdf.parallelism)} lane(s), ${formatCount(header.kdf.saltBytes)}-byte salt`
    );
    lines.push(`  Vault id: ${header.vaultId}`);
  } else {
    lines.push('  Header: not readable');
  }

  if (file.chunks.length > 0) {
    const present = file.chunks.filter((chunk) => chunk.present).length;
    lines.push(
      `  Attachment chunks framed: ${formatCount(present)} of ${formatCount(file.chunks.length)}`
    );
  }

  lines.push('');
  paragraph(lines, file.verdict, '  ');
}

function renderSurvey(lines: string[], survey: VaultFileSurvey): void {
  heading(lines, 'COPIES FOUND, BEST FIRST');
  if (survey.files.length === 0) {
    lines.push('  Nothing in the listing matched this vault or a backup of it.');
    return;
  }
  if (!survey.vaultPresent) {
    lines.push(`  The vault file itself (${survey.vaultName}) is not in the listing.`);
    lines.push('');
  }

  for (const file of survey.files) {
    lines.push(`  ${formatCount(file.rank)}. ${file.name}  [${file.role}]`);
    lines.push(`      ${file.ranking}`);
    if (file.note !== null) paragraph(lines, file.note, '      ');
  }
}

function renderDiagnosis(lines: string[], diagnosis: DocumentDiagnosis): void {
  heading(lines, 'THE CONTENTS');
  lines.push(
    `  ${formatCount(diagnosis.recordCount)} record(s) (${formatCount(diagnosis.trashedCount)} in the trash), ${formatCount(diagnosis.folderCount)} folder(s), ${formatCount(diagnosis.tagCount)} tag(s)`
  );
  lines.push(
    `  Findings: ${formatCount(diagnosis.counts.critical)} critical, ${formatCount(diagnosis.counts.warning)} warning, ${formatCount(diagnosis.counts.info)} info`
  );

  const attachments = diagnosis.attachments;
  if (attachments === null) {
    lines.push('  Attachments: not reconciled — the chunk list was not supplied.');
  } else {
    lines.push(
      `  Attachments: ${formatCount(attachments.chunkCount)} chunk(s) in the file, ${formatCount(attachments.referencedCount)} referenced, ${formatCount(attachments.totalBytes)} bytes`
    );
  }
}

/**
 * Renders the report as plain text.
 *
 * Deliberately not Markdown: this is pasted into terminals, mail and issue trackers that all
 * treat backticks and asterisks differently, and a report that renders wrongly in half of
 * them is worse than one that renders plainly in all of them.
 */
export function renderRecoveryReport(report: RecoveryReport): string {
  const lines: string[] = [];

  lines.push('KEYHOLD VAULT DIAGNOSTICS');
  lines.push(`Generated: ${new Date(report.generatedAt).toISOString()}`);
  lines.push(`Vault file: ${report.vaultName ?? 'not named'}`);
  lines.push('This report contains no passwords, notes, titles, names, or file paths.');

  heading(lines, 'WHAT WAS CHECKED');
  for (const entry of report.checked) {
    if (entry.startsWith('  · ')) lines.push(`  ${entry}`);
    else paragraph(lines, entry, '  ');
  }

  if (report.file !== null) renderFile(lines, report.file);
  if (report.survey !== null) renderSurvey(lines, report.survey);
  if (report.diagnosis !== null) renderDiagnosis(lines, report.diagnosis);

  heading(lines, 'WHAT WAS FOUND');
  if (report.findings.length === 0) {
    lines.push('  Nothing. Every check above passed.');
  } else {
    for (const finding of report.findings) {
      lines.push(`  [${finding.severity}] ${finding.title}  (${finding.source}/${finding.code})`);
      if (finding.detail !== null) paragraph(lines, finding.detail, '      ');
      paragraph(lines, finding.meaning, '      ');
      if (finding.subjects.length > 0) {
        paragraph(lines, `Affected: ${finding.subjects.join(', ')}`, '      ');
      }
      lines.push('');
    }
  }

  heading(lines, 'WHAT CANNOT BE RECOVERED');
  for (const statement of report.plan.unrecoverable) {
    paragraph(lines, statement, '  ');
    lines.push('');
  }

  heading(lines, 'WHAT TO DO');
  if (report.plan.clean) {
    lines.push('  Nothing. No action is proposed, because nothing was found to act on.');
  } else {
    lines.push('  Proposals only. Nothing below has been done, and the order matters.');
    lines.push('');
    for (const action of report.plan.actions) {
      lines.push(`  ${formatCount(action.step)}. ${action.summary}`);
      paragraph(lines, `Changes: ${action.changes}`, '      ');
      if (action.cannotRecover !== null) {
        paragraph(lines, `Cannot recover: ${action.cannotRecover}`, '      ');
      }
      lines.push(
        `      Undoable afterwards: ${action.reversible ? 'yes' : 'no, only from the copy'} · needs the vault open: ${action.requiresUnlock ? 'yes' : 'no'}`
      );
      if (action.subjects.length > 0) {
        paragraph(lines, `Applies to: ${action.subjects.join(', ')}`, '      ');
      }
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
