// SPDX-License-Identifier: GPL-3.0-or-later
import { importMatchHost } from '@shared/model/import-plan.js';
import type { CustomField, CustomFieldType } from '@shared/model/credential.js';
import {
  folderAncestors,
  importFolderId,
  importWarning,
  type ImportWarning,
  type ImportWarningKind,
} from '@shared/model/import.js';
import type { NewCredentialInput } from '../vault/credential-ops.js';

/**
 * The normalisation layer every parser shares: how a loose pile of source columns becomes a
 * `NewCredentialInput`.
 *
 * This is where importers are usually lazy. The lazy version keeps title, username, password
 * and URL and throws everything else away, because everything else is awkward. The result is
 * a user who migrates, finds their security answers and account numbers gone, and has already
 * cancelled the old subscription. **Nothing is discarded here without the user being told the
 * column's name.**
 *
 * Parsers produce *drafts* and this module finishes them. Keeping the two apart is what lets
 * eleven formats share one definition of "a title is derived from the URL host when the
 * source had none" — rule 8 in `CLAUDE.md`: no second list.
 */

// ── Drafts ───────────────────────────────────────────────────────────────────

export interface DraftCustomField {
  readonly label: string;
  readonly value: string;
  readonly type: CustomFieldType;
  /** The user's "treat as sensitive" switch. Secret *types* carry themselves; see below. */
  readonly hidden: boolean;
}

/**
 * A record under construction. Mutable, deliberately — it is filled column by column and
 * then frozen into a `NewCredentialInput` by `finishDraft`.
 */
export interface DraftRecord {
  title: string;
  username: string;
  email: string;
  password: string;
  urls: string[];
  notes: string[];
  tags: string[];
  favorite: boolean;
  folderPath: string | null;
  custom: DraftCustomField[];
}

export function newDraft(): DraftRecord {
  return {
    title: '',
    username: '',
    email: '',
    password: '',
    urls: [],
    notes: [],
    tags: [],
    favorite: false,
    folderPath: null,
    custom: [],
  };
}

/**
 * Adds a custom field, skipping empty values.
 *
 * `hidden` defaults to false even for secret-looking fields, because the model already
 * answers that question: `isCustomFieldValueSecret` treats `password`, `pin` and `otp-secret`
 * as secret by type. Setting `hidden` as well would be a second source of truth for the same
 * fact, and the two would disagree the first time someone edited one of them.
 */
export function addCustom(
  draft: DraftRecord,
  label: string,
  value: string,
  type?: CustomFieldType,
  hidden = false
): void {
  if (value.trim() === '') return;
  draft.custom.push({
    label: label.trim() === '' ? 'Field' : label.trim(),
    value,
    type: type ?? guessCustomFieldType(label, value),
    hidden,
  });
}

export function addNote(draft: DraftRecord, note: string): void {
  if (note.trim() === '') return;
  draft.notes.push(note);
}

export function addUrls(draft: DraftRecord, value: string): void {
  for (const url of splitUrls(value)) {
    if (!draft.urls.includes(url)) draft.urls.push(url);
  }
}

export interface FinishOptions {
  /** Applied to every record in the import, on top of anything the source had. */
  readonly extraTags?: readonly string[];
}

/**
 * Freezes a draft into parser output, or returns `null` when there is nothing in it.
 *
 * Returning `null` rather than an empty record matters: a trailing blank row, a separator
 * line, or a row of commas would otherwise become an untitled credential in the user's
 * vault, and they would have to delete them by hand after every import.
 */
export function finishDraft(
  draft: DraftRecord,
  options: FinishOptions = {}
): NewCredentialInput | null {
  if (isEmptyDraft(draft)) return null;

  // Keyhold keeps `username` and `email` apart, and most login identifiers are email
  // addresses. Mirroring rather than moving is the point: `username` stays byte-identical to
  // what the source had, so "copy username" still types what the site expects, while `email`
  // gets populated for the search, grouping and health rules that read it. Leaving `email`
  // empty on every imported record would make those features useless on an imported vault,
  // which is most vaults.
  if (draft.email === '' && looksLikeEmail(draft.username)) draft.email = draft.username;

  const custom: CustomField[] = draft.custom.map((field, index) => ({
    // Record-scoped and deterministic. Ids only have to be unique *within* a record — the
    // reveal path addresses a value by (credential id, field id) — and a parser is a pure
    // function that must not mint a vault-wide identity for a record that may never be
    // committed. The commit stage may re-key these through `OpsContext.newId`.
    id: `imported-field-${index + 1}`,
    label: field.label,
    type: field.type,
    value: field.value,
    hidden: field.hidden,
    order: index,
  }));

  return {
    title: draft.title.trim() === '' ? deriveTitle(draft) : draft.title.trim(),
    username: draft.username,
    email: draft.email,
    password: draft.password,
    urls: draft.urls,
    notes: draft.notes.join('\n\n'),
    securityQuestions: [],
    custom,
    tags: [...draft.tags, ...(options.extraTags ?? [])],
    folderId: draft.folderPath === null ? null : importFolderId(draft.folderPath),
    favorite: draft.favorite,
  };
}

