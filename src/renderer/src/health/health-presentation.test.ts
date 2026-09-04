// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  CLUSTER_RULE_IDS,
  HEALTH_RULE_IDS,
  HEALTH_RULE_SEVERITY,
  HEALTH_RULE_WEIGHTS,
} from '@shared/model/health.js';
import { buildReport } from './health-fixture.js';
import {
  RULES_BY_IMPACT,
  RULE_ADVICE,
  RULE_DESCRIPTIONS,
  RULE_LABELS,
  SEVERITY_LABELS,
  SEVERITY_ICONS,
  SEVERITY_TONES,
  clusterCaption,
  clusterHeading,
  countLabel,
  formatEntropyBits,
  groupIssuesByRule,
  isClusterRule,
  recordLabel,
  recordSubtitle,
} from './health-presentation.js';

/**
 * The dashboard's ordering, grouping and wording.
 *
 * `@testing-library/react` is not a dependency of this project, so the components are only
 * exercised through the render guard in `health-no-secrets.test.tsx`. Everything that can be
 * a pure function is one, and this is where it is tested — which is most of what the screen
 * actually decides.
 *
 * **Not covered here:** the interaction behaviour of the components themselves — that a
 * click on a row calls `onSelectCredential`, that a checkbox change reaches the hook, that
 * the effect in `use-health-report.ts` re-runs when a toggle flips, or that the `aria-live`
 * region announces. Those need a DOM testing library or a driver this project has decided
 * not to take on. `HealthReportView` is a pure function of props specifically so that the
 * untested surface is as thin as it is.
 *
 * Fault injections performed, all caught and all reverted. Counts are the failures in this
 * file; the same injections also broke assertions elsewhere:
 *
 *   | Injection                                             | Result                        |
 *   |-------------------------------------------------------|-------------------------------|
 *   | `RULES_BY_IMPACT` sorted alphabetically                | 3 failed — the descending-weights assertion (`expected [ 6, 3, 15, … ] to deeply equal [ 30, 25, 15, … ]`), the tiebreak, and the grouping order |
 *   | `clusterHeading` returns `cluster.id`                  | 2 failed — the synthetic-id test and the two-groups test |
 *   | `formatEntropyBits` drops the rounding                 | 1 failed — `expected '≈28.3172 bits' to be '≈28 bits'` |
 */

describe('rule ordering', () => {
  it('is the weights, descending — not alphabetical and not the declaration order', () => {
    // The weights encode the argument: reuse spreads across accounts, age does not. An
    // ordering invented here would be a second list, and the wrong one.
    const weights = RULES_BY_IMPACT.map((rule) => HEALTH_RULE_WEIGHTS[rule]);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
    expect(RULES_BY_IMPACT[0]).toBe('reused');
    expect(RULES_BY_IMPACT[1]).toBe('weak');
    expect(RULES_BY_IMPACT.at(-1)).toBe('emptyTitle');
  });

  it('breaks ties with the declaration order, so it is deterministic', () => {
    // `old` and `insecureUrl` both cost 10; `expiring` and `emptyTitle` both cost 3.
    expect(HEALTH_RULE_WEIGHTS.old).toBe(HEALTH_RULE_WEIGHTS.insecureUrl);
    expect(RULES_BY_IMPACT.indexOf('old')).toBeLessThan(RULES_BY_IMPACT.indexOf('insecureUrl'));
    expect(HEALTH_RULE_WEIGHTS.expiring).toBe(HEALTH_RULE_WEIGHTS.emptyTitle);
    expect(RULES_BY_IMPACT.indexOf('expiring')).toBeLessThan(RULES_BY_IMPACT.indexOf('emptyTitle'));
  });

  it('covers every rule exactly once', () => {
    expect([...RULES_BY_IMPACT].sort()).toEqual([...HEALTH_RULE_IDS].sort());
  });
});

