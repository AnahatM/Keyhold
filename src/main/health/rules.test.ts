// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Credential, CustomField } from '@shared/model/credential.js';
import {
  DEFAULT_HEALTH_RULE_TOGGLES,
  DEFAULT_HEALTH_THRESHOLDS,
  HEALTH_RULE_IDS,
  HEALTH_RULE_WEIGHTS,
  MAX_PENALTY_PER_RECORD,
  type HealthRuleId,
} from '@shared/model/health.js';
import {
  DEFAULT_VAULT_SETTINGS,
  type VaultDocument,
  type VaultSettings,
} from '@shared/model/vault-document.js';
import { analyseVault, isLoopbackHost, normaliseHost, passwordEntropyBits } from './rules.js';

/**
 * Tests for the offline health rules.
 *
 * Two things here are worth an expensive silent regression, and everything else is here in
 * service of them:
 *
 *   1. **The report must never carry secret material.** It crosses to the renderer, so
 *      decision D13 binds it exactly as it binds the safe projection. The property test in
 *      the last block is the most important test in this file: it plants a marker in every
 *      password in a vault, serialises the whole report, and asserts nothing survives.
 *
 *   2. **Every boundary.** "Old after 365 days" and "old after 364" are different products
 *      and the difference is one comparison operator. Each rule is tested exactly at its
 *      threshold and one unit either side, because off-by-one here is invisible: the
 *      dashboard still looks right, it is just wrong.
 *
 * Fault injections performed against this file (testing policy: "break it on purpose
 * before you trust it"). All were caught, and all were reverted:
 *
 *   | Injection into `rules.ts`                        | Result                          |
 *   |--------------------------------------------------|---------------------------------|
 *   | reuse cluster `label` set to the shared password  | 4 failed — both no-secrets property tests, the every-subset variant, and the "no label" test |
 *   | trashed filter replaced with `filter(() => true)` | 3 failed — the trashed-exclusion block, the trashed-joins-a-cluster case, and the TOTP marker test (`missingTotp` counted 3 records, not 2) |
 *   | weak comparison `bits < threshold` → `bits <=`    | 1 failed — "exactly at the threshold is not weak" |
 *   | empty-password skip removed from the reuse map    | 1 failed — "never counts empty passwords as shared", reporting a cluster of 3 |
 *
 * And for `missingTotp`, which is the riskiest rule in the file because the field it reads
 * holds secret material:
 *
 *   | Injection                                         | Result                         |
 *   |---------------------------------------------------|--------------------------------|
 *   | `enabledRules.missingTotp` dropped from the guard  | 5 failed — the off-by-default test and four score assertions |
 *   | `missingTotp: false` → `true` in the model         | 4 failed — same shape, from the other direction |
 *   | `hasPassword` dropped from the guard               | 1 failed — "says nothing about a record with no password" |
 *   | `field.value.trim() !== ''` dropped                | 1 failed — "flags an otp-secret field with nothing in it" |
 *   | `field.type === TOTP_FIELD_TYPE` → `field.hidden`  | 2 failed — the recovery-code case, and the TOTP marker count |
 *   | `!hasTotpSecret(record)` → `hasTotpSecret(record)` | 8 failed — nearly the whole block |
 *   | every custom value echoed into the issue `detail`  | 3 failed — "carries no detail", and **both** no-secrets property tests |
 *   | the seed itself echoed into `detail`               | 3 failed — including "holds for every subset of enabled rules", which is what catches a leak the default configuration would hide |
 *   | `ALL_RULES_ON` removed from the every-rule sweep   | 1 failed — proving the sweep genuinely covers an off-by-default rule rather than passing over it |
 *
 * There are no network assertions here because there is no network code to assert against:
 * the offline rules import nothing that can make a request, which is the point.
 */

const DAY = 86_400_000;
/** A fixed, arbitrary "now". Every date in the fixtures is expressed relative to it. */
const NOW = 1_800_000_000_000;

// ── Fixtures ─────────────────────────────────────────────────────────────────

interface RecordInput {
  readonly id: string;
  readonly title?: string;
  readonly username?: string;
  readonly email?: string;
  readonly password?: string;
  readonly notes?: string;
  readonly answer?: string;
  readonly customValue?: string;
  /** The value of an `otp-secret` custom field. `undefined` means no such field at all. */
  readonly totpSecret?: string;
  readonly urls?: readonly string[];
  readonly passwordUpdatedAt?: number;
  readonly expiresAt?: number | null;
  readonly rotationIntervalDays?: number | null;
  readonly trashedAt?: number | null;
}

/**
 * The custom fields a fixture record carries.
 *
 * Two kinds, and keeping them apart is the point: `customValue` builds a hidden field of
 * type `password` (a stored recovery code), `totpSecret` builds one of type `otp-secret`.
 * Only the second is a second factor, and a rule that confused them would be wrong about
 * both.
 */
