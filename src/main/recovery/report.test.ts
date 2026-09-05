// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTICS,
  DOCUMENT_DIAGNOSTIC_CODES,
  FILE_DIAGNOSTIC_CODES,
} from '@shared/model/recovery.js';
import type { Credential } from '@shared/model/credential.js';
import { emptyVaultDocument, type VaultDocument } from '@shared/model/vault-document.js';
import { recordOf } from '../attachments/test-fixtures.js';
import { diagnoseDocument } from './document-diagnosis.js';
import { inspectVaultFile } from './file-inspection.js';
import {
  DISCLOSURE_CARRIED,
  DISCLOSURE_STATEMENT,
  DISCLOSURE_WITHHELD,
  buildRecoveryReport,
  renderRecoveryReport,
} from './report.js';
import { surveyVaultFiles } from './survey.js';
import {
  FIXTURE_DEVICE_ID,
  FIXTURE_NOW,
  FIXTURE_VAULT_ID,
  bodyOffsetOf,
  buildContainer,
  chunkId,
  truncatedTo,
} from './test-support.js';

/**
 * The report is written to be pasted into a bug report, which is what makes the no-content
 * property the most important test in this directory. Everything else here is about it saying
 * what was *checked*, not only what failed — because a reader who cannot tell "clean" from
 * "never ran" has been told nothing.
 */

const DAY = 86_400_000;

/**
 * One marker per category the report promises to withhold, keyed by the category.
 *
 * A single umbrella marker proves "nothing leaked", which is the property that matters most —
 * but it cannot prove that each category the report *names* is individually guaranteed, and
 * naming a category is what a user acts on. So the map is keyed by the exact phrases in
 * `DISCLOSURE_WITHHELD`, `plantedMarkers` proves every one of them is really planted, and the
 * sweep then checks them one at a time. Add a category to the promise without planting it and
 * the fixture test fails; plant one the report does not actually withhold and the sweep fails.
 */
const WITHHELD_MARKERS: Readonly<Record<string, string>> = {
  passwords: 'ZZPASSWORDZZ',
  notes: 'ZZNOTEBODYZZ',
  titles: 'ZZTITLEZZ',
  usernames: 'ZZUSERNAMEZZ',
  emails: 'ZZEMAILZZ',
  'web addresses': 'ZZWEBADDRZZ',
  'field labels': 'ZZFIELDLABELZZ',
  'security questions or answers': 'ZZSECURITYQAZZ',
  'tag or folder names': 'ZZORGNAMEZZ',
  'attachment names': 'ZZATTACHNAMEZZ',
  // The directory lives in the path handed to the report, not in the document.
  'directory paths': 'ZZDIRMARKERZZ',
};

/**
 * The corrupt document's own bytes, which belong to no field at all.
 *
 * A snapshot key or a changed-field name out of a damaged vault is whatever the corruption
 * put there — `versioning.ts` and `history-detail.ts` both say a fragment of a decrypted note
 * is the case to plan for. It gets its own token rather than borrowing the `notes` one so that
 * each token is planted in exactly one place: a token planted twice makes the plant check
 * below unable to notice when one of the two goes missing, which is how a sweep quietly stops
 * covering what it claims to. (Learned the hard way: it did exactly that once here.)
 */
const CORRUPT_KEY_MARKER = 'ZZCORRUPTKEYZZ';

/** Shorthand, because the fixture below reads better than `WITHHELD_MARKERS['titles']` does. */
function marker(category: string): string {
  const value = WITHHELD_MARKERS[category];
  if (value === undefined) throw new Error(`no marker planted for "${category}"`);
  return value;
}

