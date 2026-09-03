// SPDX-License-Identifier: GPL-3.0-or-later
import { HEALTH_RULE_IDS } from '@shared/model/health.js';
import {
  AUDIT_PRIVACY_LEVELS,
  type AuditPrivacyLevel,
  type Credential,
} from '@shared/model/credential.js';
import type { Folder, Tag, VaultSettings } from '@shared/model/vault-document.js';
import type {
  AppliedSide,
  ConflictChoice,
  MergeConflict,
  MergeNote,
  MergeNoteKind,
} from '@shared/model/sync.js';
import { conflictId, plainSide } from './conflict-projection.js';
import { orderIds, resolveValue } from './merge-values.js';
import { canonicallyFirst, largerCap, sameValue } from './stable-value.js';

/**
 * Everything in a vault that is **not** a record: folders, the tag palette, saved searches,
 * site rules, and vault settings.
 *
 * Each needs its own policy, for the same reason: none of them has a tombstone. A record that
 * vanishes from one side might have
 * been deleted or might never have arrived, and `trashedAt` is what settles it. A folder that
 * vanishes has no such marker, so the merge has only the ancestor to go on.
 *
 * ## Folders and tags: the ancestor decides, and absence alone never deletes
 *
 * With an ancestor, "present in the ancestor, gone from one side, untouched on the other" is a
 * deletion and is honoured. Without one — a two-way merge — the result is the union, because
 * the alternative is deleting a folder on the evidence of nothing.
 *
 * Then there is a second pass, `repairFolderTree`, that exists because folders are *referenced*.
 * Honouring a folder deletion while another device was still filing records into it would
 * leave records pointing at nothing; that pass resurrects the folder instead, and only unfiles
 * a record when the folder exists nowhere at all. Losing a password's grouping is a small harm
 * and losing it silently is a larger one, so it is reported either way.
 *
 * ## Settings: always decided, never blocking
 *
 * Every settings disagreement resolves by policy, and the policies all point the same way —
 * toward the answer that keeps more data or reveals less. That is a deliberate departure from
 * how record fields are handled, and the reason is that settings are preferences, not content:
 * a merge that refuses to complete until someone picks a password-age warning threshold is a
 * merge people learn to click through without reading, which is how a real conflict gets
 * dismissed. Every one is still reported.
 */

import {
  bySavedSearchOrder,
  SAVED_SEARCH_MAX,
  type SavedSearch,
} from '@shared/model/saved-search.js';
import {
  bySiteRuleHost,
  readSiteRules,
  SITE_RULE_MAX,
  type SiteRule,
} from '@shared/model/site-rules.js';

interface Keyed {
  readonly id: string;
}

function indexById<T extends Keyed>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

/**
 * `indexById` for a list that deliberately contains the *same id more than once*.
 *
 * The resurrection pool is the ancestor's folders plus both sides' folders concatenated, so
 * one folder id can arrive three times with three different names. `indexById` keeps whichever
 * copy came last, which makes the answer depend on the order the caller happened to
 * concatenate the documents in — and therefore on which document was passed first. That is
 * precisely the kind of quiet asymmetry the commutativity property exists to catch.
 *
 * The canonically smaller definition wins instead: arbitrary, but identical whichever
 * direction the merge ran in.
 */
function canonicalIndexById<T extends Keyed>(items: readonly T[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const item of items) {
    const existing = index.get(item.id);
    index.set(item.id, existing === undefined ? item : canonicallyFirst(existing, item));
  }
  return index;
}

/**
 * The shape shared by the folder and tag merges: which entries survive, and in what order.
 *
 * The per-property resolution differs between the two, so it is supplied as `mergeBoth`. The
 * survival rules do not differ at all, and having them in one place is what stops folders and
 * tags from drifting into two subtly different answers to the same question.
 */
