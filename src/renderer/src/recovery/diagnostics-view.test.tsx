// SPDX-License-Identifier: GPL-3.0-or-later
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecoveryReport } from '@shared/model/recovery.js';
import { mountReact, type MountedTree } from '../chrome/test-dom.js';
import { DiagnosticsView } from './DiagnosticsView.js';

/**
 * "Diagnose a vault", and the one case the ledger singled out.
 *
 * **A dismissed file dialog must not clear a report already on screen.** The channel answers
 * `null` when the user closed the picker without choosing, and `null` is not a result — it is
 * the absence of one. Treating it as a result wipes a report somebody may have been reading
 * for a minute, at the exact moment they were trying to compare it with another file, and it
 * does so silently: no error, no explanation, just an empty screen where their answer was.
 *
 * It is a one-character mistake — `setReport(result.value)` instead of
 * `if (result.value !== null) setReport(result.value)` — and nothing else in the suite would
 * notice it.
 *
 * The rest of the cases here are the states this screen has to have because every view does:
 * nothing yet, a report, an error, and a save confirmation. `EmptyState` exists so the first
 * of those is not a blank rectangle.
 *
 * ## Fault injection performed, two defects
 *
 *  1. The `!== null` guard removed, so a dismissed dialog clears the report — failed
 *     `a dismissed dialog leaves the report alone`.
 *  2. `setError` dropped from the failure branch — failed `says what went wrong`.
 */

let mounted: MountedTree | null = null;

/**
 * A clean report, built from the real shape rather than guessed at.
 *
 * The first draft invented `plan: { steps, unrecoverable }`. `RepairPlan` has `actions`,
 * `unrecoverable` and `clean`, so the component threw on `plan.actions.length` and four cases
 * failed for a reason that had nothing to do with what they assert. A fixture that guesses at
 * a type is testing the guess.
 */
function report(overrides: Partial<RecoveryReport> = {}): RecoveryReport {
  const built: RecoveryReport = {
    generatedAt: 1_800_000_000_000,
    vaultName: 'personal.keep',
    checked: ['The container'],
    file: null,
    survey: null,
    diagnosis: null,
    findings: [],
    plan: { actions: [], unrecoverable: [], clean: true },
    ...overrides,
  };
  return built;
}

const ok = <T,>(value: T): { ok: true; value: T } => ({ ok: true, value });

function mount(options: {
  // Non-nullable, matching the prop: `diagnose` acts on the **open** vault, so there is no
  // dialog to dismiss and no `null` to answer with. Only `diagnoseFile` has that case, which
  // is the whole point of the test below.
  readonly diagnose?: () => Promise<{ ok: true; value: RecoveryReport }>;
  readonly diagnoseFile?: () => Promise<
    { ok: true; value: RecoveryReport | null } | { ok: false; message: string }
  >;
  readonly saveReport?: () => Promise<
    { ok: true; value: string | null } | { ok: false; message: string }
  >;
}): MountedTree {
  const tree = mountReact(
    <DiagnosticsView
      diagnose={options.diagnose ?? (() => Promise.resolve(ok(report())))}
      diagnoseFile={options.diagnoseFile ?? (() => Promise.resolve(ok(null)))}
      saveReport={options.saveReport ?? (() => Promise.resolve(ok(null)))}
    />
  );
  mounted = tree;
  return tree;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function press(tree: MountedTree, label: string): void {
  const button = [...tree.container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent.includes(label)
  );
  expect(button, `no "${label}" control on the diagnostics view`).toBeDefined();
  act(() => {
    button?.click();
  });
}

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
});

describe('the diagnostics view', () => {
  it('starts with something to do rather than a blank rectangle', () => {
    const tree = mount({});
    expect(tree.container.textContent).toContain('Diagnose this vault');
  });

  it('renders a report once one has been produced', async () => {
    const tree = mount({ diagnose: () => Promise.resolve(ok(report())) });
    press(tree, 'Diagnose this vault');
    await settle();

    expect(tree.container.textContent).toContain('personal.keep');
  });

  it('a dismissed dialog leaves the report alone', async () => {
    // The case the ledger named. A report is on screen; the user opens the file picker to
    // compare against another vault, changes their mind, and closes it. `null` comes back —
    // and it is the absence of a result, not a result.
    const tree = mount({
      diagnose: () => Promise.resolve(ok(report())),
      diagnoseFile: () => Promise.resolve(ok(null)),
    });
    press(tree, 'Diagnose this vault');
    await settle();
    expect(tree.container.textContent).toContain('personal.keep');

    press(tree, 'Diagnose a file');
    await settle();

    expect(tree.container.textContent).toContain('personal.keep');
  });

  it('replaces the report when a file really was chosen', async () => {
    // The other half: a dismissal must not clear it, and a real choice must.
    const tree = mount({
      diagnose: () => Promise.resolve(ok(report())),
      diagnoseFile: () => Promise.resolve(ok(report({ vaultName: 'other.keep' }))),
    });
    press(tree, 'Diagnose this vault');
    await settle();

    press(tree, 'Diagnose a file');
    await settle();

    expect(tree.container.textContent).toContain('other.keep');
    expect(tree.container.textContent).not.toContain('personal.keep');
  });

  it('says what went wrong instead of failing silently', async () => {
    const tree = mount({
      diagnoseFile: () =>
        Promise.resolve({ ok: false as const, message: 'That file is a folder.' }),
    });
    press(tree, 'Diagnose a file');
    await settle();

    expect(tree.container.textContent).toContain('That file is a folder.');
  });

  it('confirms a save by name, and says nothing when the save dialog is dismissed', async () => {
    const saveReport = vi
      .fn<() => Promise<{ ok: true; value: string | null }>>()
      .mockResolvedValueOnce(ok('report.txt'))
      .mockResolvedValueOnce(ok(null));

    const tree = mount({ diagnose: () => Promise.resolve(ok(report())), saveReport });
    press(tree, 'Diagnose this vault');
    await settle();

    press(tree, 'Save report');
    await settle();
    expect(tree.container.textContent).toContain('report.txt');

    // Dismissed. No confirmation, because nothing was written — a "saved" line over a save
    // that did not happen is the same class of lie as a clean breach report over a failed run.
    press(tree, 'Save report');
    await settle();
    expect(tree.container.textContent).not.toContain('report.txt');
  });
});
