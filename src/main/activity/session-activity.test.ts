// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { SecretRef } from '@shared/model/credential.js';
import { LOCK_NOTICE_SEQ } from '@shared/model/activity.js';
import { ActivityLog } from './activity-log.js';
import { SessionActivity, type ActivityVaultRef } from './session-activity.js';

/**
 * The adapter's job is to make the invariants unforgettable: the label is attached once, the
 * privacy level comes from the vault rather than from a call site, and locking wipes.
 */

const vault = (
  auditPrivacyLevel: ActivityVaultRef['settings']['auditPrivacyLevel']
): ActivityVaultRef => ({
  displayName: 'Personal',
  settings: { auditPrivacyLevel },
});

const password = (id: string): SecretRef => ({ kind: 'password', credentialId: id });

describe('opening a vault', () => {
  it('takes its privacy level from the vault rather than from the default', () => {
    const activity = new SessionActivity(new ActivityLog({ privacyLevel: 'full' }));
    activity.vaultOpened(vault('none'), 'password');

    expect(activity.log.privacyLevel).toBe('none');
  });

  it('applies the level before the unlock entry, not after it', () => {
    // The off-by-one worth a test: applying the setting after recording would put the vault
    // name in the log once per unlock, forever, for a user who asked for none.
    const activity = new SessionActivity(new ActivityLog({ privacyLevel: 'full' }));
    activity.vaultOpened(vault('none'), 'password');

    expect(activity.snapshot().entries[0]?.vaultLabel).toBeUndefined();
  });

  it('records how the vault was opened', () => {
    const activity = new SessionActivity();
    activity.vaultOpened(vault('device'), 'quick-unlock');

    expect(activity.snapshot().entries[0]).toMatchObject({
      kind: 'unlock',
      unlockMethod: 'quick-unlock',
      vaultLabel: 'Personal',
    });
  });

  it('attaches the label to every later entry without the call site passing it', () => {
    const activity = new SessionActivity();
    activity.vaultOpened(vault('device'), 'password');
    activity.secretRevealed(password('cred-1'));
    activity.vaultSaved(12);

    for (const entry of activity.snapshot().entries) {
      expect(entry.vaultLabel).toBe('Personal');
    }
  });
});

describe('a failed unlock', () => {
  it('names nothing — there is no open vault to name', () => {
    const activity = new SessionActivity();
    activity.unlockFailed();

    const [entry] = activity.snapshot().entries;
    expect(entry?.kind).toBe('unlock-failed');
    expect(entry === undefined ? [] : Object.keys(entry)).toEqual(['seq', 'at', 'kind']);
  });

  it('does not pick up the previous vault label after a lock', () => {
    const activity = new SessionActivity();
    activity.vaultOpened(vault('device'), 'password');
    activity.locked('idle');
    activity.unlockFailed();

    expect(activity.snapshot().entries[0]?.vaultLabel).toBeUndefined();
  });
});

describe('locking', () => {
  it('clears the log', () => {
    const activity = new SessionActivity();
    activity.vaultOpened(vault('device'), 'password');
    activity.secretRevealed(password('cred-1'));
    activity.secretCopied(password('cred-1'));

    activity.locked('idle');

    const snapshot = activity.snapshot();
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.totals.reveal).toBe(0);
    expect(snapshot.startedAt).toBeNull();
  });

  it('retains no lock entry — the wipe leaves nothing behind, including itself', () => {
    const activity = new SessionActivity();
    activity.vaultOpened(vault('device'), 'password');

    activity.locked('screen-lock');

    expect(activity.snapshot().entries).toEqual([]);
    expect(activity.snapshot().totals.lock).toBe(0);
  });

  it('returns the notice so the reason can still be announced once', () => {
    const activity = new SessionActivity();
    activity.vaultOpened(vault('device'), 'password');

    const notice = activity.locked('sleep');

    expect(notice.kind).toBe('lock');
    expect(notice.lockReason).toBe('sleep');
    expect(notice.seq).toBe(LOCK_NOTICE_SEQ);
    // Not even in the notice: a live region reading "Personal locked" out loud names the
    // vault at the exact moment the user stepped away from the machine.
    expect(notice.vaultLabel).toBeUndefined();
  });
});

describe('secrets', () => {
  it('records which record and which kind of secret, never a value', () => {
    const activity = new SessionActivity();
    activity.vaultOpened(vault('device'), 'password');
    activity.secretRevealed({
      kind: 'historic-password',
      credentialId: 'cred-9',
      versionNumber: 3,
    });

    expect(activity.snapshot().entries[1]).toMatchObject({
      kind: 'reveal',
      subjectId: 'cred-9',
      secretKind: 'historic-password',
    });
  });

  it('distinguishes a reveal from a copy — only one of them left the app', () => {
    const activity = new SessionActivity();
    activity.vaultOpened(vault('device'), 'password');
    activity.secretRevealed(password('cred-1'));
    activity.secretCopied(password('cred-1'));
    activity.clipboardCleared();

    const totals = activity.snapshot().totals;
    expect(totals.reveal).toBe(1);
    expect(totals.copy).toBe(1);
    expect(totals['clipboard-clear']).toBe(1);
  });
});

describe('the file', () => {
  it('records counts for saves, imports and exports', () => {
    const activity = new SessionActivity();
    activity.vaultOpened(vault('device'), 'created');
    activity.vaultSaved(120);
    activity.imported(37);
    activity.exported(120);

    const counts = activity.snapshot().entries.map((entry) => entry.count);
    expect(counts).toEqual([undefined, 120, 37, 120]);
  });

  it('records no destination for an export', () => {
    const activity = new SessionActivity();
    activity.vaultOpened(vault('full'), 'password');
    const entry = activity.exported(5);

    // A path names a directory on this machine and usually the OS user inside it. At level
    // `full` the log is at its most permissive and still must not carry one.
    expect(Object.keys(entry)).toEqual(['seq', 'at', 'kind', 'vaultLabel', 'count']);
  });
});