function mergeCollection<T extends Keyed>(
  base: readonly T[] | null,
  ours: readonly T[],
  theirs: readonly T[],
  mergeBoth: (id: string, ancestor: T | undefined, mine: T, yours: T) => T,
  note: (kind: MergeNoteKind, id: string) => void,
  kinds: { readonly added: MergeNoteKind; readonly kept: MergeNoteKind }
): T[] {
  // The three cases where nothing was combined, short-circuited so an untouched collection
  // comes back untouched — which is what makes `merge(x, x)` return `x`.
  if (sameValue(ours, theirs)) return [...ours];
  if (base !== null) {
    if (sameValue(ours, base)) {
      // We did not touch the collection, so their version is the edit and is taken wholesale.
      // The arrivals are still reported: a short-circuit is a shortcut through the *work*, not
      // through the report, and a folder appearing in someone's sidebar unannounced is exactly
      // the kind of silent change that makes people stop trusting a sync.
      const ourIds = new Set(ours.map((item) => item.id));
      for (const item of theirs) {
        if (!ourIds.has(item.id)) note(kinds.added, item.id);
      }
      return [...theirs];
    }
    // The mirror of the branch above needs no notes: everything surviving is already ours, so
    // from this device's point of view nothing arrived. `*-added` is deliberately a statement
    // about *our* copy, exactly as `record-added` is in `merge-document.ts`.
    if (sameValue(theirs, base)) return [...ours];
  }

  const baseIndex = base === null ? null : indexById(base);
  const ourIndex = indexById(ours);
  const theirIndex = indexById(theirs);

  const surviving = new Map<string, T>();
  for (const id of new Set([
    ...(baseIndex?.keys() ?? []),
    ...ourIndex.keys(),
    ...theirIndex.keys(),
  ])) {
    const mine = ourIndex.get(id);
    const yours = theirIndex.get(id);
    const ancestor = baseIndex?.get(id);

    if (mine !== undefined && yours !== undefined) {
      surviving.set(id, mergeBoth(id, ancestor, mine, yours));
      continue;
    }
    const present = mine ?? yours;
    if (present === undefined) continue; // Gone from both sides relative to the ancestor.

    if (ancestor !== undefined) {
      if (sameValue(present, ancestor)) continue; // Untouched here, deleted there.
      // Deleted on one side, renamed or moved on the other. Keep it: a folder is trivially
      // deleted again, and a folder deleted out from under a record is a filing system that
      // rearranges itself.
      surviving.set(id, present);
      note(kinds.kept, id);
      continue;
    }
    surviving.set(id, present);
    if (mine === undefined) note(kinds.added, id);
  }

  const order = orderIds(
    new Set(surviving.keys()),
    ours.map((item) => item.id),
    theirs.map((item) => item.id),
    base === null ? null : base.map((item) => item.id)
  );

  const items: T[] = [];
  for (const id of order) {
    const item = surviving.get(id);
    if (item !== undefined) items.push(item);
  }
  return items;
}

export interface CollectionMerge<T> {
  readonly items: readonly T[];
  readonly conflicts: readonly MergeConflict[];
  readonly notes: readonly MergeNote[];
}

// ── Folders ──────────────────────────────────────────────────────────────────

export function mergeFolders(
  base: readonly Folder[] | null,
  ours: readonly Folder[],
  theirs: readonly Folder[],
  resolutions: ReadonlyMap<string, ConflictChoice>
): CollectionMerge<Folder> {
  const conflicts: MergeConflict[] = [];
  const notes: MergeNote[] = [];

  const items = mergeCollection<Folder>(
    base,
    ours,
    theirs,
    (id, ancestor, mine, yours) => ({
      id,
      name: pick(
        id,
        'name',
        ancestor?.name,
        mine.name,
        yours.name,
        'folder',
        resolutions,
        conflicts
      ),
      parentId: pick(
        id,
        'parentId',
        ancestor?.parentId,
        mine.parentId,
        yours.parentId,
        'folder',
        resolutions,
        conflicts
      ),
      order: pick(
        id,
        'order',
        ancestor?.order,
        mine.order,
        yours.order,
        'folder',
        resolutions,
        conflicts
      ),
    }),
    (kind, id) => notes.push({ kind, targetId: id, count: null }),
    { added: 'folder-added', kept: 'folder-kept-unmatched' }
  );

  return { items, conflicts, notes };
}