/** A vault where every user-authored string carries the marker for its own category. */
function poisonedDocument(): VaultDocument {
  const base = recordOf('r1');
  const record: Credential = {
    ...base,
    title: `${marker('titles')}-title`,
    tags: [`${marker('tag or folder names')}-tagname`],
    fields: {
      username: `${marker('usernames')}-username`,
      email: `${marker('emails')}-email`,
      password: `${marker('passwords')}-password`,
      urls: [`https://${marker('web addresses')}.example.com`],
      securityQuestions: [
        {
          id: 'q1',
          question: `${marker('security questions or answers')}-question`,
          answer: `${marker('security questions or answers')}-answer`,
        },
        {
          id: 'q1',
          question: `${marker('security questions or answers')}-question2`,
          answer: `${marker('security questions or answers')}-answer2`,
        },
      ],
      notes: `${marker('notes')}-notes`,
      custom: [
        {
          id: 'c1',
          label: `${marker('field labels')}-label`,
          type: 'otp-secret',
          value: `${marker('passwords')}-seed`,
          hidden: true,
          order: 0,
        },
        {
          id: 'c1',
          label: `${marker('field labels')}-label2`,
          type: 'password',
          value: `${marker('passwords')}-value`,
          hidden: true,
          order: 1,
        },
      ],
    },
    attachments: [
      {
        id: chunkId('a'),
        name: `${marker('attachment names')}-payslip.pdf`,
        mime: 'application/pdf',
        size: 999,
        sha256: 'f'.repeat(64),
        addedAt: FIXTURE_NOW,
      },
    ],
    meta: { ...base.meta, updatedAt: FIXTURE_NOW + 5 * DAY },
    /**
     * Ordering-valid on purpose, so the check *below* it is the one that fires.
     *
     * `assertValidHistory` stops at the first broken invariant. The fixture used to open
     * with version 2 followed by version 1, which meant this sweep never reached the
     * snapshot-key branch — the single reason the redaction existed. The guard reported
     * success for a path it had never executed. Each poisoned record below therefore breaks
     * exactly one invariant, and `reaches every history branch` asserts all three ran.
     */
    history: {
      enabled: true,
      maxVersions: null,
      versions: [
        {
          versionNumber: 1,
          savedAt: FIXTURE_NOW,
          changedFields: ['title'],
          snapshot: { title: `${marker('titles')}-older` },
          origin: { action: 'update' },
        },
        {
          versionNumber: 2,
          savedAt: FIXTURE_NOW,
          changedFields: ['title'],
          // The branch that matters: a key that came out of the document, shaped to walk
          // past a quoted-run scrubber — its own quotes, and long enough to lose the
          // closing one to the length cap.
          snapshot: {
            title: `${marker('titles')}-old`,
            [`x" ${CORRUPT_KEY_MARKER}-snapshot-key ${'y'.repeat(200)}`]: 'x',
          },
          origin: { action: 'update' },
        },
      ],
    },
    folderId: 'ghost-folder',
  };

  /** Same id as `record` — the duplicate-record-id case — but broken a different way. */
  const duplicate: Credential = {
    ...record,
    id: 'r1',
    history: {
      enabled: true,
      maxVersions: null,
      versions: [
        {
          versionNumber: 2,
          savedAt: FIXTURE_NOW,
          changedFields: ['title'],
          snapshot: { title: `${marker('titles')}-old` },
          origin: { action: 'update' },
        },
        {
          versionNumber: 1,
          savedAt: FIXTURE_NOW,
          changedFields: ['title'],
          snapshot: { title: `${marker('titles')}-older` },
          origin: { action: 'update' },
        },
      ],
    },
  };

  /** The third history branch: a changed-field name the build does not recognise. */
  const unknownField: Credential = {
    ...record,
    id: 'r2',
    history: {
      enabled: true,
      maxVersions: null,
      versions: [
        {
          versionNumber: 1,
          savedAt: FIXTURE_NOW,
          changedFields: [
            `q" ${CORRUPT_KEY_MARKER}-changed-field`,
          ] as unknown as Credential['history']['versions'][number]['changedFields'],
          snapshot: {},
          origin: { action: 'update' },
        },
      ],
    },
  };

  return {
    ...emptyVaultDocument(),
    records: [record, duplicate, unknownField],
    folders: [
      { id: 'f1', name: `${marker('tag or folder names')}-Work`, parentId: 'f2', order: 0 },
      { id: 'f2', name: `${marker('tag or folder names')}-Personal`, parentId: 'f1', order: 0 },
    ],
    tags: [
      { id: 't1', name: `${marker('tag or folder names')}-Employer`, colour: 'tag-slate' },
      { id: 't2', name: `${marker('tag or folder names')}-employer`, colour: 'tag-slate' },
    ],
  };
}

/**
 * A separate marker for the directory.
 *
 * The basename is *deliberately* kept — `RecoveryReport.vaultName` is documented as
 * "basename only", and the survey's whole product is a ranked list of filenames the user is
 * meant to go and open. The directory is the part that must never survive, because a home
 * directory is a person's real name often enough to matter. Two markers, so the test can
 * hold the real boundary instead of a stricter one the design does not claim.
 */
const DIRECTORY_MARKER = marker('directory paths');