function customFields(input: RecordInput): CustomField[] {
  const fields: CustomField[] = [];

  if (input.customValue !== undefined) {
    fields.push({
      id: `c-${input.id}`,
      label: 'Recovery code',
      type: 'password',
      value: input.customValue,
      hidden: true,
      order: fields.length,
    });
  }

  if (input.totpSecret !== undefined) {
    fields.push({
      id: `otp-${input.id}`,
      label: 'One-time password',
      type: 'otp-secret',
      value: input.totpSecret,
      hidden: true,
      order: fields.length,
    });
  }

  return fields;
}

/** A record that breaks no rule, unless the input says otherwise. */
function record(input: RecordInput): Credential {
  return {
    id: input.id,
    type: 'login',
    title: input.title ?? `Record ${input.id}`,
    favorite: false,
    folderId: null,
    tags: [],
    icon: { kind: 'auto' },
    fields: {
      username: input.username ?? `user-${input.id}`,
      email: input.email ?? '',
      // Long, mixed-class and unique per record, so the default fixture is healthy.
      password: input.password ?? `Str0ng-unique-passphrase-${input.id}!`,
      urls: input.urls ?? [`https://${input.id}.example.com`],
      securityQuestions:
        input.answer === undefined
          ? []
          : [{ id: `q-${input.id}`, question: 'First pet?', answer: input.answer }],
      notes: input.notes ?? '',
      custom: customFields(input),
    },
    attachments: [],
    meta: {
      createdAt: NOW - 400 * DAY,
      updatedAt: NOW,
      passwordUpdatedAt: input.passwordUpdatedAt ?? NOW,
      lastUsedAt: null,
      useCount: 0,
      expiresAt: input.expiresAt ?? null,
      rotationIntervalDays: input.rotationIntervalDays ?? null,
      createdOrigin: { action: 'create' as const },
    },
    history: { enabled: true, maxVersions: 50, versions: [] },
    trashedAt: input.trashedAt ?? null,
  };
}

function vault(records: readonly Credential[], settings?: Partial<VaultSettings>): VaultDocument {
  return {
    documentVersion: 1,
    records,
    folders: [],
    tags: [],
    savedSearches: [],
    siteRules: [],
    settings: { ...DEFAULT_VAULT_SETTINGS, ...settings },
  };
}

/** Rule ids flagged on a given record, for terse assertions. */
function rulesFor(document: VaultDocument, id: string, options = {}): HealthRuleId[] {
  const report = analyseVault(document, { now: NOW, ...options });
  return (
    report.byCredential.find((entry) => entry.credentialId === id)?.issues.map((i) => i.rule) ?? []
  );
}

/**
 * Every rule on, including the ones that ship off.
 *
 * The sweeps below assert something about *each* rule in `HEALTH_RULE_IDS`, so they have to
 * run with each rule actually running. Left on the defaults, `missingTotp` would satisfy
 * every one of them vacuously — "the disabled rule reported nothing" is not evidence of
 * anything — which is exactly the shape of a guard that has quietly stopped guarding.
 */
const ALL_RULES_ON = Object.fromEntries(HEALTH_RULE_IDS.map((rule) => [rule, true])) as Record<
  HealthRuleId,
  boolean
>;

// ── weak ─────────────────────────────────────────────────────────────────────

describe('weak', () => {
  // 10 lower-case letters over a 26-character pool: 10 × log2(26) = 47.00 bits exactly.
  // Pinned so the boundary cases below are arithmetic, not guesswork.
  const TEN_LOWER = 'abcdefghij';

  it('estimates entropy from the classes present and the length', () => {
    expect(passwordEntropyBits(TEN_LOWER)).toBe(47);
    // Same length, one capital: the pool doubles to 52 and the estimate rises accordingly.
    expect(passwordEntropyBits('Abcdefghij')).toBe(57);
    // Adding digits and symbols widens it further, not just the length.
    expect(passwordEntropyBits('Abcdefgh1!')).toBe(65.7);
    expect(passwordEntropyBits('')).toBe(0);
  });

  it('counts a code point once, not its UTF-16 units', () => {
    // Without this an emoji password would score double for its length, which would let a
    // genuinely short password pass the weak check.
    expect(passwordEntropyBits('\u{1F600}')).toBe(passwordEntropyBits('é'));
  });

  it('flags a password below the threshold, and not one exactly at it', () => {
    // The boundary case. "Below the threshold" must mean below, not at: a rule that fires
    // at exactly the configured number is a different product from the one documented, and
    // nothing about the dashboard would look wrong.
    const document = vault([record({ id: 'a', password: TEN_LOWER })]);
    expect(rulesFor(document, 'a', { thresholds: { weakEntropyBits: 47 } })).not.toContain('weak');
    expect(rulesFor(document, 'a', { thresholds: { weakEntropyBits: 47.01 } })).toContain('weak');
    expect(rulesFor(document, 'a', { thresholds: { weakEntropyBits: 46.99 } })).not.toContain(
      'weak'
    );
  });

  it('does not call a missing password weak — that is `incomplete`', () => {
    // Otherwise an empty record is penalised twice for the same single defect, and the
    // score reads worse than the vault is.
    expect(rulesFor(vault([record({ id: 'a', password: '' })]), 'a')).toEqual(['incomplete']);
  });
});

// ── reused ───────────────────────────────────────────────────────────────────