// ── The tag palette ──────────────────────────────────────────────────────────

/**
 * The palette — `{ id, name, colour }` — not a record's tag strings.
 *
 * The two are deliberately merged by different rules and it is worth being explicit about
 * why. A record's `tags` are a **set**, merged element-wise with no possible conflict. The
 * palette is a table of *definitions*, where two devices can genuinely give the same tag two
 * colours, and that is a disagreement only a person can settle.
 */
export function mergeTagPalette(
  base: readonly Tag[] | null,
  ours: readonly Tag[],
  theirs: readonly Tag[],
  resolutions: ReadonlyMap<string, ConflictChoice>
): CollectionMerge<Tag> {
  const conflicts: MergeConflict[] = [];
  const notes: MergeNote[] = [];

  const items = mergeCollection<Tag>(
    base,
    ours,
    theirs,
    (id, ancestor, mine, yours) => ({
      id,
      name: pick(id, 'name', ancestor?.name, mine.name, yours.name, 'tag', resolutions, conflicts),
      colour: pick(
        id,
        'colour',
        ancestor?.colour,
        mine.colour,
        yours.colour,
        'tag',
        resolutions,
        conflicts
      ),
    }),
    (kind, id) => notes.push({ kind, targetId: id, count: null }),
    { added: 'tag-added', kept: 'tag-kept-unmatched' }
  );

  return { items, conflicts, notes };
}

/**
 * Saved searches, merged element-wise like the tag palette.
 *
 * Through `mergeCollection` rather than beside it, which is the whole reason that function
 * was factored out: the survival rules for a named thing with an id do not vary by what the
 * thing is, and three collections answering "does absence delete?" differently would be
 * three chances to get the hardest question in the merge wrong.
 *
 * **The tie-break is `updatedAt`, not `pick`.** Folders and tags resolve property by property
 * and raise a conflict the user has to settle, because a folder edited on both machines has
 * two names that both mean something. A saved search is one thing — a name attached to a
 * query — and splitting it would produce the one outcome that is worse than either side:
 * this machine's name over that machine's query, a shortcut labelled "Banking" that searches
 * for expiring passwords. So the later edit wins whole, and the user is told it happened
 * rather than asked which half they wanted.
 *
 * That is a deliberate loss of one edit, and it is affordable here for the reason the parser
 * gives for dropping malformed entries: a saved search is a shortcut its owner can rebuild in
 * ten seconds, and a record is not.
 */
export function mergeSavedSearches(
  base: readonly SavedSearch[] | null,
  ours: readonly SavedSearch[],
  theirs: readonly SavedSearch[]
): CollectionMerge<SavedSearch> {
  const notes: MergeNote[] = [];

  const items = mergeCollection<SavedSearch>(
    base,
    ours,
    theirs,
    (_id, _ancestor, mine, yours) => (yours.updatedAt > mine.updatedAt ? yours : mine),
    (kind, id) => notes.push({ kind, targetId: id, count: null }),
    { added: 'saved-search-added', kept: 'saved-search-kept-unmatched' }
  );

  // Capped after merging, not before. Two machines each holding a legal number can combine
  // to exceed it, and the cap exists so the sidebar stays scannable — it is not a claim about
  // either input being wrong. Sorted first so what survives is deterministic rather than
  // whichever side happened to be walked first.
  const ordered = [...items].sort(bySavedSearchOrder);

  return { items: ordered.slice(0, SAVED_SEARCH_MAX), conflicts: [], notes };
}

// ── Site rules ───────────────────────────────────────────────────────────────