/**
 * Forward slashes, and a POSIX-shaped path, deliberately.
 *
 * `basename` follows the platform it runs on. A Windows-shaped fixture parses only on
 * Windows, so on a macOS runner `basename` returned the *whole path* — and the assertion
 * below, which is that no directory ever reaches the report, failed on code that is correct
 * on every platform it actually runs on. Windows' own `basename` accepts `/` as a separator
 * too, so this shape works on both and the guard stops being Windows-only.
 *
 * Found the first time this suite ran on a macOS runner, which had never happened before.
 */
const VAULT_DIRECTORY = `/home/${DIRECTORY_MARKER}-person/${DIRECTORY_MARKER}-Documents`;
const VAULT_PATH = `${VAULT_DIRECTORY}\\vault.keep`;

/** Every analysis run over a thoroughly broken vault, so the report has plenty to leak. */
function poisonedReport(): ReturnType<typeof buildRecoveryReport> {
  const whole = buildContainer();
  return buildRecoveryReport({
    vaultPath: VAULT_PATH,
    generatedAt: FIXTURE_NOW,
    file: inspectVaultFile(truncatedTo(whole, bodyOffsetOf(whole) + 8)),
    survey: surveyVaultFiles({
      vaultPath: VAULT_PATH,
      entries: [
        { path: VAULT_PATH, sizeBytes: 10, modifiedAt: FIXTURE_NOW },
        {
          path: `${VAULT_PATH}.bak.1`,
          sizeBytes: 20,
          modifiedAt: FIXTURE_NOW,
          bytes: buildContainer(),
        },
        { path: `${VAULT_PATH}.tmp`, sizeBytes: 5, modifiedAt: FIXTURE_NOW },
      ],
    }),
    diagnosis: diagnoseDocument(poisonedDocument(), { now: FIXTURE_NOW, chunks: [] }),
  });
}

/** Every token the fixture plants — the disclosure categories plus the corrupt-key bytes. */
const ALL_MARKERS: Readonly<Record<string, string>> = {
  ...WITHHELD_MARKERS,
  'a corrupt document’s own bytes': CORRUPT_KEY_MARKER,
};

