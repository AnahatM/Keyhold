// SPDX-License-Identifier: GPL-3.0-or-later
import type { AttachmentAudit, AttachmentIssueCode } from './attachment.js';

/**
 * The shapes vault diagnostics produce: what was inspected, what was found, and what is
 * *proposed* about it.
 *
 * Lives in `@shared` for the same reason `health.ts` does — the renderer draws the
 * diagnostics screen, so it needs the codes to label them and the report shape to render
 * it. **Types and declarative constants only. No logic, and no Node imports.** The analysis
 * itself runs in `src/main/recovery/`, which is the only side that may hold a decrypted
 * document or a file's bytes.
 *
 * ## Nothing here ever repairs anything
 *
 * Every type in this file describes an observation or a proposal. There is no "apply" shape
 * and there is deliberately no function that takes a `RepairPlan` and executes it. Corruption
 * has causes — a crash mid-write, a bad merge, a failing disk, a bug in this app — and a
 * repair destroys the evidence of which one it was. So the module reports, the UI offers, and
 * the user chooses. That is the same rule `src/main/organisation/integrity.ts` and
 * `src/main/attachments/audit.ts` already follow, and this module is the third instance of it
 * rather than an exception to it.
 *
 * ## What a report may contain
 *
 * A diagnostic report is written to be pasted into a bug report. It is therefore bound by a
 * rule *stricter* than the safe projection's: **ids, counts, byte offsets and timestamps
 * only — never a user-authored string.** Not a password, not a note, not an attachment byte,
 * and also not a record title, not a folder name, not a tag name, and no filename beyond a
 * basename. The safe projection carries titles because the renderer must draw them; a report
 * carries them because someone forgot, and then a titled list of accounts lands in a public
 * issue tracker.
 *
 * `src/main/recovery/report.test.ts` enforces this with a property test that plants a marker
 * in every secret *and* in every name, title and directory path of its fixture, and asserts
 * that none of them survives serialisation.
 *
 * ## Why organisation and attachment findings ride along rather than being restated
 *
 * `checkOrganisation` already answers "are the folders and tags coherent?" and
 * `auditAttachments` already answers "does the metadata agree with the chunks?". Re-deriving
 * either here would be a second list of the same findings, which drift apart within a month
 * (hard rule 8). So `DocumentDiagnosis` carries their output rather than a copy of it:
 * `attachments` is the existing `AttachmentAudit` verbatim, and `organisation` is the
 * existing issue with its severity resolved and its `name` field dropped — see
 * `OrganisationFinding`.
 */

// ── Severity ─────────────────────────────────────────────────────────────────

/** Loudest first. The order is the sort order a report renders in. */
export const DIAGNOSTIC_SEVERITIES = ['critical', 'warning', 'info'] as const;
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

// ── Codes ────────────────────────────────────────────────────────────────────

/**
 * Findings `inspectVaultFile` can produce, in the order the bytes are read.
 *
 * Every one of these is reachable without the master password, which is the point: a user
 * whose vault will not open needs to be told *where* it stops being readable before they are
 * asked to type anything.
 */
export const FILE_DIAGNOSTIC_CODES = [
  'file-empty',
  'file-too-short',
  'not-a-vault',
  'invalid-version',
  'unsupported-version',
  'version-disagreement',
  'header-truncated',
  'header-unreadable',
  'kdf-out-of-range',
  'body-length-implausible',
  'body-truncated',
  'chunk-count-truncated',
  'chunk-framing-broken',
  'chunk-count-disagreement',
  'trailing-bytes',
] as const;

/**
 * Findings `diagnoseDocument` produces from a decrypted document.
 *
 * Deliberately short: folder, tag and attachment coherence are not here because they are
 * already owned elsewhere. What remains is what nothing else checks.
 */
export const DOCUMENT_DIAGNOSTIC_CODES = [
  'document-version-unsupported',
  'duplicate-record-id',
  'duplicate-custom-field-id',
  'duplicate-question-id',
  'invalid-history',
  'record-invalid',
  'future-timestamp',
] as const;

export const DIAGNOSTIC_CODES = [...FILE_DIAGNOSTIC_CODES, ...DOCUMENT_DIAGNOSTIC_CODES] as const;

export type FileDiagnosticCode = (typeof FILE_DIAGNOSTIC_CODES)[number];
export type DocumentDiagnosticCode = (typeof DOCUMENT_DIAGNOSTIC_CODES)[number];
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

