// SPDX-License-Identifier: GPL-3.0-or-later
import type { GeneratorOptions, GeneratorMode, WordCapitalisation } from '../model/generator.js';
import { IpcValidationError, requireBoolean, requireString } from './validation.js';

/**
 * Runtime validation for generator payloads.
 *
 * The generator is the one part of the app a hostile renderer could use to make a *weak*
 * password rather than to read an existing one, which is a quieter failure and therefore
 * worth being strict about. The engine already refuses an over-restrictive configuration —
 * see `GeneratorConfigurationError` — so this layer's job is narrower: reject anything that
 * is not the shape the engine expects, before it gets there.
 *
 * Numeric bounds are deliberately **not** duplicated here. `GENERATOR_LIMITS` lives in the
 * engine, the engine enforces it, and a second copy of "length is 8 to 256" in this file
 * would be a second list that disagrees the first time one of them changes.
 */

const MODES: readonly GeneratorMode[] = ['random', 'passphrase', 'pronounceable', 'pin'];
const CAPITALISATIONS: readonly WordCapitalisation[] = ['none', 'first', 'all'];

/** Long enough for any legitimate "this site rejects these characters" list. */
const MAX_EXCLUDE_LENGTH = 256;
/** A separator is one or two characters in every real use. */
const MAX_SEPARATOR_LENGTH = 8;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireCount(channel: string, value: unknown, name: string): number {
  // Bounds belong to the engine; this only rejects what is not a count at all. A float or a
  // NaN would otherwise reach code that loops `while (i < length)` and never returns.
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100_000) {
    throw new IpcValidationError(channel, `${name} must be a positive whole number`);
  }
  return value;
}

export function requireGeneratorOptions(channel: string, value: unknown): GeneratorOptions {
  if (!isObject(value)) throw new IpcValidationError(channel, 'options must be an object');

  const mode = value.mode;
  if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) {
    throw new IpcValidationError(channel, 'options.mode is not a known generator mode');
  }

  switch (mode as GeneratorMode) {
    case 'random': {
      const options: {
        mode: 'random';
        length?: number;
        lowercase?: boolean;
        uppercase?: boolean;
        digits?: boolean;
        symbols?: boolean;
        excludeAmbiguous?: boolean;
        excludeCharacters?: string;
        requireEachClass?: boolean;
      } = { mode: 'random' };

      if (value.length !== undefined)
        options.length = requireCount(channel, value.length, 'length');
      if (value.lowercase !== undefined) {
        options.lowercase = requireBoolean(channel, value.lowercase, 'lowercase');
      }
      if (value.uppercase !== undefined) {
        options.uppercase = requireBoolean(channel, value.uppercase, 'uppercase');
      }
      if (value.digits !== undefined)
        options.digits = requireBoolean(channel, value.digits, 'digits');
      if (value.symbols !== undefined) {
        options.symbols = requireBoolean(channel, value.symbols, 'symbols');
      }
      if (value.excludeAmbiguous !== undefined) {
        options.excludeAmbiguous = requireBoolean(
          channel,
          value.excludeAmbiguous,
          'excludeAmbiguous'
        );
      }
      if (value.excludeCharacters !== undefined) {
        const excluded = requireString(channel, value.excludeCharacters, 'excludeCharacters');
        if (excluded.length > MAX_EXCLUDE_LENGTH) {
          throw new IpcValidationError(channel, 'excludeCharacters is unreasonably long');
        }
        options.excludeCharacters = excluded;
      }
      if (value.requireEachClass !== undefined) {
        options.requireEachClass = requireBoolean(
          channel,
          value.requireEachClass,
          'requireEachClass'
        );
      }
      return options;
    }

    case 'passphrase': {
      const options: {
        mode: 'passphrase';
        wordCount?: number;
        separator?: string;
        capitalisation?: WordCapitalisation;
        includeDigit?: boolean;
      } = { mode: 'passphrase' };

      if (value.wordCount !== undefined) {
        options.wordCount = requireCount(channel, value.wordCount, 'wordCount');
      }
      if (value.separator !== undefined) {
        const separator = requireString(channel, value.separator, 'separator');
        if (separator.length > MAX_SEPARATOR_LENGTH) {
          throw new IpcValidationError(channel, 'separator is too long');
        }
        options.separator = separator;
      }
      if (value.capitalisation !== undefined) {
        const capitalisation = value.capitalisation;
        if (
          typeof capitalisation !== 'string' ||
          !(CAPITALISATIONS as readonly string[]).includes(capitalisation)
        ) {
          throw new IpcValidationError(channel, 'capitalisation is not a known style');
        }
        options.capitalisation = capitalisation as WordCapitalisation;
      }
      if (value.includeDigit !== undefined) {
        options.includeDigit = requireBoolean(channel, value.includeDigit, 'includeDigit');
      }
      return options;
    }

    case 'pronounceable': {
      const options: {
        mode: 'pronounceable';
        length?: number;
        digits?: boolean;
        symbols?: boolean;
      } = { mode: 'pronounceable' };

      if (value.length !== undefined)
        options.length = requireCount(channel, value.length, 'length');
      if (value.digits !== undefined)
        options.digits = requireBoolean(channel, value.digits, 'digits');
      if (value.symbols !== undefined) {
        options.symbols = requireBoolean(channel, value.symbols, 'symbols');
      }
      return options;
    }

    case 'pin': {
      const options: { mode: 'pin'; length?: number } = { mode: 'pin' };
      if (value.length !== undefined)
        options.length = requireCount(channel, value.length, 'length');
      return options;
    }
  }
}