/**
 * Remembered per-site password policies, merged element-wise and keyed on the **host**.
 *
 * ## Host, not an id, and still through `mergeCollection`
 *
 * `SiteRule` has no `id` and deliberately never will — `site-rules.ts` carries that argument in
 * full, and the short version is that the host already *is* the identity, so a second one would
 * let the model hold two rules for `bank.example` of which `ruleForUrl` silently applies one.
 *
 * That leaves a choice between adding an id purely to satisfy `mergeCollection`'s
 * `{ id: string }` constraint, and writing a host-keyed merge beside it. Both are wrong. The
 * first corrupts the model to please a function signature, and it would make two machines that
 * independently discovered the same constraint keep **both** rules — the one outcome a
 * host-keyed model exists to avoid. The second is the duplicate hard rule 8 forbids, and of all
 * the code in this file `mergeCollection` is the worst to have two of: it is the single place
 * that answers "does absence delete?", and a second answer to that is how a merge loses data.
 *
 * So neither. The rules are lifted into `{ id: host, rule }` for the length of the call and
 * dropped back out. Three lines, no new survival rules, and the stored model keeps one identity.
 *
 * ## Both sides edited the same host: the later edit wins, whole
 *
 * `mergeSavedSearches`' policy, for `mergeSavedSearches`' reason. Resolving `options` and `note`
 * independently would produce this machine's note over that machine's constraint — "rejects
 * symbols" attached to a 16-character limit — which is worse than either side's version and
 * would go unnoticed until a password was rejected. And no conflict is raised: asking somebody
 * to adjudicate two password policies in the middle of a merge that may also be asking about
 * real credentials spends their attention on the cheapest thing in the file.
 *
 * The one place this is stricter than `mergeSavedSearches` is an exact tie. Two rules stamped
 * in the same millisecond — which is not exotic, since copying a vault stamps a whole list at
 * once — fall through to `canonicallyFirst` rather than to "mine", so `merge(a, b)` and
 * `merge(b, a)` agree. A tie-break that depended on argument order would make a sync's outcome
 * depend on which machine pressed the button.
 */
export function mergeSiteRules(
  base: readonly SiteRule[] | null,
  ours: readonly SiteRule[],
  theirs: readonly SiteRule[]
): CollectionMerge<SiteRule> {
  const notes: MergeNote[] = [];

  // `readSiteRules` rather than a bare map, and not for tidiness. A duplicated host would make
  // `indexById` below keep whichever copy came last, which is both silent and dependent on the
  // order the caller concatenated its documents in. The parser already collapses duplicates on
  // the way in from a file; doing it here too means the engine is total on any input, including
  // a document handed to it by a test, an import, or a build we have not written.
  const keyed = (rules: readonly SiteRule[]): KeyedSiteRule[] =>
    readSiteRules(rules).map((rule) => ({ id: rule.host, rule }));

  const items = mergeCollection<KeyedSiteRule>(
    base === null ? null : keyed(base),
    keyed(ours),
    keyed(theirs),
    (id, _ancestor, mine, yours) => ({ id, rule: laterRule(mine.rule, yours.rule) }),
    (kind, id) => notes.push({ kind, targetId: id, count: null }),
    { added: 'site-rule-added', kept: 'site-rule-kept-unmatched' }
  );

  const rules = items.map((entry) => entry.rule);
  // Capped after merging, because two vaults each holding a legal number can combine to exceed
  // it — the cap is a bound on the file, not a claim that either input was wrong.
  //
  // Sorted only when the cap actually bites, unlike `mergeSavedSearches`, which sorts
  // unconditionally. Sorting a list that fits would make `merge(x, x)` return `x` reordered,
  // and the whole point of that property is that syncing with a device that has nothing new is
  // a no-op rather than a rewrite of the file.
  if (rules.length <= SITE_RULE_MAX) return { items: rules, conflicts: [], notes };
  return {
    items: [...rules].sort(bySiteRuleHost).slice(0, SITE_RULE_MAX),
    conflicts: [],
    notes,
  };
}