describe('reused', () => {
  it('reports the whole cluster, not a flag per record', () => {
    // The user cannot act on "this is reused" — they have to know which records to go and
    // change. Every member must be listed, including the first one seen.
    const report = analyseVault(
      vault([
        record({ id: 'a', password: 'shared-passphrase' }),
        record({ id: 'b', password: 'different-passphrase' }),
        record({ id: 'c', password: 'shared-passphrase' }),
        record({ id: 'd', password: 'shared-passphrase' }),
      ]),
      { now: NOW }
    );

    const clusters = report.clusters.filter((cluster) => cluster.rule === 'reused');
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.credentialIds).toEqual(['a', 'c', 'd']);
    expect(clusters[0]?.size).toBe(3);
    expect(report.counts.reused).toBe(3);

    // Every member's issue points back at the cluster, so the UI can navigate from one
    // record to its siblings without re-deriving the grouping.
    for (const id of ['a', 'c', 'd']) {
      const issue = report.issues.find((i) => i.credentialId === id && i.rule === 'reused');
      expect(issue?.clusterId).toBe(clusters[0]?.id);
    }
    expect(rulesFor(vault([]), 'b')).toEqual([]);
  });

  it('never counts empty passwords as shared', () => {
    // Half a vault may legitimately have no password yet. Telling those users they all
    // share one would be wrong, and the fastest possible way to get the rule switched off.
    const report = analyseVault(
      vault([
        record({ id: 'a', password: '' }),
        record({ id: 'b', password: '' }),
        record({ id: 'c', password: '' }),
      ]),
      { now: NOW }
    );
    expect(report.counts.reused).toBe(0);
    expect(report.clusters).toHaveLength(0);
  });

  it('treats passwords as case-sensitive', () => {
    // `hunter2` and `Hunter2` are two different passwords: changing one does not fix the
    // other, so calling them reuse would send the user to fix a record that is already fine.
    const report = analyseVault(
      vault([
        record({ id: 'a', password: 'hunter2xyz' }),
        record({ id: 'b', password: 'Hunter2xyz' }),
      ]),
      { now: NOW }
    );
    expect(report.counts.reused).toBe(0);
  });

  it('gives reuse clusters no label, because the only thing shared is the password', () => {
    const report = analyseVault(
      vault([
        record({ id: 'a', password: 'shared-pw' }),
        record({ id: 'b', password: 'shared-pw' }),
      ]),
      { now: NOW }
    );
    expect(report.clusters[0]?.label).toBeNull();
  });
});

// ── old ──────────────────────────────────────────────────────────────────────

describe('old', () => {
  const cutoff = NOW - DEFAULT_VAULT_SETTINGS.passwordAgeWarningDays * DAY;

  it('fires strictly past the window, not at it', () => {
    // A password changed exactly N days ago is N days old, not older than N days. One
    // millisecond decides it, and no amount of clicking around the app would reveal which
    // way this went.
    const at = vault([record({ id: 'a', passwordUpdatedAt: cutoff })]);
    const older = vault([record({ id: 'a', passwordUpdatedAt: cutoff - 1 })]);
    const newer = vault([record({ id: 'a', passwordUpdatedAt: cutoff + 1 })]);

    expect(rulesFor(at, 'a')).not.toContain('old');
    expect(rulesFor(older, 'a')).toContain('old');
    expect(rulesFor(newer, 'a')).not.toContain('old');
  });

  it('reads the window from vault settings, not from a constant', () => {
    // `passwordAgeWarningDays` lives in VaultSettings and travels with the vault. If the
    // rules ever stopped reading it, the setting would silently do nothing.
    const document = vault([record({ id: 'a', passwordUpdatedAt: NOW - 100 * DAY })], {
      passwordAgeWarningDays: 90,
    });
    expect(rulesFor(document, 'a')).toContain('old');
    expect(analyseVault(document, { now: NOW }).config.thresholds.passwordAgeWarningDays).toBe(90);
  });

  it('lets an explicit override beat the vault setting, for previews', () => {
    const document = vault([record({ id: 'a', passwordUpdatedAt: NOW - 100 * DAY })]);
    expect(rulesFor(document, 'a', { thresholds: { passwordAgeWarningDays: 30 } })).toContain(
      'old'
    );
  });

  it('says nothing about the age of a password that does not exist', () => {
    const document = vault([record({ id: 'a', password: '', passwordUpdatedAt: 0 })]);
    expect(rulesFor(document, 'a')).not.toContain('old');
  });
});

// ── expiring / expired ───────────────────────────────────────────────────────