function isEmptyDraft(draft: DraftRecord): boolean {
  return (
    draft.title.trim() === '' &&
    draft.username === '' &&
    draft.email === '' &&
    draft.password === '' &&
    draft.urls.length === 0 &&
    draft.notes.length === 0 &&
    draft.custom.length === 0
  );
}

/**
 * A title for a record whose source had none.
 *
 * Order is by usefulness in a list: the site's hostname identifies a login better than the
 * username does, and either beats the literal word "Untitled" — which is what a user sees
 * for every Firefox row if nobody bothers, since Firefox's export has no title column at all.
 */
export function deriveTitle(draft: DraftRecord): string {
  for (const url of draft.urls) {
    const host = importMatchHost(url);
    if (host !== null) return host;
  }
  if (draft.username !== '') return draft.username;
  if (draft.email !== '') return draft.email;
  return 'Untitled';
}

/**
 * The registrable-ish host of a URL, or `null` if it does not look like one.
 *
 * Re-exported from `@shared/model/import-plan.ts`, which is where the dedupe rule reads it.
 * This file used to carry a behaviourally identical copy, and the copies mattered: the
 * dedupe rule decides whether two records are the *same account*, and the title derivation
 * decides what that account is called. Two functions answering "what host is this?" would
 * eventually answer differently, and the visible result would be an import that shows two
 * rows named the same thing while insisting they are not duplicates.
 *
 * The one difference between the two was that the shared version lower-cases an
 * `android://` package name and this one did not. Package names are lower-case by
 * convention, so nothing observable changed — but it is exactly the kind of drift that
 * accumulates unnoticed between two copies nobody diffs.
 */
export { importMatchHost as hostOf };

// ── Value shapes ─────────────────────────────────────────────────────────────

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SCHEME_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const BARE_DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$|\?)/i;
/**
 * Deliberately narrow: an international `+` prefix, or the grouped shape a phone number is
 * written in. A looser "digits and separators" pattern classified `4471-9902` — an account
 * number, in the fixtures — as a phone, which is the kind of quiet mislabelling that makes a
 * user distrust an import they cannot easily audit.
 */
const PHONE_PATTERN = /^\+\d[\d\s().-]{6,}$|^\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}([T ]|$)/;

export function looksLikeEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

export function looksLikeUrl(value: string): boolean {
  const trimmed = value.trim();
  return SCHEME_URL_PATTERN.test(trimmed) || BARE_DOMAIN_PATTERN.test(trimmed);
}

export function looksLikeOtpUri(value: string): boolean {
  return /^otpauth:\/\//i.test(value.trim());
}

/**
 * Splits a multi-URL cell.
 *
 * Newlines only. Splitting on commas as well is tempting and wrong: a comma is legal in a
 * query string, so it would quietly bisect real URLs — and the CSV layer has already dealt
 * with commas as *delimiters*, so a comma reaching here was inside quotes and is data.
 */
export function splitUrls(value: string): string[] {
  return value
    .split(/[\r\n]+/)
    .map((url) => url.trim())
    .filter((url) => url !== '');
}