/**
 * What a code means, in the words the report will use.
 *
 * `title` is the finding; `meaning` is what it most likely says about *what happened*, which
 * is the whole reason this module exists. "Could not open file" is useless. "The header is
 * intact but the body is truncated" tells the user their disk filled up mid-save and points
 * them at a backup.
 */
export interface DiagnosticDefinition {
  readonly severity: DiagnosticSeverity;
  readonly title: string;
  readonly meaning: string;
}

/**
 * Every code's severity and prose, in one table.
 *
 * A `Record` over the union rather than a lookup with a fallback: adding a code without
 * writing down what it means is then a type error, not a report that says `undefined`.
 */
export const DIAGNOSTICS: Readonly<Record<DiagnosticCode, DiagnosticDefinition>> = {
  'file-empty': {
    severity: 'critical',
    title: 'The file is empty',
    meaning:
      'Zero bytes. Either nothing was ever written here, or a write was interrupted before any data reached the disk. The vault contents are not in this file and cannot be taken out of it.',
  },
  'file-too-short': {
    severity: 'critical',
    title: 'The file is shorter than a KEEP signature',
    meaning:
      'A KEEP file begins with an 8-byte signature and a fixed preamble. A file smaller than that was truncated almost immediately, or is not a vault at all.',
  },
  'not-a-vault': {
    severity: 'critical',
    title: 'This is not a KEEP file',
    meaning:
      'The first eight bytes are not the KEEP signature. Either this is a different kind of file, or the beginning of the vault was overwritten.',
  },
  'invalid-version': {
    severity: 'critical',
    title: 'The format version is not a valid one',
    meaning:
      'The preamble declares a version below 1, which no Keyhold has ever written. The preamble has been overwritten.',
  },
  'unsupported-version': {
    severity: 'warning',
    title: 'Written by a newer Keyhold',
    meaning:
      'The file declares a format version this build does not understand. Nothing is wrong with the file — this build simply must not guess at a layout it does not know. Update Keyhold and open it again.',
  },
  'version-disagreement': {
    severity: 'critical',
    title: 'The preamble and the header disagree about the version',
    meaning:
      'The version is stored twice by design, once in the binary preamble and once in the authenticated header, so that editing one is detectable. They disagree, so the preamble was edited after the file was written.',
  },
  'header-truncated': {
    severity: 'critical',
    title: 'The header is cut short',
    meaning:
      'The file declares a header longer than the bytes that follow it. The file was truncated while, or shortly after, the header was written — so almost nothing of the vault is present.',
  },
  'header-unreadable': {
    severity: 'critical',
    title: 'The header will not parse',
    meaning:
      'The header bytes are present but are not the JSON a KEEP header must be, or a field is missing or the wrong type. Without a readable header there are no key-derivation parameters, so the file cannot be unlocked even with the correct password.',
  },
  'kdf-out-of-range': {
    severity: 'critical',
    title: 'The key-derivation settings are outside the accepted range',
    meaning:
      'The header asks for Argon2 parameters below the safety floor or above the ceiling. A file asking for less is a downgrade; a file asking for more turns opening it into a denial of service. Either way the parameters are refused before anything runs.',
  },
  'body-length-implausible': {
    severity: 'critical',
    title: 'The declared body length cannot be right',
    meaning:
      'The body length field names a size below the minimum a sealed region can be, or above the safety ceiling. The four bytes holding that length were corrupted, or the file is not laid out the way its header claims.',
  },
  'body-truncated': {
    severity: 'critical',
    title: 'The body is truncated',
    meaning:
      'The header is intact and says how long the encrypted body is, and the file ends before that. This is the signature of an interrupted write — a crash, a full disk, or a cloud client that synchronised half a file. The missing bytes are not recoverable from this file: an authenticated region decrypts whole or not at all.',
  },
  'chunk-count-truncated': {
    severity: 'warning',
    title: 'The attachment count is missing',
    meaning:
      'The body is complete but the file ends before the attachment count. The records are probably intact; any attachments are not in this file.',
  },
  'chunk-framing-broken': {
    severity: 'warning',
    title: 'An attachment chunk is not framed correctly',
    meaning:
      'A chunk declares a length that does not fit in the bytes that remain, or one that cannot be right. The tail of the file was truncated or overwritten. The records are unaffected; the attachments after this point are not in this file.',
  },
  'chunk-count-disagreement': {
    severity: 'warning',
    title: 'The header and the file disagree about how many attachments there are',
    meaning:
      'The header records an attachment count and a different number of chunks is present. This is exactly how a silently truncated tail is caught — the records may be perfectly readable while an attachment has quietly vanished.',
  },
  'trailing-bytes': {
    severity: 'warning',
    title: 'There are bytes after the end of the container',
    meaning:
      'A KEEP file ends with its last attachment chunk. Extra bytes usually mean two files were concatenated, or that a longer file was partially overwritten by a shorter one. The container itself still reads.',
  },

  'document-version-unsupported': {
    severity: 'critical',
    title: 'The contents use a newer document version',
    meaning:
      'The decrypted contents declare a document version this build does not understand. Saving over it with today’s rules would silently discard whatever fields this build does not know about, which is data loss. Update Keyhold.',
  },
  'duplicate-record-id': {
    severity: 'critical',
    title: 'Two records share an id',
    meaning:
      'Records are addressed by id everywhere — reveal, update, trash, history. With two claiming one id, an edit lands on whichever is found first and the other silently goes stale. Almost always the result of a merge that did not deduplicate.',
  },
  'duplicate-custom-field-id': {
    severity: 'critical',
    title: 'Two custom fields on one record share an id',
    meaning:
      'The reveal path addresses fields by id, so a duplicate hands back the *wrong* value: asking for one field returns the other’s secret. This is a correctness bug with a security shape, and it is why it outranks everything else about a record.',
  },
  'duplicate-question-id': {
    severity: 'critical',
    title: 'Two security questions on one record share an id',
    meaning:
      'Security answers are revealed by question id, exactly as custom fields are. A duplicate returns the wrong answer for the question that was asked.',
  },
  'invalid-history': {
    severity: 'warning',
    title: 'A record’s history breaks its own invariants',
    meaning:
      'Version numbers must strictly ascend, and a version may not snapshot a field it does not list as changed. A violation means the file is corrupt, was merged wrongly, or was written by a build with a bug — and a restore from that timeline could write values the diff never showed.',
  },
  'record-invalid': {
    severity: 'warning',
    title: 'A record would be rejected by the record validator',
    meaning:
      'The record fails a check that every create and update enforces — an over-length field, an unknown custom-field type, or a structural rule. The reason is deliberately not quoted here, because the validator’s message names the offending field by its label and a label is the user’s own text.',
  },
  'future-timestamp': {
    severity: 'warning',
    title: 'A timestamp is in the future',
    meaning:
      'A created, updated, used or trashed time later than now. Usually a device with a wrong clock, occasionally a merge that took a timestamp from one. It quietly breaks sorting, the password-age rule, and trash retention, none of which will look broken.',
  },
};

