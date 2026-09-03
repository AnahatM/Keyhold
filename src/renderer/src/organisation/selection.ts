// SPDX-License-Identifier: GPL-3.0-or-later
import type { CredentialProjection } from '@shared/model/credential.js';
import type { Folder, Tag } from '@shared/model/vault-document.js';
import {
  parseQuery,
  scoresById,
  searchCredentials,
  sortCredentials,
  type FilterOptions,
  type SortOptions,
} from '@shared/search/index.js';
import { DEFAULT_SMART_VIEW_ID, hasBeenUsed, smartView, type SmartViewId } from './smart-views.js';

/**
 * What the sidebar is currently pointing at, and how that becomes a list of records.
 *
 * The selection is a small serialisable value, not a pile of component state: one primary
 * view (a smart view or a folder) plus a tag narrowing that applies on top of it. That
 * shape is what makes "Work folder, tagged #banking, matching 'chase'" a single expression
 * rather than three filters that each know about the other two.
 *
 * ## Everything here funnels into `@shared/search`
 *
 * There is no matching, no ranking and no ordering in this file. It builds a
 * `FilterOptions`, composes a query string, and hands both to `searchCredentials` /
 * `sortCredentials`. The renderer already had a second, weaker filter once — it was folded
 * into the shared engine (see `credential-store.ts`) and this module exists to consume that
 * engine, not to grow a third.
 */

export type ViewSelection =
  | { readonly kind: 'smart'; readonly viewId: SmartViewId }
  | { readonly kind: 'folder'; readonly folderId: string }
  /**
   * A saved search — the user's own smart view.
   *
   * Carries the query text and the name rather than only an id, and that is the point. The
   * list would otherwise have to be resolved against a store to render its own heading, so a
   * selection could not be turned into a list without a second lookup that might fail. It
   * also means a saved search deleted in another window leaves the current list intact
   * instead of collapsing to "Missing search" under the user's cursor.
   *
   * The id is kept alongside so the sidebar can mark the row it came from, and is allowed to
   * name nothing.
   */
  | {
      readonly kind: 'saved-search';
      readonly searchId: string;
      readonly name: string;
      readonly query: string;
    };

export interface SidebarSelection {
  readonly view: ViewSelection;
  /** Narrows whatever `view` selected. Empty means no tag filter. */
  readonly tagIds: readonly string[];
  /** `any` is what a tag sidebar normally does; `all` is for narrowing hard. */
  readonly tagMatch: 'any' | 'all';
  /**
   * Whether a folder means that folder or that folder and everything under it.
   *
   * Off by default, matching `FilterOptions`: picking "Work" and seeing records that are
   * actually in "Work/Banking" is surprising the first time, and the toggle is one click.
   */
  readonly includeDescendantFolders: boolean;
}

export const DEFAULT_SELECTION: SidebarSelection = {
  view: { kind: 'smart', viewId: DEFAULT_SMART_VIEW_ID },
  tagIds: [],
  tagMatch: 'any',
  includeDescendantFolders: false,
};

export interface OrganisationContext {
  readonly folders: readonly Folder[];
  readonly tags: readonly Tag[];
}

/** The selection, flattened into everything the list pane needs. */
export interface ResolvedView {
  /** Structured filters only. The query is composed separately, from `queryText`. */
  readonly filter: FilterOptions;
  /** Prefixed to whatever the user typed in the search box. Often empty. */
  readonly queryText: string;
  readonly sort: SortOptions;
  readonly limit: number | null;
  readonly usedOnly: boolean;
  /** What the list pane should call itself. */
  readonly label: string;
  readonly description: string;
}

function folderLabel(context: OrganisationContext, folderId: string): string {
  return context.folders.find((folder) => folder.id === folderId)?.name ?? 'Missing folder';
}

