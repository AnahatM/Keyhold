// SPDX-License-Identifier: GPL-3.0-or-later
import { AUDIT_LEVEL_FIELDS, AUDIT_PRIVACY_LEVELS } from '@shared/model/credential.js';
import type { HealthRuleId } from '@shared/model/health.js';
import type { AuditPrivacyLevel, ChangeOrigin } from '@shared/model/credential.js';
import {
  DEFAULT_KDF_COST,
  DEFAULT_MACHINE_SETTINGS,
  DEFAULT_CONFIGURABLE_VAULT_SETTINGS,
  type ConfigurableVaultSettings,
  type KdfCost,
  type KdfPresetId,
  type MachineSettings,
  type SettingId,
  type SettingsScope,
} from '@shared/model/settings-plan.js';

/**
 * Every word this screen says, and the pure functions that decide when it says them.
 *
 * Outside the components on purpose — the same reasoning as `health-presentation.ts` and
 * `origin-labels.ts`. The copy *is* the feature here: a settings screen that lists
 * `auditPrivacyLevel: network` is a config file with a mouse, and one that says "the vault
 * file will name the networks you were on" is the thing that lets someone choose.
 * `@testing-library/react` is not a dependency, so keeping the strings and the predicates
 * pure is also the only way most of this can be tested at all.
 *
 * ## Two rules every entry here honours
 *
 * **Say where it lives.** Machine settings stay on this computer; vault settings ride
 * inside the encrypted file to wherever it is copied. Every control is labelled with its
 * scope, from `SETTING_SCOPE`, because a user who cannot tell will be surprised by a
 * security setting.
 *
 * **Say what it costs.** Where a choice is a trade — a longer auto-lock, a higher reveal
 * ceiling, `full` audit capture, a cheaper KDF — the cost is one plain sentence beside the
 * control, and it is shown exactly when the chosen value is looser than the default. A
 * warning that is always on is wallpaper.
 *
 * Nothing here derives a string from anything secret. There is no secret on this screen to
 * derive one from.
 */

// ── Scope ────────────────────────────────────────────────────────────────────

export const SCOPE_LABELS: Readonly<Record<SettingsScope, string>> = {
  machine: 'This computer',
  vault: 'Travels with the vault',
};

export const SCOPE_NOTES: Readonly<Record<SettingsScope, string>> = {
  machine:
    'Stored on this computer, outside the vault. Opening the same vault on another machine will not bring this setting with it.',
  vault:
    'Stored inside the encrypted vault file. Copy the vault to another computer — or hand the file to someone — and this setting goes with it.',
};

// ── Every setting, in English ────────────────────────────────────────────────

export interface SettingCopy {
  readonly label: string;
  /** What the setting does, in one or two sentences. Wired up via `aria-describedby`. */
  readonly help: string;
  /**
   * What the looser end of this control costs. `null` where no option is a trade.
   * Shown only when the current value is actually looser than the default.
   */
  readonly tradeOff: string | null;
}

/**
 * An exhaustive `Record`, so a new `SettingId` with no copy is a compile error rather than
 * a control that ships with an identifier where its label should be.
 */