describe('expiring and expired', () => {
  it('treats the moment of expiry as expired, not expiring', () => {
    // A deadline that has arrived has passed. The `<=` here is the whole rule.
    expect(rulesFor(vault([record({ id: 'a', expiresAt: NOW })]), 'a')).toContain('expired');
    expect(rulesFor(vault([record({ id: 'a', expiresAt: NOW - 1 })]), 'a')).toContain('expired');
    expect(rulesFor(vault([record({ id: 'a', expiresAt: NOW + 1 })]), 'a')).toContain('expiring');
    expect(rulesFor(vault([record({ id: 'a', expiresAt: NOW + 1 })]), 'a')).not.toContain(
      'expired'
    );
  });

  it('warns exactly to the edge of the warning window and no further', () => {
    const horizon = NOW + DEFAULT_HEALTH_THRESHOLDS.expiringWithinDays * DAY;
    expect(rulesFor(vault([record({ id: 'a', expiresAt: horizon })]), 'a')).toContain('expiring');
    expect(rulesFor(vault([record({ id: 'a', expiresAt: horizon + 1 })]), 'a')).not.toContain(
      'expiring'
    );
  });

  it('measures a rotation interval from passwordUpdatedAt, not updatedAt', () => {
    // Renaming a record must not reset its rotation clock. `updatedAt` here is NOW, so a
    // rule reading the wrong field would report this as freshly rotated.
    const due = vault([
      record({ id: 'a', passwordUpdatedAt: NOW - 90 * DAY, rotationIntervalDays: 90 }),
    ]);
    const notDue = vault([
      record({ id: 'a', passwordUpdatedAt: NOW - 90 * DAY, rotationIntervalDays: 91 }),
    ]);
    expect(rulesFor(due, 'a')).toContain('expired');
    expect(rulesFor(notDue, 'a')).toContain('expiring');
    expect(rulesFor(notDue, 'a')).not.toContain('expired');
  });

  it('takes the earlier of an explicit date and a rotation interval', () => {
    // Two ways of saying "by then". Honouring the later one would let one setting quietly
    // cancel the other, which is the opposite of what someone setting both intends.
    const document = vault([
      record({
        id: 'a',
        expiresAt: NOW + 1000 * DAY,
        passwordUpdatedAt: NOW - 400 * DAY,
        rotationIntervalDays: 90,
      }),
    ]);
    expect(rulesFor(document, 'a')).toContain('expired');
  });

  it('says nothing when the user set neither', () => {
    const rules = rulesFor(vault([record({ id: 'a' })]), 'a');
    expect(rules).not.toContain('expired');
    expect(rules).not.toContain('expiring');
  });
});

// ── insecureUrl ──────────────────────────────────────────────────────────────

describe('insecureUrl', () => {
  it('flags plain http and ignores https', () => {
    expect(
      rulesFor(vault([record({ id: 'a', urls: ['http://example.com/login'] })]), 'a')
    ).toContain('insecureUrl');
    expect(
      rulesFor(vault([record({ id: 'a', urls: ['https://example.com/login'] })]), 'a')
    ).not.toContain('insecureUrl');
    // Schemes are case-insensitive in every browser; the rule must agree.
    expect(rulesFor(vault([record({ id: 'a', urls: ['HTTP://Example.com'] })]), 'a')).toContain(
      'insecureUrl'
    );
  });

  it('does not flag loopback, where plain http is correct', () => {
    // A dev server, a router admin page, a container on `api.localhost`. Flagging these
    // teaches the user the rule cries wolf, which costs more than the rule is worth.
    for (const url of [
      'http://localhost:3000/admin',
      'http://127.0.0.1:8080',
      'http://127.1.2.3/',
      'http://api.localhost/',
      'http://[::1]:9000/x',
      'http://0.0.0.0:5000',
    ]) {
      expect(rulesFor(vault([record({ id: 'a', urls: [url] })]), 'a'), url).not.toContain(
        'insecureUrl'
      );
    }
    expect(isLoopbackHost('example.com')).toBe(false);
  });

  it('reports a record once however many bad URLs it has', () => {
    // Otherwise the score would count the same defect several times over.
    const document = vault([
      record({ id: 'a', urls: ['http://one.example.com', 'http://two.example.com'] }),
    ]);
    expect(rulesFor(document, 'a').filter((rule) => rule === 'insecureUrl')).toHaveLength(1);
  });

  it('normalises hosts for comparison but never for security decisions about case', () => {
    expect(normaliseHost('https://WWW.GitHub.com:443/a/b?c#d')).toBe('github.com');
    expect(normaliseHost('user:pw@Example.COM./login')).toBe('example.com');
    expect(normaliseHost('example.com')).toBe('example.com');
    expect(normaliseHost('   ')).toBeNull();
    expect(normaliseHost('https://')).toBeNull();
  });
});

// ── missingTotp ──────────────────────────────────────────────────────────────

