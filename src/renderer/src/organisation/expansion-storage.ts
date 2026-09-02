// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Which folders are expanded, remembered per vault.
 *
 * ## Per vault, not per app
 *
 * The key carries the vault id. Two vaults open on the same machine — a personal one and a
 * shared one — have entirely different folder trees, and a shared expansion set would mean
 * opening the second vault expands a set of ids that mean nothing in it. Worse, it would
 * leak a little structure between vaults: which ids exist in one is not information the
 * other should carry. The vault id comes from `VaultSummary.vaultId`, which the renderer
 * already holds and which is not secret.
 *
 * ## Everything here treats storage as hostile
 *
 * `localStorage` can be absent (a stripped environment), throw on read (privacy settings,
 * a disabled origin), or contain anything at all — it is user-writable disk. A corrupt or
 * missing value must mean **collapsed**, never a crash and never a thrown error that takes
 * the sidebar down with it. Collapsed is the safe default: the user sees their roots and
 * clicks once, which is a mild annoyance; a blank sidebar is a bug report.
 *
 * Nothing secret is stored. Folder ids are already in the safe projection.
 */

/** The slice of `Storage` this needs. Narrowed so tests can hand in a hostile fake. */
export interface ExpansionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY_PREFIX = 'keyhold:organisation:expanded:';

/**
 * A cap on what is written back.
 *
 * Without one, a vault with a pathological number of folders could grow this entry until
 * `setItem` starts throwing quota errors on every render. Ten thousand ids is far past any
 * real tree and still a small string.
 */
export const MAX_PERSISTED_IDS = 10_000;

export function expansionStorageKey(vaultId: string): string {
  return `${KEY_PREFIX}${vaultId}`;
}

/**
 * Whether a value can actually be used as a store.
 *
 * Checked structurally rather than asserted. `globalThis.localStorage` is typed `Storage` by
 * the DOM lib, which is a claim about the browser and not about the environment this bundle
 * happens to be running in — under test, in a stripped renderer, or in a preload sandbox the
 * property is simply absent. Casting it to `Storage | undefined` would encode the optimistic
 * half of that and still leave `null` unhandled, which is precisely the shape of the bug this
 * module's own docblock says must not exist.
 */
function isExpansionStore(value: unknown): value is ExpansionStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getItem' in value &&
    typeof value.getItem === 'function' &&
    'setItem' in value &&
    typeof value.setItem === 'function' &&
    'removeItem' in value &&
    typeof value.removeItem === 'function'
  );
}

/**
 * The browser's `localStorage`, or `null` where it is unavailable or unusable.
 *
 * Accessing `window.localStorage` can itself throw — a browser configured to block site
 * data raises on the property access, not on the call — so even the lookup is guarded.
 */
export function browserExpansionStore(): ExpansionStore | null {
  try {
    const candidate: unknown = Reflect.get(globalThis, 'localStorage');
    return isExpansionStore(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * The expanded ids for a vault. **Any problem at all yields an empty set.**
 *
 * The accepted shape is a JSON array of strings. Anything else — a bare string, an object,
 * a number, a nested array, unparseable bytes — is discarded wholesale rather than
 * partially salvaged, because a half-read expansion set is not more useful than none and
 * salvage logic is where the crash would live.
 */
export function readExpansion(store: ExpansionStore | null, vaultId: string): ReadonlySet<string> {
  if (store === null || vaultId === '') return new Set();

  let raw: string | null;
  try {
    raw = store.getItem(expansionStorageKey(vaultId));
  } catch {
    return new Set();
  }
  if (raw === null || raw === '') return new Set();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }

  if (!Array.isArray(parsed)) return new Set();

  const ids = new Set<string>();
  for (const entry of parsed) {
    // One non-string entry means the value was not written by this code. Take the strings
    // that are there and ignore the rest; the alternative — discarding the lot — punishes
    // the user for a stray value without making anything safer.
    if (typeof entry === 'string' && entry !== '') ids.add(entry);
  }
  return ids;
}

/** Writes the set, silently. A storage failure must never interrupt a click. */
export function writeExpansion(
  store: ExpansionStore | null,
  vaultId: string,
  expanded: ReadonlySet<string>
): void {
  if (store === null || vaultId === '') return;
  const key = expansionStorageKey(vaultId);
  try {
    if (expanded.size === 0) {
      store.removeItem(key);
      return;
    }
    store.setItem(key, JSON.stringify([...expanded].slice(0, MAX_PERSISTED_IDS).sort()));
  } catch {
    // Quota, a disabled origin, a private window. Losing the expansion state is a strictly
    // better outcome than an exception escaping a state update.
  }
}

/**
 * Drops ids that no longer name a folder.
 *
 * Run whenever the folder list changes. Without it, deleting folders leaves their ids in
 * storage forever, and the entry only ever grows.
 */
export function pruneExpansion(
  expanded: ReadonlySet<string>,
  knownIds: ReadonlySet<string>
): ReadonlySet<string> {
  const pruned = new Set<string>();
  for (const id of expanded) {
    if (knownIds.has(id)) pruned.add(id);
  }
  return pruned;
}
