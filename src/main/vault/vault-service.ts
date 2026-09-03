// SPDX-License-Identifier: GPL-3.0-or-later
import { basename } from 'node:path';
import type {
  AttachmentChunk,
  KdfParams,
  KeepHeader,
  VaultContents,
} from '@shared/format/types.js';
import {
  isCustomFieldValueSecret,
  type AuditPrivacyLevel,
  type ChangeOrigin,
  type Credential,
  type CredentialProjection,
  type HistoryAction,
  type SecretRef,
  type VersionedField,
} from '@shared/model/credential.js';
import type { AttachmentAddView, AttachmentAudit } from '@shared/model/attachment.js';
import type { FieldDiffProjection } from '@shared/model/history.js';
import type { HealthAnalysisOptions, VaultHealthReport } from '@shared/model/health.js';
import type { Folder, Tag } from '@shared/model/vault-document.js';
import {
  DEFAULT_VAULT_HEALTH_SETTINGS,
  emptyVaultDocument,
  VAULT_DOCUMENT_VERSION,
  type VaultDocument,
  type VaultLockedInfo,
  type VaultSettings,
  type VaultSummary,
} from '@shared/model/vault-document.js';
import { malformed, VaultError } from '../crypto/errors.js';
import { createVaultKeys, unlock as unlockKeys, type DeriveKeyFn } from '../crypto/envelope.js';
import { calibrateKdf, newKdfParams } from '../crypto/kdf.js';
import { uuid } from '../crypto/random.js';
import { SecretBytes } from '../crypto/secret.js';
import { readContainer, readPreamble, writeContainer } from '../format/container.js';
import { newHeader } from '../format/header.js';
import {
  appendVersion,
  assertValidHistory,
  comparePoints,
  diffVersion,
  resolveState,
  restoreField,
  restoreVersion,
  type FieldDiff,
  type HistoryPoint,
  type RestoreResult,
} from '../history/versioning.js';
import { findOrphanedTemp, readVaultFile, writeVaultFileAtomically } from './atomic-write.js';
import {
  addCredential,
  applyPatch,
  buildCredential,
  duplicateCredential,
  findCredential,
  purgeCredential,
  purgeExpiredTrash,
  recordUse,
  replaceCredential,
  restoreCredential,
  trashCredential,
  type CredentialPatch,
  type NewCredentialInput,
  type OpsContext,
} from './credential-ops.js';
import {
  assertAttachmentIntegrity,
  auditAttachments,
  pruneUnreferencedChunks,
} from '../attachments/audit.js';
import {
  addAttachmentToDocument,
  removeAttachment,
  toContainerChunk,
} from '../attachments/store.js';
import {
  createFolder,
  deleteFolder,
  moveFolder,
  renameFolder,
  type FolderDeletePolicy,
  type NewFolderInput,
} from '../organisation/folder-ops.js';
import {
  createTag,
  deleteTag,
  renameTag,
  setTagColour,
  type NewTagInput,
} from '../organisation/tag-ops.js';
import { chunkIdsOrphanedBy } from '../attachments/references.js';
import { analyseVault } from '../health/rules.js';
import { toDiffProjection } from '../history/diff-projection.js';
import { toProjection, toProjections } from './projection.js';
import { SecretBroker } from './secret-broker.js';

/**
 * Owns the open vault. **The only place decrypted records exist.**
 *
 * Everything about this class is shaped by decision D13: the renderer may ask it
 * questions, and it answers with projections (§`listProjections`) or with one secret at a
 * time through the broker. It never hands over the document, and there is no method that
 * could be made to.
 *
 * Lifecycle:
 *
 *     locked ──create/unlock──► unlocked ──save──► unlocked
 *        ▲                          │
 *        └──────── lock ────────────┘   (keys zeroed, grants revoked, document dropped)
 *
 * Locking is not a UI state. It destroys the DEK, clears the document reference, and
 * revokes every outstanding secret grant — so a lock that the user asked for is a lock
 * that actually happened.
 */

export type VaultState = 'closed' | 'locked' | 'unlocked';

interface OpenVault {
  readonly path: string;
  readonly header: KeepHeader;
  readonly dek: SecretBytes;
  document: VaultDocument;
  attachments: VaultContents['attachments'];
  dirty: boolean;
}

export interface CreateVaultOptions {
  readonly path: string;
  readonly password: string;
  readonly settings?: VaultSettings;
  /** Skips calibration and uses the shipped defaults. */
  readonly skipCalibration?: boolean;
  /**
   * Explicit Argon2 cost, overriding both calibration and the defaults.
   *
   * Surfaced to users in Settings → Advanced (Phase 14) for the two real cases: a machine
   * too slow for the calibrated cost, and a user who wants a deliberately expensive vault.
   * Still validated against the floor in `assertUsableKdfParams`, so this cannot be used
   * to create a weak vault by accident.
   */
  readonly kdf?: Partial<Pick<KdfParams, 'memoryKib' | 'iterations' | 'parallelism'>>;
  readonly deviceId?: string;
  /**
   * Where Argon2 runs.
   *
   * Injected so this class stays testable without a worker, while the app routes it to a
   * worker thread — Argon2 blocks whatever thread it is on for the full derivation, and
   * blocking the main thread freezes the window at exactly the wrong moment.
   */
  readonly derive?: DeriveKeyFn;
}

/**
 * Supplies the provenance recorded against a change.
 *
 * An interface rather than the concrete `OriginCapture` so this class never reaches for
 * the machine directly, and so no test spawns `netsh` in order to save a credential.
 */