describe('missingTotp', () => {
  /** The rule ships off, so every test that wants to see it fire has to ask for it. */
  const on = { enabledRules: { missingTotp: true } };

  it('is off by default, and is the only rule that is', () => {
    // The whole design decision, pinned. A default report finding nothing on a vault with
    // no second factors anywhere is the default working, not the rule being broken — so
    // both halves are asserted, or a rule that never fired would look identical.
    for (const rule of HEALTH_RULE_IDS) {
      expect(DEFAULT_HEALTH_RULE_TOGGLES[rule], rule).toBe(rule !== 'missingTotp');
    }

    const document = vault([record({ id: 'a' })]);
    expect(analyseVault(document, { now: NOW }).counts.missingTotp).toBe(0);
    expect(rulesFor(document, 'a')).not.toContain('missingTotp');
    expect(rulesFor(document, 'a', on)).toContain('missingTotp');
  });

  it('does not flag a record carrying a seed, in either form a vault stores one', () => {
    // Import parsers keep whichever form the source gave them: 1Password, Safari and
    // Bitwarden's JSON keep the whole `otpauth://` URI, LastPass and most CSVs keep the bare
    // base32 seed. A rule that recognised only one of them would tell half of a freshly
    // migrated vault that it has no 2FA, on the records where it demonstrably does.
    for (const seed of [
      'JBSWY3DPEHPK3PXP',
      'otpauth://totp/Example:bob@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example',
    ]) {
      expect(rulesFor(vault([record({ id: 'a', totpSecret: seed })]), 'a', on), seed).not.toContain(
        'missingTotp'
      );
    }
  });

  it('flags an otp-secret field with nothing in it', () => {
    // The field existing is not the same as a second factor existing: an empty one generates
    // no codes, so the account is still reachable with the password alone. This is where the
    // rule is deliberately stricter than the `has:totp` search flag, which asks only whether
    // the field is present.
    expect(rulesFor(vault([record({ id: 'a', totpSecret: '' })]), 'a', on)).toContain(
      'missingTotp'
    );
    expect(rulesFor(vault([record({ id: 'a', totpSecret: '   ' })]), 'a', on)).toContain(
      'missingTotp'
    );
  });

  it('does not mistake another secret custom field for a seed', () => {
    // `customValue` builds a *hidden* custom field of type `password` — a stored recovery
    // code. Keying the rule off "has a hidden custom field", or off the field's label, would
    // count that as a second factor and quietly clear the record.
    expect(
      rulesFor(vault([record({ id: 'a', customValue: 'recovery-code-1234' })]), 'a', on)
    ).toContain('missingTotp');
  });

  it('says nothing about a record with no password for a second factor to be second to', () => {
    // Same reasoning as `weak` and `old` skipping a missing password: a record with no first
    // factor is `incomplete`, which already says the useful thing about it. Reporting both
    // would penalise one defect twice and send the user to add 2FA to a record that cannot
    // sign anyone in yet.
    const document = vault([record({ id: 'a', password: '' })]);
    expect(rulesFor(document, 'a', on)).toContain('incomplete');
    expect(rulesFor(document, 'a', on)).not.toContain('missingTotp');
  });

  it('carries no detail, because everything about a seed is secret material', () => {
    // `insecureUrl` sets a detail and this rule must not: the issuer and account name in an
    // `otpauth://` URI are only reachable by parsing the seed's own field, and the report
    // crosses to the renderer. A boolean is the entire safe answer.
    const report = analyseVault(vault([record({ id: 'a' })]), { now: NOW, ...on });
    const found = report.issues.filter((entry) => entry.rule === 'missingTotp');
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toBeNull();
    expect(found[0]?.clusterId).toBeNull();
  });
});

// ── incomplete ───────────────────────────────────────────────────────────────

describe('incomplete', () => {
  it('needs a password, and a username or an email', () => {
    const cases: readonly [RecordInput, boolean][] = [
      [{ id: 'a', username: 'bob', email: '' }, false],
      [{ id: 'a', username: '', email: 'bob@example.com' }, false],
      [{ id: 'a', username: '', email: '' }, true],
      [{ id: 'a', password: '' }, true],
      // Whitespace is not an identity. A record whose username is a stray space cannot be
      // used to log in any more than an empty one can.
      [{ id: 'a', username: '   ', email: '  ' }, true],
    ];

    for (const [input, expected] of cases) {
      expect(
        rulesFor(vault([record(input)]), 'a').includes('incomplete'),
        JSON.stringify(input)
      ).toBe(expected);
    }
  });
});

// ── duplicate ────────────────────────────────────────────────────────────────

describe('duplicate', () => {
  it('clusters records that look like the same account', () => {
    // Host case, a `www.` prefix, a port and a path must not make two records look like
    // different accounts — a human reading them would say they are the same.
    const report = analyseVault(
      vault([
        record({ id: 'a', urls: ['https://www.GitHub.com/login'], username: 'bob' }),
        record({ id: 'b', urls: ['https://github.com:443/settings'], username: 'BOB' }),
        record({ id: 'c', urls: ['https://github.com'], username: 'alice' }),
      ]),
      { now: NOW }
    );

    const clusters = report.clusters.filter((cluster) => cluster.rule === 'duplicate');
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.credentialIds).toEqual(['a', 'b']);
    expect(clusters[0]?.label).toBe('github.com · bob');
    expect(rulesFor(vault([]), 'c')).toEqual([]);
  });

  it('does not cluster records with nothing to identify them by', () => {
    // Without a host or an identity there is no evidence of duplication, only of emptiness
    // — and `incomplete` already says that.
    const report = analyseVault(
      vault([
        record({ id: 'a', urls: [], username: 'bob' }),
        record({ id: 'b', urls: [], username: 'bob' }),
        record({ id: 'c', urls: ['https://x.example.com'], username: '', email: '' }),
        record({ id: 'd', urls: ['https://x.example.com'], username: '', email: '' }),
      ]),
      { now: NOW }
    );
    expect(report.counts.duplicate).toBe(0);
  });

  it('uses only the primary URL', () => {
    // A record listing five mirrors of a site is not five chances to be a duplicate.
    const report = analyseVault(
      vault([
        record({ id: 'a', urls: ['https://one.example.com', 'https://shared.example.com'] }),
        record({ id: 'b', urls: ['https://shared.example.com'], username: 'user-a' }),
      ]),
      { now: NOW }
    );
    expect(report.counts.duplicate).toBe(0);
  });
});

