// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The password generator UI — roadmap Phase 8.
 *
 * Two entry points over **one** implementation:
 *
 *   `GeneratorScreen`   — the standalone Generate view. Needs no open vault.
 *   `InlineGenerator`   — a disclosure beside a password field, handing the result back.
 *
 * Both render `GeneratorPanel`, which is exported too for anywhere that wants the panel
 * without either wrapper's chrome. Two generators would eventually disagree about what a
 * setting means, which is the "no second list" rule applied to a screen.
 *
 * A barrel, for the same reason `chrome/index.ts` is one: the generator is reached from the
 * editor, the detail pane and its own screen, and one import site is the difference between
 * it being reused and being reimplemented by whoever could not find it.
 */

export { GeneratorScreen, type GeneratorScreenProps } from './GeneratorScreen.js';
export { InlineGenerator, type InlineGeneratorProps } from './InlineGenerator.js';
export { GeneratorPanel, type GeneratorPanelProps } from './GeneratorPanel.js';

export {
  GENERATOR_MODES,
  MODE_DETAILS,
  CAPITALISATIONS,
  CAPITALISATION_LABELS,
  clampToRange,
  configurationKey,
  draftFromDefaults,
  limitForMode,
  optionsFromDraft,
  type GeneratorDraft,
  type ModeDetail,
} from './generator-options.js';

export {
  METER_CEILING_BITS,
  STRENGTH_BANDS,
  bandForEntropyBits,
  formatBits,
  meterPercent,
  type StrengthBand,
  type StrengthBandId,
} from './strength-band.js';

export {
  MAX_SECRET_HISTORY,
  findSecretHistoryEntry,
  pushSecretHistory,
  type SecretHistoryEntry,
} from './generation-history.js';

export {
  loadGeneratorLimits,
  resetGeneratorLimits,
  useGeneratorLimits,
  type GeneratorLimitsState,
} from './generator-limits.js';