export interface OriginSource {
  capture(action: HistoryAction, level: AuditPrivacyLevel): ChangeOrigin;
}

/**
 * The default: the verb, and nothing about the machine.
 *
 * A service constructed without an origin source records *less* than the user asked for,
 * never more. The opposite default — reaching for the hostname whenever nobody said not
 * to — is how a privacy setting quietly stops meaning anything.
 */
const NO_ORIGIN: OriginSource = { capture: (action) => ({ action }) };

export class VaultService {
  #open: OpenVault | null = null;
  /** The save queue. See `save()` — two writers on one temp path is data loss, not a race to tune. */
  #saving: Promise<void> = Promise.resolve();
  #broker = new SecretBroker();
  readonly #deviceId: string;
  readonly #origin: OriginSource;

  constructor(deviceId: string = uuid(), origin: OriginSource = NO_ORIGIN) {
    this.#deviceId = deviceId;
    this.#origin = origin;
  }

  get state(): VaultState {
    return this.#open === null ? 'closed' : 'unlocked';
  }

  get broker(): SecretBroker {
    return this.#broker;
  }

  // ── Opening ────────────────────────────────────────────────────────────────

  /**
   * Reads what can be known about a vault file without the password.
   *
   * The unlock screen needs the KDF cost to warn about a slow open, and needs to surface
   * an interrupted write before the user types anything — telling them afterwards would
   * mean they had already committed to a path.
   */
  static async inspect(path: string): Promise<VaultLockedInfo> {
    const bytes = await readVaultFile(path);
    const { header } = readPreamble(bytes);
    const orphan = await findOrphanedTemp(path);

    return {
      path,
      vaultId: header.vaultId,
      createdAt: header.createdAt,
      modifiedAt: header.modifiedAt,
      generation: header.generation,
      kdfMemoryKib: header.kdf.memoryKib,
      kdfIterations: header.kdf.iterations,
      hasOrphanedTemp: orphan !== null,
    };
  }

  async createVault(options: CreateVaultOptions): Promise<VaultSummary> {
    this.lock();

    const calibrated =
      options.kdf !== undefined || options.skipCalibration ? null : await calibrateKdf();

    const kdf = newKdfParams({
      ...(calibrated === null
        ? {}
        : {
            memoryKib: calibrated.params.memoryKib,
            iterations: calibrated.params.iterations,
            parallelism: calibrated.params.parallelism,
          }),
      ...options.kdf,
    });

    const { keys, wrappedDek } = await createVaultKeys(options.password, kdf, options.derive);
    const header = newHeader({
      vaultId: uuid(),
      deviceId: options.deviceId ?? this.#deviceId,
      kdf,
      wrappedDek,
    });

    this.#open = {
      path: options.path,
      header,
      dek: keys.dek,
      document: emptyVaultDocument(options.settings),
      attachments: [],
      dirty: true,
    };

