// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What the renderer is told when the vault file changed underneath it.
 *
 * Generations and two booleans. Deliberately no path, no header, no device id: the renderer
 * cannot act on any of them, and a payload that carries what a reader *might* want is how a
 * projection widens until it is carrying something it should not.
 *
 * `generation` is a counter, so the two numbers together say roughly how far apart the files
 * are — which is the difference between "somebody saved once" and "this vault has moved on
 * a long way", and those deserve different words on screen.
 */
export interface VaultChangedExternally {
  /** What this app believed was on disk. */
  readonly knownGeneration: number;
  /** What is actually there now. */
  readonly currentGeneration: number;
  /**
   * A different vault entirely — a different `vaultId` at the same path.
   *
   * Not a merge candidate under any circumstances: merging two unrelated vaults would mix
   * two people's credentials into one file. It is a "something replaced your vault file"
   * warning, and the only safe response is to stop.
   */
  readonly differentVault: boolean;
  /**
   * The file on disk is *older* than what we have — a restored backup, or a cloud client
   * that lost a race and put back a stale copy.
   *
   * Called out separately because the obvious response to "the file changed" is to reload
   * it, and reloading here would silently discard newer edits.
   */
  readonly wentBackwards: boolean;
}