export const SETTING_COPY: Readonly<Record<SettingId, SettingCopy>> = {
  'autoLock.idleMinutes': {
    label: 'Lock after idle',
    help: 'Measured by the operating system across your whole machine, not just inside Keyhold — so working in another window correctly counts as not idle.',
    tradeOff:
      'A longer wait, or no wait at all, means an unattended machine stays unlocked for that much longer.',
  },
  'autoLock.lockOnSleep': {
    label: 'Lock when the computer sleeps',
    help: 'Keyhold is told before the machine sleeps, so the keys are destroyed before the memory image is written to disk.',
    tradeOff:
      'Turning this off leaves the keys in memory when the machine sleeps — which matters most on a computer without full-disk encryption.',
  },
  'autoLock.lockOnScreenLock': {
    label: 'Lock when the screen locks',
    help: 'Locking your screen is you saying you are leaving.',
    tradeOff: 'Turning this off leaves the vault open behind a locked screen.',
  },
  'autoLock.lockOnMinimise': {
    label: 'Lock when the window is minimised',
    help: 'Off by default: minimising to check something else is not walking away, and a vault that relocks every time you glance at another window trains you to raise every other timeout.',
    tradeOff: null,
  },
  'autoLock.lockOnBlur': {
    label: 'Lock when the window loses focus',
    help: 'Off by default, for the same reason as minimising. Switching to your browser to paste a password would otherwise lock the vault mid-task.',
    tradeOff: null,
  },
  clipboardClearMs: {
    label: 'Clear the clipboard after',
    help: 'Keyhold marks copied secrets so Windows clipboard history and cloud clipboard skip them, but those markers are advisory. The timer is the part that does not depend on anyone else honouring them. Keyhold only clears the clipboard if it still holds the value it put there.',
    tradeOff:
      'A longer delay, or none, leaves the password sitting on the clipboard where any running app can read it without asking.',
  },
  wipeAfterFailedAttempts: {
    label: 'Erase the vault after repeated failures',
    help: 'Off unless you switch it on, refused below three attempts, and it removes the rolling backups too — leaving them would make the whole feature theatre.',
    tradeOff:
      'This destroys the vault permanently. A forgotten password, or a child at the keyboard, is enough to trigger it, and there is no recovery.',
  },
  'secretReveal.maxRevealsPerWindow': {
    label: 'Reveal limit',
    help: 'How many individual secrets may be revealed in one minute. This is a tripwire for a bug or a hostile dependency looping over every record, not a defence against a patient attacker — a human revealing passwords one at a time never comes near it.',
    tradeOff:
      'A higher ceiling means automated harvesting of the whole vault runs for longer before anything notices.',
  },
  'secretReveal.grantTtlMs': {
    label: 'Revealed secrets expire after',
    help: 'A revealed secret stops being available again after this long, whether or not anything used it.',
    tradeOff:
      'A longer window keeps a revealed secret reachable for longer after you asked for it.',
  },
  quickUnlock: {
    label: 'Quick unlock',
    help: 'Stores a second, independently wrapped copy of this vault’s data key in your operating system’s key store. Your master password is never stored, in any form, and re-keying the vault turns this off automatically.',
    tradeOff: null,
  },
  networkAllowed: {
    label: 'Let Keyhold make network requests',
    help: 'Off. Keyhold works entirely offline and has exactly one optional feature that would use a connection — checking your passwords against Have I Been Pwned, which is itself off by default. With this off, that code is not merely disabled: no connection can be opened at all, because nothing that could open one is ever built. Opening a link in your browser is not affected; that request is made by your browser, as you.',
    tradeOff:
      'Turning this on lets the breach check reach the internet, if you also turn that on. Nothing else in Keyhold will use it.',
  },
  blockScreenCapture: {
    label: 'Hide this window from screenshots and screen recordings',
    help: 'On. Asks the operating system to exclude the Keyhold window from screen capture, so a password on screen does not end up in a recording of a shared call. A capture gets a black rectangle where the window was. **This is the operating system’s promise, not Keyhold’s** — a camera pointed at the screen still works, and on Linux there is nothing equivalent to ask for, so it does nothing there.',
    tradeOff:
      'Turning it off means anything that can record your screen can record your passwords.',
  },
  'tray.showTrayIcon': {
    label: 'Show a Keyhold icon in the system tray',
    help: 'On. Puts Keyhold in the notification area (the menu bar on macOS) with a small menu — show the window, lock the vault, quit. The menu deliberately shows nothing about what is in your vault: no record names, no counts, no unlock state beyond locked or unlocked.',
    tradeOff: null,
  },
  'tray.closeToTray': {
    label: 'Closing the window keeps Keyhold running in the tray',
    help: 'Off. Today, closing the last window locks the vault and quits, which is what guarantees the keys are gone from memory. With this on, closing hides the window instead and the process keeps running.',
    tradeOff:
      'A running Keyhold holds a decrypted vault in the memory of a process you believe you have finished with. The setting below is what limits that, and it is on by default.',
  },
  'tray.minimiseToTray': {
    label: 'Minimising hides the window to the tray',
    help: 'Off. Minimising sends Keyhold to the notification area rather than the taskbar. The tray icon is the way back.',
    tradeOff: null,
  },
  'tray.lockOnHideToTray': {
    label: 'Lock the vault when the window is hidden to the tray',
    help: 'On. A window hidden to the tray fires neither “minimised” nor “lost focus”, so the two auto-lock settings above cannot see it — this is what covers the gesture that actually means “I have put this away”.',
    tradeOff:
      'Turning it off means Keyhold can sit in the tray with the vault unlocked for as long as the idle timer allows.',
  },
  'breachCheck.enabled': {
    label: 'Check this vault’s passwords against Have I Been Pwned',
    help: 'Off. This is the only feature in Keyhold that uses the internet, and it needs the switch above turned on as well. It never sends a password: each one is hashed with SHA-1 locally, the **first five characters** of that hash are sent, and the service answers with every leaked hash sharing those five — hundreds of thousands of them — which Keyhold searches on your machine. The service therefore cannot tell which password you asked about, or whether it was found. This setting travels with the vault file, so a copy of it on another machine is not checked unless you turn this on there too.',
    tradeOff:
      'A request goes to haveibeenpwned.com each time you run a check. That reveals to them, and to anything watching the connection, that Keyhold is being used from your address — never which password, and never the answer.',
  },
  historyEnabledByDefault: {
    label: 'Keep history for new records',
    help: 'Each record can override this on its own. History stores the values a change replaced, so a previous password is recoverable — and is protected exactly like the current one.',
    tradeOff: null,
  },
  historyMaxVersions: {
    label: 'Versions kept per record',
    help: 'The oldest versions are dropped first. Every version that survives stays fully restorable — history stores what each change replaced, so pruning the oldest never breaks the entries left behind.',
    tradeOff: null,
  },
  auditPrivacyLevel: {
    label: 'What each change records',
    help: 'The level is enforced when a change is recorded, not when it is shown. A detail this setting excludes is never written to the file, so it cannot be recovered later by anyone — including by a future version of Keyhold.',
    tradeOff:
      'Higher levels write more about you into a file you may one day copy, sync or hand to someone.',
  },
  'health.rules': {
    label: 'Which checks run',
    help: 'Turning a check off only stops it being reported. It never changes the score of a vault that was not breaking that rule anyway.',
    tradeOff: 'A check that is off will not tell you about the problem it looks for.',
  },
  'health.weakEntropyBits': {
    label: 'Call a password weak below',
    help: 'Estimated bits of entropy. The default of 60 flags an eight-character mixed password and passes a sixteen-character generated one.',
    tradeOff:
      'A lower threshold means fewer passwords are flagged — not that fewer of them are weak.',
  },
  'health.expiringWithinDays': {
    label: 'Warn before a rotation date',
    help: 'How far ahead of an expiry date or rotation interval you set the dashboard starts mentioning it.',
    tradeOff: null,
  },
  passwordAgeWarningDays: {
    label: 'Call a password old after',
    help: 'Age is a proxy for risk rather than risk itself — a strong, unique password three years old is still a strong, unique password — so this is weighted as a prompt, not a finding.',
    tradeOff: null,
  },
  trashRetentionDays: {
    label: 'Keep trashed records for',
    help: 'Trashed records are restorable until this passes. Purging happens when the vault is saved, not on a background timer, so nothing disappears while you are looking at it.',
    tradeOff: null,
  },
  kdfCost: {
    label: 'Unlock cost',
    help: 'How much memory and time it takes to turn your master password into a key. Every guess an attacker makes costs the same, which is what makes a stolen vault file expensive to attack. Changing this re-derives the key and turns quick unlock off.',
    tradeOff:
      'A lower cost makes every unlock faster — and makes every guess against a stolen copy of your vault cheaper by exactly the same factor.',
  },
};

