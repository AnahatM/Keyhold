// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  AUDIT_LEVEL_FIELDS,
  AUDIT_PRIVACY_LEVELS,
  type ChangeOrigin,
} from '@shared/model/credential.js';
import { HEALTH_RULE_IDS } from '@shared/model/health.js';
import {
  DEFAULT_CONFIGURABLE_VAULT_SETTINGS,
  DEFAULT_KDF_COST,
  DEFAULT_MACHINE_SETTINGS,
  KDF_PRESET_IDS,
  SETTING_IDS,
} from '@shared/model/settings-plan.js';
import { RULE_DESCRIPTIONS, RULE_LABELS } from '../health/health-presentation.js';
import {
  AUDIT_LEVEL_COSTS,
  AUDIT_LEVEL_TITLES,
  KDF_PRESET_COPY,
  ORIGIN_FIELD_LABELS,
  SCOPE_LABELS,
  SCOPE_NOTES,
  SETTING_COPY,
  auditLevelCapturesNetwork,
  auditLevelOmits,
  auditLevelRecords,
  formatMemory,
  machineWeakenings,
  vaultWeakenings,
} from './settings-copy.js';

/**
 * The strings this screen is judged on, and the predicates that decide when a warning is
 * shown.
 *
 * The two that genuinely matter:
 *
 * **The audit level descriptions must match `AUDIT_LEVEL_FIELDS` exactly.** They are what a
 * user reads before deciding what gets written into a file they may hand to someone. A
 * description that has drifted from the capture table is not a cosmetic bug — it is the app
 * lying about the contents of the user's own vault.
 *
 * **Every health rule must have a control and a label.** A rule that shipped without one
 * would be a check the user cannot turn off and cannot see, which is precisely the
 * "configurable by the user" promise being broken by omission rather than by decision.
 */

describe('every setting has copy', () => {
  it('has a label and help text for every id', () => {
    for (const id of SETTING_IDS) {
      const copy = SETTING_COPY[id];
      expect(copy.label, `no label for "${id}"`).not.toBe('');
      // A label that is the identifier means someone filled the Record to satisfy the
      // compiler rather than to say anything.
      expect(copy.label, `"${id}" shows its identifier to the user`).not.toBe(id);
      expect(
        copy.help.length,
        `help text for "${id}" is too short to explain anything`
      ).toBeGreaterThan(30);
    }
  });

  it('names the cost of every setting that is a security trade', () => {
    // The ones where the looser option genuinely costs something. Each must carry a
    // sentence; the rest are free to have none rather than inventing a warning.
    const mustExplain = [
      'autoLock.idleMinutes',
      'autoLock.lockOnSleep',
      'clipboardClearMs',
      'wipeAfterFailedAttempts',
      'secretReveal.maxRevealsPerWindow',
      'auditPrivacyLevel',
      'kdfCost',
    ] as const;

    for (const id of mustExplain) {
      expect(SETTING_COPY[id].tradeOff, `"${id}" is a trade with no stated cost`).not.toBeNull();
    }
  });

  it('describes both scopes without either sounding like the other', () => {
    expect(SCOPE_LABELS.machine).not.toBe(SCOPE_LABELS.vault);
    expect(SCOPE_NOTES.machine).not.toBe(SCOPE_NOTES.vault);
    // The distinction is "does it follow the file", so both halves have to say so.
    expect(SCOPE_NOTES.machine.toLowerCase()).toContain('another machine');
    expect(SCOPE_NOTES.vault.toLowerCase()).toContain('another computer');
  });
});

describe('the audit privacy levels', () => {
  it('presents every level', () => {
    for (const level of AUDIT_PRIVACY_LEVELS) {
      expect(AUDIT_LEVEL_TITLES[level], level).not.toBe('');
      expect(AUDIT_LEVEL_TITLES[level], level).not.toBe(level);
      expect(AUDIT_LEVEL_COSTS[level], level).toBeTypeOf('string');
    }
  });

  it('describes exactly the fields the level captures — no more and no fewer', () => {
    for (const level of AUDIT_PRIVACY_LEVELS) {
      const expected = AUDIT_LEVEL_FIELDS[level].map((field) => ORIGIN_FIELD_LABELS[field]);
      expect(auditLevelRecords(level), level).toEqual(expected);

      // And the complement, which is the half users actually want: what does this level
      // keep OUT of my file.
      const omitted = auditLevelOmits(level);
      expect(new Set([...expected, ...omitted]).size, level).toBe(
        Object.keys(ORIGIN_FIELD_LABELS).length
      );
      for (const phrase of omitted) {
        expect(
          expected,
          `"${phrase}" is listed as both recorded and not recorded at ${level}`
        ).not.toContain(phrase);
      }
    }
  });

  it('has a label for every provenance field, and no two that could be confused', () => {
    const fields = Object.keys(ORIGIN_FIELD_LABELS) as (keyof ChangeOrigin)[];
    const labels = fields.map((field) => ORIGIN_FIELD_LABELS[field]);

    for (const [index, label] of labels.entries()) {
      expect(label, `no label for "${fields[index]}"`).not.toBe('');
      for (const [otherIndex, other] of labels.entries()) {
        if (index === otherIndex) continue;
        // A label that contains another makes "does the description mention X" ambiguous,
        // for a reader as well as for this test.
        expect(other.includes(label), `"${other}" contains "${label}"`).toBe(false);
      }
    }
  });

  it('knows which levels actually record a network name', () => {
    // Drives whether the "what network am I on?" check says the answer would be recorded.
    expect(auditLevelCapturesNetwork('none')).toBe(false);
    expect(auditLevelCapturesNetwork('device')).toBe(false);
    expect(auditLevelCapturesNetwork('network')).toBe(true);
    expect(auditLevelCapturesNetwork('full')).toBe(true);
  });

  it('warns about the levels that write more about the user into the file', () => {
    expect(AUDIT_LEVEL_COSTS.device).toBe('');
    expect(AUDIT_LEVEL_COSTS.network).not.toBe('');
    expect(AUDIT_LEVEL_COSTS.full).not.toBe('');
  });
});

