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
import { differentVault, malformed, unsavedChanges, VaultError } from '../crypto/errors.js';
import {
  createVaultKeys,
  rewrapForNewPassword,
  unlock as unlockKeys,
  type DeriveKeyFn,
} from '../crypto/envelope.js';
import type { GeneratorOptions } from '@shared/model/generator.js';
import {
  bySiteRuleHost,
  normaliseSiteRule,
  siteRuleProblem,
  SITE_RULE_MAX,
  type SiteRule,
} from '@shared/model/site-rules.js';
import {
  duplicateSearchName,
  invalidSavedSearch,
  invalidSiteRule,
  noSuchSavedSearch,
  tooManySavedSearches,
  tooManySiteRules,
} from '../organisation/errors.js';
import {
  bySavedSearchOrder,
  normaliseSavedSearch,
  savedSearchProblem,
  SAVED_SEARCH_MAX,
  type SavedSearch,
} from '@shared/model/saved-search.js';
import { readSiteRules } from '@shared/model/site-rules.js';
import { calibrateKdf, newKdfParams } from '../crypto/kdf.js';
import { uuid } from '../crypto/random.js';
import { SecretBytes } from '../crypto/secret.js';
import { readContainer, readPreamble, writeContainer } from '../format/container.js';
import { bodyDigest, newHeader } from '../format/header.js';
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
  #writeGuard: (() => () => void) | null = null;
  readonly #origin: OriginSource;

  constructor(deviceId: string = uuid(), origin: OriginSource = NO_ORIGIN) {
    this.#deviceId = deviceId;
    this.#origin = origin;
  }

  /**
   * Something to bracket every write with — the vault watcher, in production.
   *
   * A settable hook rather than a constructor argument, because the watcher needs the vault
   * *path*, which only exists once a vault is open, and the service is constructed before
   * that. Default is a no-op, so nothing else has to know this exists.
   *
   * It lives here, wrapping the one call to `writeVaultFileAtomically`, rather than in
   * `SessionController.save()` — which is not the only save. The import service calls
   * `VaultService.save()` directly in three places and `createVault` saves internally, and
   * bracketing at the session layer would have left all four unbracketed and looking correct.
   */
  setWriteGuard(guard: (() => () => void) | null): void {
    this.#writeGuard = guard;
  }

  get state(): VaultState {
    return this.#open === null ? 'closed' : 'unlocked';
  }

  get broker(): SecretBroker {
    return this.#broker;
  }

  /**
   * What an unlock screen needs in order to name this vault, read while it is still open.
   *
   * The same shape `inspect` returns, but taken from the header already in memory rather
   * than by reading the file again — locking must not wait on I/O, and by the time a caller
   * knows the vault is locked the header is gone.
   *
   * `hasOrphanedTemp` is false by construction. The field reports an interrupted *previous*
   * write, which is a thing to warn about when first opening a file; this vault has been
   * open and saving atomically since, so raising it again on a re-unlock would be a warning
   * about nothing.
   */
  get lockedInfo(): VaultLockedInfo | null {
    const open = this.#open;
    if (open === null) return null;
    return {
      path: open.path,
      vaultId: open.header.vaultId,
      createdAt: open.header.createdAt,
      modifiedAt: open.header.modifiedAt,
      generation: open.header.generation,
      recordCount: open.header.recordCount,
      kdfMemoryKib: open.header.kdf.memoryKib,
      kdfIterations: open.header.kdf.iterations,
      hasOrphanedTemp: false,
    };
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
      recordCount: header.recordCount,
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

    // Chunks nothing references are dropped here rather than accumulating forever. This is
    // the *only* place data is removed without the user naming it, and it is safe precisely
    // because the condition is "no record points at this" — a trashed record still points,
    // so a chunk survives until its last referrer is permanently purged.
    const attachments = pruneUnreferencedChunks(document, opened.attachments);
    const body = serialiseVaultDocument(document);

    const header: KeepHeader = {
      ...opened.header,
      modifiedAt: Date.now(),
      generation: opened.header.generation + 1,
      deviceId: this.#deviceId,
      // Of the plaintext body, before it is sealed. The ciphertext differs on every save
      // whatever the content, because a fresh nonce is drawn each time — hashing that would
      // answer "was this saved again", which `generation` already says. This answers "is
      // this file's content different from mine", which is the question sync has.
      contentHash: bodyDigest(body),
      recordCount: document.records.length,
      attachmentCount: attachments.length,
    };

    const bytes = writeContainer(header, { body, attachments }, opened.dek);

    // Bracketed so a watcher can tell our own write from somebody else's. The release is in
    // a `finally`: a write that throws must still close the window, or the watcher stays
    // deaf to real external changes for the rest of the session — which is a worse failure
    // than the one that caused it.
    const release = this.#writeGuard?.() ?? null;
    try {
      await writeVaultFileAtomically(opened.path, bytes);
    } finally {
      release?.();
    }

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
      // The vault's own caps, not the shipped defaults. Until this was passed, raising the
      // limit in settings changed nothing at all: the store folded `undefined` and got the
      // defaults back, so the setting was a control that moved and did not connect.
      settings: open.document.settings.attachments,
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

  // ── Saved searches ───────────────────────────────────────────────────────────
  //
  // Content, like folders and tags, so they live on the document and travel inside the
  // encrypted body. `saved-search.ts` carries the argument for that scope.
  //
  // Every one of these returns the whole list rather than the entry it touched. The list is
  // small and bounded by `SAVED_SEARCH_MAX`, and a caller that has to splice a returned entry
  // into its own copy is a caller that will eventually splice it wrong — the same reasoning
  // the folder and tag channels already use.

  savedSearches(): readonly SavedSearch[] {
    return [...this.#requireOpen().document.savedSearches].sort(bySavedSearchOrder);
  }

  /**
   * Saves the current query under a name.
   *
   * Refuses a duplicate name rather than silently making a second one. Two rows reading
   * "Banking" in the sidebar is a state with no way out for the user: neither row says which
   * is which, and renaming one requires guessing which one they are looking at.
   */
  createSavedSearch(input: { readonly name: string; readonly query: string }): SavedSearch {
    const open = this.#requireOpen();
    const existing = open.document.savedSearches;

    if (existing.length >= SAVED_SEARCH_MAX) {
      throw tooManySavedSearches(SAVED_SEARCH_MAX);
    }

    const candidate = normaliseSavedSearch({
      id: uuid(),
      name: input.name,
      query: input.query,
      // Appended, not inserted. A new shortcut going to the bottom is predictable; one that
      // reorders the list the user was just looking at is not.
      order: existing.reduce((highest, entry) => Math.max(highest, entry.order), -1) + 1,
      updatedAt: Date.now(),
    });

    const problem = savedSearchProblem(candidate);
    // Never quotes the name or the query: this message reaches an error banner, and a query
    // can contain a fragment of a record's title.
    if (problem !== null) throw invalidSavedSearch(problem);

    this.#requireUniqueSearchName(existing, candidate.name, null);

    this.#open = {
      ...open,
      document: { ...open.document, savedSearches: [...existing, candidate] },
      dirty: true,
    };
    return candidate;
  }

  /** Renames a saved search, or replaces its query, or both. */
  updateSavedSearch(
    searchId: string,
    patch: { readonly name?: string; readonly query?: string }
  ): SavedSearch {
    const open = this.#requireOpen();
    const current = open.document.savedSearches.find((entry) => entry.id === searchId);
    if (current === undefined) {
      throw noSuchSavedSearch();
    }

    const candidate = normaliseSavedSearch({
      ...current,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.query === undefined ? {} : { query: patch.query }),
      // Stamped on every edit, because this is what the merge uses to decide which of two
      // edited copies wins. An update that left it alone would make the older edit win.
      updatedAt: Date.now(),
    });

    const problem = savedSearchProblem(candidate);
    if (problem !== null) throw invalidSavedSearch(problem);

    this.#requireUniqueSearchName(open.document.savedSearches, candidate.name, searchId);

    this.#open = {
      ...open,
      document: {
        ...open.document,
        savedSearches: open.document.savedSearches.map((entry) =>
          entry.id === searchId ? candidate : entry
        ),
      },
      dirty: true,
    };
    return candidate;
  }

  /**
   * Deletes a saved search outright.
   *
   * No tombstone and no trash, unlike a record — and none is needed. A three-way merge reads
   * the deletion out of the ancestor: present there, gone here, untouched on the other side
   * is honoured as a delete, exactly as it is for a folder. The two cases where the shortcut
   * comes back are both the right answer: a two-way merge has no ancestor and so no evidence
   * anything was deleted, and a side that *edited* it while this one deleted it keeps it,
   * because somebody was still using it and a shortcut is trivially deleted again.
   *
   * A tombstone would buy the two-way case and cost a list that grows forever to remember
   * bookmarks nobody wants back.
   */
  deleteSavedSearch(searchId: string): boolean {
    const open = this.#requireOpen();
    const remaining = open.document.savedSearches.filter((entry) => entry.id !== searchId);
    if (remaining.length === open.document.savedSearches.length) return false;

    this.#open = {
      ...open,
      document: { ...open.document, savedSearches: remaining },
      dirty: true,
    };
    return true;
  }

  /** Case-insensitively, because two rows differing only in case are two rows nobody can tell apart. */
  #requireUniqueSearchName(
    existing: readonly SavedSearch[],
    name: string,
    exceptId: string | null
  ): void {
    const clash = existing.some(
      (entry) => entry.id !== exceptId && entry.name.toLowerCase() === name.toLowerCase()
    );
    if (clash) {
      throw duplicateSearchName();
    }
  }

  // ── Site rules ───────────────────────────────────────────────────────────────
  //
  // What a particular site will accept. Content on the document, like the saved searches
  // above, and keyed by registrable host rather than by an id — see `site-rules.ts` for why
  // the host being the identity is what makes two machines converge on the same rule instead
  // of keeping two.

  siteRules(): readonly SiteRule[] {
    return [...this.#requireOpen().document.siteRules].sort(bySiteRuleHost);
  }

  /**
   * Saves the rule for a site, replacing any rule already held for that host.
   *
   * **One upsert, not create-plus-update.** The host is the identity and it is derived from a
   * URL already on screen, so "remember this" and "change this" are the same gesture. A
   * `createSiteRule` that refused a duplicate host would force every caller to check first,
   * and that check would be a second copy of the identity rule.
   */
  setSiteRule(input: {
    /** A URL or a bare host. Normalised here, so a caller never has to know the rule. */
    readonly url: string;
    readonly options: Partial<GeneratorOptions>;
    readonly note?: string;
  }): SiteRule {
    const open = this.#requireOpen();

    const candidate = normaliseSiteRule({
      host: input.url,
      options: input.options,
      ...(input.note === undefined ? {} : { note: input.note }),
      // Never left alone: this is what the merge tie-breaks on, so an update that did not
      // stamp it would let the older of two edits win.
      updatedAt: Date.now(),
    });

    const problem = siteRuleProblem(candidate);
    if (problem !== null) throw invalidSiteRule(problem);

    const existing = open.document.siteRules;
    const replacing = existing.some((rule) => rule.host === candidate.host);
    // Checked only when adding. Correcting a rule on a vault that is already at the cap must
    // not be refused — the list is not growing.
    if (!replacing && existing.length >= SITE_RULE_MAX) throw tooManySiteRules(SITE_RULE_MAX);

    this.#open = {
      ...open,
      document: {
        ...open.document,
        siteRules: replacing
          ? existing.map((rule) => (rule.host === candidate.host ? candidate : rule))
          : [...existing, candidate],
      },
      dirty: true,
    };
    return candidate;
  }

  /** Forgets a site's rule. `false` when there was nothing to forget. */
  deleteSiteRule(host: string): boolean {
    const open = this.#requireOpen();
    const remaining = open.document.siteRules.filter((rule) => rule.host !== host);
    if (remaining.length === open.document.siteRules.length) return false;

    this.#open = {
      ...open,
      document: { ...open.document, siteRules: remaining },
      dirty: true,
    };
    return true;
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

  /**
   * Reads another copy of *this* vault, with the key already held. **Main-process only.**
   *
   * Uses the open vault's DEK, and that is the point rather than a convenience: a merge is
   * between two copies of one vault, and a genuinely different vault simply fails to decrypt.
   * The alternative — asking for a second password — would let somebody merge two unrelated
   * vaults together, which mixes two people's credentials into one file.
   *
   * Named `Unsafe` like its neighbours: what comes back is a whole decrypted document.
   */
  async readOtherCopyUnsafe(path: string): Promise<{ readonly document: VaultDocument }> {
    const open = this.#requireOpen();
    const bytes = await readVaultFile(path);
    const contents = readContainer(bytes, open.dek);
    return { document: parseVaultDocument(contents.body) };
  }

  /**
   * Re-reads the open vault from disk, keeping the key.
   *
   * For the case the watcher reports: another device — or another copy of this app through a
   * synced folder — wrote the file, and what is in memory is now the older story. There is no
   * password prompt because there is nothing to prove. The DEK is a property of the vault, not
   * of a session: another device that unlocked with the same password unwrapped the *same* DEK
   * and re-sealed the body with it, which is also why changing the master password is instant.
   * A file that will not open with the DEK in hand is not this vault.
   *
   * **Refuses when there are unsaved changes.** The caller is expected to have checked —
   * nothing offers this button while the vault is dirty — and that is exactly why the check is
   * repeated here. A reload is a read that destroys: the in-memory document is replaced
   * wholesale, and an edit that existed only there is gone with no undo, no tombstone and no
   * trace. Making the service refuse means "never lose data" survives a caller that forgets,
   * and survives an edit landing between the check and the call.
   *
   * **Refuses a different vault id.** `differentVault` in the watcher's report is the same
   * condition seen from the other side, and it is checked again here for the same reason. A
   * different id at this path means the file was replaced or restored from something
   * unrelated; reading it into this session would put two people's credentials behind one
   * master password. The header is read before the body is unsealed, so this costs nothing.
   *
   * Outstanding secret grants are revoked. They are keyed by record id, and after a reload a
   * record id either means something different or nothing at all — a grant that outlived the
   * document it was issued against is a reveal nobody asked for.
   */
  async reloadFromDisk(): Promise<VaultSummary> {
    const open = this.#requireOpen();
    if (open.dirty) throw unsavedChanges();

    const bytes = await readVaultFile(open.path);
    const { header } = readPreamble(bytes);
    if (header.vaultId !== open.header.vaultId) throw differentVault();

    const contents = readContainer(bytes, open.dek);
    const document = parseVaultDocument(contents.body);

    this.#broker.revokeAll();
    this.#open = {
      path: open.path,
      header,
      dek: open.dek,
      document,
      attachments: contents.attachments,
      dirty: false,
    };

    return this.summary();
  }

  /**
   * Changes the master password, or the KDF cost, or both, on the open vault.
   *
   * **The vault body is never re-encrypted, and that is the whole point of the envelope.**
   * The DEK that seals the records does not change, so a password change re-wraps one
   * 32-byte key and rewrites a header. A scheme that derived the body key from the password
   * directly would have to decrypt and re-encrypt every record and every attachment chunk —
   * minutes of work on a large vault, with a window in which the file is half-converted.
   *
   * **The current password is verified first, and that is not ceremony.** The vault is already
   * unlocked, so the DEK is in memory and the change would succeed without it. The check is
   * against somebody at an unattended machine: without it a passer-by sets a new master
   * password and the owner is locked out of their own vault permanently, because there is no
   * reset by design. It is verified by deriving and unwrapping rather than by comparing
   * anything stored, because nothing about the password is stored.
   *
   * **A fresh salt every time.** `newKdfParams` draws one; reusing the old salt would mean two
   * different passwords for this vault share it, and drawing a new one costs nothing.
   *
   * The write goes through the ordinary save path, so it is atomic, it rotates the backups and
   * it brackets the watcher. A password change is the last operation that should invent its
   * own write.
   *
   * The header is the AAD, so a new header means the body must be re-sealed under a fresh
   * nonce — which `writeContainer` does on every save regardless.
   */
  async changeMasterPassword(options: {
    readonly currentPassword: string;
    readonly newPassword: string;
    /** Omit to keep the vault's existing cost; supply to re-key at a new one. */
    readonly kdf?: Partial<Pick<KdfParams, 'memoryKib' | 'iterations' | 'parallelism'>>;
    readonly derive?: DeriveKeyFn;
  }): Promise<VaultSummary> {
    const open = this.#requireOpen();

    // Throws WRONG_PASSWORD if the current password does not unwrap the DEK. The result is
    // discarded — the DEK already in memory is the one re-wrapped below — so this call is
    // purely the check, and it deliberately runs before anything is generated or written.
    const proof = await unlockKeys(
      options.currentPassword,
      open.header.kdf,
      open.header.wrappedDek,
      options.derive
    );
    proof.dek.destroy();

    // The existing cost by default: changing a password and silently changing how long every
    // future unlock takes are two decisions, and only one of them was asked for.
    const kdf = newKdfParams({
      memoryKib: options.kdf?.memoryKib ?? open.header.kdf.memoryKib,
      iterations: options.kdf?.iterations ?? open.header.kdf.iterations,
      parallelism: options.kdf?.parallelism ?? open.header.kdf.parallelism,
    });

    const wrappedDek = await rewrapForNewPassword(
      open.dek,
      options.newPassword,
      kdf,
      options.derive
    );

    // Written into the open state before saving, so `#saveOnce` seals the body against the new
    // header — which it must, because the header is the AAD.
    this.#open = { ...this.#requireOpen(), header: { ...open.header, kdf, wrappedDek } };

    try {
      return await this.save();
    } catch (error) {
      // Nothing was written, so the file on disk still opens with the OLD password. The header
      // in memory has to go back to match it, or the next save would write a header describing
      // a key the user cannot derive. Only the header is reverted: an edit made while Argon2
      // was running belongs to the document, and reverting the whole open state would lose it.
      this.#open = { ...this.#requireOpen(), header: open.header };
      throw error;
    }
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
    // Additive, exactly like `folders` and `tags` above, which is why saved searches needed
    // no `documentVersion` bump: a vault written before they existed opens with none and
    // gains the field on its next save.
    //
    // Unusable entries are **dropped rather than repaired**, and that is the opposite of how
    // records are treated one line up. A record is the user's data and losing one silently is
    // unthinkable, so `normaliseRecord` refuses the whole file instead. A saved search is a
    // shortcut the user can recreate in ten seconds, and refusing to open a vault because one
    // of them has a malformed name would be a self-inflicted lockout over a bookmark.
    savedSearches: (Array.isArray(candidate.savedSearches) ? candidate.savedSearches : [])
      .filter((entry) => savedSearchProblem(entry) === null)
      .map((entry) => normaliseSavedSearch(entry as SavedSearch))
      .slice(0, SAVED_SEARCH_MAX),
    // Additive for the same reason, and behind one function rather than the four lines above
    // it: the cap, the drop-don't-refuse rule and the collapsing of duplicate hosts have to
    // hold wherever a rule list is read, and a `.keep` can be hand-edited, so "the UI enforces
    // it" would not be an enforcement at all. See `readSiteRules`.
    siteRules: readSiteRules(candidate.siteRules),
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