    await this.save();
    return this.summary();
  }

  /**
   * Opens and decrypts a vault.
   *
   * A failure here throws a `VaultError` whose code distinguishes a wrong password from a
   * damaged file — see `errors.ts` for why those are the same mechanism reported
   * differently, and why the distinction still matters to the person typing.
   */
  async unlock(path: string, password: string, derive?: DeriveKeyFn): Promise<VaultSummary> {
    this.lock();

    const bytes = await readVaultFile(path);
    const { header } = readPreamble(bytes);

    // Throws WRONG_PASSWORD if the DEK will not unwrap.
    const keys = await unlockKeys(password, header.kdf, header.wrappedDek, derive);

    let contents: VaultContents;
    try {
      contents = readContainer(bytes, keys.dek);
    } catch (error) {
      // The password was right — the DEK unwrapped — so do not leave a live key behind
      // just because the body was damaged.
      keys.dek.destroy();
      throw error;
    }

    let document: VaultDocument;
    try {
      document = parseVaultDocument(contents.body);
    } catch (error) {
      keys.dek.destroy();
      throw error;
    }

    this.#open = {
      path,
      header,
      dek: keys.dek,
      document,
      attachments: contents.attachments,
      dirty: false,
    };

    return this.summary();
  }

  /**
   * Opens a vault with a data key recovered from the OS key store, skipping Argon2.
   *
   * There is no password check here, and there does not need to be: possession of the
   * correct DEK **is** the proof. If the key is wrong the container's authentication tag
   * fails and the vault does not open — the same guarantee the password path relies on,
   * reached by a different route.
   *
   * Deliberately separate from `unlock` rather than an optional branch inside it. The two
   * have genuinely different security stories, and a single method with a "or use this key
   * instead" parameter is how a bypass gets added by accident later.
   */
  async unlockWithKey(path: string, dekBytes: Uint8Array): Promise<VaultSummary> {
    this.lock();

    const bytes = await readVaultFile(path);
    const { header } = readPreamble(bytes);
    const dek = SecretBytes.adopt(Uint8Array.from(dekBytes));

    let contents: VaultContents;
    try {
      contents = readContainer(bytes, dek);
    } catch (error) {
      dek.destroy();
      throw error;
    }

    let document: VaultDocument;
    try {
      document = parseVaultDocument(contents.body);
    } catch (error) {
      dek.destroy();
      throw error;
    }

    this.#open = { path, header, dek, document, attachments: contents.attachments, dirty: false };
    return this.summary();
  }

  /**
   * Hands the raw data key to a callback, for quick-unlock enrolment.
   *
   * The only place key bytes leave `SecretBytes`, and shaped as a callback precisely so
   * that is visible: there is no getter that quietly returns the key, and a reviewer
   * scanning for `exportKeyForQuickUnlock` finds every such site.
   */
  exportKeyForQuickUnlock<T>(wrap: (dekBytes: Uint8Array) => T): T {
    const open = this.#requireOpen();
    return open.dek.use((bytes) => wrap(bytes));
  }

  // ── Locking ────────────────────────────────────────────────────────────────

  /**
   * Destroys the key, drops the document, and revokes every grant.
   *
   * Idempotent, so it is safe from a `finally`, from a window-close handler, and from a
   * quit handler that may all fire for the same shutdown.
   *
   * Note what this does **not** do: save. An auto-lock on idle must never write, because
   * writing unattended is how a half-finished edit becomes the saved state. Unsaved
   * changes are the caller's problem to prompt about while the user is still there.
   */
  lock(): void {
    if (this.#open === null) return;
    this.#open.dek.destroy();
    this.#open = null;
    this.#broker.revokeAll();
  }

  get hasUnsavedChanges(): boolean {
    return this.#open?.dirty ?? false;
  }

  // ── Saving ─────────────────────────────────────────────────────────────────

  /**
   * Saves the vault. **Serialised**, and it must stay that way.
   *
   * Two concurrent saves would both call `writeVaultFileAtomically` on the same
   * `<vault>.keep.tmp` path: both open it for writing, one truncates the other's bytes, and
   * the loser's rename either clobbers the winner or fails into the cleanup that removes the
   * temp file. Every mutator here is synchronous, so the only way two saves overlap is
   * through this `await` — which is exactly what the queue closes.
   */
  async save(): Promise<VaultSummary> {
    // The chain absorbs a rejection so one failed save does not poison every save after it,
    // while the returned promise still rejects for the caller that asked for this one.
    const run = this.#saving.then(
      () => this.#saveOnce(),
      () => this.#saveOnce()
    );
    this.#saving = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async #saveOnce(): Promise<VaultSummary> {
    const opened = this.#requireOpen();

    // Retention is enforced on save rather than on a timer, so a vault that is never opened
    // never loses anything. Measuring against wall-clock time while the app was closed
    // would mean reopening after a long break silently purges a trash the user never saw.
    const document = purgeExpiredTrash(opened.document, Date.now());

    const header: KeepHeader = {
      ...opened.header,
      modifiedAt: Date.now(),
      generation: opened.header.generation + 1,
      deviceId: this.#deviceId,
      recordCount: document.records.length,
      attachmentCount: pruneUnreferencedChunks(document, opened.attachments).length,
    };

    // Chunks nothing references are dropped here rather than accumulating forever. This is
    // the *only* place data is removed without the user naming it, and it is safe precisely
    // because the condition is "no record points at this" — a trashed record still points,
    // so a chunk survives until its last referrer is permanently purged.
    const attachments = pruneUnreferencedChunks(document, opened.attachments);

    const bytes = writeContainer(
      header,
      { body: serialiseVaultDocument(document), attachments },
      opened.dek
    );

    await writeVaultFileAtomically(opened.path, bytes);

    // ── Writing back, without discarding whatever happened during the await ──
    //
    // The naive form — `this.#open = { ...opened, header, dirty: false }` — restores a
    // snapshot taken before the write and clears the dirty flag. A mutation that landed
    // while the file was being written is then gone from memory *and* marked as saved, so
    // nothing will ever write it again: the record simply vanishes on the next refresh,
    // with no error. That is the worst failure this class can have.
    //
    // So only the fields this save actually owns are written back, and the dirty flag is
    // cleared only when the document is still the one that was serialised.
    const current = this.#open;
    if (current?.path !== opened.path) {
      // Locked, closed, or a different vault opened while we were writing. The bytes on
      // disk are correct; there is no in-memory state left that they belong to.
      return this.#summaryFrom(opened, header);
    }

    const untouched = current.document === opened.document;
    this.#open = {
      ...current,
      header,
      document: untouched ? document : current.document,
      // The pruned set is what was written, so keeping the unpruned one in memory would make
      // the next save think chunks exist that no longer do.
      attachments: untouched ? attachments : current.attachments,
      dirty: !untouched,
    };
    return this.summary();
  }

  // ── Reading, the safe way ──────────────────────────────────────────────────

  summary(): VaultSummary {
    const open = this.#requireOpen();
    return this.#summaryFrom(open, open.header);
  }

  /**
   * A summary of a specific snapshot, rather than of whatever is open now.
   *
   * `save()` needs this for the case where the vault was locked or replaced during the file
   * write: the bytes on disk are correct and the caller is owed an accurate answer about
   * them, but there is no live state left to read it from.
   */
  #summaryFrom(open: OpenVault, header: KeepHeader): VaultSummary {
    return {
      vaultId: header.vaultId,
      path: open.path,
      displayName: basename(open.path).replace(/\.keep$/i, ''),
      createdAt: header.createdAt,
      modifiedAt: header.modifiedAt,
      generation: header.generation,
      recordCount: open.document.records.filter((r) => r.trashedAt === null).length,
      attachmentCount: open.attachments.length,
      trashedCount: open.document.records.filter((r) => r.trashedAt !== null).length,
      folderCount: open.document.folders.length,
      tagCount: open.document.tags.length,
      settings: open.document.settings,
    };
  }

  /** Every record, as projections. The renderer's entire view of the vault. */
  listProjections(options: { includeTrashed?: boolean } = {}): CredentialProjection[] {
    const open = this.#requireOpen();
    const records = options.includeTrashed
      ? open.document.records
      : open.document.records.filter((r) => r.trashedAt === null);
    return toProjections(records);
  }

  getProjection(credentialId: string): CredentialProjection | null {
    const record = this.#findRecord(credentialId);
    return record === null ? null : toProjection(record);
  }

  /**
   * Resolves one secret, through the broker.
   *
   * This is the only route by which secret material leaves this process, and every path
   * into it is enumerated by `SecretRef` — a closed union rather than a path string, so
   * the set of askable things is finite and reviewable rather than parsed.
   *
   * Returns `null` for "no such thing" and throws only for "not allowed". Conflating the
   * two would let a caller distinguish a missing record from a forbidden one by the error
   * type, which is a small enumeration oracle.
   */
  revealSecret(ref: SecretRef): string | null {
    this.#requireOpen();
    const record = this.#findRecord(ref.credentialId);
    if (record === null) return null;

    this.#broker.grant(ref);

    switch (ref.kind) {
      case 'password':
        return record.fields.password;
      case 'notes':
        return record.fields.notes;
      case 'security-answer': {
        const question = record.fields.securityQuestions.find((q) => q.id === ref.questionId);
        return question?.answer ?? null;
      }
      case 'custom-value': {
        const field = record.fields.custom.find((f) => f.id === ref.fieldId);
        if (field === undefined) return null;
        // Deliberately unconditional, and it used to be written as
        // `isCustomFieldValueSecret(field) ? field.value : field.value` — a ternary whose
        // branches are identical. That looked like the secret gate to anyone skimming, so a
        // reviewer asking "is the classification enforced on this path?" read a yes where
        // the honest answer is "it does not need to be". A non-secret value already reached
        // the renderer in the projection, so asking for one here is redundant or a probe;
        // either way this route discloses nothing the caller does not have. The gate that
        // matters is in `projection.ts`, which is where the classification decides anything.
        return field.value;
      }

      // Historic reveals resolve the *state at that point*, not the raw snapshot. A version
      // stores only what changed, so a version that did not touch the password still has a
      // password that was current when it was written — and `resolveState` is what knows it.
      // Reading `snapshot.password` directly would return nothing and the UI would show
      // "empty", which is a lie about the record's past.
      case 'historic-password': {
        const state = resolveState(record, ref.versionNumber);
        return state === null ? null : state.password;
      }
      case 'historic-notes': {
        const state = resolveState(record, ref.versionNumber);
        return state === null ? null : state.notes;
      }
      case 'historic-answer': {
        const state = resolveState(record, ref.versionNumber);
        if (state === null) return null;
        const question = state.securityQuestions.find((q) => q.id === ref.questionId);
        return question?.answer ?? null;
      }
      case 'historic-custom': {
        const state = resolveState(record, ref.versionNumber);
        if (state === null) return null;
        const field = state.custom.find((f) => f.id === ref.fieldId);
        return field?.value ?? null;
      }

      case 'attachment':
        // Deliberately not served here. This method's contract is "one secret, as a string",
        // and an attachment is bytes — often megabytes of them. Encoding a file as a string
        // to fit a signature would double it in memory and put a passport photograph through
        // the same path as a password. `readAttachment` is the door for those, and it goes
        // through the same broker, so nothing is bypassed by refusing here.
        return null;
    }
  }

  /**
   * Searches inside secret material without shipping any of it.
   *
   * The renderer cannot do this itself — it does not have notes, security answers, or
   * hidden custom values. Rather than sending them over so it can, the search runs here
   * and only **ids** come back. The renderer already has the projections to render.
   */
  deepSearch(query: string): string[] {
    const open = this.#requireOpen();
    const needle = query.trim().toLowerCase();
    if (needle === '') return [];

    const matches: string[] = [];
    for (const record of open.document.records) {
      if (record.trashedAt !== null) continue;

      const haystacks = [
        record.fields.notes,
        ...record.fields.securityQuestions.map((q) => q.answer),
        ...record.fields.custom.filter(isCustomFieldValueSecret).map((f) => f.value),
      ];

      if (haystacks.some((value) => value.toLowerCase().includes(needle))) {
        matches.push(record.id);
      }
    }
    return matches;
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  /**
   * The context the pure operations need.
   *
   * Built fresh per call so `now` is the real current time, and so the vault's settings —
   * which the user can change mid-session — are always the current ones.
   */
  #ops(): OpsContext {
    const settings = this.#requireOpen().document.settings;
    return {
      newId: uuid,
      now: Date.now,
      settings,
      captureOrigin: (action) => this.#origin.capture(action, settings.auditPrivacyLevel),
    };
  }

  /** The provenance for one change, at the vault's current privacy level. */
  #captureOrigin(action: HistoryAction): ChangeOrigin {
    return this.#origin.capture(action, this.#requireOpen().document.settings.auditPrivacyLevel);
  }

  createCredential(input: NewCredentialInput): CredentialProjection {
    const open = this.#requireOpen();
    const credential = buildCredential(input, this.#ops());
    this.#open = { ...open, document: addCredential(open.document, credential), dirty: true };
    return toProjection(credential);
  }

  /**
   * Applies a patch and reports what changed.
   *
   * Returns `null` for an unknown id and an **empty `changedFields`** for a no-op patch, so
   * the caller can skip the save. Without that, opening a record and closing it would bump
   * `updatedAt`, create a history version, and dirty the vault for no user-visible change.
   */
  updateCredential(
    credentialId: string,
    patch: CredentialPatch
  ): { projection: CredentialProjection; changedFields: readonly string[] } | null {
    const open = this.#requireOpen();
    const existing = findCredential(open.document, credentialId);
    if (existing === null) return null;

    const { credential, changedFields } = applyPatch(existing, patch, this.#ops());
    if (changedFields.length === 0) {
      return { projection: toProjection(credential), changedFields };
    }

    // The version is appended here rather than inside `applyPatch` because provenance is
    // an I/O concern — it reads the machine — and `credential-ops` is pure by design.
    const versioned = appendVersion(
      credential,
      existing,
      changedFields,
      this.#captureOrigin('update')
    );
    this.#open = { ...open, document: replaceCredential(open.document, versioned), dirty: true };
    return { projection: toProjection(versioned), changedFields };
  }

  // ── Attachments ──────────────────────────────────────────────────────────────

  /**
   * Attaches a file to a record.
   *
   * The **main process** reads the file, so the path never comes from the renderer — the same
   * rule as opening a vault. Bytes arrive here already read, and ownership of them transfers
   * into the attachment store, which zeroes them on every path including the failing ones.
   *
   * Chunks are content-addressed and shared, so attaching a file two records already have
   * stores nothing new and returns the existing metadata.
   */
  addAttachment(
    credentialId: string,
    file: { readonly name: string; readonly mime: string; readonly bytes: Uint8Array }
  ): AttachmentAddView {
    const open = this.#requireOpen();
    const result = addAttachmentToDocument(open.document, credentialId, {
      name: file.name,
      mime: file.mime,
      bytes: SecretBytes.adopt(file.bytes),
      now: Date.now(),
      newId: uuid(),
    });

    this.#open = {
      ...open,
      document: result.document,
      attachments:
        result.chunk === null
          ? open.attachments
          : [...open.attachments, toContainerChunk(result.chunk)],
      dirty: true,
    };

    // The metadata, the checks, and nothing derived from the bytes. `AttachmentMeta` is
    // already part of the safe projection — name, size, mime and digest — so it crosses as
    // it is; the content does not, and is fetched through the broker like any other secret.
    return {
      meta: result.meta,
      deduped: result.deduped,
      mime: result.mime,
      name: result.name,
      warnLarge: result.warnLarge,
    };
  }

  /**
   * Removes an attachment from a record.
   *
   * The chunk survives while any other record still points at it. Dropping it on the first
   * removal would take a file out from under an attachment that still displays it.
   */
  removeAttachment(credentialId: string, attachmentId: string): boolean {
    const open = this.#requireOpen();
    const result = removeAttachment(open.document, credentialId, attachmentId);

    this.#open = {
      ...open,
      document: result.document,
      attachments: result.chunkOrphaned
        ? open.attachments.filter((chunk) => chunk.id !== attachmentId)
        : open.attachments,
      dirty: true,
    };
    return result.chunkOrphaned;
  }

  /**
   * The bytes of one attachment, verified against the digest recorded when it was stored.
   *
   * Goes through the broker, exactly like a password: one item per request, rate-limited,
   * and every grant dropped on lock. An attachment can be a photo of a passport.
   */
  readAttachment(credentialId: string, attachmentId: string): Uint8Array | null {
    this.#requireOpen();
    const record = this.#findRecord(credentialId);
    const meta = record?.attachments.find((entry) => entry.id === attachmentId);
    if (record === null || meta === undefined) return null;

    const chunk = this.#requireOpen().attachments.find((entry) => entry.id === attachmentId);
    if (chunk === undefined) return null;

    this.#broker.grant({ kind: 'attachment', credentialId, attachmentId });
    // Verified on read rather than trusted: a chunk that does not match its digest means the
    // file is damaged or was altered, and handing it over as though it were intact is how a
    // corrupt attachment becomes a corrupt document somewhere else.
    assertAttachmentIntegrity(meta, chunk.data);
    return chunk.data;
  }

  /** Orphans in both directions, reported rather than repaired. */
  auditAttachments(): AttachmentAudit {
    const open = this.#requireOpen();
    return auditAttachments(
      open.document,
      new Set(open.attachments.map((chunk) => chunk.id)),
      new Map(open.attachments.map((chunk) => [chunk.id, chunk.data.length]))
    );
  }

  // ── Vault settings ───────────────────────────────────────────────────────────

  /**
   * Replaces the vault-scoped settings.
   *
   * These live **inside** the encrypted body rather than in app preferences, because they
   * are properties of the data: copy the vault to another machine and its history retention
   * and audit privacy level go with it. See `VaultSettings`.
   *
   * Merged rather than replaced, so a caller sending one field cannot silently reset the
   * rest to whatever its own defaults happened to be.
   */
  updateSettings(patch: Partial<VaultSettings>): VaultSettings {
    const open = this.#requireOpen();
    const settings: VaultSettings = { ...open.document.settings, ...patch };
    this.#open = {
      ...open,
      document: { ...open.document, settings },
      dirty: true,
    };
    return settings;
  }

  /** The vault-scoped settings as stored. No secrets — retention, privacy level, thresholds. */
  settings(): VaultSettings {
    return this.#requireOpen().document.settings;
  }

  /** Every stored version across every record — what "clear all history" is about to cost. */
  historyVersionCount(): number {
    const open = this.#requireOpen();
    return open.document.records.reduce(
      (total, record) => total + record.history.versions.length,
      0
    );
  }

  /**
   * Clears every record's history in one action.
   *
   * The bulk form of `clearHistory`, and it exists for the same reason: the audit trail is
   * the one feature that can hold something a user wants gone. Like the per-record version it
   * is deliberately **not** itself versioned — recording "all history was cleared, from
   * DESKTOP-A, at 14:02" would defeat the point of the button.
   */
  clearAllHistory(): number {
    const open = this.#requireOpen();
    const removed = this.historyVersionCount();
    if (removed === 0) return 0;

    this.#open = {
      ...open,
      document: {
        ...open.document,
        records: open.document.records.map((record) =>
          record.history.versions.length === 0
            ? record
            : { ...record, history: { ...record.history, versions: [] } }
        ),
      },
      dirty: true,
    };
    return removed;
  }

  /** The KDF cost this vault was created with. Read-only here; changing it is a re-key. */
  kdfParams(): KdfParams {
    return this.#requireOpen().header.kdf;
  }

  // ── Folders and tags ─────────────────────────────────────────────────────────
  //
  // Thin: every rule lives in `src/main/organisation/`, which is pure, and this layer only
  // supplies the id generator and marks the vault dirty. A rule that leaked up to here
  // would be a rule the pure tests cannot reach.

  /** Folders and tags as the vault holds them. No secrets — names, colours and structure. */
  organisation(): { folders: readonly Folder[]; tags: readonly Tag[] } {
    const open = this.#requireOpen();
    return { folders: open.document.folders, tags: open.document.tags };
  }

  createFolder(input: NewFolderInput): Folder {
    const open = this.#requireOpen();
    const result = createFolder(open.document, input, { newId: uuid });
    this.#open = { ...open, document: result.document, dirty: true };
    return result.folder;
  }

  renameFolder(folderId: string, name: string): Folder {
    const open = this.#requireOpen();
    const document = renameFolder(open.document, folderId, name);
    this.#open = { ...open, document, dirty: true };
    return requireFolderIn(document, folderId);
  }

  moveFolder(folderId: string, parentId: string | null, index?: number): Folder {
    const open = this.#requireOpen();
    const document = moveFolder(open.document, folderId, parentId, {
      ...(index === undefined ? {} : { index }),
    });
    this.#open = { ...open, document, dirty: true };
    return requireFolderIn(document, folderId);
  }

  /**
   * Deletes a folder, and the caller says what happens to the records inside.
   *
   * There is deliberately no "delete everything inside" policy. Records reach the trash by
   * their own action, with undo; a folder delete able to sweep records away would be the one
   * destructive path in the app with no recovery.
   */
  deleteFolder(folderId: string, policy: FolderDeletePolicy): { movedRecords: number } {
    const open = this.#requireOpen();
    // Counted before the delete, because afterwards there is nothing to count: the records
    // have been reparented or unfiled and no longer name this folder.
    const movedRecords = open.document.records.filter(
      (record) => record.folderId === folderId
    ).length;
    this.#open = {
      ...open,
      document: deleteFolder(open.document, folderId, policy),
      dirty: true,
    };
    return { movedRecords };
  }

  createTag(input: NewTagInput): Tag {
    const open = this.#requireOpen();
    const result = createTag(open.document, input, { newId: uuid });
    this.#open = { ...open, document: result.document, dirty: true };
    return result.tag;
  }

  /** Renames the tag **and** every record carrying it — the classic half of this that gets missed. */
  renameTag(tagId: string, name: string): { tag: Tag; updatedRecords: number } {
    const open = this.#requireOpen();
    const result = renameTag(open.document, tagId, name);
    this.#open = { ...open, document: result.document, dirty: true };
    return {
      tag: requireTagIn(result.document, tagId),
      updatedRecords: result.changedRecordIds.length,
    };
  }

  setTagColour(tagId: string, colour: string): Tag {
    const open = this.#requireOpen();
    const document = setTagColour(open.document, tagId, colour);
    this.#open = { ...open, document, dirty: true };
    return requireTagIn(document, tagId);
  }

  deleteTag(tagId: string): { updatedRecords: number } {
    const open = this.#requireOpen();
    const result = deleteTag(open.document, tagId);
    this.#open = { ...open, document: result.document, dirty: true };
    return { updatedRecords: result.changedRecordIds.length };
  }

  // ── History ──────────────────────────────────────────────────────────────────

  /**
   * What one edit changed, as a field-level diff.
   *
   * Returns `null` for an unknown record or an unknown version — pruned, or never there.
   * The diff carries the *values*, including secret ones, so it never crosses IPC as it
   * stands; the renderer gets `VersionProjection` and asks for old secrets one at a time.
   */
  diffVersion(credentialId: string, versionNumber: number): FieldDiff[] | null {
    this.#requireOpen();
    const record = this.#findRecord(credentialId);
    return record === null ? null : diffVersion(record, versionNumber);
  }

  /** The difference between any two points in a record's timeline. */
  compareVersions(credentialId: string, from: HistoryPoint, to: HistoryPoint): FieldDiff[] | null {
    this.#requireOpen();
    const record = this.#findRecord(credentialId);
    return record === null ? null : comparePoints(record, from, to);
  }

  /**
   * The same two, projected for the renderer.
   *
   * Separate methods rather than a flag, so the raw form cannot be sent by passing the
   * wrong boolean. A caller reaching for `diffVersion` over IPC has to notice it is
   * returning values rather than a projection.
   */
  diffVersionProjection(credentialId: string, versionNumber: number): FieldDiffProjection[] | null {
    const diffs = this.diffVersion(credentialId, versionNumber);
    return diffs === null ? null : toDiffProjection(diffs);
  }

  compareVersionsProjection(
    credentialId: string,
    from: HistoryPoint,
    to: HistoryPoint
  ): FieldDiffProjection[] | null {
    const diffs = this.compareVersions(credentialId, from, to);
    return diffs === null ? null : toDiffProjection(diffs);
  }

  /**
   * Analyses the open vault.
   *
   * `now` is taken here rather than inside `analyseVault`, which is pure by design — the
   * clock is I/O, and a health report that reads one is a health report that cannot be
   * tested at a boundary.
   *
   * The report contains no secret material by construction (see
   * `docs/05-Features/01-Health-Rules.md`), which is why it crosses IPC whole rather than
   * being projected first.
   */
  analyseHealth(options: Omit<HealthAnalysisOptions, 'now'> = {}): VaultHealthReport {
    const open = this.#requireOpen();
    const analysis: HealthAnalysisOptions = { ...options, now: Date.now() };
    return analyseVault(open.document, analysis);
  }

  /**
   * Puts a record back to the state before `versionNumber`, recording the restore.
   *
   * A restore is a change like any other: it bumps `updatedAt`, appends a version with
   * `action: 'restore'`, and can itself be undone from the timeline. Anything else would
   * make the one operation that rewrites a record the one the audit trail cannot see.
   */
  restoreVersion(
    credentialId: string,
    versionNumber: number
  ): { projection: CredentialProjection; changedFields: readonly string[] } | null {
    const record = this.#findRecord(credentialId);
    if (record === null) return null;
    return this.#commitRestore(
      restoreVersion(record, versionNumber, this.#captureOrigin('restore'), this.#ops())
    );
  }

  /** Restores one field from one version, leaving the rest of the record alone. */
  restoreField(
    credentialId: string,
    versionNumber: number,
    field: VersionedField
  ): { projection: CredentialProjection; changedFields: readonly string[] } | null {
    const record = this.#findRecord(credentialId);
    if (record === null) return null;
    return this.#commitRestore(
      restoreField(record, versionNumber, field, this.#captureOrigin('restore'), this.#ops())
    );
  }

  #commitRestore(
    result: RestoreResult | null
  ): { projection: CredentialProjection; changedFields: readonly string[] } | null {
    if (result === null) return null;

    // A restore to the state the record is already in changes nothing, and must not dirty
    // the vault or add a version saying so.
    if (result.changedFields.length > 0) {
      const open = this.#requireOpen();
      this.#open = {
        ...open,
        document: replaceCredential(open.document, result.credential),
        dirty: true,
      };
    }
    return { projection: toProjection(result.credential), changedFields: result.changedFields };
  }

  /**
   * Clears a record's history.
   *
   * Offered because the audit trail is the one feature that can hold something a user
   * wants gone — an old password they now consider burned, a device name from a job they
   * have left. A password manager that cannot forget is not one people will hand their
   * whole life to. The clear is deliberately *not* versioned: recording “history was
   * cleared, from DESKTOP-A, at 14:02” would defeat the point of the button.
   */
  clearHistory(credentialId: string): boolean {
    const open = this.#requireOpen();
    const record = this.#findRecord(credentialId);
    if (record === null || record.history.versions.length === 0) return false;

    const cleared: Credential = { ...record, history: { ...record.history, versions: [] } };
    this.#open = { ...open, document: replaceCredential(open.document, cleared), dirty: true };
    return true;
  }

  duplicateCredential(credentialId: string): CredentialProjection | null {
    const open = this.#requireOpen();
    const existing = findCredential(open.document, credentialId);
    if (existing === null) return null;

    const copy = duplicateCredential(existing, this.#ops());
    this.#open = { ...open, document: addCredential(open.document, copy), dirty: true };
    return toProjection(copy);
  }

  /** Soft delete. The record becomes a tombstone, restorable from Trash. */
  trashCredential(credentialId: string): boolean {
    const open = this.#requireOpen();
    if (findCredential(open.document, credentialId) === null) return false;

    this.#open = {
      ...open,
      document: trashCredential(open.document, credentialId, Date.now()),
      dirty: true,
    };
    return true;
  }

  restoreCredential(credentialId: string): boolean {
    const open = this.#requireOpen();
    if (findCredential(open.document, credentialId) === null) return false;

    this.#open = {
      ...open,
      document: restoreCredential(open.document, credentialId),
      dirty: true,
    };
    return true;
  }

  /**
   * Permanent deletion.
   *
   * The only operation that actually loses data, which is why it is a distinct method
   * rather than a flag on `trashCredential`. Also drops any attachment chunks the record
   * owned — otherwise they would linger in the file forever, unreferenced.
   */
  purgeCredential(credentialId: string): boolean {
    const open = this.#requireOpen();
    const existing = findCredential(open.document, credentialId);
    if (existing === null) return false;

    // NOT "every chunk this record lists". Chunks are content-addressed and shared: two
    // records attaching the same file point at one chunk, so dropping everything this
    // record references would delete a file another record still displays. `existing` is
    // read above only to confirm the record is there; the orphan set is computed from the
    // whole document.
    const orphaned = new Set(chunkIdsOrphanedBy(open.document, credentialId));
    this.#open = {
      ...open,
      document: purgeCredential(open.document, credentialId),
      attachments: open.attachments.filter((chunk) => !orphaned.has(chunk.id)),
      dirty: true,
    };
    return true;
  }

  /** Marks a record as used, for "recently used" and sort-by-frequency. */
  markUsed(credentialId: string): void {
    const open = this.#requireOpen();
    const existing = findCredential(open.document, credentialId);
    if (existing === null) return;

    this.#open = {
      ...open,
      document: replaceCredential(open.document, recordUse(existing, Date.now())),
      dirty: true,
    };
  }

  /** Replaces the document wholesale. Used by import and by tests. */
  replaceDocument(document: VaultDocument): void {
    const open = this.#requireOpen();
    this.#open = { ...open, document, dirty: true };
  }

  /** Main-process only. Never call this from anything that talks to the renderer. */
  documentUnsafe(): VaultDocument {
    return this.#requireOpen().document;
  }

  /**
   * The attachment chunks the open container holds. **Main-process only.**
   *
   * Exists for the encrypted export, which must carry the bytes of the attachments belonging
   * to the records it seals. Named `Unsafe` for the same reason as `documentUnsafe`: these
   * are file contents, they can be a photograph of a passport, and nothing that talks to the
   * renderer may call this.
   */
  attachmentChunksUnsafe(): readonly AttachmentChunk[] {
    return this.#requireOpen().attachments;
  }

  #requireOpen(): OpenVault {
    if (this.#open === null) {
      throw new VaultError('MALFORMED', 'No vault is open. Unlock a vault first.');
    }
    return this.#open;
  }

  #findRecord(credentialId: string): Credential | null {
    return this.#requireOpen().document.records.find((r) => r.id === credentialId) ?? null;
  }
}