/** A rule under its own host, for the length of one `mergeCollection` call. */
interface KeyedSiteRule extends Keyed {
  readonly rule: SiteRule;
}

/** The later edit, or — on an exact tie — the canonically smaller one, so the merge commutes. */
function laterRule(mine: SiteRule, yours: SiteRule): SiteRule {
  if (yours.updatedAt > mine.updatedAt) return yours;
  if (mine.updatedAt > yours.updatedAt) return mine;
  return canonicallyFirst(mine, yours);
}

/**
 * One property of one folder or palette tag.
 *
 * Every value it handles is a name, a colour token, a parent id or an ordinal — nothing in
 * either model can hold credential material, which is why these cross as plain values while a
 * record field goes through the history projector.
 */
function pick<T extends string | number | null>(
  targetId: string,
  property: string,
  ancestor: T | undefined,
  mine: T,
  yours: T,
  kind: 'folder' | 'tag',
  resolutions: ReadonlyMap<string, ConflictChoice>,
  conflicts: MergeConflict[]
): T {
  const id =
    kind === 'folder' ? conflictId.folder(targetId, property) : conflictId.tag(targetId, property);
  const outcome = resolveValue(ancestor === undefined ? null : { value: ancestor }, mine, yours);
  if (!outcome.conflict) return outcome.value;

  const choice = resolutions.get(id);
  const value = choice === 'theirs' ? yours : mine;
  const applied: AppliedSide = choice === 'theirs' ? 'theirs' : 'ours';
  conflicts.push({
    id,
    kind,
    targetId,
    field: property,
    ours: plainSide(mine),
    theirs: plainSide(yours),
    base: ancestor === undefined ? null : plainSide(ancestor),
    applied,
    resolution: choice === undefined ? 'unresolved' : 'user',
  });
  return value;
}

// ── Referential integrity of the folder tree ─────────────────────────────────

export interface FolderRepair {
  readonly folders: readonly Folder[];
  readonly records: readonly Credential[];
  readonly notes: readonly MergeNote[];
}

/**
 * Puts the folder tree back into a state the UI can render, after the merge has decided what
 * survives.
 *
 * Three things can be wrong at this point, and all three are produced by perfectly reasonable
 * per-side decisions:
 *
 *  - **A record files into a folder that did not survive.** One device deleted the folder
 *    while the other filed a record into it. The folder is *resurrected* from whichever side
 *    still remembers it, because a deleted folder is one click to delete again and a vault
 *    whose records silently fall out of their folders is not.
 *  - **A folder's parent did not survive.** It is moved to the root rather than dropped —
 *    losing the nesting is recoverable, losing the folder is not.
 *  - **The tree contains a cycle.** Two devices reparenting each other's folders can produce
 *    `A → B → A`, which no per-side decision is wrong to have made and which would hang any
 *    renderer that walks parents. One link is cut, at the canonically smallest id in the
 *    cycle, so the same cut is made whichever direction the merge ran in.
 *
 * Every repair is reported. A merge that silently rearranges someone's filing is exactly the
 * kind of thing that makes people stop trusting sync.
 */
