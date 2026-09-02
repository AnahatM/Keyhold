// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_RECENTS, pushRecent, useRecentCommands } from './recent-commands.js';

describe('pushRecent', () => {
  it('puts the newest first', () => {
    expect(pushRecent(['a'], 'b')).toEqual(['b', 'a']);
  });

  it('moves an existing entry to the front rather than duplicating it', () => {
    expect(pushRecent(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(pushRecent(['a', 'b', 'c'], 'c')).toHaveLength(3);
  });

  it('caps the list, evicting the oldest', () => {
    let keys: readonly string[] = [];
    for (let index = 0; index < MAX_RECENTS + 5; index += 1) {
      keys = pushRecent(keys, `k${index}`);
    }
    expect(keys).toHaveLength(MAX_RECENTS);
    expect(keys[0]).toBe(`k${MAX_RECENTS + 4}`);
    expect(keys).not.toContain('k0');
  });

  it('respects a caller-supplied limit', () => {
    expect(pushRecent(['a', 'b'], 'c', 2)).toEqual(['c', 'a']);
    expect(pushRecent(['a', 'b'], 'c', 0)).toEqual([]);
  });

  it('does not mutate the list it was given', () => {
    const original = ['a', 'b'];
    pushRecent(original, 'c');
    expect(original).toEqual(['a', 'b']);
  });
});

describe('the store', () => {
  beforeEach(() => {
    useRecentCommands.getState().clear();
  });

  it('starts empty', () => {
    expect(useRecentCommands.getState().keys).toEqual([]);
  });

  it('remembers and caps through the store', () => {
    const { remember } = useRecentCommands.getState();
    for (let index = 0; index < MAX_RECENTS + 3; index += 1) remember(`k${index}`);
    expect(useRecentCommands.getState().keys).toHaveLength(MAX_RECENTS);
  });

  /**
   * The security property, asserted directly.
   *
   * A recents list on disk is a plaintext record of someone's accounts sitting outside the
   * encrypted file. Nothing in this module may write anywhere, so a future refactor that
   * reaches for `localStorage` — the obvious "improvement" — fails here.
   */
  it('writes nothing to browser storage', () => {
    const { remember } = useRecentCommands.getState();
    remember('credential:my-bank');

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);

    // Read through `key`/`getItem` rather than spreading the Storage object: a spread copies
    // own enumerable properties off an instance, which is not what a Storage holds, so it
    // would report "nothing stored" for a real write. This also sweeps sessionStorage, which
    // the two length checks above cover but the original spread did not.
    const written: string[] = [];
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key === null) continue;
        written.push(key, storage.getItem(key) ?? '');
      }
    }
    expect(written.join('\n')).not.toContain('my-bank');
  });

  it('clears completely', () => {
    useRecentCommands.getState().remember('credential:r1');
    useRecentCommands.getState().clear();
    expect(useRecentCommands.getState().keys).toEqual([]);
  });
});
