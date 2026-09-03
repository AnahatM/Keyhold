// SPDX-License-Identifier: GPL-3.0-or-later
import type { ConflictChoice } from '@shared/model/sync.js';
import { canonicallyFirst, sameValue } from './stable-value.js';

/**
 * The three value-merge shapes every part of this engine is built from: a scalar, a list
 * keyed by id, and a set of tags.
 *
 * Everything above this file — records, folders, tags, settings — is a matter of deciding
 * *which* of these three a given field is, and then reporting what came back. Keeping the
 * rules in one place is what makes "why did the merge do that?" answerable by reading one
 * short file instead of tracing four.
 *
 * ## No function in this file looks at a clock
 *
 * That is the point, and it is worth stating as a rule rather than leaving as an observation.
 * Last-write-wins is the obvious way to merge two records and it is a trap: two machines'
 * clocks disagree, often by minutes and occasionally by years, and nothing tells you which is
 * right. A device with a fast clock does not win once — it wins *every* conflict, forever,
 * silently, on every field. The user sees a vault that keeps reverting and no error anywhere.
 *
 * So a timestamp never decides a winner here. Where one side changed and the other did not,
 * the ancestor says so and there is nothing to decide. Where both changed, the answer is a
 * conflict the user is shown. The engine does carry timestamps *through* a merge —
 * `updatedAt`, `createdAt`, `lastUsedAt` — but only ever by `min` or `max`, which are
 * commutative and cannot be gamed by a skewed clock into overwriting content.
 */

/**
 * The common ancestor's value, or `null` when there is no ancestor.
 *
 * A wrapper rather than `T | undefined`, because a field's value may legitimately *be*
 * `undefined` or `null`, and "the ancestor held null" and "there was no ancestor" lead to
 * opposite decisions. Collapsing them is exactly the bug that resurrects deleted data.
 */
export type Ancestor<T> = { readonly value: T } | null;

export interface ValueResolution<T> {
  readonly value: T;
  /** True when both sides changed this away from the ancestor, differently. */
  readonly conflict: boolean;
  /** Which side the value in `value` came from. Meaningless when the sides agree. */
  readonly from: ConflictChoice;
}

/**
 * Three-way (or two-way) resolution of a single value.
 *
 * The whole of the merge policy for scalars, in five lines:
 *
 *  1. The sides agree → done, and there was never a decision to make.
 *  2. Ours matches the ancestor → we did not touch it, so theirs is the edit. Take theirs.
 *  3. Theirs matches the ancestor → symmetric. Take ours.
 *  4. Both moved, differently → **conflict**. The returned value is provisional.
 *  5. No ancestor → rule 1, then straight to rule 4. Two-way cannot tell an edit from a
 *     stale copy, so it must not pretend to.
 *
 * The provisional value for a conflict is *ours*. That choice is not a resolution and is not
 * presented as one: `MergeResolution` records it as `'unresolved'`, and a report with an
 * unresolved conflict sets `requiresResolution`, which the caller must not write past. Ours
 * is used rather than theirs only so the merged document is a complete, valid document the UI
 * can render while the user decides — a half-populated record would be worse in every way.
 */
export function resolveValue<T>(base: Ancestor<T>, ours: T, theirs: T): ValueResolution<T> {
  if (sameValue(ours, theirs)) return { value: ours, conflict: false, from: 'ours' };
  if (base !== null) {
    if (sameValue(ours, base.value)) return { value: theirs, conflict: false, from: 'theirs' };
    if (sameValue(theirs, base.value)) return { value: ours, conflict: false, from: 'ours' };
  }
  return { value: ours, conflict: true, from: 'ours' };
}

// ── Lists keyed by id ────────────────────────────────────────────────────────

export interface KeyedListMerge<T> {
  readonly items: readonly T[];
  /** True when at least one entry existed on both sides, changed on both, and differed. */
  readonly conflict: boolean;
}

interface Keyed {
  readonly id: string;
}

function indexById<T extends Keyed>(items: readonly T[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const item of items) index.set(item.id, item);
  return index;
}

/**
 * Merges two lists whose entries are identified by `id` — custom fields, security questions,
 * attachments.
 *
 * Entry-level rather than whole-field, because the case it handles is completely ordinary:
 * one device adds a "recovery code" custom field, the other adds "account number", and a
 * whole-field resolution would make the user pick one and lose the other. With ids, both
 * survive and nothing is a conflict.
 *
 * An entry present on one side only:
 *
 *  - **not in the ancestor** → it was added there. Keep it.
 *  - **in the ancestor, unchanged on the side that has it** → the other side deleted it.
 *    Honour the delete: the ancestor proves the deletion happened, so this is not the
 *    resurrection hazard that record-level absence is.
 *  - **in the ancestor, changed on the side that has it** → one side deleted while the other
 *    edited. Keep the edited entry and flag a conflict on the field. Deleting a custom field
 *    is a click; retyping a recovery code the user no longer has anywhere else is not.
 *  - **no ancestor at all** → keep it. Two-way cannot distinguish "deleted" from "not yet
 *    seen", and the safe reading of an ambiguity is always the one that keeps data.
 */
