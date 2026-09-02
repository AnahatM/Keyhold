// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_HEALTH_RULE_TOGGLES } from '@shared/model/health.js';
import { mountReact } from '../chrome/test-dom.js';
import { HealthReportView } from './HealthReportView.js';
import { buildReport } from './health-fixture.js';
import type { HealthRecordRef } from './health-presentation.js';

/**
 * The boundary, asserted against what the screen actually renders.
 *
 * A health report crosses the bridge, so decision D13 binds it exactly as it binds the safe
 * projection: no secret material, and nothing derived from a secret that would narrow a
 * search for it. The main-side property test in `src/main/health/rules.test.ts` proves the
 * *report* carries none. This one proves the *dashboard* cannot invent one — by planting a
 * marker in every field a careless implementation might reach for and asserting that nothing
 * survives into the DOM.
 *
 * Written as a property over the rendered markup rather than as a list of "this component
 * does not render that field", because a per-field check cannot catch a **new** field being
 * added and forgotten, which is exactly how a boundary like this fails in practice.
 *
 * `@testing-library/react` is not a dependency of this project, so this renders through
 * `react-dom/client` via the existing `chrome/test-dom.ts` harness — the same trade the app
 * chrome made rather than taking on a testing library for one screen.
 *
 * Fault injections performed against these guards, all caught and all reverted. Counts are
 * the failures in this file:
 *
 *   | Injection                                                    | Result                |
 *   |--------------------------------------------------------------|-----------------------|
 *   | `RecordButton` gains `title={JSON.stringify(record)}`         | 1 failed — the markup sweep. The **text** sweep did not fire, which is precisely why both exist: a leak into an attribute is invisible to `textContent` |
 *   | `clusterHeading` returns `cluster.id`                         | 2 failed — the markup guard, and the reuse-groups-by-position assertion |
 *   | `formatEntropyBits` drops its `Math.round`                    | 1 failed — `expected … to contain '≈28 bits'`, the rendered value being `≈28.3172 bits` |
 */

const SECRET_MARKER = 'SECRET_MARKER_MUST_NOT_LEAK';
const marker = (where: string): string => `${SECRET_MARKER}_${where}`;

const noop = (): void => undefined;

/**
 * A record ref carrying the fields it must not have.
 *
 * `HealthRecordRef` declares four non-secret fields. If someone widens it, or a component
 * starts spreading the whole object into the DOM, these land in the markup and the sweep
 * below fails. Built through a variable rather than returned as a literal so TypeScript's
 * excess-property check does not reject the very contamination this is for.
 */
function contaminate(record: HealthRecordRef): HealthRecordRef {
  const wider = {
    ...record,
    password: marker('password'),
    notes: marker('notes'),
    totpSecret: marker('totp-seed'),
    securityAnswer: marker('answer'),
    passwordHistory: [marker('old-password')],
  };
  return wider;
}

/**
 * A vault broken in every way the eight rules can see, including both kinds of cluster.
 *
 * The reuse cluster deliberately has **no** label — the only thing those records share is the
 * password, so a label could only be derived from it. The duplicate cluster has one, because
 * a host and an identity are already in the safe projection and naming the account is the
 * whole value of the finding.
 */
function scenario(): {
  report: ReturnType<typeof buildReport>;
  records: readonly HealthRecordRef[];
} {
  const report = buildReport(
    [
      {
        id: 'a',
        rules: ['reused', 'weak', 'emptyTitle'],
        clusterId: 'reused-1',
        entropyBits: 28.3172,
      },
      { id: 'b', rules: ['reused'], clusterId: 'reused-1' },
      { id: 'c', rules: ['duplicate'], clusterId: 'duplicate-1' },
      { id: 'd', rules: ['duplicate'], clusterId: 'duplicate-1' },
      { id: 'e', rules: ['insecureUrl', 'old'], detail: 'intranet.example.com' },
      { id: 'f', rules: ['incomplete'] },
      { id: 'g', rules: ['expired'] },
      { id: 'h', rules: ['expiring'] },
      { id: 'i' },
    ],
    { trashedCount: 2, clusterLabels: { 'duplicate-1': 'github.com · bob' } }
  );

  const records: readonly HealthRecordRef[] = [
    { id: 'a', title: '', username: 'anahat', email: '' },
    { id: 'b', title: 'Streaming', username: '', email: 'me@example.com' },
    { id: 'c', title: 'GitHub', username: 'bob', email: '' },
    { id: 'd', title: 'GitHub (old)', username: 'bob', email: '' },
    { id: 'e', title: 'Intranet', username: 'staff', email: '' },
    { id: 'f', title: 'Half-filled', username: '', email: '' },
    { id: 'g', title: 'Bank', username: 'anahat', email: '' },
    { id: 'h', title: 'Router', username: 'admin', email: '' },
    { id: 'i', title: 'Fine', username: 'anahat', email: '' },
  ].map(contaminate);

  return { report, records };
}