export function repairFolderTree(
  folders: readonly Folder[],
  records: readonly Credential[],
  pool: readonly Folder[]
): FolderRepair {
  const notes: MergeNote[] = [];
  const known = new Map(folders.map((folder) => [folder.id, folder]));
  const available = canonicalIndexById(pool);

  // 1. Resurrect folders that surviving records still live in.
  const resurrected: Folder[] = [];
  for (const record of records) {
    const { folderId } = record;
    if (folderId === null || known.has(folderId)) continue;
    const recovered = available.get(folderId);
    if (recovered === undefined) continue;
    known.set(folderId, recovered);
    resurrected.push(recovered);
    notes.push({ kind: 'folder-resurrected', targetId: folderId, count: null });
  }
  // Appended in id order rather than interleaved, so the result does not depend on the order
  // records happened to be visited in.
  const withResurrected = [...folders, ...resurrected.sort((a, b) => (a.id < b.id ? -1 : 1))];

  // 2. Unfile records whose folder exists nowhere at all.
  const repairedRecords = records.map((record) => {
    if (record.folderId === null || known.has(record.folderId)) return record;
    notes.push({ kind: 'record-unfiled', targetId: record.id, count: null });
    return { ...record, folderId: null };
  });

  // 3. Reparent folders whose parent did not survive, then break any cycle.
  const rooted = withResurrected.map((folder) => {
    if (folder.parentId === null || known.has(folder.parentId)) return folder;
    notes.push({ kind: 'folder-reparented', targetId: folder.id, count: null });
    return { ...folder, parentId: null };
  });

  const cut = breakCycles(rooted);
  for (const id of cut.broken) {
    notes.push({ kind: 'folder-cycle-broken', targetId: id, count: null });
  }

  return { folders: cut.folders, records: repairedRecords, notes };
}

function breakCycles(folders: readonly Folder[]): {
  readonly folders: readonly Folder[];
  readonly broken: readonly string[];
} {
  const parents = new Map(folders.map((folder) => [folder.id, folder.parentId]));
  const broken = new Set<string>();

  for (const folder of folders) {
    const seen = new Set<string>([folder.id]);
    let current = parents.get(folder.id) ?? null;
    while (current !== null && !broken.has(current)) {
      if (seen.has(current)) {
        // Cut at the canonically smallest id in the loop: a deterministic, side-independent
        // choice, so `merge(a, b)` and `merge(b, a)` cut the same link.
        const victim = [...seen].sort()[0];
        if (victim !== undefined) {
          broken.add(victim);
          parents.set(victim, null);
        }
        break;
      }
      seen.add(current);
      current = parents.get(current) ?? null;
    }
  }

  if (broken.size === 0) return { folders, broken: [] };
  return {
    folders: folders.map((folder) =>
      broken.has(folder.id) ? { ...folder, parentId: null } : folder
    ),
    broken: [...broken].sort(),
  };
}

// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * Which direction each setting resolves when the two sides disagree.
 *
 * A `Record` over `keyof VaultSettings`, so a new setting cannot be added without deciding
 * what a merge does with it — and a test walks this table and asserts the implementation
 * below actually moves in the direction named here, because a table nothing reads is a
 * comment that lies.
 */
export const SETTING_POLICY = {
  /** Off wins: recording history is a privacy decision, and the quieter answer cannot surprise. */
  historyEnabledByDefault: 'history-off',
  /**
   * Off wins, for the same reason and one more.
   *
   * Same privacy argument as above — a merge may not start recording more about somebody than
   * either of their devices was. The extra reason is that this setting is about what *this*
   * merge writes, so resolving it toward "record" would mean a merge deciding to record itself
   * on the strength of a preference the other device holds.
   */
  historyRecordsMerges: 'history-off',
  /** The larger cap wins (`null` is unlimited): keeping more history destroys nothing. */
  historyMaxVersions: 'larger-cap',
  /** The less revealing level wins: capture is irreversible, and the file travels. */
  auditPrivacyLevel: 'more-private',
  /** The earlier warning wins: being told sooner is a nag, being told later is a gap. */
  passwordAgeWarningDays: 'warn-sooner',
  /** The longer retention wins (`null` is never purge): trash that survives can be restored. */
  trashRetentionDays: 'larger-cap',
  /**
   * The stricter configuration wins, field by field.
   *
   * A rule enabled on either side stays enabled, the lower `weakEntropyBits` threshold is
   * taken and the longer `expiringWithinDays` warning is — every one of which resolves toward
   * *more* warning rather than less. A health setting is advice, so a merge that quietly
   * silenced a warning one device was giving would be the one direction with a cost.
   */
  health: 'stricter-wins',
  /**
   * The larger cap wins, field by field.
   *
   * Same reasoning as `historyMaxVersions` and `trashRetentionDays`: the direction that
   * cannot cost the user anything. A smaller cap costs them the ability to attach a file
   * they could attach yesterday; a larger one costs nothing, because `resolveAttachmentLimits`
   * still refuses anything above the container's own ceiling at the moment it is used.
   *
   * Taking each field's maximum independently also preserves the invariant that the vault
   * total is at least the per-file cap: if both sides were individually valid, the pairwise
   * maxima are too.
   */
  attachments: 'larger-cap',
  /**
   * Off wins, and the pacing settles toward the gentler number.
   *
   * The opposite direction from every cap above, and deliberately: enabling a network
   * feature is not something a merge may do on a user's behalf. If either device says no,
   * the answer is no — the same reasoning as `historyEnabledByDefault`, where the quieter
   * answer is the one that cannot surprise anybody.
   *
   * The two timings take the *slower* interval and the *longer* timeout, because both spend
   * someone else's free, unauthenticated API and the merge should not silently make a vault
   * more demanding of it than either device was.
   */
  breachCheck: 'off-and-gentler',
} as const satisfies Readonly<Record<keyof VaultSettings, string>>;

