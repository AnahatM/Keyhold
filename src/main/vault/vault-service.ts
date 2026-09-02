// SPDX-License-Identifier: GPL-3.0-or-later
import { basename } from 'node:path';
import type { KdfParams, KeepHeader, VaultContents } from '@shared/format/types.js';
import {
  isCustomFieldValueSecret,
  type Credential,
  type CredentialProjection,
  type SecretRef,
} from '@shared/model/credential.js';
import {
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

export class VaultService {
  #open: OpenVault | null = null;
  #broker = new SecretBroker();
  readonly #deviceId: string;

  constructor(deviceId: string = uuid()) {
    this.#deviceId = deviceId;
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

  async save(): Promise<VaultSummary> {
    const opened = this.#requireOpen();

    // Retention is enforced on save rather than on a timer, so a vault that is never opened
    // never loses anything. Measuring against wall-clock time while the app was closed
    // would mean reopening after a long break silently purges a trash the user never saw.
    const document = purgeExpiredTrash(opened.document, Date.now());
    const open = { ...opened, document };

    const header: KeepHeader = {
      ...open.header,
      modifiedAt: Date.now(),
      generation: open.header.generation + 1,
      deviceId: this.#deviceId,
      recordCount: open.document.records.length,
      attachmentCount: open.attachments.length,
    };

    const bytes = writeContainer(
      header,
      { body: serialiseVaultDocument(open.document), attachments: open.attachments },
      open.dek
    );

    await writeVaultFileAtomically(open.path, bytes);

    this.#open = { ...open, header, dirty: false };
    return this.summary();
  }

  // ── Reading, the safe way ──────────────────────────────────────────────────

  summary(): VaultSummary {
    const open = this.#requireOpen();
    return {
      vaultId: open.header.vaultId,
      path: open.path,
      displayName: basename(open.path).replace(/\.keep$/i, ''),
      createdAt: open.header.createdAt,
      modifiedAt: open.header.modifiedAt,
      generation: open.header.generation,
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
        // Non-secret values already reached the renderer in the projection, so asking for
        // one here is either redundant or a probe. Either way there is nothing to add.
        return isCustomFieldValueSecret(field) ? field.value : field.value;
      }
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
    return { newId: uuid, now: Date.now, settings: this.#requireOpen().document.settings };
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
    if (changedFields.length > 0) {
      this.#open = {
        ...open,
        document: replaceCredential(open.document, credential),
        dirty: true,
      };
    }
    return { projection: toProjection(credential), changedFields };
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

    const orphaned = new Set(existing.attachments.map((attachment) => attachment.id));
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
    records: candidate.records,
    folders: candidate.folders ?? [],
    tags: candidate.tags ?? [],
    settings: candidate.settings ?? emptyVaultDocument().settings,
  };
}