describe('the health rules', () => {
  it('has a label and a description for every rule', () => {
    // These come from `health-presentation.ts` rather than being restated here — the whole
    // point of reusing them. This asserts the reuse actually covers every rule.
    for (const rule of HEALTH_RULE_IDS) {
      expect(RULE_LABELS[rule], rule).not.toBe('');
      expect(RULE_LABELS[rule], rule).not.toBe(rule);
      expect(RULE_DESCRIPTIONS[rule], rule).not.toBe('');
    }
  });
});

describe('when a trade-off is in effect', () => {
  it('says nothing at all at the defaults', () => {
    // Every default is the safe one, so a fresh install shows no warnings anywhere. If this
    // fails, either a default stopped being safe or a predicate is inverted.
    expect([...machineWeakenings(DEFAULT_MACHINE_SETTINGS)]).toEqual([]);
    expect([...vaultWeakenings(DEFAULT_CONFIGURABLE_VAULT_SETTINGS, DEFAULT_KDF_COST)]).toEqual([]);
  });

  it('flags a longer idle timeout but not a shorter one', () => {
    const longer = machineWeakenings({
      ...DEFAULT_MACHINE_SETTINGS,
      autoLock: { ...DEFAULT_MACHINE_SETTINGS.autoLock, idleMinutes: 60 },
    });
    expect(longer.has('autoLock.idleMinutes')).toBe(true);

    const shorter = machineWeakenings({
      ...DEFAULT_MACHINE_SETTINGS,
      autoLock: { ...DEFAULT_MACHINE_SETTINGS.autoLock, idleMinutes: 1 },
    });
    expect(shorter.has('autoLock.idleMinutes')).toBe(false);
  });

  it('treats "never" as the loosest option, not as a small number', () => {
    const never = machineWeakenings({
      ...DEFAULT_MACHINE_SETTINGS,
      clipboardClearMs: null,
      autoLock: { ...DEFAULT_MACHINE_SETTINGS.autoLock, idleMinutes: null },
    });
    expect(never.has('clipboardClearMs')).toBe(true);
    expect(never.has('autoLock.idleMinutes')).toBe(true);
  });

  it('flags erase-after-failures when it is ON', () => {
    // The one setting whose dangerous direction is on rather than off: it destroys the
    // vault rather than exposing it.
    const on = machineWeakenings({ ...DEFAULT_MACHINE_SETTINGS, wipeAfterFailedAttempts: 3 });
    expect(on.has('wipeAfterFailedAttempts')).toBe(true);
  });

  it('flags the audit levels that record more, and a disabled health check', () => {
    const vault = vaultWeakenings(
      {
        ...DEFAULT_CONFIGURABLE_VAULT_SETTINGS,
        auditPrivacyLevel: 'full',
        health: {
          ...DEFAULT_CONFIGURABLE_VAULT_SETTINGS.health,
          enabledRules: {
            ...DEFAULT_CONFIGURABLE_VAULT_SETTINGS.health.enabledRules,
            reused: false,
          },
        },
      },
      DEFAULT_KDF_COST
    );
    expect(vault.has('auditPrivacyLevel')).toBe(true);
    expect(vault.has('health.rules')).toBe(true);
  });
});

describe('formatting', () => {
  it('reads memory in the unit a person uses', () => {
    expect(formatMemory(65_536)).toBe('64 MiB');
    expect(formatMemory(262_144)).toBe('256 MiB');
    expect(formatMemory(1_048_576)).toBe('1 GiB');
    expect(formatMemory(2_097_152)).toBe('2 GiB');
  });

  it('names and explains every KDF preset', () => {
    for (const id of KDF_PRESET_IDS) {
      expect(KDF_PRESET_COPY[id].name, id).not.toBe('');
      expect(KDF_PRESET_COPY[id].note.length, id).toBeGreaterThan(20);
    }
  });
});