describe('rule vocabulary', () => {
  it('has a label, a description and a piece of advice for every rule', () => {
    // A `Record` makes a missing entry a compile error, but not an empty string.
    for (const rule of HEALTH_RULE_IDS) {
      expect(RULE_LABELS[rule].length, rule).toBeGreaterThan(0);
      expect(RULE_DESCRIPTIONS[rule].length, rule).toBeGreaterThan(0);
      expect(RULE_ADVICE[rule].length, rule).toBeGreaterThan(0);
    }
  });

  it('never shows a rule identifier to a user', () => {
    // "insecureUrl" on screen is a database dump, not a finding. Tested as "no camelCase
    // token anywhere in a label" rather than "the label does not contain the id", because
    // several ids — `duplicate`, `reused`, `weak` — are ordinary English words that a good
    // label is entitled to use.
    for (const rule of HEALTH_RULE_IDS) {
      expect(RULE_LABELS[rule], rule).not.toBe(rule);
      expect(RULE_LABELS[rule], rule).not.toMatch(/[a-z][A-Z]/);
      expect(RULE_DESCRIPTIONS[rule], rule).not.toMatch(/[a-z][A-Z]/);
    }
  });

  it('agrees with the model about which rules report clusters', () => {
    for (const rule of HEALTH_RULE_IDS) {
      expect(isClusterRule(rule), rule).toBe(
        (CLUSTER_RULE_IDS as readonly string[]).includes(rule)
      );
    }
  });
});

describe('severity', () => {
  it('always carries a word and a symbol, not only a tone', () => {
    // WCAG 1.4.1. This is the screen where a colour-only signal would matter most.
    for (const severity of ['critical', 'warning', 'info'] as const) {
      expect(SEVERITY_LABELS[severity].length).toBeGreaterThan(0);
      expect(SEVERITY_ICONS[severity].length).toBeGreaterThan(0);
      expect(SEVERITY_TONES[severity].length).toBeGreaterThan(0);
    }
  });

  it('gives the three severities three distinguishable symbols', () => {
    const symbols = new Set(Object.values(SEVERITY_ICONS));
    expect(symbols.size).toBe(3);
  });

  it('maps severity to a tone without inventing one', () => {
    expect(SEVERITY_TONES[HEALTH_RULE_SEVERITY.reused]).toBe('danger');
    expect(SEVERITY_TONES[HEALTH_RULE_SEVERITY.old]).toBe('warning');
    expect(SEVERITY_TONES[HEALTH_RULE_SEVERITY.emptyTitle]).toBe('info');
  });
});

describe('grouping', () => {
  const report = buildReport(
    [
      { id: 'a', rules: ['emptyTitle'] },
      { id: 'b', rules: ['reused'], clusterId: 'reused-1' },
      { id: 'c', rules: ['reused'], clusterId: 'reused-1' },
      { id: 'd', rules: ['old', 'insecureUrl'], detail: 'example.com' },
      { id: 'e' },
    ],
    { clusterLabels: {} }
  );

  it('orders the groups by impact, whatever order the issues arrived in', () => {
    expect(groupIssuesByRule(report).map((group) => group.rule)).toEqual([
      'reused',
      'old',
      'insecureUrl',
      'emptyTitle',
    ]);
  });

  it('omits rules that flagged nothing', () => {
    // A section reading "0 records" on every clean vault trains people to skim.
    const rules = groupIssuesByRule(report).map((group) => group.rule);
    expect(rules).not.toContain('weak');
    expect(rules).not.toContain('duplicate');
  });

  it('carries the weight and the count, so a finding can be priced', () => {
    const reused = groupIssuesByRule(report).find((group) => group.rule === 'reused');
    expect(reused?.weight).toBe(HEALTH_RULE_WEIGHTS.reused);
    expect(reused?.flaggedCount).toBe(2);
    expect(reused?.points).toBe(HEALTH_RULE_WEIGHTS.reused * 2);
  });

  it('renders cluster rules as clusters and record rules as records', () => {
    const groups = groupIssuesByRule(report);
    const reused = groups.find((group) => group.rule === 'reused');
    const old = groups.find((group) => group.rule === 'old');

    expect(reused?.presentation).toBe('clusters');
    expect(reused?.clusters).toHaveLength(1);
    // Empty, so a component cannot accidentally render both a cluster list and a flat list
    // of the same records.
    expect(reused?.issues).toHaveLength(0);

    expect(old?.presentation).toBe('records');
    expect(old?.issues.map((issue) => issue.credentialId)).toEqual(['d']);
    expect(old?.clusters).toHaveLength(0);
  });

  it('produces nothing at all for a clean vault', () => {
    expect(groupIssuesByRule(buildReport([{ id: 'a' }, { id: 'b' }]))).toEqual([]);
  });
});

