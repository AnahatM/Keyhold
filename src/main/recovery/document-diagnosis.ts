// SPDX-License-Identifier: GPL-3.0-or-later
import { type Credential } from '@shared/model/credential.js';
import {
  ATTACHMENT_DIAGNOSTICS,
  DIAGNOSTICS,
  type ChunkPresence,
  type DiagnosticIssue,
  type DiagnosticSeverity,
  type DiagnosticSubjectKind,
  type DocumentDiagnosis,
  type DocumentDiagnosticCode,
  type OrganisationFinding,
} from '@shared/model/recovery.js';
import { VAULT_DOCUMENT_VERSION, type VaultDocument } from '@shared/model/vault-document.js';
import { auditAttachments } from '../attachments/audit.js';
import {
  checkOrganisation,
  type OrganisationIssue,
  type OrganisationIssueKind,
} from '../organisation/integrity.js';
import { assertValidHistory } from '../history/versioning.js';
import { assertValidCredential } from '../vault/credential-ops.js';
import { describeHistoryViolation } from './history-detail.js';
import { formatCount } from './text.js';

/**
 * Integrity of a **decrypted** vault: everything that is still wrong after the file opened.
 *
 * A container that authenticates proves the bytes are the bytes that were written. It proves
 * nothing about whether what was written makes sense, and the states below are all reachable
 * from a merge, a partial restore, an interrupted import, a hand-edited export, or a bug in
 * an older build.
 *
 * ## Nothing here is repaired
 *
 * Same rule as `integrity.ts` and `audit.ts`, for the same reason: the repair is one line and
 * that is the trap. Reassigning a duplicate id, clearing a history array, dropping a dangling
 * attachment — each takes a moment and each destroys the evidence of *which* cause produced
 * the state, and the causes want different responses. `planRepairs` turns these findings into
 * proposals; the user chooses; nothing in this directory mutates a document.
 *
 * ## What this module owns, and what it delegates
 *
 * It owns exactly the checks nothing else performs — record ids, per-record field ids,
 * history invariants, and clocks. Folder and tag coherence belong to
 * `checkOrganisation`, and metadata-versus-chunk reconciliation belongs to
 * `auditAttachments`; both are called, neither is re-derived. A second implementation of
 * "is this folder tree sound?" would disagree with the first within a month (hard rule 8).
 *
 * ## Pure, including the clock
 *
 * `now` is supplied rather than read, exactly as `analyseVault` requires it, so a diagnosis
 * is a pure function of the document and the moment it was asked about — which is what makes
 * "this timestamp is 40 days in the future" testable at a boundary instead of at a whim.
 */

export interface DocumentDiagnosisOptions {
  /** Passed in, never read from a clock, so the diagnosis is reproducible. */
  readonly now: number;
  /**
   * The chunks the container actually holds.
   *
   * Omit when they are not to hand — the diagnosis still runs, and reports that the
   * attachment reconciliation did not. Supplying them is what turns on `missing-chunk`,
   * `unreferenced-chunk`, `size-mismatch` and the duplicate-chunk-id check, all four of which
   * belong to `auditAttachments`.
   */
  readonly chunks?: readonly ChunkPresence[] | undefined;
}

/**
 * Severity for each of the organisation checker's kinds.
 *
 * A `Record` over `OrganisationIssueKind`, so a kind added to `integrity.ts` without a
 * severity here is a compile error rather than a finding that quietly renders at the bottom
 * of the report with no colour.
 */
const ORGANISATION_SEVERITY: Readonly<Record<OrganisationIssueKind, DiagnosticSeverity>> = {
  'record-missing-folder': 'warning',
  'folder-missing-parent': 'warning',
  'folder-cycle': 'warning',
  'record-missing-tag': 'info',
  'duplicate-folder-name': 'info',
  'duplicate-tag-name': 'info',
  'import-placeholder-folder': 'warning',
};

/**
 * Adapts one organisation issue for the report — and **drops its `name`**.
 *
 * `integrity.ts` puts the colliding folder or tag name in a dedicated field precisely so that
 * each caller can decide whether to render it. A diagnostic report is written to be pasted
 * into an issue tracker, so it decides not to: the ids identify the folders well enough to
 * act on, and a tag called after an employer or an ex is not something to put in a public
 * paste on the user's behalf.
 *
 * The signature is also the compile-time proof that this module can carry every field
 * `OrganisationIssue` has.
 */
function toOrganisationFinding(issue: OrganisationIssue): OrganisationFinding {
  return {
    kind: issue.kind,
    severity: ORGANISATION_SEVERITY[issue.kind],
    message: issue.message,
    folderIds: issue.folderIds ?? [],
    recordIds: issue.recordIds ?? [],
    tagIds: issue.tagIds ?? [],
  };
}

function issueFor(
  code: DocumentDiagnosticCode,
  subject: DiagnosticSubjectKind,
  subjectId: string | null,
  credentialId: string | null,
  detail: string | null
): DiagnosticIssue {
  return { code, severity: DIAGNOSTICS[code].severity, subject, subjectId, credentialId, detail };
}

/** Ids appearing more than once, with how many times, in first-seen order. */
function duplicates(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);

  const repeated = new Map<string, number>();
  for (const [id, count] of counts) if (count > 1) repeated.set(id, count);
  return repeated;
}

/**
 * The record timestamps that must not be in the future.
 *
 * `expiresAt` and `rotationIntervalDays` are deliberately absent: an expiry date in the
 * future is the entire point of an expiry date, and flagging it would make the check noise
 * that everyone learns to ignore.
 */