// ── emptyTitle ───────────────────────────────────────────────────────────────

describe('emptyTitle', () => {
  it('flags a record search could never surface', () => {
    expect(rulesFor(vault([record({ id: 'a', title: '' })]), 'a')).toContain('emptyTitle');
    expect(rulesFor(vault([record({ id: 'a', title: '   ' })]), 'a')).toContain('emptyTitle');
    expect(rulesFor(vault([record({ id: 'a', title: 'x' })]), 'a')).not.toContain('emptyTitle');
  });
});

// ── trashed records ──────────────────────────────────────────────────────────

/**
 * Three records that between them break every rule. Two of them (`a`, `b`) share a weak
 * password, a host and a username, so `reused` and `duplicate` both fire; `c` covers
 * `incomplete`, which is mutually exclusive with `weak` and `reused` on a single record.
 */
function maximallyBroken(trashed: boolean): Credential[] {
  const trashedAt = trashed ? NOW - DAY : null;
  const base = {
    title: '',
    password: 'aaa',
    username: 'bob',
    urls: ['http://ex.example.com/login'],
    passwordUpdatedAt: NOW - 1000 * DAY,
    trashedAt,
  };
  return [
    record({ ...base, id: 'a', expiresAt: NOW - DAY }),
    record({ ...base, id: 'b', expiresAt: NOW + DAY }),
    record({ id: 'c', title: '', password: '', username: '', email: '', urls: [], trashedAt }),
  ];
}

describe('trashed records are excluded from every rule', () => {
  // Someone who deleted a weak password has dealt with it. Continuing to score them down
  // for it trains them to ignore the dashboard, which costs more than the finding is worth.
  //
  // The first case is what stops the second from passing vacuously: if the fixture stopped
  // breaking a rule, this would fail rather than quietly weakening the guard below.
  it('the fixture really does break every rule when it is not trashed', () => {
    const report = analyseVault(vault(maximallyBroken(false)), {
      now: NOW,
      enabledRules: ALL_RULES_ON,
    });
    for (const rule of HEALTH_RULE_IDS) {
      expect(report.counts[rule], `rule ${rule} should fire`).toBeGreaterThan(0);
    }
  });

  it('reports nothing at all once the same records are in the trash', () => {
    const report = analyseVault(vault(maximallyBroken(true)), {
      now: NOW,
      enabledRules: ALL_RULES_ON,
    });
    for (const rule of HEALTH_RULE_IDS) {
      expect(report.counts[rule], `rule ${rule} must not fire on trash`).toBe(0);
    }
    expect(report.issues).toHaveLength(0);
    expect(report.clusters).toHaveLength(0);
    expect(report.byCredential).toHaveLength(0);
    expect(report.analysedCount).toBe(0);
    expect(report.trashedCount).toBe(3);
    expect(report.score).toBe(100);
  });

  it('does not let a trashed record join a live record’s cluster', () => {
    // The subtle version of the same bug: excluding trashed records from the *count* but
    // not from the clustering would report a live password as reused because a deleted
    // record still holds it.
    const report = analyseVault(
      vault([
        record({ id: 'live', password: 'shared-pw' }),
        record({ id: 'gone', password: 'shared-pw', trashedAt: NOW - DAY }),
      ]),
      { now: NOW }
    );
    expect(report.counts.reused).toBe(0);
    expect(report.clusters).toHaveLength(0);
  });
});

// ── toggles and thresholds ───────────────────────────────────────────────────

describe('rules are independently toggleable', () => {
  it('drops exactly the disabled rule and nothing else', () => {
    const document = vault(maximallyBroken(false));
    const all = analyseVault(document, { now: NOW, enabledRules: ALL_RULES_ON });

    for (const rule of HEALTH_RULE_IDS) {
      const without = analyseVault(document, {
        now: NOW,
        enabledRules: { ...ALL_RULES_ON, [rule]: false },
      });
      expect(without.counts[rule], `${rule} should be silenced`).toBe(0);
      for (const other of HEALTH_RULE_IDS) {
        if (other === rule) continue;
        expect(without.counts[other], `${rule} off must not change ${other}`).toBe(
          all.counts[other]
        );
      }
    }
  });

  it('never lowers the score by switching a rule off', () => {
    // The property that makes the weighting defensible: disabling a check can only stop
    // penalising you. A user who turns off `expiring` must not watch their score drop.
    const document = vault(maximallyBroken(false));
    const all = analyseVault(document, { now: NOW, enabledRules: ALL_RULES_ON }).score;
    for (const rule of HEALTH_RULE_IDS) {
      const without = analyseVault(document, {
        now: NOW,
        enabledRules: { ...ALL_RULES_ON, [rule]: false },
      });
      expect(without.score, `disabling ${rule}`).toBeGreaterThanOrEqual(all);
    }
  });
});