// ── The audit levels, rendered from the capture table ────────────────────────

/**
 * One label per `ChangeOrigin` field.
 *
 * Exhaustive over `keyof ChangeOrigin`, so a new provenance field cannot be captured
 * without appearing on this screen. The level descriptions are **generated** from
 * `AUDIT_LEVEL_FIELDS` through this map rather than written out by hand — a hand-written
 * list of "what `network` records" is a second list, and the first time capture changed it
 * would start lying about what is in the user's file.
 *
 * Deliberately distinct phrasings, none a substring of another, so the guard test can
 * assert a level's description names exactly the fields that level captures.
 */
export const ORIGIN_FIELD_LABELS: Readonly<Record<keyof ChangeOrigin, string>> = {
  action: 'What kind of change it was',
  deviceName: 'The name of this computer',
  platform: 'Which operating system',
  appVersion: 'Which release of Keyhold',
  osUser: 'Your sign-in name on this computer',
  networkName: 'The name of the network you were on',
  osRelease: 'The exact operating-system build',
  localIp: 'This computer’s address on that network',
};

export const AUDIT_LEVEL_TITLES: Readonly<Record<AuditPrivacyLevel, string>> = {
  none: 'Nothing but the change itself',
  device: 'This device',
  network: 'This device and network',
  full: 'Everything Keyhold can see',
};

/** The trade, level by level. Empty string where there is nothing to warn about. */
export const AUDIT_LEVEL_COSTS: Readonly<Record<AuditPrivacyLevel, string>> = {
  none: 'You lose the ability to tell your own edits from someone else’s on a shared vault.',
  device: '',
  network:
    'The vault file will name the networks you were on. Anyone you give a copy to learns where you have been.',
  full: 'Adds your local address on each network. A copy of this vault becomes a partial record of where this computer has been.',
};

