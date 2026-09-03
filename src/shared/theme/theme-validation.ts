// SPDX-License-Identifier: GPL-3.0-or-later
import { IpcValidationError } from '../ipc/validation.js';
import {
  KEEPTHEME_FORMAT,
  KEEPTHEME_FORMAT_VERSION,
  KEEPTHEME_MAX_DESCRIPTION_LENGTH,
  KEEPTHEME_MAX_NAME_LENGTH,
  type KeepTheme,
} from './keeptheme.js';
import { COLOUR_TOKENS, type ColourToken, type Palette } from './tokens.js';
import {
  isThemeErrorCode,
  type ThemeExportRequest,
  type ThemeExportResponse,
  type ThemeFileRefusal,
  type ThemeImportResponse,
  type ThemeNotice,
} from './theme-channels.js';

/**
 * Runtime validation for both directions of the `kh:theme:*` bridge.
 *
 * TypeScript is erased at runtime and proves nothing about what actually arrived over IPC,
 * which is why `src/shared/ipc/validation.ts` exists and why this file exists beside the
 * payloads it checks. Two directions, two different failure styles, on purpose:
 *
 *  - **renderer → main** ({@link requireThemeExportRequest}) throws `IpcValidationError`,
 *    which `register.ts`'s `toFailure` turns into `INVALID_REQUEST`. A malformed request is
 *    a bug or an attack; either way the handler must not proceed on a guess.
 *  - **main → renderer** ({@link readThemeImportResponse}) returns `null`. A renderer that
 *    threw on an unexpected response would turn a main-process bug into a blank screen; the
 *    studio shows "that could not be read" and stays usable.
 *
 * The main → renderer direction looks redundant — the main process wrote that object. It is
 * checked anyway because the preload is the only thing between the two, the contract in
 * `api.ts` is a compile-time claim about a runtime boundary, and "schema-validated both
 * ways" is written into CLAUDE.md's architecture diagram rather than into whichever half
 * seemed likelier to be wrong.
 */

// ── renderer → main ──────────────────────────────────────────────────────────