// ── Document serialisation ───────────────────────────────────────────────────

export function serialiseVaultDocument(document: VaultDocument): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify(document), 'utf8'));
}

/**
 * Parses the decrypted body.
 *
 * Validation here is intentionally shallow: unlike the header, this data has already been
 * authenticated by the AEAD, so it was written by something holding the DEK. The checks
 * below catch *our own* bugs and version mismatches, not an attacker.
 */
export function parseVaultDocument(body: Uint8Array): VaultDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    throw malformed('the vault contents are not valid JSON');
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw malformed('the vault contents are not an object');
  }

  const candidate = raw as Partial<VaultDocument>;
  if (typeof candidate.documentVersion !== 'number') {
    throw malformed('the vault contents have no document version');
  }
  if (candidate.documentVersion > VAULT_DOCUMENT_VERSION) {
    throw malformed(
      `the vault contents use document version ${candidate.documentVersion}, newer than the supported ${VAULT_DOCUMENT_VERSION}`
    );
  }
  if (!Array.isArray(candidate.records))
    throw malformed('the vault contents have no records array');

  return {
    documentVersion: candidate.documentVersion,
    records: candidate.records.map(normaliseRecord),
    folders: candidate.folders ?? [],
    tags: candidate.tags ?? [],
    // Merged rather than defaulted wholesale: a vault written before a settings field
    // existed must keep every setting it *does* carry, and gain only the missing one. A
    // `?? defaults` would silently reset the user's whole configuration on the first open
    // after an upgrade — which looks exactly like the app forgetting their choices.
    settings: {
      ...emptyVaultDocument().settings,
      ...candidate.settings,
      health: { ...DEFAULT_VAULT_HEALTH_SETTINGS, ...candidate.settings?.health },
    },
  };
}