/** Splits a tag or list cell. Managers use commas, semicolons or newlines interchangeably. */
export function splitList(value: string): string[] {
  return value
    .split(/[,;\r\n]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** Exports spell "true" as `1`, `true`, `yes` and `x`, sometimes within one file. */
export function isTruthy(value: string): boolean {
  return ['1', 'true', 'yes', 'y', 'x', 'on'].includes(value.trim().toLowerCase());
}

// ── Type guessing ────────────────────────────────────────────────────────────

/** Label words that mean "this value is a one-time-password seed". */
const OTP_LABEL = /\b(otp|totp|2fa|mfa|one time password|authenticator|token seed)\b/;
/** Label words that mean "short numeric secret". */
const PIN_LABEL = /\b(pin|passcode|cvv|cvc|cvn|security code|access code)\b/;
/** Label words that mean "long secret". Deliberately broad — a false positive only hides a value. */
const SECRET_LABEL =
  /\b(password|passphrase|secret|api key|apikey|private key|token|seed|recovery|licence key|license key|serial)\b/;
const EMAIL_LABEL = /\b(e ?mail)\b/;
const URL_LABEL = /\b(url|uri|website|web site|site|link|domain)\b/;
const PHONE_LABEL = /\b(phone|mobile|cell|tel|telephone|fax)\b/;
const DATE_LABEL = /\b(date|expiry|expiration|expires|birthday|dob|created|modified|renewal)\b/;
const ADDRESS_LABEL = /\b(address|street|postal|mailing)\b/;
const BOOLEAN_LABEL = /\b(enabled|disabled|active|archived|favou?rite|is [a-z]+)\b/;

/** Turns a header into something the label patterns can match: words, lower case, spaced. */
function labelWords(label: string): string {
  return ` ${label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

/**
 * Picks a `CustomFieldType` for a column that has no first-class home.
 *
 * **The secret checks come first, and they lose ties on purpose.** A column called `otp`,
 * `pin` or `secret` gets a secret type, which means the renderer never receives its value
 * (decision D13). Guessing "text" for something that turns out to be a TOTP seed puts that
 * seed in the projection; guessing "password" for something that turns out to be a display
 * name costs one extra click to reveal. Those errors are not the same size.
 */
export function guessCustomFieldType(label: string, value: string): CustomFieldType {
  const words = labelWords(label);
  const trimmed = value.trim();

  // An `otpauth://` value is unambiguous whatever the column is called, so it goes first.
  if (looksLikeOtpUri(trimmed)) return 'otp-secret';

  // **Every label check runs before every value-shape check.** The column name is what the
  // user chose; the value shape is a coincidence. `2027-03-01` in a column called `Renewal`
  // matches a loose phone pattern perfectly well, and letting shape win produced exactly that
  // wrong answer the first time this was written.
  if (OTP_LABEL.test(words)) return 'otp-secret';
  if (PIN_LABEL.test(words)) return 'pin';
  if (SECRET_LABEL.test(words)) return 'password';
  if (EMAIL_LABEL.test(words)) return 'email';
  if (URL_LABEL.test(words)) return 'url';
  if (DATE_LABEL.test(words)) return 'date';
  if (PHONE_LABEL.test(words)) return 'phone';
  if (ADDRESS_LABEL.test(words)) return 'address';
  if (BOOLEAN_LABEL.test(words) && /^(true|false|yes|no|0|1)$/i.test(trimmed)) return 'boolean';

  if (looksLikeEmail(trimmed)) return 'email';
  if (looksLikeUrl(trimmed)) return 'url';
  if (DATE_PATTERN.test(trimmed)) return 'date';
  if (PHONE_PATTERN.test(trimmed)) return 'phone';
  if (trimmed.includes('\n')) return 'multiline';
  if (/^\d+$/.test(trimmed) && trimmed.length <= 15) return 'number';
  return 'text';
}

// ── Warning collection ───────────────────────────────────────────────────────

/**
 * Accumulates warnings, and — the part that matters — collapses per-column complaints into
 * one line each.
 *
 * A 3,000-row export with one unmapped column would otherwise produce 3,000 identical
 * warnings, which is indistinguishable from no warnings at all: nobody reads that list, so
 * the loss it describes goes unnoticed. One line saying "column X had a value on 3,000 rows"
 * is read.
 */
export class WarningLog {
  private readonly entries: ImportWarning[] = [];
  private readonly columnCounts = new Map<string, { column: string; count: number }>();

  add(kind: ImportWarningKind, message: string, line?: number): void {
    this.entries.push(importWarning(kind, message, { line }));
  }

  /** Records that `column` carried a value on one more row, without emitting anything yet. */
  countColumn(column: string): void {
    const key = column.toLowerCase();
    const existing = this.columnCounts.get(key);
    if (existing === undefined) {
      this.columnCounts.set(key, { column, count: 1 });
      return;
    }
    existing.count += 1;
  }

  /** Emits one warning per counted column, then clears the counters. */
  flushColumns(kind: ImportWarningKind, describe: (column: string, count: number) => string): void {
    for (const { column, count } of this.columnCounts.values()) {
      this.entries.push(importWarning(kind, describe(column, count), { column }));
    }
    this.columnCounts.clear();
  }

  addAll(warnings: readonly ImportWarning[]): void {
    this.entries.push(...warnings);
  }

  get all(): readonly ImportWarning[] {
    return this.entries;
  }
}

// ── Folder collection ────────────────────────────────────────────────────────

/**
 * Collects folder paths, ancestors included, so the caller can create them in order.
 *
 * Sorting is what makes "in order" true: `A` sorts before `A/B` because `/` is the last
 * character compared, so a caller creating them in the returned order never needs a parent
 * that does not exist yet.
 */
export class FolderSet {
  private readonly paths = new Set<string>();

  add(path: string | null): void {
    if (path === null) return;
    for (const ancestor of folderAncestors(path)) this.paths.add(ancestor);
  }

  get all(): string[] {
    return [...this.paths].sort((a, b) => a.localeCompare(b));
  }
}
