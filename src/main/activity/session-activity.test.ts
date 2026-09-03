// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { AuditPrivacyLevel, SecretRef } from '@shared/model/credential.js';
import { LOCK_NOTICE_SEQ } from '@shared/model/activity.js';
import type { ImportDuplicateAction } from '@shared/model/import-plan.js';
import { commitImport, type ImportCommitOutcome } from '../import-service/commit.js';
import { buildImportPlan } from '../import-service/plan.js';
import {
  bitwardenCsv,
  emptyDocument,
  FakeVault,
  type BitwardenRow,
} from '../import-service/test-support.js';
import { ActivityLog } from './activity-log.js';
import { SessionActivity, type ActivityVaultRef } from './session-activity.js';

/**
 * The adapter's job is to make the invariants unforgettable: the label is attached once, the
 * privacy level comes from the vault rather than from a call site, and locking wipes.
 *
 * The import suite at the bottom drives the **real** parser, planner and commit rather than a
 * hand-built outcome, because the thing it is guarding is not "does `imported()` store a
 * number" — it is "can anything in somebody's export reach this log". A fixture that skipped
 * the parse would be asserting that about code it had replaced.
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
    activity.imported({ importedCount: 37, mergedCount: 4, skippedCount: 2 });
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

// ── An import, end to end ────────────────────────────────────────────────────

/**
 * A string that appears in no fixture, no vault, and no label but the one this plants.
 *
 * Distinctive on purpose: the sweep below asserts its **absence** from the serialised log, and
 * an absence assertion is only worth anything when the value could not have been absent by
 * coincidence. `MARKER` is planted in every field of an incoming record that carries either
 * secret material or something that names the user's account.
 */
const MARKER = 'kh-planted-9f2c41d7';

const ROW_A: BitwardenRow = {
  name: 'GitHub',
  uri: 'https://github.com',
  username: 'octocat',
  password: 'hunter2-github',
};
const ROW_B: BitwardenRow = {
  name: 'Bank',
  uri: 'https://bank.example',
  username: 'alice',
  password: 'hunter2-bank',
};
const ROW_C: BitwardenRow = {
  name: 'Forum',
  uri: 'https://forum.example',
  username: 'bob',
  password: 'hunter2-forum',
};

interface ImportRun {
  readonly outcome: ImportCommitOutcome;
  readonly activity: SessionActivity;
}

/**
 * Parses a real Bitwarden CSV, plans it against an empty vault, and commits it with a live
 * `SessionActivity` attached — the whole path a user's export takes, minus the file dialog.
 */
function runImport(
  rows: readonly BitwardenRow[],
  options: {
    readonly duplicateAction?: ImportDuplicateAction;
    readonly extraTags?: readonly string[];
    readonly privacyLevel?: AuditPrivacyLevel;
  } = {}
): ImportRun {
  const fake = new FakeVault(emptyDocument());
  const activity = new SessionActivity();
  activity.vaultOpened(vault(options.privacyLevel ?? 'device'), 'password');

  const plan = buildImportPlan({
    planId: 'plan-1',
    sourceId: 'source-1',
    formatId: 'bitwarden-csv',
    secretText: bitwardenCsv(rows),
    sampleSize: 10,
    document: fake.document,
  });

  const duplicateActions: Record<string, ImportDuplicateAction> = {};
  if (options.duplicateAction !== undefined) {
    for (const group of plan.duplicates) duplicateActions[group.key] = options.duplicateAction;
  }

  const outcome = commitImport({
    document: fake.document,
    plan,
    duplicateActions,
    extraTags: options.extraTags ?? [],
    ops: fake.opsContext(),
    activity,
  });

  return { outcome, activity };
}

function importEntriesOf(activity: SessionActivity): readonly { count?: number }[] {
  return activity.snapshot().entries.filter((entry) => entry.kind === 'import');
}

describe('an import', () => {
  it('records one entry, carrying the count of records it created', () => {
    // Three copies of one row plus two others, merged: the lead copy becomes a record, the
    // two after it fold into it. The three counts are all different, so an entry carrying the
    // wrong one is visible rather than coincidentally right.
    const { outcome, activity } = runImport([ROW_A, ROW_A, ROW_A, ROW_B, ROW_C], {
      duplicateAction: 'merge',
    });
    expect(outcome).toMatchObject({ importedCount: 3, mergedCount: 2, skippedCount: 0 });

    const entries = importEntriesOf(activity);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.count).toBe(3);
    expect(activity.snapshot().totals.import).toBe(1);
  });

  it('carries no field beyond the count, at the most permissive privacy level', () => {
    const { activity } = runImport([ROW_A, ROW_B], { privacyLevel: 'full' });

    const [entry] = importEntriesOf(activity);
    // No format id, no folder path, no batch id, no subject. `full` is the level at which the
    // log is allowed the most, and an import is still allowed only a number.
    expect(entry === undefined ? [] : Object.keys(entry)).toEqual([
      'seq',
      'at',
      'kind',
      'vaultLabel',
      'count',
    ]);
  });

  it('lets nothing out of the file reach the log — the planted-secret sweep', () => {
    const { outcome, activity } = runImport(
      [
        {
          folder: `Folder-${MARKER}`,
          name: `Title-${MARKER}`,
          notes: `Notes-${MARKER}`,
          fields: `Field-${MARKER}: Value-${MARKER}`,
          uri: `https://${MARKER}.example`,
          username: `user-${MARKER}`,
          password: `password-${MARKER}`,
        },
      ],
      { extraTags: [`Tag-${MARKER}`], privacyLevel: 'full' }
    );

    // The control, and the reason this test is worth anything. An absence assertion passes
    // trivially against an import that imported nothing, so first prove the marker really did
    // travel the whole way into the vault the commit built.
    expect(outcome.importedCount).toBe(1);
    expect(JSON.stringify(outcome.document)).toContain(MARKER);
    expect(activity.snapshot().totals.import).toBe(1);

    // The log is never serialised in production — there is deliberately no serialiser — so
    // this is the test reaching for every reachable field at once rather than a code path.
    expect(JSON.stringify(activity.snapshot())).not.toContain(MARKER);
  });

  it('says how many, never which, for a bulk import', () => {
    const rows = Array.from({ length: 400 }, (_, index) => ({
      name: `Account ${index}`,
      username: `user-${index}@example.com`,
      password: `${MARKER}-${index}`,
      uri: `https://site-${index}.example`,
    }));

    const { outcome, activity } = runImport(rows);
    expect(outcome.importedCount).toBe(400);

    const [entry] = importEntriesOf(activity);
    expect(entry?.count).toBe(400);
    expect(JSON.stringify(activity.snapshot())).not.toContain(MARKER);
  });

  it('records nothing when no session is attached, and still commits', () => {
    // `commitImport` without an activity recorder is the shape every existing test uses and
    // the shape a headless caller uses. The optional injection must not have made the log
    // mandatory, and must not have made the commit throw when it is absent.
    const fake = new FakeVault(emptyDocument());
    const outcome = commitImport({
      document: fake.document,
      plan: buildImportPlan({
        planId: 'plan-1',
        sourceId: 'source-1',
        formatId: 'bitwarden-csv',
        secretText: bitwardenCsv([ROW_A]),
        sampleSize: 10,
        document: fake.document,
      }),
      duplicateActions: {},
      extraTags: [],
      ops: fake.opsContext(),
    });

    expect(outcome.importedCount).toBe(1);
  });
});