// ── the score ────────────────────────────────────────────────────────────────

describe('the score', () => {
  it('is exactly 100 minus the average per-record penalty', () => {
    // The score is meant to be arguable, which means reproducible from the report itself.
    // If this ever diverges, the number on the dashboard has become a horoscope.
    const report = analyseVault(vault(maximallyBroken(false)), { now: NOW });
    const total = report.byCredential.reduce((sum, entry) => sum + entry.penalty, 0);
    expect(report.score).toBe(Math.round(100 - total / report.analysedCount));
  });

  it('costs a single weak record exactly its weight', () => {
    const report = analyseVault(vault([record({ id: 'a', password: 'abcdefghij' })]), { now: NOW });
    expect(report.byCredential[0]?.penalty).toBe(HEALTH_RULE_WEIGHTS.weak);
    expect(report.score).toBe(100 - HEALTH_RULE_WEIGHTS.weak);
  });

  it('gives a clean vault, and an empty one, 100', () => {
    // An empty vault is unmeasured, not unhealthy. Reporting 0 would be a lie in the
    // alarming direction, and the first thing a new user would ever see.
    expect(analyseVault(vault([]), { now: NOW }).score).toBe(100);
    const clean = analyseVault(vault([record({ id: 'a' }), record({ id: 'b' })]), { now: NOW });
    expect(clean.score).toBe(100);
    expect(clean.healthyCount).toBe(2);
    expect(clean.byCredential).toHaveLength(0);
  });

  it('bottoms out at the worst mutually-consistent combination, and never below 0', () => {
    // Documented in HEALTH_RULE_WEIGHTS: the worst a single record can consistently be is
    // reused + weak + expired + old + insecureUrl + duplicate + emptyTitle = 99 points, so
    // a vault of them scores 1. Pinned here so a weight change that breaks the documented
    // arithmetic breaks a test rather than a paragraph of prose.
    const worst = {
      title: '',
      password: 'aaa',
      username: 'bob',
      urls: ['http://ex.example.com/login'],
      passwordUpdatedAt: NOW - 1000 * DAY,
      expiresAt: NOW - DAY,
    };
    const report = analyseVault(
      vault([record({ ...worst, id: 'a' }), record({ ...worst, id: 'b' })]),
      { now: NOW }
    );
    expect(report.byCredential.every((entry) => entry.penalty === 99)).toBe(true);
    expect(report.score).toBe(1);
    expect(report.score).toBeGreaterThanOrEqual(0);

    // With `missingTotp` switched on too, the same records break an eighth rule — none of
    // them carries a seed — for 107 raw, which the per-record cap clips to 100 and puts the
    // vault at 0. Pinned because HEALTH_RULE_WEIGHTS states that arithmetic in prose, and
    // because it is the one case where the cap is load-bearing rather than theoretical.
    const capped = analyseVault(
      vault([record({ ...worst, id: 'a' }), record({ ...worst, id: 'b' })]),
      { now: NOW, enabledRules: ALL_RULES_ON }
    );
    expect(capped.byCredential.every((entry) => entry.penalty === MAX_PENALTY_PER_RECORD)).toBe(
      true
    );
    expect(capped.score).toBe(0);
  });

  it('caps what one record can cost', () => {
    expect(MAX_PENALTY_PER_RECORD).toBe(100);
    const report = analyseVault(vault(maximallyBroken(false)), { now: NOW });
    for (const entry of report.byCredential) {
      expect(entry.penalty).toBeLessThanOrEqual(MAX_PENALTY_PER_RECORD);
    }
  });
});

// ── no second source of truth ────────────────────────────────────────────────

describe('configuration', () => {
  it('keeps the password-age default equal to the vault-settings default', () => {
    // Two defaults that are meant to be the same number, in two files. Without this they
    // drift, and the health dashboard starts disagreeing with the settings screen.
    expect(DEFAULT_HEALTH_THRESHOLDS.passwordAgeWarningDays).toBe(
      DEFAULT_VAULT_SETTINGS.passwordAgeWarningDays
    );
  });

  it('reports the configuration it actually used', () => {
    const report = analyseVault(vault([]), {
      now: NOW,
      thresholds: { weakEntropyBits: 80 },
      enabledRules: { reused: false },
    });
    expect(report.config.thresholds.weakEntropyBits).toBe(80);
    expect(report.config.enabledRules.reused).toBe(false);
    expect(report.config.enabledRules.weak).toBe(true);
    expect(report.generatedAt).toBe(NOW);
  });

  it('is deterministic: same inputs, byte-identical report', () => {
    // `now` is a parameter precisely so this holds. A rule that reached for Date.now() or
    // iterated a Set of passwords would break it.
    const document = vault(maximallyBroken(false));
    expect(JSON.stringify(analyseVault(document, { now: NOW }))).toBe(
      JSON.stringify(analyseVault(document, { now: NOW }))
    );
  });
});