/**
 * Severity and prose for the attachment audit's codes.
 *
 * Keyed by `AttachmentIssueCode` so the list of codes stays owned by
 * `@shared/model/attachment.ts` — a code added there without an entry here is a type error.
 * The prose lives here rather than there because it is report copy, and `attachment.ts` is
 * the model.
 */
export const ATTACHMENT_DIAGNOSTICS: Readonly<Record<AttachmentIssueCode, DiagnosticDefinition>> = {
  'missing-chunk': {
    severity: 'warning',
    title: 'An attachment’s bytes are not in this file',
    meaning:
      'A record advertises an attachment and the chunk it names is not in the container. A partial restore from a backup written before the file was attached, or a merge that took the record but not the chunk. The record looks fine until someone tries to open the file.',
  },
  'unreferenced-chunk': {
    severity: 'info',
    title: 'A chunk nothing points at',
    meaning:
      'Encrypted bytes in the file that no record’s metadata claims. Costs space and nothing else — but it may be the only copy of a file whose metadata is recoverable from a backup, which is why it is never removed automatically.',
  },
  'size-mismatch': {
    severity: 'warning',
    title: 'The recorded size does not match the chunk',
    meaning:
      'The chunk decrypted and authenticated, so the bytes are the bytes that were written; the metadata simply records a different length. The two halves came from different writes, which is worth knowing before trusting either.',
  },
  'duplicate-id': {
    severity: 'critical',
    title: 'Two attachments on one record share a chunk id',
    meaning:
      'Attachments are addressed by chunk id, so a duplicate makes "open this one" ambiguous and detaching one can take the other’s bytes with it.',
  },
};

// ── One finding ──────────────────────────────────────────────────────────────