/** What this level writes into the file, one phrase per captured field. */
export function auditLevelRecords(level: AuditPrivacyLevel): readonly string[] {
  return AUDIT_LEVEL_FIELDS[level].map((field) => ORIGIN_FIELD_LABELS[field]);
}

/** What this level deliberately leaves out. The half people actually want to know. */
export function auditLevelOmits(level: AuditPrivacyLevel): readonly string[] {
  const captured = new Set<keyof ChangeOrigin>(AUDIT_LEVEL_FIELDS[level]);
  return (Object.keys(ORIGIN_FIELD_LABELS) as (keyof ChangeOrigin)[])
    .filter((field) => !captured.has(field))
    .map((field) => ORIGIN_FIELD_LABELS[field]);
}

/** True when the level captures the network name, so the "what am I on?" check is useful. */
export function auditLevelCapturesNetwork(level: AuditPrivacyLevel): boolean {
  return AUDIT_LEVEL_FIELDS[level].includes('networkName');
}

export const AUDIT_LEVELS_IN_ORDER: readonly AuditPrivacyLevel[] = AUDIT_PRIVACY_LEVELS;

// ── KDF presets ──────────────────────────────────────────────────────────────

export const KDF_PRESET_COPY: Readonly<Record<KdfPresetId, { name: string; note: string }>> = {
  default: {
    name: 'Standard',
    note: 'What Keyhold ships with, and the lowest this screen will go. Roughly half a second on a typical machine.',
  },
  stronger: {
    name: 'Stronger',
    note: 'Four times the memory. Noticeably slower to unlock, and four times as expensive to attack.',
  },
  strongest: {
    name: 'Strongest',
    note: 'Sixteen times the memory. Several seconds to unlock on most machines, and unusable on one with little RAM to spare.',
  },
};

// ── Choices ──────────────────────────────────────────────────────────────────

export interface Choice<T> {
  readonly value: T;
  readonly label: string;
}

/** `null` means "never" throughout — the option that switches the behaviour off. */
export const IDLE_MINUTE_CHOICES: readonly Choice<number | null>[] = [
  { value: 1, label: '1 minute' },
  { value: 5, label: '5 minutes' },
  { value: 10, label: '10 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: null, label: 'Never lock on idle' },
];

export const CLIPBOARD_CHOICES: readonly Choice<number | null>[] = [
  { value: 5_000, label: '5 seconds' },
  { value: 10_000, label: '10 seconds' },
  { value: 30_000, label: '30 seconds' },
  { value: 60_000, label: '1 minute' },
  { value: 300_000, label: '5 minutes' },
  { value: 600_000, label: '10 minutes' },
  { value: null, label: 'Never clear it' },
];

export const WIPE_CHOICES: readonly Choice<number | null>[] = [
  { value: null, label: 'Never erase the vault' },
  { value: 3, label: 'After 3 failed unlocks' },
  { value: 5, label: 'After 5 failed unlocks' },
  { value: 10, label: 'After 10 failed unlocks' },
  { value: 25, label: 'After 25 failed unlocks' },
];

export const REVEAL_LIMIT_CHOICES: readonly Choice<number>[] = [
  { value: 20, label: '20 a minute' },
  { value: 60, label: '60 a minute' },
  { value: 120, label: '120 a minute' },
  { value: 240, label: '240 a minute' },
  { value: 500, label: '500 a minute' },
];

export const GRANT_TTL_CHOICES: readonly Choice<number>[] = [
  { value: 5_000, label: '5 seconds' },
  { value: 15_000, label: '15 seconds' },
  { value: 30_000, label: '30 seconds' },
  { value: 60_000, label: '1 minute' },
  { value: 300_000, label: '5 minutes' },
];

export const HISTORY_MAX_CHOICES: readonly Choice<number | null>[] = [
  { value: 10, label: '10 versions' },
  { value: 25, label: '25 versions' },
  { value: 50, label: '50 versions' },
  { value: 200, label: '200 versions' },
  { value: 1_000, label: '1000 versions' },
  { value: null, label: 'Every version' },
];

export const PASSWORD_AGE_CHOICES: readonly Choice<number>[] = [
  { value: 90, label: '3 months' },
  { value: 180, label: '6 months' },
  { value: 365, label: '1 year' },
  { value: 730, label: '2 years' },
];

export const TRASH_RETENTION_CHOICES: readonly Choice<number | null>[] = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 365, label: '1 year' },
  { value: null, label: 'Keep until I empty the trash' },
];