// ── the property that matters most ───────────────────────────────────────────

/**
 * **The most important test in this file.**
 *
 * A health report crosses to the renderer, so decision D13 binds it: no secret material,
 * and nothing derived from a secret that would narrow a search for it. The reuse rule is
 * the hazard — it exists to compare passwords, so it is the one place in the codebase where
 * passwords are used as map keys and grouped, and the natural implementations of "tell the
 * user which records share a password" leak it (a label, a hash, a prefix, a key).
 *
 * This is written as a property rather than a list of field assertions on purpose: a
 * per-field check cannot catch a *new* field being added and forgotten, which is exactly
 * how a boundary like this fails in practice.
 */
const SECRET_MARKER = 'SECRET_MARKER_MUST_NOT_LEAK';
const marker = (where: string): string => `${SECRET_MARKER}_${where}`;

function vaultFullOfSecrets(): VaultDocument {
  // Every password contains the marker, several records share one (so clusters form), one
  // URL carries credentials in its userinfo — the case that makes copying a raw URL into
  // the report a leak rather than a convenience — and one record carries a marked TOTP
  // seed, so `missingTotp` is exercised on a vault where the thing it inspects is secret.
  const shared = marker('shared-password');
  return vault([
    record({
      id: 'a',
      password: shared,
      notes: marker('notes-a'),
      answer: marker('answer-a'),
      customValue: marker('custom-a'),
      urls: [`http://someone:${marker('url-userinfo')}@example.com/login`],
      title: '',
      passwordUpdatedAt: NOW - 1000 * DAY,
      expiresAt: NOW - DAY,
    }),
    record({
      id: 'b',
      password: shared,
      notes: marker('notes-b'),
      answer: marker('answer-b'),
      urls: ['http://example.com/login'],
      passwordUpdatedAt: NOW - 1000 * DAY,
      rotationIntervalDays: 1,
    }),
    record({
      id: 'c',
      password: marker('unique-c'),
      customValue: marker('custom-c'),
      totpSecret: marker('totp-seed-c'),
    }),
    record({ id: 'd', password: marker('trashed-d'), trashedAt: NOW - DAY }),
  ]);
}

/** Every string anywhere in a value, however deeply nested. */
function allStrings(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, found);
  else if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) allStrings(nested, found);
  }
  return found;
}

describe('a health report never carries secret material', () => {
  it('leaks no marker anywhere in the serialised report', () => {
    const report = analyseVault(vaultFullOfSecrets(), { now: NOW });
    // Sanity: the fixture must actually exercise the reuse path, or this proves nothing.
    expect(report.counts.reused).toBe(2);
    expect(JSON.stringify(report)).not.toContain(SECRET_MARKER);
  });

  it('leaks no marker from a TOTP seed, on the records with one and the records without', () => {
    // `missingTotp` is off by default, so the sweep above would never run it. It reads a
    // field whose value is secret material, which makes it exactly the kind of rule that
    // leaks by being helpful — an issuer name, a "seed starts with…", a cluster of records
    // sharing a seed. Two of these records have no seed and one has a marked one, so both
    // branches of the rule are walked with the marker present.
    const report = analyseVault(vaultFullOfSecrets(), {
      now: NOW,
      enabledRules: { missingTotp: true },
    });
    expect(report.counts.missingTotp).toBe(2);
    expect(JSON.stringify(report)).not.toContain(SECRET_MARKER);
    for (const value of allStrings(report)) {
      expect(value).not.toContain(SECRET_MARKER);
    }
  });

  it('leaks no marker in any nested string, however deep', () => {
    // Belt and braces: JSON.stringify would miss a value behind a custom toJSON.
    const report = analyseVault(vaultFullOfSecrets(), { now: NOW });
    for (const value of allStrings(report)) {
      expect(value).not.toContain(SECRET_MARKER);
    }
  });

  it('holds for every subset of enabled rules', () => {
    // Turning a rule on must not open a leak that the default configuration hides.
    const document = vaultFullOfSecrets();
    for (const rule of HEALTH_RULE_IDS) {
      const only = analyseVault(document, {
        now: NOW,
        enabledRules: Object.fromEntries(
          HEALTH_RULE_IDS.map((candidate) => [candidate, candidate === rule])
        ),
      });
      expect(JSON.stringify(only), `only ${rule} enabled`).not.toContain(SECRET_MARKER);
    }
  });

  it('carries the host of an insecure URL, never the URL itself', () => {
    // A URL may hold credentials in its userinfo. The host cannot.
    const report = analyseVault(vaultFullOfSecrets(), { now: NOW });
    const insecure = report.issues.filter((issue) => issue.rule === 'insecureUrl');
    expect(insecure.length).toBeGreaterThan(0);
    for (const issue of insecure) {
      expect(issue.detail).toBe('example.com');
    }
  });

  it('is JSON round-trippable, so nothing hides behind a class instance', () => {
    const report = analyseVault(vaultFullOfSecrets(), { now: NOW });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