/** What a finding is *about*. Chosen so a UI can link to the thing. */
export const DIAGNOSTIC_SUBJECT_KINDS = [
  'file',
  'document',
  'record',
  'field',
  'question',
  'version',
] as const;
export type DiagnosticSubjectKind = (typeof DIAGNOSTIC_SUBJECT_KINDS)[number];

/**
 * One finding.
 *
 * Flat rather than nested, so the report can sort and group without a walk, and so the
 * property test has one shape to sweep. **`detail` carries ids, counts and byte offsets and
 * nothing else** — see the file header.
 */
export interface DiagnosticIssue {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly subject: DiagnosticSubjectKind;
  /** The subject's id. `null` for a file- or document-level finding, which has none. */
  readonly subjectId: string | null;
  /** The record the subject hangs off, when the subject is nested inside one. */
  readonly credentialId: string | null;
  /** Ids, counts and byte offsets only. Never a name, a title, a label, or a value. */
  readonly detail: string | null;
}

// ── File inspection ──────────────────────────────────────────────────────────

/**
 * The stages of reading a KEEP container, in order.
 *
 * `inspectVaultFile` reports the last one that completed, which is what turns "could not
 * open file" into "the header is intact but the body is truncated".
 */
export const INSPECTION_STAGES = [
  'magic',
  'format-version',
  'header-length',
  'header-bytes',
  'header-json',
  'body-length',
  'body-bytes',
  'chunk-count',
  'chunk-framing',
  'complete',
] as const;
export type InspectionStage = (typeof INSPECTION_STAGES)[number];

/**
 * The KDF parameters, minus the salt.
 *
 * The salt is not secret in the cryptographic sense — it is plaintext in a file anyone
 * holding the file can read — but it is key material, and key material has no business in a
 * document written to be shared. The length is reported instead, because "the salt is 4 bytes
 * when it must be at least 16" is a real finding.
 */
export interface KdfSummary {
  readonly memoryKib: number;
  readonly iterations: number;
  readonly parallelism: number;
  readonly saltBytes: number;
}

/** The header as a report may repeat it: no salt, no wrapped key, only their sizes. */
export interface HeaderSummary {
  readonly formatVersion: number;
  readonly vaultId: string;
  readonly deviceId: string;
  readonly cipher: string;
  readonly kdf: KdfSummary;
  /** Byte lengths of the wrapped data key's parts. Never the bytes. */
  readonly wrappedDekBytes: {
    readonly nonce: number;
    readonly ciphertext: number;
    readonly tag: number;
  };
  readonly createdAt: number;
  readonly modifiedAt: number;
  readonly generation: number;
  readonly recordCount: number;
  readonly attachmentCount: number;
}

/** One attachment chunk, as the framing walk saw it. */
export interface ChunkFraming {
  readonly index: number;
  /** 32 lowercase hex characters, or `null` when the id itself was cut off. */
  readonly id: string | null;
  readonly idOffset: number;
  /** What the length field claimed. `null` when the length field was cut off. */
  readonly declaredLength: number | null;
  /** True when the declared bytes are all present in the file. */
  readonly present: boolean;
  readonly availableBytes: number;
}

/** Where each part of the container begins, as actually read. */
export interface ContainerLayout {
  readonly headerOffset: number;
  readonly headerLength: number;
  readonly bodyLengthOffset: number;
  readonly declaredBodyLength: number | null;
  /** Start of the body's nonce. `null` when the body length was never read. */
  readonly bodyOffset: number | null;
  readonly chunkCountOffset: number | null;
  readonly declaredChunkCount: number | null;
  /** Bytes after the last structure that parsed. 0 for a well-formed file. */
  readonly trailingBytes: number;
}

/** Exactly where the file stopped being readable, and what that most likely means. */
export interface InspectionStop {
  readonly stage: InspectionStage;
  /** Byte offset at which reading stopped. */
  readonly offset: number;
  /** How many bytes the file said were there. `null` when nothing declared a length. */
  readonly expectedBytes: number | null;
  /** How many were actually available from `offset`. */
  readonly availableBytes: number;
  /** One sentence naming what happened, with the numbers in it. */
  readonly meaning: string;
}