export function resolveSelection(
  selection: SidebarSelection,
  context: OrganisationContext
): ResolvedView {
  const tagFilter =
    selection.tagIds.length === 0 ? {} : { tagIds: selection.tagIds, tagMatch: selection.tagMatch };

  if (selection.view.kind === 'folder') {
    const { folderId } = selection.view;
    return {
      filter: {
        folderId,
        includeDescendantFolders: selection.includeDescendantFolders,
        folders: context.folders,
        tags: context.tags,
        ...tagFilter,
      },
      queryText: '',
      sort: { key: 'title', direction: 'asc' },
      limit: null,
      usedOnly: false,
      label: folderLabel(context, folderId),
      description: selection.includeDescendantFolders
        ? 'This folder and everything inside it.'
        : 'Records filed directly in this folder.',
    };
  }

  if (selection.view.kind === 'saved-search') {
    const { name, query } = selection.view;
    return {
      // No structured filter of its own: everything a saved search says is in its query, and
      // the query goes through the same parser as the search box. A tag narrowing still
      // applies on top, exactly as it does to a smart view.
      filter: { folders: context.folders, tags: context.tags, ...tagFilter },
      queryText: query,
      sort: { key: 'title', direction: 'asc' },
      limit: null,
      usedOnly: false,
      label: name,
      // The query, verbatim. It is the only honest description — the name was chosen by the
      // user and is under no obligation to describe what it matches, and a query that no
      // longer parses is visible here rather than silently matching nothing.
      description: query,
    };
  }

  const view = smartView(selection.view.viewId);
  return {
    filter: { ...view.filter, folders: context.folders, tags: context.tags, ...tagFilter },
    queryText: view.queryText,
    sort: view.sort,
    limit: view.limit,
    usedOnly: view.usedOnly,
    label: view.label,
    description: view.description,
  };
}

/**
 * Composes the view's own query with what the user typed.
 *
 * Textual composition rather than merging two `ParsedQuery` values, so there is exactly one
 * parser and one place that decides what `is:untagged chase` means. An empty half
 * contributes nothing.
 */
export function composeQueryText(viewQuery: string, userQuery: string): string {
  return [viewQuery, userQuery]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ');
}

export interface VisibleListOptions {
  readonly selection: SidebarSelection;
  readonly context: OrganisationContext;
  /** What the user typed in the list pane's search box. */
  readonly userQuery: string;
  /** Ids the main process matched against secret material, per `credential-store.ts`. */
  readonly deepMatches?: readonly string[] | null | undefined;
  /** Overrides the view's sort when the user picks one explicitly. */
  readonly sort?: SortOptions | undefined;
}

/**
 * The list, end to end: structured filters, the composed query, ranking, order, and the cap.
 *
 * This is the one function the list pane should call. It replaces the `visibleCredentials`
 * helper in `credential-store.ts`, which does the same thing without a sidebar selection —
 * see the report for the exact edit. Two functions answering "what is in the list" would
 * disagree the first time a folder filter and a search box were used together.
 */
export function visibleForSelection(
  records: readonly CredentialProjection[],
  options: VisibleListOptions
): readonly CredentialProjection[] {
  const resolved = resolveSelection(options.selection, options.context);
  const composed = composeQueryText(resolved.queryText, options.userQuery);
  const parsed = parseQuery(composed);
  const deep = options.deepMatches;

  const results = searchCredentials(records, {
    ...resolved.filter,
    query: parsed,
    ...(deep === null || deep === undefined ? {} : { deepMatchIds: new Set(deep) }),
  });

  // "Recently used" is a window over records that have actually been used. Applied after
  // the search so the view still narrows correctly when the user types into it.
  const eligible = resolved.usedOnly
    ? results.filter((result) => hasBeenUsed(result.record))
    : results;

  // Relevance only means something with a query behind it. On an empty box every record
  // scores the same and the order falls through to the id tiebreak, which reads as random.
  // The user typing is what makes relevance the right key — the view's own `queryText` is
  // a filter they did not type and should not reorder their list.
  const userTyped = options.userQuery.trim() !== '';
  const sort: SortOptions =
    options.sort ?? (userTyped ? { key: 'relevance', direction: 'desc' } : resolved.sort);

  const ordered = sortCredentials(
    eligible.map((result) => result.record),
    { ...sort, scores: scoresById(eligible) }
  );

  return resolved.limit === null ? ordered : ordered.slice(0, resolved.limit);
}

/** Whether a tag is currently part of the narrowing. */
export function isTagSelected(selection: SidebarSelection, tagId: string): boolean {
  return selection.tagIds.includes(tagId);
}

/**
 * Adds or removes a tag, keeping the list sorted.
 *
 * Sorted so that selecting A then B and selecting B then A produce the same selection —
 * which matters because the selection is compared for equality when deciding whether to
 * recompute the list.
 */
export function toggleTag(selection: SidebarSelection, tagId: string): SidebarSelection {
  const next = selection.tagIds.includes(tagId)
    ? selection.tagIds.filter((id) => id !== tagId)
    : [...selection.tagIds, tagId].sort();
  return { ...selection, tagIds: next };
}

/** How many records carry a tag, in the same scope the sidebar counts folders in. */
export function countRecordsByTag(
  records: readonly CredentialProjection[]
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    if (record.trashedAt !== null) continue;
    for (const tagId of record.tags) counts.set(tagId, (counts.get(tagId) ?? 0) + 1);
  }
  return counts;
}