describe('the property that matters: no user content, anywhere', () => {
  it('plants every category it later sweeps for, so no sweep can pass vacuously', () => {
    // Without this, deleting a poisoned field would turn its sweep green rather than red —
    // the same shape of hollow guard that let the redaction bypass live: a test that reports
    // success for a case it never actually presented.
    const planted = `${JSON.stringify(poisonedDocument())} ${VAULT_PATH}`;
    for (const [category, token] of Object.entries(ALL_MARKERS)) {
      expect(`${category}:${planted.includes(token)}`).toBe(`${category}:true`);
    }
  });

  it('names every withheld category in the sentence it prints', () => {
    // The promise and the checked list must be the same list. A category quietly dropped from
    // the prose while the sweep still covers it understates; one added to the prose without a
    // sweep behind it is an unbacked claim.
    const claim = DISCLOSURE_STATEMENT.join(' ');
    for (const category of DISCLOSURE_WITHHELD) {
      expect(claim).toContain(category);
      expect(Object.keys(WITHHELD_MARKERS)).toContain(category);
    }
    expect(Object.keys(WITHHELD_MARKERS).sort()).toEqual([...DISCLOSURE_WITHHELD].sort());
  });

  it('leaks no category of user content into the serialised report', () => {
    const serialised = JSON.stringify(poisonedReport());
    for (const [category, token] of Object.entries(ALL_MARKERS)) {
      expect(`${category}:${serialised.includes(token)}`).toBe(`${category}:false`);
    }
  });

  it('leaks no category into the rendered text either', () => {
    // Rendering is a second surface: a field that is safe in the object could still be
    // interpolated into a sentence.
    const text = renderRecoveryReport(poisonedReport());
    for (const [category, token] of Object.entries(ALL_MARKERS)) {
      expect(`${category}:${text.includes(token)}`).toBe(`${category}:false`);
    }
  });

  it('found plenty to report, so the sweep above is not passing on an empty report', () => {
    const report = poisonedReport();

    // Without this the no-leak test would pass trivially on a report with no findings.
    expect(report.findings.length).toBeGreaterThan(5);
    expect(report.plan.actions.length).toBeGreaterThan(3);
    const sources = new Set(report.findings.map((finding) => finding.source));
    expect(sources).toContain('file');
    expect(sources).toContain('document');
    expect(sources).toContain('organisation');
    expect(sources).toContain('attachments');
  });

  it('reaches every history branch, so the sweep is guarding code that ran', () => {
    // The guard for the guard. A sweep that never executes the branch it exists to police
    // reports success forever — which is exactly what this fixture did before: it broke the
    // ascending-order invariant first, and `assertValidHistory` never got as far as the
    // snapshot key. If this assertion fails, the two sweeps above have stopped meaning
    // anything, whatever colour they are.
    const details = poisonedReport()
      .findings.filter((finding) => finding.code === 'invalid-history')
      .map((finding) => finding.detail ?? '');

    expect(details.some((detail) => detail.includes('snapshot'))).toBe(true);
    expect(details.some((detail) => detail.includes('ascend'))).toBe(true);
    expect(details.some((detail) => detail.includes('changed field'))).toBe(true);
  });

  it('never lets a directory reach the report, in the object or the text', () => {
    const report = poisonedReport();
    expect(JSON.stringify(report)).not.toContain(DIRECTORY_MARKER);
    expect(renderRecoveryReport(report)).not.toContain(DIRECTORY_MARKER);
  });

  it('keeps a basename and drops the directory', () => {
    const report = buildRecoveryReport({
      vaultPath: `/home/${DIRECTORY_MARKER}-person/vault.keep`,
      generatedAt: FIXTURE_NOW,
    });
    // A home directory is a person's real name often enough to matter. The basename is the
    // deliberate exception — the user has to be told which file the report is about, and
    // the survey exists to name the copy worth opening next.
    expect(report.vaultName).toBe('vault.keep');
    expect(JSON.stringify(report)).not.toContain(DIRECTORY_MARKER);
  });

  it('structurally has no path field to leak one through', () => {
    for (const file of poisonedReport().survey?.files ?? []) {
      expect(Object.keys(file)).not.toContain('path');
    }
  });

  it('says in the report itself what it does not contain', () => {
    const text = renderRecoveryReport(poisonedReport());
    for (const line of DISCLOSURE_STATEMENT) expect(text).toContain(line);
  });

  it('is honest in the other direction too: it does carry what it says it carries', () => {
    // A promise that understates is still a promise the code does not keep. A user who strips
    // nothing because the report said "no names" has been misled just as surely as one whose
    // note leaked. The basename and the two ids are deliberate — so the sentence names them,
    // and this asserts they really are there and must therefore stay named.
    const report = poisonedReport();
    const serialised = JSON.stringify(report);
    const claim = DISCLOSURE_STATEMENT.join(' ');

    for (const category of DISCLOSURE_CARRIED) expect(claim).toContain(category);

    expect(report.vaultName).toBe('vault.keep');
    expect(report.survey?.files.map((file) => file.name)).toContain('vault.keep.bak.1');
    expect(serialised).toContain(FIXTURE_VAULT_ID);
    expect(serialised).toContain(FIXTURE_DEVICE_ID);
    expect(renderRecoveryReport(report)).toContain(FIXTURE_VAULT_ID);
  });

  it('leaks nothing when handed only a document diagnosis', () => {
    const report = buildRecoveryReport({
      generatedAt: FIXTURE_NOW,
      diagnosis: diagnoseDocument(poisonedDocument(), { now: FIXTURE_NOW }),
    });
    for (const token of Object.values(ALL_MARKERS)) {
      expect(JSON.stringify(report)).not.toContain(token);
      expect(renderRecoveryReport(report)).not.toContain(token);
    }
  });
});