export interface SettingsMerge {
  readonly settings: VaultSettings;
  readonly conflicts: readonly MergeConflict[];
}

export function mergeSettings(
  base: VaultSettings | null,
  ours: VaultSettings,
  theirs: VaultSettings,
  resolutions: ReadonlyMap<string, ConflictChoice>
): SettingsMerge {
  const conflicts: MergeConflict[] = [];

  const settle = <T extends string | number | boolean | null>(
    key: keyof VaultSettings,
    mine: T,
    yours: T,
    ancestor: T | undefined,
    policy: T
  ): T => {
    const outcome = resolveValue(ancestor === undefined ? null : { value: ancestor }, mine, yours);
    if (!outcome.conflict) return outcome.value;

    const id = conflictId.setting(key);
    const choice = resolutions.get(id);
    const value = choice === 'ours' ? mine : choice === 'theirs' ? yours : policy;
    conflicts.push({
      id,
      kind: 'setting',
      targetId: key,
      field: null,
      ours: plainSide(mine),
      theirs: plainSide(yours),
      base: ancestor === undefined ? null : plainSide(ancestor),
      applied: sameValue(value, mine) ? 'ours' : 'theirs',
      resolution: choice === undefined ? 'policy' : 'user',
    });
    return value;
  };

  // Health is the one compound setting, and it is reconciled field by field rather than
  // settled as a whole. A whole-object `settle` would ask the user to choose between two
  // configurations when every field has an answer that cannot cost them anything: a rule
  // enabled on either side stays enabled, and both thresholds take the value that warns
  // more. A health setting is *advice*, so the only direction with a real cost is a merge
  // that quietly silences a warning one device was giving.
  // No conflict entry, and that is a decision rather than an omission. `ConflictSide`
  // carries a scalar, because a resolver's whole job is to offer a user one value or the
  // other — and there is no version of that question here: every field of `health` has an
  // answer that cannot cost anything. Reporting it as a conflict would put a choice in front
  // of someone that has already been made correctly on their behalf.
  // Attachments are the second compound setting, and settled the same way and for the same
  // reason: every field has an answer that cannot cost anything, so asking the user to
  // choose between two configurations would be putting a question in front of them that has
  // already been answered correctly on their behalf. No conflict entry, deliberately —
  // `ConflictSide` carries a scalar, and there is no scalar question here.
  // The third compound setting, settled field by field like the other two and with no
  // conflict entry for the same reason: `ConflictSide` carries a scalar, and every field
  // here has an answer that cannot cost the user anything.
  const mergedBreachCheck: VaultSettings['breachCheck'] = {
    // `&&`, not `||`. Either device saying no is a no.
    enabled: ours.breachCheck.enabled && theirs.breachCheck.enabled,
    requestIntervalMs: Math.max(
      ours.breachCheck.requestIntervalMs,
      theirs.breachCheck.requestIntervalMs
    ),
    requestTimeoutMs: Math.max(
      ours.breachCheck.requestTimeoutMs,
      theirs.breachCheck.requestTimeoutMs
    ),
  };

  const mergedAttachments: VaultSettings['attachments'] = {
    maxAttachmentBytes: Math.max(
      ours.attachments.maxAttachmentBytes,
      theirs.attachments.maxAttachmentBytes
    ),
    maxVaultAttachmentBytes: Math.max(
      ours.attachments.maxVaultAttachmentBytes,
      theirs.attachments.maxVaultAttachmentBytes
    ),
    // The warning threshold is the exception to "larger wins": it is advice, not a limit, and
    // the lower value warns *more*. Same direction as the health thresholds, for the same
    // reason — a merge that quietly silenced a warning one device was giving is the one
    // outcome with a cost.
    warnAboveBytes: Math.min(ours.attachments.warnAboveBytes, theirs.attachments.warnAboveBytes),
    maxAttachmentsPerRecord: Math.max(
      ours.attachments.maxAttachmentsPerRecord,
      theirs.attachments.maxAttachmentsPerRecord
    ),
  };

  const mergedHealth: VaultSettings['health'] = {
    enabledRules: Object.fromEntries(
      HEALTH_RULE_IDS.map((rule) => [
        rule,
        ours.health.enabledRules[rule] || theirs.health.enabledRules[rule],
      ])
    ) as VaultSettings['health']['enabledRules'],
    weakEntropyBits: Math.max(ours.health.weakEntropyBits, theirs.health.weakEntropyBits),
    expiringWithinDays: Math.max(ours.health.expiringWithinDays, theirs.health.expiringWithinDays),
  };

  return {
    settings: {
      health: mergedHealth,
      attachments: mergedAttachments,
      breachCheck: mergedBreachCheck,
      historyEnabledByDefault: settle(
        'historyEnabledByDefault',
        ours.historyEnabledByDefault,
        theirs.historyEnabledByDefault,
        base?.historyEnabledByDefault,
        false
      ),
      historyRecordsMerges: settle(
        'historyRecordsMerges',
        ours.historyRecordsMerges,
        theirs.historyRecordsMerges,
        base?.historyRecordsMerges,
        false
      ),
      historyMaxVersions: settle(
        'historyMaxVersions',
        ours.historyMaxVersions,
        theirs.historyMaxVersions,
        base?.historyMaxVersions,
        largerCap(ours.historyMaxVersions, theirs.historyMaxVersions)
      ),
      auditPrivacyLevel: settle(
        'auditPrivacyLevel',
        ours.auditPrivacyLevel,
        theirs.auditPrivacyLevel,
        base?.auditPrivacyLevel,
        lessRevealing(ours.auditPrivacyLevel, theirs.auditPrivacyLevel)
      ),
      passwordAgeWarningDays: settle(
        'passwordAgeWarningDays',
        ours.passwordAgeWarningDays,
        theirs.passwordAgeWarningDays,
        base?.passwordAgeWarningDays,
        Math.min(ours.passwordAgeWarningDays, theirs.passwordAgeWarningDays)
      ),
      trashRetentionDays: settle(
        'trashRetentionDays',
        ours.trashRetentionDays,
        theirs.trashRetentionDays,
        base?.trashRetentionDays,
        largerCap(ours.trashRetentionDays, theirs.trashRetentionDays)
      ),
    },
    conflicts,
  };
}

/** `AUDIT_PRIVACY_LEVELS` is ordered from least to most revealing, so the lower index wins. */
export function lessRevealing(a: AuditPrivacyLevel, b: AuditPrivacyLevel): AuditPrivacyLevel {
  return AUDIT_PRIVACY_LEVELS.indexOf(a) <= AUDIT_PRIVACY_LEVELS.indexOf(b) ? a : b;
}