const RECORD_TIMESTAMPS = ['createdAt', 'updatedAt', 'passwordUpdatedAt', 'lastUsedAt'] as const;

function futureTimestampFields(record: Credential, now: number): readonly string[] {
  const ahead: string[] = [];
  for (const field of RECORD_TIMESTAMPS) {
    const value = record.meta[field];
    if (value !== null && value > now) ahead.push(field);
  }
  if (record.trashedAt !== null && record.trashedAt > now) ahead.push('trashedAt');
  if (record.history.versions.some((version) => version.savedAt > now)) {
    ahead.push('history.savedAt');
  }
  return ahead;
}

/** How far ahead the worst offender is, in milliseconds. Reported as days, which is readable. */
function furthestAhead(record: Credential, now: number): number {
  const values: number[] = [
    ...RECORD_TIMESTAMPS.map((field) => record.meta[field] ?? now),
    record.trashedAt ?? now,
    ...record.history.versions.map((version) => version.savedAt),
  ];
  return Math.max(...values) - now;
}

const MILLISECONDS_PER_DAY = 86_400_000;

function diagnoseRecord(record: Credential, now: number): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];

  // Enumerated rather than delegated to `assertValidCredential`, which stops at the first
  // duplicate and whose message names the offending field by its *label* — the user's own
  // text, which must not reach a report. A diagnosis needs every duplicate and needs the ids.
  for (const [fieldId, count] of duplicates(record.fields.custom.map((field) => field.id))) {
    issues.push(
      issueFor(
        'duplicate-custom-field-id',
        'field',
        fieldId,
        record.id,
        `${formatCount(count)} custom fields on this record share this id`
      )
    );
  }

  for (const [questionId, count] of duplicates(
    record.fields.securityQuestions.map((question) => question.id)
  )) {
    issues.push(
      issueFor(
        'duplicate-question-id',
        'question',
        questionId,
        record.id,
        `${formatCount(count)} security questions on this record share this id`
      )
    );
  }

  try {
    assertValidHistory(record);
  } catch {
    // The thrown message is deliberately dropped rather than cleaned. It interpolates the
    // snapshot key, the changed-field name and the version number straight out of the
    // document, and in a corrupt document each of those can be any bytes at all — including a
    // fragment of a decrypted note. Two shapes walked past the scrubber that used to stand
    // here; `history-detail.ts` records both and explains why the replacement composes a
    // sentence from safe values instead of trying to clean an unsafe one.
    issues.push(
      issueFor('invalid-history', 'record', record.id, record.id, describeHistoryViolation(record))
    );
  }

  if (issues.length === 0) {
    // Only asked when nothing above fired: `assertValidCredential` throws on the same
    // duplicates, and reporting both would make one problem look like two. What it adds is
    // the rest of its checks — over-length fields, an unknown custom-field type.
    try {
      assertValidCredential(record);
    } catch {
      // No message. `assertValidCredential` interpolates a custom field's *label* into its
      // over-length message, and a label is the user's own text.
      issues.push(issueFor('record-invalid', 'record', record.id, record.id, null));
    }
  }

  const ahead = futureTimestampFields(record, now);
  if (ahead.length > 0) {
    const days = Math.round(furthestAhead(record, now) / MILLISECONDS_PER_DAY);
    issues.push(
      issueFor(
        'future-timestamp',
        'record',
        record.id,
        record.id,
        `${ahead.join(', ')} — up to ${formatCount(days)} day(s) ahead`
      )
    );
  }

  return issues;
}

export function diagnoseDocument(
  document: VaultDocument,
  options: DocumentDiagnosisOptions
): DocumentDiagnosis {
  const { now } = options;
  const issues: DiagnosticIssue[] = [];

  if (document.documentVersion > VAULT_DOCUMENT_VERSION) {
    issues.push(
      issueFor(
        'document-version-unsupported',
        'document',
        null,
        null,
        `contents declare version ${formatCount(document.documentVersion)}, this build reads ${formatCount(VAULT_DOCUMENT_VERSION)}`
      )
    );
  }

  for (const [id, count] of duplicates(document.records.map((record) => record.id))) {
    issues.push(
      issueFor(
        'duplicate-record-id',
        'record',
        id,
        id,
        `${formatCount(count)} records share this id`
      )
    );
  }

  for (const record of document.records) issues.push(...diagnoseRecord(record, now));

  const organisation = checkOrganisation(document).map(toOrganisationFinding);

  const attachments =
    options.chunks === undefined
      ? null
      : auditAttachments(
          document,
          options.chunks.map((chunk) => chunk.id),
          new Map(options.chunks.map((chunk) => [chunk.id, chunk.byteLength]))
        );

  const counts: Record<DiagnosticSeverity, number> = { critical: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.severity] += 1;
  for (const finding of organisation) counts[finding.severity] += 1;
  for (const issue of attachments?.issues ?? []) {
    counts[ATTACHMENT_DIAGNOSTICS[issue.code].severity] += 1;
  }

  return {
    checkedAt: now,
    recordCount: document.records.length,
    trashedCount: document.records.filter((record) => record.trashedAt !== null).length,
    folderCount: document.folders.length,
    tagCount: document.tags.length,
    issues,
    organisation,
    attachments,
    counts,
    healthy: counts.critical === 0 && counts.warning === 0 && counts.info === 0,
  };
}