function renderDashboard(): { markup: string; text: string; container: HTMLElement } {
  const { report, records } = scenario();
  const tree = mountReact(
    <HealthReportView
      report={report}
      records={records}
      enabledRules={{ ...DEFAULT_HEALTH_RULE_TOGGLES }}
      pending={false}
      onSelectCredential={noop}
      onRuleEnabled={noop}
      onReset={noop}
      onRefresh={noop}
    />
  );

  return {
    markup: tree.container.innerHTML,
    text: tree.container.textContent,
    container: tree.container,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the dashboard never renders secret material', () => {
  it('leaks no marker into the markup, attributes included', () => {
    // Attributes as well as text: a leak into `title=` or `aria-label=` is still a leak, and
    // is the more likely accident.
    expect(renderDashboard().markup).not.toContain(SECRET_MARKER);
  });

  it('leaks no marker into the visible text', () => {
    expect(renderDashboard().text).not.toContain(SECRET_MARKER);
  });

  it('is not passing vacuously — it does render the records it was given', () => {
    // Without this, deleting the whole component body would make every assertion above pass.
    const { text } = renderDashboard();
    expect(text).toContain('GitHub');
    expect(text).toContain('Intranet');
    expect(text).toContain('anahat');
  });

  it('has no field that could hold a value: every input is a checkbox', () => {
    const inputs = [...renderDashboard().container.querySelectorAll('input')];
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input.type).toBe('checkbox');
    }
    expect(renderDashboard().container.querySelector('input[type="password"]')).toBeNull();
    expect(renderDashboard().container.querySelector('textarea')).toBeNull();
  });
});

describe('cluster ids stay internal', () => {
  it('appears nowhere in the markup, not even as a DOM id', () => {
    // The id is a synthetic sequential counter, deliberately not derived from the shared
    // password — a hash of one would be a stable, offline-attackable handle on it. Keeping
    // it out of the DOM entirely means that if it ever stopped being synthetic, the mistake
    // would be caught here rather than shipped.
    const { report } = scenario();
    const { markup } = renderDashboard();

    expect(report.clusters.length).toBeGreaterThan(0);
    for (const cluster of report.clusters) {
      expect(markup, cluster.id).not.toContain(cluster.id);
    }
  });

  it('names reuse groups by position and duplicate groups by their engine label', () => {
    const { text } = renderDashboard();
    // Reuse: nothing can be said about what the members share except that they share it.
    expect(text).toContain('Group 1');
    expect(text).toContain('share one password');
    // Duplicates: a host and an identity, both already in the safe projection.
    expect(text).toContain('github.com · bob');
  });
});

describe('what is derived from a password stays coarse', () => {
  it('shows entropy rounded, never at the precision it was computed', () => {
    // `passwordEntropyBits` is the one fact about a password the report may carry, in the
    // same family as `passwordLength`. Rendering it unrounded would leak a little more of the
    // character-class composition than the safe projection already does, for no benefit.
    const { text } = renderDashboard();
    expect(text).toContain('≈28 bits');
    expect(text).not.toContain('28.3');
  });
});

describe('accessibility guards', () => {
  it('never carries severity by colour alone', () => {
    // Every severity badge on screen has to say a word. WCAG 1.4.1, on the one screen in the
    // app whose entire job is flagging problems.
    const { text } = renderDashboard();
    expect(text).toContain('Critical');
    expect(text).toContain('Warning');
    expect(text).toContain('Note');
  });

  it('announces the score politely when it changes', () => {
    const region = renderDashboard().container.querySelector('[aria-live]');
    expect(region).not.toBeNull();
    expect(region?.getAttribute('aria-live')).toBe('polite');
    // The live region is the headline only. Wrapping the working table in it would re-read
    // forty numbers on every toggle.
    expect(region?.textContent ?? '').not.toContain('Points charged');
  });

  it('skips no heading level', () => {
    // A screen reader's heading list is the primary way this page is navigated, and a jump
    // from h2 to h4 makes it read as though a section is missing.
    const levels = [...renderDashboard().container.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(
      (heading) => Number(heading.tagName.slice(1))
    );

    expect(levels[0]).toBe(2);
    for (let index = 1; index < levels.length; index += 1) {
      const previous = levels[index - 1] ?? 2;
      const current = levels[index] ?? 2;
      expect(
        current,
        `heading ${index} jumped from h${previous} to h${current}`
      ).toBeLessThanOrEqual(previous + 1);
    }
  });

  it('gives every finding row an accessible name with a verb in it', () => {
    // "Netflix" alone, heard button after button, does not say what activating it does.
    const buttons = [...renderDashboard().container.querySelectorAll('button.kh-health-record')];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.getAttribute('aria-label') ?? '').toMatch(/^Open /);
    }
  });
});

describe('honesty guards', () => {
  it('says the breach check does not exist, with no button pretending otherwise', () => {
    const { text, container } = renderDashboard();
    expect(text).toContain('breach');
    expect(text).toContain('no network requests');
    // No stub, no "coming soon" affordance that looks broken.
    expect(text).not.toMatch(/coming soon/i);
    for (const button of container.querySelectorAll('button')) {
      expect(button.textContent).not.toMatch(/breach|pwned|hibp/i);
    }
  });

  it('states that turning a check off cannot lower the score', () => {
    // The engine guarantees exactly this — the cap is not renormalised to the enabled rule
    // set. It is worth saying because the natural assumption is the opposite.
    expect(renderDashboard().text).toMatch(/can only raise the score or leave it/i);
  });

  it('explains the score rather than asserting it', () => {
    const { text } = renderDashboard();
    expect(text).toContain('Points charged');
    expect(text).toContain('Recalculated here from the report and it matches');
  });
});