function record(channel: string, value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new IpcValidationError(channel, `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * A bounded string.
 *
 * Capped at the format's own limit rather than at `MAX_STRING_UNITS`: a 1 MiB theme name is
 * not a long name, it is a renderer trying to push a megabyte into a save dialog's default
 * path. Never interpolates the value into the error — this message reaches a log.
 */
function boundedString(
  channel: string,
  value: unknown,
  name: string,
  maximumLength: number
): string {
  if (typeof value !== 'string') {
    throw new IpcValidationError(channel, `${name} must be a string`);
  }
  if (value.length > maximumLength) {
    throw new IpcValidationError(channel, `${name} exceeds ${maximumLength} characters`);
  }
  return value;
}

/**
 * Checks a renderer-supplied theme into the shape `serialiseKeepTheme` can safely handle.
 *
 * This is **not** where a theme is judged. It establishes only that every field is the
 * primitive it claims to be — the colours are still arbitrary strings here. The real gate is
 * `parseKeepTheme`, which the export path runs over the serialised result, so a theme that
 * fails contrast or carries a value that is not a colour is refused with the same rules and
 * the same messages an imported file gets. Validating shape here and meaning there is what
 * keeps one implementation of "is this a theme" rather than two.
 */
function requireKeepTheme(channel: string, value: unknown, name: string): KeepTheme {
  const raw = record(channel, value, name);

  if (raw.format !== KEEPTHEME_FORMAT) {
    throw new IpcValidationError(channel, `${name}.format is not a Keyhold theme`);
  }

  const version = raw.version;
  if (version !== KEEPTHEME_FORMAT_VERSION) {
    // Exact, not `<=`. The renderer is built from this source tree; a renderer asking to
    // write a version this build does not implement is not a compatibility case, it is a
    // renderer that is not the one we shipped.
    throw new IpcValidationError(channel, `${name}.version must be ${KEEPTHEME_FORMAT_VERSION}`);
  }

  const scheme = raw.scheme;
  if (scheme !== 'light' && scheme !== 'dark') {
    throw new IpcValidationError(channel, `${name}.scheme must be "light" or "dark"`);
  }

  const paletteRaw = record(channel, raw.palette, `${name}.palette`);
  const palette: Record<string, string> = {};
  for (const token of COLOUR_TOKENS) {
    const colour = paletteRaw[token];
    if (typeof colour !== 'string') {
      throw new IpcValidationError(channel, `${name}.palette.${token} must be a string`);
    }
    // Rebuilt key by key from `COLOUR_TOKENS` rather than spread, so anything extra the
    // renderer attached — including `__proto__` or a getter — is left behind rather than
    // carried into a value that is about to be serialised to disk.
    palette[token] = colour;
  }

  return {
    format: KEEPTHEME_FORMAT,
    version: KEEPTHEME_FORMAT_VERSION,
    name: boundedString(channel, raw.name, `${name}.name`, KEEPTHEME_MAX_NAME_LENGTH),
    description: boundedString(
      channel,
      raw.description,
      `${name}.description`,
      KEEPTHEME_MAX_DESCRIPTION_LENGTH
    ),
    scheme,
    basedOn: boundedString(channel, raw.basedOn, `${name}.basedOn`, KEEPTHEME_MAX_NAME_LENGTH),
    palette: palette as Palette,
  };
}

/** An acknowledgement is `contrastAcknowledgement`'s output: eight lower-case hex digits. */
const ACKNOWLEDGEMENT = /^[0-9a-f]{8}$/;

export function requireThemeExportRequest(channel: string, value: unknown): ThemeExportRequest {
  const raw = record(channel, value, 'request');
  const acknowledgement = raw.acknowledgement;

  if (acknowledgement !== null && acknowledgement !== undefined) {
    if (typeof acknowledgement !== 'string' || !ACKNOWLEDGEMENT.test(acknowledgement)) {
      // Shape-checked, not trusted. A well-formed token still only admits a theme when it
      // matches the one `contrastAcknowledgement` derives from that exact palette; this
      // check exists so a 10 MB "acknowledgement" is refused at the door rather than
      // compared.
      throw new IpcValidationError(channel, 'acknowledgement must be null or an 8-digit token');
    }
  }

  return {
    theme: requireKeepTheme(channel, raw.theme, 'theme'),
    acknowledgement: typeof acknowledgement === 'string' ? acknowledgement : null,
  };
}

// ── main → renderer ──────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const COLOUR_TOKEN_SET: ReadonlySet<string> = new Set<string>(COLOUR_TOKENS);

function isColourToken(value: unknown): value is ColourToken {
  return typeof value === 'string' && COLOUR_TOKEN_SET.has(value);
}

function readRefusalTokens(value: unknown): readonly ColourToken[] | null {
  if (!Array.isArray(value)) return null;
  // Every entry must be a token this build knows. A refusal is rendered as text, so an
  // unrecognised string here means the response did not come from our own projection.
  const tokens: ColourToken[] = [];
  for (const entry of value) {
    if (!isColourToken(entry)) return null;
    tokens.push(entry);
  }
  return tokens;
}

function readNotices(value: unknown): readonly ThemeNotice[] | null {
  if (!Array.isArray(value)) return null;
  const notices: ThemeNotice[] = [];

  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.message !== 'string') return null;

    if (entry.kind === 'missing-token') {
      if (!isColourToken(entry.token)) return null;
      if (typeof entry.filledFrom !== 'string') return null;
      notices.push({
        kind: 'missing-token',
        token: entry.token,
        filledFrom: entry.filledFrom,
        message: entry.message,
      });
      continue;
    }

    if (entry.kind === 'unknown-tokens') {
      if (typeof entry.count !== 'number' || !Number.isInteger(entry.count) || entry.count < 0) {
        return null;
      }
      notices.push({ kind: 'unknown-tokens', count: entry.count, message: entry.message });
      continue;
    }

    if (entry.kind === 'unknown-base') {
      if (typeof entry.usedInstead !== 'string') return null;
      notices.push({
        kind: 'unknown-base',
        usedInstead: entry.usedInstead,
        message: entry.message,
      });
      continue;
    }

    return null;
  }

  return notices;
}

/**
 * Re-checks the theme the main process sent.
 *
 * The palette is the part worth re-checking. Every value should already be a `#rrggbb`
 * literal the main process wrote; asserting that here means a palette entry can never reach
 * `style.setProperty` without having satisfied this pattern on **both** sides of the
 * bridge. Belt and braces on the one field where a bad string is an injection rather than a
 * cosmetic bug.
 */
const CANONICAL_HEX = /^#[0-9a-f]{6}$/;

function readKeepTheme(value: unknown): KeepTheme | null {
  if (!isRecord(value)) return null;
  if (value.format !== KEEPTHEME_FORMAT) return null;
  if (value.version !== KEEPTHEME_FORMAT_VERSION) return null;
  if (typeof value.name !== 'string' || value.name.length > KEEPTHEME_MAX_NAME_LENGTH) return null;
  if (
    typeof value.description !== 'string' ||
    value.description.length > KEEPTHEME_MAX_DESCRIPTION_LENGTH
  ) {
    return null;
  }
  if (value.scheme !== 'light' && value.scheme !== 'dark') return null;
  if (typeof value.basedOn !== 'string') return null;
  if (!isRecord(value.palette)) return null;

  const palette: Record<string, string> = {};
  for (const token of COLOUR_TOKENS) {
    const colour = value.palette[token];
    if (typeof colour !== 'string' || !CANONICAL_HEX.test(colour)) return null;
    palette[token] = colour;
  }

  return {
    format: KEEPTHEME_FORMAT,
    version: KEEPTHEME_FORMAT_VERSION,
    name: value.name,
    description: value.description,
    scheme: value.scheme,
    basedOn: value.basedOn,
    palette: palette as Palette,
  };
}

function readRefusal(value: Record<string, unknown>): ThemeFileRefusal | null {
  if (!isThemeErrorCode(value.code)) return null;
  if (typeof value.message !== 'string') return null;
  const tokens = readRefusalTokens(value.tokens);
  if (tokens === null) return null;
  return { kind: 'refused', code: value.code, message: value.message, tokens };
}

export function readThemeImportResponse(value: unknown): ThemeImportResponse | null {
  if (!isRecord(value)) return null;

  if (value.kind === 'cancelled') return { kind: 'cancelled' };
  if (value.kind === 'refused') return readRefusal(value);

  if (value.kind === 'imported' || value.kind === 'needs-review') {
    if (typeof value.fileName !== 'string') return null;
    const theme = readKeepTheme(value.theme);
    if (theme === null) return null;
    const notices = readNotices(value.notices);
    if (notices === null) return null;
    return { kind: value.kind, fileName: value.fileName, theme, notices };
  }

  return null;
}

export function readThemeExportResponse(value: unknown): ThemeExportResponse | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'cancelled') return { kind: 'cancelled' };
  if (value.kind === 'refused') return readRefusal(value);
  if (value.kind === 'saved' && typeof value.fileName === 'string') {
    return { kind: 'saved', fileName: value.fileName };
  }
  return null;
}