export const WEAK_ENTROPY_CHOICES: readonly Choice<number>[] = [
  { value: 40, label: '40 bits' },
  { value: 50, label: '50 bits' },
  { value: 60, label: '60 bits' },
  { value: 70, label: '70 bits' },
  { value: 80, label: '80 bits' },
];

export const EXPIRING_WITHIN_CHOICES: readonly Choice<number>[] = [
  { value: 7, label: '7 days ahead' },
  { value: 14, label: '14 days ahead' },
  { value: 30, label: '30 days ahead' },
  { value: 60, label: '60 days ahead' },
];

// ── When a trade-off is actually being made ──────────────────────────────────

/**
 * Which machine settings are currently looser than the shipped default.
 *
 * A pure set rather than a flag on each control, so "is this weaker than the default"
 * has exactly one definition and one test. Anything not looser produces no warning at
 * all — a caution that is always visible stops being read.
 */
export function machineWeakenings(machine: MachineSettings): ReadonlySet<SettingId> {
  const weakened = new Set<SettingId>();
  const defaults = DEFAULT_MACHINE_SETTINGS;

  const idle = machine.autoLock.idleMinutes;
  const defaultIdle = defaults.autoLock.idleMinutes;
  if (idle === null || (defaultIdle !== null && idle > defaultIdle)) {
    weakened.add('autoLock.idleMinutes');
  }
  if (!machine.autoLock.lockOnSleep) weakened.add('autoLock.lockOnSleep');
  if (!machine.autoLock.lockOnScreenLock) weakened.add('autoLock.lockOnScreenLock');

  const clipboard = machine.clipboardClearMs;
  const defaultClipboard = defaults.clipboardClearMs;
  if (clipboard === null || (defaultClipboard !== null && clipboard > defaultClipboard)) {
    weakened.add('clipboardClearMs');
  }

  // The dangerous direction here is ON, not off: this is the one setting whose looser
  // choice destroys data rather than exposing it.
  if (machine.wipeAfterFailedAttempts !== null) weakened.add('wipeAfterFailedAttempts');

  if (machine.secretReveal.maxRevealsPerWindow > defaults.secretReveal.maxRevealsPerWindow) {
    weakened.add('secretReveal.maxRevealsPerWindow');
  }
  if (machine.secretReveal.grantTtlMs > defaults.secretReveal.grantTtlMs) {
    weakened.add('secretReveal.grantTtlMs');
  }

  return weakened;
}

/** The same, for the settings that travel inside the vault file. */
export function vaultWeakenings(
  vault: ConfigurableVaultSettings,
  kdf: KdfCost | null
): ReadonlySet<SettingId> {
  const weakened = new Set<SettingId>();
  const defaults = DEFAULT_CONFIGURABLE_VAULT_SETTINGS;

  // `network` and `full` both write more about the user into the file than the default.
  if (vault.auditPrivacyLevel === 'network' || vault.auditPrivacyLevel === 'full') {
    weakened.add('auditPrivacyLevel');
  }

  if (vault.health.weakEntropyBits < defaults.health.weakEntropyBits) {
    weakened.add('health.weakEntropyBits');
  }

  // Weakened means "turned off something that ships on", not "not everything is on". Some
  // rules ship off deliberately — `missingTotp` does, because most records legitimately have
  // no second factor and a rule that lights up the whole vault on first run is one people
  // switch off and stop trusting. Marking the defaults as a weakened trade-off would put a
  // warning on a screen nobody had touched, which is how a warning stops meaning anything.
  //
  // Compared against `defaults` for the same reason the entropy threshold above is.
  const weakenedRule = Object.entries(vault.health.enabledRules).some(
    ([rule, enabled]) => !enabled && defaults.health.enabledRules[rule as HealthRuleId]
  );
  if (weakenedRule) weakened.add('health.rules');

  if (kdf !== null && kdf.memoryKib < DEFAULT_KDF_COST.memoryKib) weakened.add('kdfCost');

  return weakened;
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** Memory in the unit a person reads it in. Never a bare KiB count on screen. */
export function formatMemory(kib: number): string {
  if (kib >= 1_048_576) {
    const gib = kib / 1_048_576;
    return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`;
  }
  return `${Math.round(kib / 1024)} MiB`;
}

export function formatKdfCost(cost: KdfCost): string {
  return `${formatMemory(cost.memoryKib)} · ${cost.iterations} passes · ${cost.parallelism} lanes`;
}