export function mergeKeyedList<T extends Keyed>(
  base: readonly T[] | null,
  ours: readonly T[],
  theirs: readonly T[]
): KeyedListMerge<T> {
  if (sameValue(ours, theirs)) return { items: ours, conflict: false };
  if (base !== null) {
    if (sameValue(ours, base)) return { items: theirs, conflict: false };
    if (sameValue(theirs, base)) return { items: ours, conflict: false };
  }

  const baseIndex = base === null ? null : indexById(base);
  const ourIndex = indexById(ours);
  const theirIndex = indexById(theirs);

  const surviving = new Map<string, T>();
  let conflict = false;

  for (const id of allIds(ours, theirs, base)) {
    const mine = ourIndex.get(id);
    const yours = theirIndex.get(id);
    const ancestor = baseIndex?.get(id);

    if (mine !== undefined && yours !== undefined) {
      const resolved = resolveValue(
        ancestor === undefined ? null : { value: ancestor },
        mine,
        yours
      );
      if (resolved.conflict) conflict = true;
      surviving.set(id, resolved.value);
      continue;
    }

    const present = mine ?? yours;
    if (present === undefined) continue; // Gone from both sides: the ancestor's entry is dead.
    if (ancestor === undefined) {
      surviving.set(id, present); // Added on the side that has it.
      continue;
    }
    if (sameValue(present, ancestor)) continue; // Untouched here, deleted there. Delete wins.
    // Deleted on one side, edited on the other. Keep the edit and say so.
    conflict = true;
    surviving.set(id, present);
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
  return { items, conflict };
}

function allIds<T extends Keyed>(
  ours: readonly T[],
  theirs: readonly T[],
  base: readonly T[] | null
): Set<string> {
  const ids = new Set<string>();
  for (const item of base ?? []) ids.add(item.id);
  for (const item of ours) ids.add(item.id);
  for (const item of theirs) ids.add(item.id);
  return ids;
}

// ── Ordering ─────────────────────────────────────────────────────────────────

/**
 * True when `list` is a **duplicate-free enumeration of exactly `surviving`** — the question
 * the name asks, rather than the cheaper one it used to answer.
 *
 * It used to compare `list.length` against `surviving.size`, and a length is not a cardinality
 * the moment a list can repeat an id. `['a', 'a']` against `{a, b}` counts two against two,
 * finds every entry present, and says "these are the same set" — after which `keep()` returns
 * `['a', 'a']` and whatever the repeat displaced is silently gone from the merged document.
 * That is hard rule 6, in the one function nobody reads as a data-safety function.
 *
 * The duplicate-free clause is the half that is easy to leave out and cannot be. Set equality
 * alone still admits `['a', 'a']` against `{a}`, which is a true statement about sets and a
 * false one about what `orderIds` may return: a list that names a survivor twice makes the
 * caller emit that entry twice. This predicate gates a *list*, so it has to judge the list.
 *
 * Both clauses fail safe. A list that does not qualify does not lose its ids — it falls
 * through to the ancestor-then-sorted branch, which is built from `surviving` itself and
 * therefore cannot omit or repeat anything. The cost of rejecting a list is a reordering; the
 * cost of wrongly accepting one is a lost credential.
 */
function sameIdSet(surviving: ReadonlySet<string>, list: readonly string[]): boolean {
  const distinct = new Set(list);
  return (
    distinct.size === list.length &&
    distinct.size === surviving.size &&
    list.every((id) => surviving.has(id))
  );
}

/**
 * The order the merged ids appear in — the one part of a merge that reads as pure presentation
 * and is not.
 *
 * **The contract is that this returns exactly `surviving`, each id once.** Every caller maps
 * the result back through its surviving-entries index, so an id omitted here is an entry that
 * never reaches the merged document and an id repeated here is an entry emitted twice. Order
 * is the visible part of the job; membership is the part that can lose a password.
 *
 * Order matters twice. `merge(x, x)` must return `x` **unchanged**, which it cannot do if the
 * merge reshuffles a list that did not change; and `merge(a, b)` and `merge(b, a)` must agree,
 * which they cannot do if the answer is "ours first, then theirs".
 *
 * So: if the surviving set is exactly one side's set, keep that side's order — nothing was
 * combined, so nothing should move. If it is exactly *both* sides' sets in different orders,
 * break the tie canonically rather than by argument position. Otherwise the merge genuinely
 * combined two lists, and the result is the ancestor's order followed by everything new,
 * sorted by id. Ids here are UUID v7, which sorts by creation time, so "sorted by id" reads
 * as "in the order they were made" rather than as an arbitrary shuffle.
 */
export function orderIds(
  surviving: ReadonlySet<string>,
  ours: readonly string[],
  theirs: readonly string[],
  base: readonly string[] | null
): string[] {
  const keep = (list: readonly string[]): string[] => list.filter((id) => surviving.has(id));

  const fromOurs = sameIdSet(surviving, ours) ? keep(ours) : null;
  const fromTheirs = sameIdSet(surviving, theirs) ? keep(theirs) : null;
  if (fromOurs !== null && fromTheirs !== null) return canonicallyFirst(fromOurs, fromTheirs);
  if (fromOurs !== null) return fromOurs;
  if (fromTheirs !== null) return fromTheirs;

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const id of base ?? []) {
    if (surviving.has(id) && !seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  const rest = [...surviving].filter((id) => !seen.has(id)).sort();
  return [...ordered, ...rest];
}

// ── Tag sets ─────────────────────────────────────────────────────────────────

/** Matches `normaliseTags`: tags are case-insensitively unique and trimmed. */
function tagKey(tag: string): string {
  return tag.trim().toLowerCase();
}

function tagIndex(tags: readonly string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const tag of tags) {
    const key = tagKey(tag);
    if (key !== '' && !index.has(key)) index.set(key, tag);
  }
  return index;
}

/**
 * Merges a record's tag list as a **set**, not as a value.
 *
 * The one field in the model where a real three-way merge is possible with no conflict at
 * all, and it is worth the special case: tagging is the thing two devices diverge on most,
 * and forcing "keep my tags or keep yours" on a user who added `work` on one machine and
 * `2fa` on the other is a bad answer to a question that has a good one.
 *
 * A tag survives if both sides have it, or if the side that has it *added* it since the
 * ancestor. A tag in the ancestor that one side dropped is a removal, and removals are
 * honoured — which is what makes this a set merge rather than a union. A union would make
 * "remove this tag" impossible to sync: the other device would put it straight back.
 *
 * There is no conflict case. Add/add, add/remove and remove/remove all have one obvious
 * answer, and "one side added T while the other removed T" cannot happen — if we added it, it
 * was not in the ancestor for them to remove.
 *
 * Order is normalised only when the two sides genuinely differ (the three short-circuits
 * above cover every case where they do not), because a combined list has no order that is
 * "the user's" — and a stable, side-independent order is what commutativity requires.
 */
export function mergeTagSet(
  base: readonly string[] | null,
  ours: readonly string[],
  theirs: readonly string[]
): string[] {
  if (sameValue(ours, theirs)) return [...ours];
  if (base !== null) {
    if (sameValue(ours, base)) return [...theirs];
    if (sameValue(theirs, base)) return [...ours];
  }

  const baseTags = base === null ? null : tagIndex(base);
  const ourTags = tagIndex(ours);
  const theirTags = tagIndex(theirs);

  const surviving = new Map<string, string>();
  for (const key of new Set([
    ...(baseTags?.keys() ?? []),
    ...ourTags.keys(),
    ...theirTags.keys(),
  ])) {
    const mine = ourTags.get(key);
    const yours = theirTags.get(key);
    const ancestor = baseTags?.get(key);

    const inOurs = mine !== undefined;
    const inTheirs = yours !== undefined;
    const inBase = ancestor !== undefined;

    // With no ancestor, absence cannot mean removal, so the answer is the union.
    const keep = baseTags === null ? inOurs || inTheirs : inOurs && inTheirs ? true : !inBase;
    if (!keep) continue;

    // The ancestor's spelling if it has one — a merge should not silently recapitalise a tag
    // neither side touched. Otherwise the canonically smaller spelling, so `Work` and `work`
    // resolve the same way whichever document was passed first.
    const spelling =
      ancestor ??
      (mine !== undefined && yours !== undefined ? canonicallyFirst(mine, yours) : (mine ?? yours));
    if (spelling !== undefined) surviving.set(key, spelling);
  }

  const order = orderIds(
    new Set(surviving.keys()),
    [...ourTags.keys()],
    [...theirTags.keys()],
    baseTags === null ? null : [...baseTags.keys()]
  );

  const merged: string[] = [];
  for (const key of order) {
    const tag = surviving.get(key);
    if (tag !== undefined) merged.push(tag);
  }
  return merged;
}