export interface VaultFileInspection {
  readonly sizeBytes: number;
  /** The last stage that completed. `null` when even the signature could not be read. */
  readonly reachedStage: InspectionStage | null;
  /** `null` when the whole container is structurally coherent. */
  readonly stoppedAt: InspectionStop | null;
  readonly header: HeaderSummary | null;
  readonly layout: ContainerLayout | null;
  readonly chunks: readonly ChunkFraming[];
  readonly issues: readonly DiagnosticIssue[];
  /** Every structural check passed. Says nothing at all about whether it will decrypt. */
  readonly structurallyIntact: boolean;
  /** The honest one-line summary, including what this cannot tell you. */
  readonly verdict: string;
}

// ── The file survey ──────────────────────────────────────────────────────────

/**
 * What a file next to the vault is.
 *
 * `quarantined-temp` is a temp file that has already been renamed aside by
 * `quarantineOrphanedTemp`. It is listed because it is still a candidate copy — quarantine
 * moves a file out of the way, it does not decide the file was worthless.
 */
export const SURVEYED_FILE_ROLES = [
  'vault',
  'backup',
  'legacy-backup',
  'orphaned-temp',
  'quarantined-temp',
  'other-vault',
] as const;
export type SurveyedFileRole = (typeof SURVEYED_FILE_ROLES)[number];

/** How much of a file could be read without the password. */
export const FILE_HEADER_STATES = ['intact', 'damaged', 'unknown'] as const;
export type FileHeaderState = (typeof FILE_HEADER_STATES)[number];

/**
 * One candidate copy.
 *
 * **`name` is a basename and there is no path field.** The caller supplied the directory
 * listing, so it can rejoin on the name; the survey deliberately cannot leak a directory into
 * a report, because a home directory is a person's real name often enough to matter.
 */
export interface SurveyedFile {
  readonly name: string;
  readonly role: SurveyedFileRole;
  /** `N` from `vault.keep.bak.N`. `null` for everything else. */
  readonly backupIndex: number | null;
  readonly sizeBytes: number;
  readonly modifiedAt: number;
  /** From the header, when it could be read. The single best ranking signal there is. */
  readonly generation: number | null;
  readonly headerState: FileHeaderState;
  /** Whether the whole container framing checked out. `null` when the bytes were not supplied. */
  readonly structurallyIntact: boolean | null;
  /** 1 is the most likely to be the best copy. */
  readonly rank: number;
  /** Why it sits where it does, in one line. */
  readonly ranking: string;
  /** A standing caveat about this kind of file. Currently only the temp-file rule. */
  readonly note: string | null;
}

export interface VaultFileSurvey {
  /** Basename of the vault the survey is about. */
  readonly vaultName: string;
  readonly vaultPresent: boolean;
  /** Rank order: most likely to be the best copy first. */
  readonly files: readonly SurveyedFile[];
  /** The basename of the highest-ranked file, or `null` when there are no candidates. */
  readonly bestCandidate: string | null;
  readonly backupCount: number;
  readonly orphanedTempCount: number;
}

// ── Document diagnosis ───────────────────────────────────────────────────────

/**
 * One organisation finding, as a report carries it.
 *
 * This is `OrganisationIssue` from `src/main/organisation/integrity.ts` with its severity
 * resolved and **its `name` field dropped**. That module puts the colliding folder or tag
 * name in a dedicated field precisely so each caller can decide; a report written to be
 * pasted into an issue tracker decides not to.
 *
 * `kind` is `string` rather than the union because `@shared` must not import from `@main`.
 * The list is owned by `integrity.ts`; `document-diagnosis.ts` holds a compile-time proof
 * that every kind there has a severity here.
 */
export interface OrganisationFinding {
  readonly kind: string;
  readonly severity: DiagnosticSeverity;
  /** Content-free by that module's own rule: ids and counts, never what anything is called. */
  readonly message: string;
  readonly folderIds: readonly string[];
  readonly recordIds: readonly string[];
  readonly tagIds: readonly string[];
}

/** A chunk the container actually holds, as the diagnosis needs to see it. */
export interface ChunkPresence {
  readonly id: string;
  /** Decrypted length, so a disagreement with the recorded size is detectable. */
  readonly byteLength: number;
}

export interface DocumentDiagnosis {
  /** The `now` the caller supplied. The diagnosis is a pure function of the document and it. */
  readonly checkedAt: number;
  readonly recordCount: number;
  readonly trashedCount: number;
  readonly folderCount: number;
  readonly tagCount: number;
  /** Record-level findings this module owns. */
  readonly issues: readonly DiagnosticIssue[];
  /** From `checkOrganisation`. Folders and tags are not re-derived here. */
  readonly organisation: readonly OrganisationFinding[];
  /** From `auditAttachments`. `null` when the caller did not supply the chunk list. */
  readonly attachments: AttachmentAudit | null;
  readonly counts: Readonly<Record<DiagnosticSeverity, number>>;
  readonly healthy: boolean;
}

