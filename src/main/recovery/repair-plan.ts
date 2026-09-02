// SPDX-License-Identifier: GPL-3.0-or-later
import type { AttachmentIssueCode } from '@shared/model/attachment.js';
import type {
  DiagnosticCode,
  DocumentDiagnosis,
  RepairAction,
  RepairActionKind,
  RepairPlan,
  VaultFileInspection,
  VaultFileSurvey,
} from '@shared/model/recovery.js';

/**
 * Turns findings into an ordered list of **proposals**. It changes nothing, and there is no
 * function anywhere that takes a `RepairPlan` and executes it.
 *
 * ## Why a plan rather than a repair
 *
 * Every action below is one line of code. That is precisely why none of them runs
 * automatically. Corruption has causes — a crash mid-write, a merge that resolved badly, a
 * disk that is failing, a bug in this app — and every one of these repairs erases the
 * evidence of which. "This record's folder is missing" is a merge that dropped a folder, a
 * restore from a backup written before it existed, or an import that committed early; the
 * three want three different responses, and after a silent fix they are indistinguishable.
 *
 * It is also the only way an undo can mean anything. A user who was asked, and who was told
 * the price, can decide the price is too high.
 *
 * ## The order is the plan
 *
 * Preserve first, then read-only alternatives, then changes a person can walk back, then the
 * ones that lose something. Step 1 is always "copy everything aside", because every step
 * after it is safe only if that one happened. The steps are not independently reorderable and
 * the numbering says so.
 *
 * ## Honesty about what cannot be recovered
 *
 * `unrecoverable` exists so a plan cannot imply a salvage that does not exist. An
 * authentication failure has no partial credit: the bytes are wrong or the password is wrong,
 * AES-256-GCM returns the whole plaintext or nothing, and there is no brute force and no
 * "recover what we can" to offer. Saying so plainly is more useful than a hopeful progress
 * bar, and far more honest.
 */

export interface RepairPlanInput {
  readonly file?: VaultFileInspection | null | undefined;
  readonly survey?: VaultFileSurvey | null | undefined;
  readonly diagnosis?: DocumentDiagnosis | null | undefined;
}

/** The standing statement about authenticated encryption. Included in every plan. */
const AEAD_HAS_NO_PARTIAL_CREDIT =
  'If the vault reports an authentication failure, either the bytes are wrong or the password is wrong, and nothing in the file can say which. There is no partial decryption of an authenticated region: AES-256-GCM returns the whole plaintext or nothing at all. Keyhold does not offer a brute force or a "salvage what we can", because neither exists.';

const BODY_IS_GONE =
  'The missing part of the encrypted body cannot be reconstructed from this file. It is not a matter of trying harder — the bytes are not here, and the ones that are here will not authenticate without them. Another copy of the file is the only route.';

const HEADER_IS_GONE =
  'Without a readable header there are no key-derivation parameters and no wrapped data key. The correct master password cannot derive a key that the file does not describe. Another copy of the file is the only route.';

const CHUNK_TAIL_IS_GONE =
  'Attachments past the break are not in this file. The records before them are unaffected, but those attachment bytes exist only in another copy, if anywhere.';

const ATTACHMENT_BYTES_ARE_GONE =
  'The bytes of an attachment with no chunk are not in this vault. Detaching the metadata tidies the record; it does not bring the file back.';

interface Draft {
  readonly kind: RepairActionKind;
  readonly summary: string;
  readonly changes: string;
  readonly cannotRecover: string | null;
  readonly reversible: boolean;
  readonly requiresUnlock: boolean;
  readonly addresses: readonly string[];
  readonly subjects: readonly string[];
}