describe('what was checked, not only what failed', () => {
  it('lists every file check by name when the bytes were inspected', () => {
    const report = buildRecoveryReport({
      generatedAt: FIXTURE_NOW,
      file: inspectVaultFile(buildContainer()),
    });

    // Derived from the code table rather than written out again, so a check added without
    // appearing here is not possible.
    for (const code of FILE_DIAGNOSTIC_CODES) {
      expect(report.checked.join('\n')).toContain(DIAGNOSTICS[code].title);
    }
  });

  it('lists every document check by name when the vault was unlocked', () => {
    const report = buildRecoveryReport({
      generatedAt: FIXTURE_NOW,
      diagnosis: diagnoseDocument(emptyVaultDocument(), { now: FIXTURE_NOW }),
    });

    for (const code of DOCUMENT_DIAGNOSTIC_CODES) {
      expect(report.checked.join('\n')).toContain(DIAGNOSTICS[code].title);
    }
  });

  it('says plainly which analyses did not run', () => {
    const report = buildRecoveryReport({ generatedAt: FIXTURE_NOW });
    const checked = report.checked.join('\n');

    // "Nothing found" and "never looked" must never read the same.
    expect(checked).toContain('was not inspected');
    expect(checked).toContain('was not surveyed');
    expect(checked).toContain('were not diagnosed');
  });

  it('warns loudly when the attachment reconciliation was skipped', () => {
    const report = buildRecoveryReport({
      generatedAt: FIXTURE_NOW,
      diagnosis: diagnoseDocument(emptyVaultDocument(), { now: FIXTURE_NOW }),
    });

    // This is the check most easily skipped and the one whose absence is least visible.
    expect(report.checked.join('\n')).toContain('NOT reconciled');
  });

  it('distinguishes a reconciled run from a skipped one', () => {
    const report = buildRecoveryReport({
      generatedAt: FIXTURE_NOW,
      diagnosis: diagnoseDocument(emptyVaultDocument(), { now: FIXTURE_NOW, chunks: [] }),
    });
    expect(report.checked.join('\n')).not.toContain('NOT reconciled');
  });
});

describe('the findings list', () => {
  it('sorts critical before warning before info', () => {
    const report = poisonedReport();
    const rank = { critical: 0, warning: 1, info: 2 } as const;

    const ranks = report.findings.map((finding) => rank[finding.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('gives every finding a title and a meaning, never an empty label', () => {
    for (const finding of poisonedReport().findings) {
      expect(finding.title.length).toBeGreaterThan(0);
      expect(finding.meaning.length).toBeGreaterThan(0);
    }
  });

  it('titles an organisation finding from its kind rather than a second list', () => {
    const finding = poisonedReport().findings.find((entry) => entry.source === 'organisation');
    expect(finding?.title[0]).toBe(finding?.title[0]?.toUpperCase());
    expect(finding?.title).not.toContain('-');
  });

  it('reports nothing found on a clean vault, and says so in words', () => {
    const report = buildRecoveryReport({
      generatedAt: FIXTURE_NOW,
      file: inspectVaultFile(buildContainer()),
      diagnosis: diagnoseDocument(emptyVaultDocument(), { now: FIXTURE_NOW, chunks: [] }),
    });

    expect(report.findings).toEqual([]);
    const text = renderRecoveryReport(report);
    expect(text).toContain('Nothing. Every check above passed.');
    expect(text).toContain('No action is proposed');
  });
});

describe('rendering', () => {
  it('is plain text, not Markdown', () => {
    const text = renderRecoveryReport(poisonedReport());
    // Pasted into terminals, mail and issue trackers that treat backticks and asterisks
    // differently; a report that renders wrongly in half of them is worse than plain.
    expect(text).not.toContain('```');
    expect(text).not.toMatch(/\*\*/);
    expect(text).not.toMatch(/^#{1,6} /m);
  });

  it('says what cannot be recovered before it says what to do', () => {
    const text = renderRecoveryReport(poisonedReport());
    expect(text.indexOf('WHAT CANNOT BE RECOVERED')).toBeLessThan(text.indexOf('WHAT TO DO'));
  });

  it('labels the plan as proposals that have not been carried out', () => {
    const text = renderRecoveryReport(poisonedReport());
    expect(text).toContain('Proposals only. Nothing below has been done');
  });

  it('wraps to a readable width and ends with exactly one newline', () => {
    const text = renderRecoveryReport(poisonedReport());
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(120);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('renders identically twice, because nothing in it reads a clock', () => {
    const report = poisonedReport();
    expect(renderRecoveryReport(report)).toBe(renderRecoveryReport(report));
  });

  it('renders a report with every analysis missing rather than throwing', () => {
    const text = renderRecoveryReport(buildRecoveryReport({ generatedAt: FIXTURE_NOW }));
    expect(text).toContain('KEYHOLD VAULT DIAGNOSTICS');
    expect(text).toContain('not named');
  });

  it('names the stop offset in bytes, which is the whole point of the exercise', () => {
    const whole = buildContainer();
    const text = renderRecoveryReport(
      buildRecoveryReport({
        generatedAt: FIXTURE_NOW,
        file: inspectVaultFile(truncatedTo(whole, bodyOffsetOf(whole) + 8)),
      })
    );

    expect(text).toMatch(/Stopped at: byte [\d,]+, during "body-bytes"/);
    expect(text).toContain('Read as far as: body-length');
  });
});
