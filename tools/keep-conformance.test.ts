// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { readPreamble } from '../src/main/format/container.js';
import { VaultService } from '../src/main/vault/vault-service.js';

/**
 * The KEEP format's conformance vector, and the guard that keeps the spec honest about it.
 *
 * `docs/04-Vault-Format/00-KEEP-Format-Spec.md` claims to be implementable by somebody who
 * has never seen this source, and that claim was missing the one thing such a person most
 * needs: **a file to test against**. A specification without a vector is a specification you
 * can follow carefully and still get wrong, with nothing to tell you which of a dozen
 * decisions you read differently.
 *
 * ## Why the file is committed rather than generated per run
 *
 * A vector's whole value is that it was produced by an implementation the reader is not
 * running. Regenerating it on every run would make it a mirror of today's code — it would
 * pass forever, including after a change that broke every existing vault on disk. This file
 * is written once and then only ever *read*, so the day the reader stops being able to open
 * it is the day it fails.
 *
 * It is written on first run rather than being an error, because a fresh clone has to be able
 * to produce it; after that, the assertions below are reading a file the current code did not
 * make.
 *
 * ## Why the numbers are not asserted byte-for-byte
 *
 * The salt is random and every nonce is fresh, by design — so two vaults created from
 * identical inputs share no bytes, and a byte-exact vector is impossible without weakening
 * the thing it is meant to verify. What is asserted instead is everything a reader must get
 * right: the magic, the version, the plaintext header's shape, and that the body decrypts to
 * exactly the records that went in.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const VECTOR_DIR = join(ROOT, 'tests/fixtures/format');
const VECTOR = join(VECTOR_DIR, 'conformance.keep');

/** Stated in the spec's §12. An implementer types this in; it must not drift from it. */
const VECTOR_PASSWORD = 'keep-conformance-vector';

/** The OWASP floor, so the vector opens quickly on any machine. Also stated in the spec. */
const VECTOR_KDF = { memoryKib: 19_456, iterations: 2, parallelism: 1 } as const;

const VECTOR_RECORDS = [
  { title: 'Example Login', username: 'someone@example.com', password: 'correct-horse' },
  { title: 'Example Note', notes: 'The recovery kit is in the safe, not the drawer' },
] as const;

/**
 * Written once, before anything reads it.
 *
 * Was a lazy `if (!existsSync(VECTOR)) await writeVector()` inside each test, which failed
 * intermittently on the run that first created the file: several tests each found it missing
 * and raced to produce it, so one read a half-written vault. Only ever reachable on a fresh
 * clone, which is exactly the run nobody watches.
 */
beforeAll(async () => {
  if (!existsSync(VECTOR)) await writeVector();
});

async function writeVector(): Promise<void> {
  mkdirSync(VECTOR_DIR, { recursive: true });
  const service = new VaultService('conformance-vector');
  await service.createVault({ path: VECTOR, password: VECTOR_PASSWORD, kdf: VECTOR_KDF });
  for (const record of VECTOR_RECORDS) service.createCredential(record);
  await service.save();
  service.lock();

  // `save()` rotates a backup beside the vault, which is right for a real vault and wrong for
  // a fixture: a committed `.bak.1` is a second copy of the vector that nothing reads and
  // that would drift from it the moment either was regenerated.
  rmSync(`${VECTOR}.bak.1`, { force: true });
}

describe('the KEEP conformance vector', () => {
  it('opens with the password the specification publishes', async () => {
    const service = new VaultService('reader');
    // The whole point: this is a file the current code did not produce, opened by the current
    // code. A format change that breaks existing vaults fails here and nowhere else.
    await expect(service.unlock(VECTOR, VECTOR_PASSWORD)).resolves.toBeDefined();

    expect(
      service
        .listProjections()
        .map((record) => record.title)
        .sort()
    ).toEqual(['Example Login', 'Example Note']);
    service.lock();
  });

  it('refuses the wrong password, which is what makes the first assertion mean anything', async () => {
    // Without this, "it opened" could be true of a reader that ignored the password entirely.
    const service = new VaultService('reader');
    await expect(service.unlock(VECTOR, 'not-the-vector-password')).rejects.toThrow();
  });

  it('has the plaintext header the specification describes', () => {
    // Read *without* a password, which is §2's central claim: the header is plaintext and
    // authenticated, so a tool can report on a vault it cannot open.
    const { header } = readPreamble(new Uint8Array(readFileSync(VECTOR)));

    expect(header.formatVersion).toBe(1);
    expect(header.kdf.alg).toBe('argon2id');
    expect(header.kdf.memoryKib).toBe(VECTOR_KDF.memoryKib);
    expect(header.kdf.iterations).toBe(VECTOR_KDF.iterations);
    // Upper-case. The first draft of §12 wrote it lower-case and this caught it within a
    // minute of existing, which is a small but exact demonstration of why a specification
    // wants a vector: §3 had the right value the whole time, and prose two sections apart
    // disagreed with itself.
    expect(header.cipher).toBe('AES-256-GCM');
    expect(header.recordCount).toBe(VECTOR_RECORDS.length);
  });

  it('begins with the magic the specification names', () => {
    const bytes = readFileSync(VECTOR);
    expect(bytes.subarray(0, 7).toString('latin1')).toBe('KEYHOLD');
  });
});

describe('the specification and the vector agree', () => {
  const spec = readFileSync(join(ROOT, 'docs/04-Vault-Format/00-KEEP-Format-Spec.md'), 'utf8');

  it('publishes the password this test uses', () => {
    // A vector nobody can open is not a vector. If the spec's password and this one drift, an
    // implementer follows the document and gets a file that refuses them, with no way to tell
    // whether their reader or the document is wrong.
    expect(spec).toContain(VECTOR_PASSWORD);
  });

  it('publishes the cost the vector was built at', () => {
    // Argon2 parameters are in the header, so an implementer does not strictly need these —
    // but somebody debugging a derivation that produces the wrong key needs to know what the
    // right answer was built from.
    expect(spec).toContain(String(VECTOR_KDF.memoryKib));
  });

  it('names the vector by the path it is actually at', () => {
    expect(spec).toContain('tests/fixtures/format/conformance.keep');
  });
});