/** Distinct values, in first-seen order. Keeps a subject list stable between runs. */
function distinct(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export function planRepairs(input: RepairPlanInput): RepairPlan {
  const file = input.file ?? null;
  const survey = input.survey ?? null;
  const diagnosis = input.diagnosis ?? null;

  const fileCodes = new Set<DiagnosticCode>(file?.issues.map((issue) => issue.code) ?? []);
  const documentIssues = diagnosis?.issues ?? [];
  const documentCodes = new Set<DiagnosticCode>(documentIssues.map((issue) => issue.code));
  const organisationKinds = new Set(diagnosis?.organisation.map((finding) => finding.kind) ?? []);
  const attachmentIssues = diagnosis?.attachments?.issues ?? [];
  const attachmentCodes = new Set<AttachmentIssueCode>(attachmentIssues.map((issue) => issue.code));

  const recordsFor = (...codes: readonly DiagnosticCode[]): readonly string[] =>
    distinct(
      documentIssues
        .filter((issue) => codes.includes(issue.code))
        .map((issue) => issue.credentialId ?? issue.subjectId ?? '')
        .filter((id) => id !== '')
    );

  const organisationSubjects = (...kinds: readonly string[]): readonly string[] =>
    distinct(
      (diagnosis?.organisation ?? [])
        .filter((finding) => kinds.includes(finding.kind))
        .flatMap((finding) => [...finding.folderIds, ...finding.recordIds, ...finding.tagIds])
    );

  const chunksFor = (...codes: readonly AttachmentIssueCode[]): readonly string[] =>
    distinct(
      attachmentIssues.filter((issue) => codes.includes(issue.code)).map((issue) => issue.chunkId)
    );

  const drafts: Draft[] = [];

  // ── Read-only alternatives, before anything is touched ─────────────────────

  if (
    survey !== null &&
    survey.bestCandidate !== null &&
    (survey.bestCandidate !== survey.vaultName || file?.structurallyIntact === false)
  ) {
    drafts.push({
      kind: 'open-another-copy',
      summary: `Try ${survey.bestCandidate} before repairing anything — it ranks above the vault file.`,
      changes:
        'Nothing. Opening a copy is a read; the vault file is not touched and neither is the copy.',
      cannotRecover:
        'Anything saved after that copy was written is not in it. Compare the generation numbers in the survey before you let it replace the vault.',
      reversible: true,
      requiresUnlock: true,
      addresses: [...fileCodes],
      subjects: [survey.bestCandidate],
    });
  }

  if (survey !== null && survey.orphanedTempCount > 0) {
    drafts.push({
      kind: 'quarantine-orphaned-temp',
      summary: 'Move the interrupted-write file aside so it stops being mistaken for a stray.',
      changes:
        'Renames it to <vault>.recovered-<timestamp> in the same folder. Nothing is deleted, and its bytes are not read.',
      cannotRecover: null,
      reversible: true,
      requiresUnlock: false,
      addresses: [],
      subjects: survey.files
        .filter((surveyed) => surveyed.role === 'orphaned-temp')
        .map((surveyed) => surveyed.name),
    });
  }

  if (fileCodes.has('unsupported-version') || documentCodes.has('document-version-unsupported')) {
    drafts.push({
      kind: 'update-keyhold',
      summary: 'Update Keyhold. This file was written by a newer build.',
      changes:
        'Nothing about the vault. Do not save over it with this build — writing a format you do not fully understand is how fields get silently dropped.',
      cannotRecover: null,
      reversible: true,
      requiresUnlock: false,
      addresses: [
        ...(fileCodes.has('unsupported-version') ? ['unsupported-version'] : []),
        ...(documentCodes.has('document-version-unsupported')
          ? ['document-version-unsupported']
          : []),
      ],
      subjects: [],
    });
  }

  // ── Changes to the open vault ──────────────────────────────────────────────

  if (documentCodes.has('duplicate-record-id')) {
    drafts.push({
      kind: 'reassign-duplicate-record-ids',
      summary: 'Give each record sharing an id a fresh one.',
      changes:
        'Every record after the first keeper of an id gets a new id, so each becomes addressable on its own instead of one shadowing the other.',
      cannotRecover:
        'Which record any external reference meant — an attachment, a history entry, a bookmark in another tool. Once two records share an id, nothing distinguishes what pointed at which.',
      reversible: false,
      requiresUnlock: true,
      addresses: ['duplicate-record-id'],
      subjects: recordsFor('duplicate-record-id'),
    });
  }

  if (
    documentCodes.has('duplicate-custom-field-id') ||
    documentCodes.has('duplicate-question-id')
  ) {
    drafts.push({
      kind: 'reassign-duplicate-field-ids',
      summary: 'Give each duplicated field or question id a fresh one.',
      changes:
        'The second and later fields sharing an id are renumbered, so revealing one stops returning the other’s value. Values themselves are untouched.',
      cannotRecover:
        'Which field each history snapshot referred to. A version that recorded "the field with this id changed" can no longer say which of the two it meant.',
      reversible: false,
      requiresUnlock: true,
      addresses: ['duplicate-custom-field-id', 'duplicate-question-id'].filter((code) =>
        documentCodes.has(code as DiagnosticCode)
      ),
      subjects: recordsFor('duplicate-custom-field-id', 'duplicate-question-id'),
    });
  }

  if (organisationKinds.has('record-missing-tag')) {
    drafts.push({
      kind: 'create-missing-tag-entries',
      summary: 'Declare the tags records are already using.',
      changes:
        'Adds a Tag entry for each tag name records carry with none, so it gets a colour and a row in the sidebar. No record changes.',
      cannotRecover: 'The colour the tag had before, if it ever had one.',
      reversible: true,
      requiresUnlock: true,
      addresses: ['record-missing-tag'],
      subjects: organisationSubjects('record-missing-tag'),
    });
  }

  if (organisationKinds.has('folder-cycle') || organisationKinds.has('folder-missing-parent')) {
    drafts.push({
      kind: 'reparent-broken-folders',
      summary: 'Move unreachable folders back to the root.',
      changes:
        'Sets parentId to null on the folders in a loop or pointing at a parent that is gone, so they and everything under them appear in the sidebar again.',
      cannotRecover:
        'Where they were meant to sit. The folder that would say is either missing or is itself part of the loop.',
      reversible: true,
      requiresUnlock: true,
      addresses: ['folder-cycle', 'folder-missing-parent'].filter((kind) =>
        organisationKinds.has(kind)
      ),
      subjects: organisationSubjects('folder-cycle', 'folder-missing-parent'),
    });
  }

  if (
    organisationKinds.has('record-missing-folder') ||
    organisationKinds.has('import-placeholder-folder')
  ) {
    drafts.push({
      kind: 'clear-missing-folder-references',
      summary: 'Un-file records whose folder does not exist.',
      changes:
        'Sets folderId to null on the affected records, so they show at the top level instead of showing nowhere at all.',
      cannotRecover:
        'Which folder they were filed under. Only the missing folder knew, and the id alone does not name it.',
      reversible: false,
      requiresUnlock: true,
      addresses: ['record-missing-folder', 'import-placeholder-folder'].filter((kind) =>
        organisationKinds.has(kind)
      ),
      subjects: organisationSubjects('record-missing-folder', 'import-placeholder-folder'),
    });
  }

  if (attachmentCodes.has('size-mismatch')) {
    drafts.push({
      kind: 'correct-attachment-sizes',
      summary: 'Make the recorded attachment size match the chunk.',
      changes:
        'Rewrites the size in the metadata to the chunk’s real length. The bytes are not touched. Note what the disagreement means: the metadata and the bytes came from different writes, so verify the recorded SHA-256 against the chunk before trusting either half.',
      cannotRecover: null,
      reversible: false,
      requiresUnlock: true,
      addresses: ['size-mismatch'],
      subjects: chunksFor('size-mismatch'),
    });
  }

  if (documentCodes.has('future-timestamp')) {
    drafts.push({
      kind: 'correct-future-timestamps',
      summary: 'Bring timestamps later than now back to now.',
      changes:
        'Clamps created, updated, password-updated, last-used, trashed and version times that are in the future, so sorting, password age and trash retention start behaving.',
      cannotRecover:
        'The real time each change happened. A device with a wrong clock did not record it anywhere.',
      reversible: false,
      requiresUnlock: true,
      addresses: ['future-timestamp'],
      subjects: recordsFor('future-timestamp'),
    });
  }

  // ── Changes that lose something ────────────────────────────────────────────

  if (documentCodes.has('invalid-history')) {
    drafts.push({
      kind: 'clear-invalid-history',
      summary: 'Empty the version array on records whose history breaks its own rules.',
      changes:
        'Removes every version from the affected records. The records themselves — the current title, password, notes and fields — are untouched.',
      cannotRecover:
        'Every previous value of those records. Old passwords, old notes, old security answers: the timeline is the only place they exist, and it is being deleted.',
      reversible: false,
      requiresUnlock: true,
      addresses: ['invalid-history'],
      subjects: recordsFor('invalid-history'),
    });
  }

  if (attachmentCodes.has('missing-chunk')) {
    drafts.push({
      kind: 'detach-missing-attachments',
      summary: 'Remove metadata for attachments whose bytes are not in this file.',
      changes:
        'The record stops advertising a file nobody can open. No bytes are removed, because there are none to remove.',
      cannotRecover:
        'The file itself, and also its name and digest — which are exactly what would let you recognise it inside a backup. Search the backups before doing this, not after.',
      reversible: false,
      requiresUnlock: true,
      addresses: ['missing-chunk'],
      subjects: chunksFor('missing-chunk'),
    });
  }

  if (attachmentCodes.has('unreferenced-chunk')) {
    drafts.push({
      kind: 'remove-unreferenced-chunks',
      summary: 'Drop attachment chunks nothing points at. Last, and only if the space matters.',
      changes: 'Removes the chunks and reclaims their space in the file.',
      cannotRecover:
        'The files themselves. A chunk with no metadata may still be the only copy of something whose metadata is sitting in a backup — which is why this is last and why the backups come first.',
      reversible: false,
      requiresUnlock: true,
      addresses: ['unreferenced-chunk'],
      subjects: chunksFor('unreferenced-chunk'),
    });
  }

  // ── Step 1, added only when there is a step 2 ──────────────────────────────

  if (drafts.length > 0) {
    drafts.unshift({
      kind: 'copy-everything-aside',
      summary: 'Copy the whole folder somewhere else before doing anything at all.',
      changes:
        'Nothing in place. It makes a second copy of every file listed in the survey — the vault, the backups, and the temp file — so that every step below can be undone by putting them back.',
      cannotRecover: null,
      reversible: true,
      requiresUnlock: false,
      addresses: [],
      subjects: survey?.files.map((surveyed) => surveyed.name) ?? [],
    });
  }

  const actions: RepairAction[] = drafts.map((draft, index) => ({ ...draft, step: index + 1 }));

  const unrecoverable: string[] = [AEAD_HAS_NO_PARTIAL_CREDIT];
  if (fileCodes.has('body-truncated') || fileCodes.has('body-length-implausible')) {
    unrecoverable.push(BODY_IS_GONE);
  }
  if (fileCodes.has('header-truncated') || fileCodes.has('header-unreadable')) {
    unrecoverable.push(HEADER_IS_GONE);
  }
  if (fileCodes.has('chunk-framing-broken') || fileCodes.has('chunk-count-disagreement')) {
    unrecoverable.push(CHUNK_TAIL_IS_GONE);
  }
  if (attachmentCodes.has('missing-chunk')) unrecoverable.push(ATTACHMENT_BYTES_ARE_GONE);

  return { actions, unrecoverable, clean: actions.length === 0 };
}