// ── The repair plan ──────────────────────────────────────────────────────────

/**
 * The proposals a plan can contain.
 *
 * Ordered here the way a plan orders them: preserve first, then read-only alternatives, then
 * changes that a backup can undo, then the ones that lose something.
 */
export const REPAIR_ACTION_KINDS = [
  'copy-everything-aside',
  'open-another-copy',
  'quarantine-orphaned-temp',
  'update-keyhold',
  'reassign-duplicate-record-ids',
  'reassign-duplicate-field-ids',
  'create-missing-tag-entries',
  'reparent-broken-folders',
  'clear-missing-folder-references',
  'correct-attachment-sizes',
  'correct-future-timestamps',
  'clear-invalid-history',
  'detach-missing-attachments',
  'remove-unreferenced-chunks',
] as const;
export type RepairActionKind = (typeof REPAIR_ACTION_KINDS)[number];

/**
 * One proposed step. **Nothing in this codebase executes one.**
 *
 * `cannotRecover` is not decoration. Every action that changes a vault buys something at a
 * price, and a user agreeing to a repair without being told the price has not agreed to
 * anything. Where an action costs nothing, this is `null` and says so by being absent.
 */
export interface RepairAction {
  readonly kind: RepairActionKind;
  /** 1-based. The order is the plan; steps are not independently reorderable. */
  readonly step: number;
  readonly summary: string;
  readonly changes: string;
  /** What this action cannot bring back. `null` only when it genuinely loses nothing. */
  readonly cannotRecover: string | null;
  /**
   * True when the action can be undone from inside the app afterwards — delete the tag,
   * move the folder back, rename the file back.
   *
   * Deliberately **not** "can be undone from the copy step 1 proposes", which would be true
   * of everything and would therefore say nothing. False here means the copy is the only way
   * back, which is exactly the thing a user needs to know before they agree.
   */
  readonly reversible: boolean;
  /** True when it needs the vault open, and therefore the master password. */
  readonly requiresUnlock: boolean;
  /** Which findings it addresses. Ids and codes only. */
  readonly addresses: readonly string[];
  /** The record ids, chunk ids or basenames it applies to. */
  readonly subjects: readonly string[];
}

export interface RepairPlan {
  readonly actions: readonly RepairAction[];
  /**
   * What no action can undo, stated plainly.
   *
   * This exists so the plan cannot imply a salvage that does not exist. An AEAD failure has
   * no partial credit: the bytes are wrong or the password is wrong, and there is no
   * brute-force and no "recover what we can" to offer.
   */
  readonly unrecoverable: readonly string[];
  readonly clean: boolean;
}

// ── The report ───────────────────────────────────────────────────────────────

/** Which analysis a finding came from, so a reader knows what it was looking at. */
export const FINDING_SOURCES = ['file', 'document', 'organisation', 'attachments'] as const;
export type FindingSource = (typeof FINDING_SOURCES)[number];

/** One finding, flattened for presentation. Every source renders through this shape. */
export interface ReportFinding {
  readonly source: FindingSource;
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly title: string;
  readonly meaning: string;
  readonly detail: string | null;
  /** Ids and basenames the finding is about. */
  readonly subjects: readonly string[];
}

/**
 * The shareable artefact: what was checked, what was found, what to do.
 *
 * Serialising this must never produce a secret, a name, a title or a directory — that is the
 * property `report.test.ts` proves, and it is the reason this is a separate shape rather than
 * the analysis results handed over as they are.
 */
export interface RecoveryReport {
  readonly generatedAt: number;
  /** Basename only, and `null` when the caller did not name a file. */
  readonly vaultName: string | null;
  /** What was inspected, in plain words. Derived from which analyses actually ran. */
  readonly checked: readonly string[];
  readonly file: VaultFileInspection | null;
  readonly survey: VaultFileSurvey | null;
  readonly diagnosis: DocumentDiagnosis | null;
  /** Every finding from every source, severity-ordered. */
  readonly findings: readonly ReportFinding[];
  readonly plan: RepairPlan;
}
