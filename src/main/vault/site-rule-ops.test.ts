// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SITE_RULE_MAX } from '@shared/model/site-rules.js';
import { OrganisationError } from '../organisation/errors.js';
import { VaultService } from './vault-service.js';

/**
 * The site-rule operations, and the versioning claim the roadmap line makes.
 *
 * The line is "per-site rule memory, **and generate-and-replace that auto-versions the old
 * password**". The second half is the one worth a test, and the interesting thing about it is
 * that there is no code to point at: replacing a password in the editor is an ordinary
 * `updateCredential`, and that already writes a history entry for every field that moved.
 *
 * That is the design rather than an accident. A separate "generate and replace" path would be
 * a second way to change a password, and of two paths one of them eventually stops versioning
 * — silently, since a missing history entry looks exactly like a record nobody edited. So the
 * test asserts the property through the ordinary path, which is the only path.
 */

let dir: string;
let vaultPath: string;
let service: VaultService;

const PASSWORD = 'a-perfectly-reasonable-master-password';
const FAST_KDF = { memoryKib: 19_456, iterations: 2, parallelism: 1 } as const;

async function create(): Promise<void> {
  await service.createVault({ path: vaultPath, password: PASSWORD, kdf: FAST_KDF });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'keyhold-siterules-'));
  vaultPath = join(dir, 'test.keep');
  service = new VaultService('test-device');
});

afterEach(async () => {
  service.lock();
  await rm(dir, { recursive: true, force: true });
});

describe('remembering a site rule', () => {
  it('normalises the URL it was given into the host the lookup will ask for', async () => {
    await create();
    const rule = service.setSiteRule({
      url: 'https://www.Bank.example/login?next=1',
      options: { length: 16 },
      note: 'Truncates at 16',
    });

    // The whole point of storing the normalised form: `ruleForUrl` asks by registrable host,
    // so a rule stored as a full URL could never fire.
    expect(rule.host).toBe('bank.example');
    expect(service.siteRules().map((entry) => entry.host)).toEqual(['bank.example']);
  });

  it('replaces rather than duplicating, because the host is the identity', async () => {
    await create();
    service.setSiteRule({ url: 'https://bank.example', options: { length: 16 } });
    service.setSiteRule({ url: 'https://www.bank.example/login', options: { length: 20 } });

    // Two rules for one host would mean the generator silently applying one of them, and
    // nothing on screen able to say which.
    const rules = service.siteRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.options).toEqual({ length: 20 });
  });

  it('stamps the modification time the merge tie-breaks on', async () => {
    await create();
    const first = service.setSiteRule({ url: 'https://bank.example', options: { length: 16 } });
    const second = service.setSiteRule({ url: 'https://bank.example', options: { length: 20 } });

    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });

  it('refuses a URL that cannot key a rule', async () => {
    await create();
    // A rule under an empty host would apply to every site whose URL failed to parse, which
    // is the opposite of what a per-site rule is for.
    expect(() => service.setSiteRule({ url: '   ', options: { length: 16 } })).toThrow(
      OrganisationError
    );
  });

  it('refuses a new rule past the cap, but still lets an existing one be corrected', async () => {
    await create();
    for (let index = 0; index < SITE_RULE_MAX; index += 1) {
      service.setSiteRule({ url: `https://site${String(index)}.example`, options: { length: 16 } });
    }

    expect(() =>
      service.setSiteRule({ url: 'https://one-more.example', options: { length: 16 } })
    ).toThrow(OrganisationError);

    // The list is not growing, so this must be allowed — being at the cap cannot mean being
    // unable to fix a rule that is wrong.
    expect(
      service.setSiteRule({ url: 'https://site0.example', options: { length: 24 } }).options
    ).toEqual({ length: 24 });
  });

  it('forgets one, and says whether there was anything to forget', async () => {
    await create();
    service.setSiteRule({ url: 'https://bank.example', options: { length: 16 } });

    expect(service.deleteSiteRule('bank.example')).toBe(true);
    expect(service.siteRules()).toEqual([]);
    expect(service.deleteSiteRule('bank.example')).toBe(false);
  });

  it('survives a save and a reopen', async () => {
    await create();
    service.setSiteRule({
      url: 'https://bank.example',
      options: { length: 16 },
      note: 'Truncates at 16',
    });
    await service.save();
    service.lock();

    await service.unlock(vaultPath, PASSWORD);
    expect(service.siteRules()[0]?.note).toBe('Truncates at 16');
  });
});

describe('replacing a password versions the old one', () => {
  it('writes a history entry naming the password as changed', async () => {
    await create();
    const created = service.createCredential({ title: 'Bank', password: 'the-old-password' });

    service.updateCredential(created.id, { fields: { password: 'the-generated-replacement' } });

    // The claim the roadmap line makes, asserted through the ordinary edit path because that
    // is the only path — a dedicated generate-and-replace route would be a second way to
    // change a password, and of two, one eventually stops versioning.
    const versions = service.getProjection(created.id)?.history ?? [];
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.at(-1)?.changedFields).toContain('password');
  });

  it('keeps the old password reachable, not merely recorded as changed', async () => {
    await create();
    const created = service.createCredential({ title: 'Bank', password: 'the-old-password' });
    service.updateCredential(created.id, { fields: { password: 'the-generated-replacement' } });

    // The first (and only) version, not the last: `appendVersion` records the state *before*
    // the edit, so the entry holding the old password is the one written by this update.
    const [version] = service.getProjection(created.id)?.history ?? [];
    expect(version).toBeDefined();

    // "Versioned" has to mean recoverable. A history entry that recorded the field moved
    // without keeping what it held would be a changelog, not a version — and the reason to
    // version a replaced password is to get it back when the new one turns out to be
    // rejected.
    const diff = service.diffVersion(created.id, version?.versionNumber ?? 0) ?? [];
    const passwordDiff = diff.find((entry) => entry.field === 'password');
    expect(passwordDiff?.before).toBe('the-old-password');
  });
});