describe('clusters', () => {
  it('never presents the synthetic cluster id as if it meant something', () => {
    // The id is a sequential counter, deliberately not derived from the shared password —
    // a hash of one would be an offline-attackable handle on it. Showing `reused-1` would
    // invite a user to read meaning into a number that has none.
    const report = buildReport([
      { id: 'a', rules: ['reused'], clusterId: 'reused-1' },
      { id: 'b', rules: ['reused'], clusterId: 'reused-1' },
    ]);
    const cluster = report.clusters[0];
    expect(cluster).toBeDefined();
    if (cluster === undefined) return;

    expect(clusterHeading(cluster, 1)).toBe('Group 1');
    expect(clusterHeading(cluster, 1)).not.toContain(cluster.id);
  });

  it('uses the position in the list, so two groups are told apart', () => {
    const report = buildReport([
      { id: 'a', rules: ['reused'], clusterId: 'reused-1' },
      { id: 'b', rules: ['reused'], clusterId: 'reused-1' },
      { id: 'c', rules: ['reused'], clusterId: 'reused-2' },
      { id: 'd', rules: ['reused'], clusterId: 'reused-2' },
    ]);
    const headings = report.clusters.map((cluster, index) => clusterHeading(cluster, index + 1));
    expect(headings).toEqual(['Group 1', 'Group 2']);
  });

  it('prefers the engine-supplied label when there is one', () => {
    // `duplicate` clusters carry a host and an identity, both already in the safe projection.
    const report = buildReport(
      [
        { id: 'a', rules: ['duplicate'], clusterId: 'duplicate-1' },
        { id: 'b', rules: ['duplicate'], clusterId: 'duplicate-1' },
      ],
      { clusterLabels: { 'duplicate-1': 'github.com · bob' } }
    );
    const cluster = report.clusters[0];
    expect(cluster).toBeDefined();
    if (cluster === undefined) return;
    expect(clusterHeading(cluster, 1)).toBe('github.com · bob');
  });

  it('says what the members share, in the terms of the rule', () => {
    const reuse = buildReport([
      { id: 'a', rules: ['reused'], clusterId: 'reused-1' },
      { id: 'b', rules: ['reused'], clusterId: 'reused-1' },
      { id: 'c', rules: ['reused'], clusterId: 'reused-1' },
    ]).clusters[0];
    const duplicate = buildReport([
      { id: 'a', rules: ['duplicate'], clusterId: 'duplicate-1' },
      { id: 'b', rules: ['duplicate'], clusterId: 'duplicate-1' },
    ]).clusters[0];

    expect(reuse).toBeDefined();
    expect(duplicate).toBeDefined();
    if (reuse === undefined || duplicate === undefined) return;

    expect(clusterCaption(reuse)).toBe('3 records share one password');
    expect(clusterCaption(duplicate)).toBe('2 records look like the same account');
  });
});

describe('naming a record', () => {
  it('falls back through title, username and email', () => {
    // The `emptyTitle` rule guarantees some of these rows have no title, and "" is not a
    // link anyone can click.
    expect(recordLabel({ id: 'a', title: 'Netflix', username: 'bob', email: '' })).toBe('Netflix');
    expect(recordLabel({ id: 'a', title: '  ', username: 'bob', email: 'b@x.io' })).toBe('bob');
    expect(recordLabel({ id: 'a', title: '', username: '', email: 'b@x.io' })).toBe('b@x.io');
    expect(recordLabel({ id: 'a', title: '', username: '', email: '' })).toBe('Untitled record');
  });

  it('says so when a flagged record is no longer in the list', () => {
    // A report can outlive a deletion by the width of one re-render. A blank row would look
    // like a bug; this says what happened.
    expect(recordLabel(undefined)).toBe('Record no longer in this vault');
    expect(recordSubtitle(undefined)).toBe('');
  });

  it('does not repeat the label as the subtitle', () => {
    expect(recordSubtitle({ id: 'a', title: 'Netflix', username: 'bob', email: '' })).toBe('bob');
    expect(recordSubtitle({ id: 'a', title: '', username: 'bob', email: '' })).toBe('');
  });
});

describe('entropy', () => {
  it('rounds, and marks the estimate as approximate', () => {
    // `length × log2(pool)` over-estimates human-chosen passwords. Printing "28.3172 bits"
    // would claim a precision the method does not have.
    expect(formatEntropyBits(28.3172)).toBe('≈28 bits');
    expect(formatEntropyBits(28.3172)).not.toContain('28.3');
    expect(formatEntropyBits(103.9)).toBe('≈104 bits');
  });

  it('shows an em dash rather than "0 bits" when there is no password', () => {
    // Zero means "no password", which `incomplete` reports — not "a password worth nothing".
    expect(formatEntropyBits(0)).toBe('—');
  });
});

describe('countLabel', () => {
  it('pluralises', () => {
    expect(countLabel(1)).toBe('1 record');
    expect(countLabel(0)).toBe('0 records');
    expect(countLabel(2, 'check')).toBe('2 checks');
  });
});