/**
 * Brings one stored record up to the current model, and refuses one that cannot be.
 *
 * `createdOrigin` post-dates the first records this app ever wrote, so a vault from before
 * it simply does not have one. It is filled with the verb alone rather than with anything
 * about *this* machine — the record was not created here, and inventing a plausible origin
 * would put a false entry in the one part of the app whose entire value is being
 * trustworthy about provenance.
 *
 * History is validated rather than repaired. A malformed version array means the file is
 * corrupt, was merged wrongly, or was written by a build with a bug — and silently
 * "fixing" it would destroy the evidence of which.
 */
function normaliseRecord(record: Credential): Credential {
  // Typed as a partial view because this record came out of `JSON.parse`, not out of the
  // model. The declared type says `createdOrigin` is always there; the file on disk is
  // under no such obligation.
  const stored = record as { meta?: Partial<Credential['meta']> };
  const normalised =
    stored.meta?.createdOrigin === undefined
      ? { ...record, meta: { ...record.meta, createdOrigin: { action: 'create' as const } } }
      : record;

  try {
    assertValidHistory(normalised);
  } catch (error) {
    throw malformed(error instanceof Error ? error.message : 'a record has invalid history');
  }
  return normalised;
}

/**
 * Reads back a folder the operation just wrote.
 *
 * The pure operations return a document rather than the entity, because an entity is a view
 * of a document and returning both invites them to disagree. This is the read side of that
 * choice, in one place rather than four.
 */
function requireFolderIn(document: VaultDocument, folderId: string): Folder {
  const folder = document.folders.find((candidate) => candidate.id === folderId);
  if (folder === undefined) throw malformed(`folder ${folderId} vanished during the operation`);
  return folder;
}

function requireTagIn(document: VaultDocument, tagId: string): Tag {
  const tag = document.tags.find((candidate) => candidate.id === tagId);
  if (tag === undefined) throw malformed(`tag ${tagId} vanished during the operation`);
  return tag;
}
