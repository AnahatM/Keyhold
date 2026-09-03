// SPDX-License-Identifier: GPL-3.0-or-later
import type { IpcResult } from '../ipc/api.js';
import type { KeepTheme } from './keeptheme.js';
import type { ColourToken } from './tokens.js';

/**
 * The `kh:theme:*` channel group — names and payload types beside each other.
 *
 * Declared here rather than in `src/shared/ipc/api.ts` for the reason `IMPORT_CHANNELS` and
 * `EXPORT_CHANNELS` are: a channel name that lives apart from the shape it carries is a
 * second list, and rule 8 says there is one. `api.ts` spreads `...THEME_CHANNELS` into
 * `CHANNELS` and `...THEME_EVENTS` into `EVENTS`, so `ALL_CHANNELS` picks these up for the
 * main-process allow-list without anybody restating a string.
 *
 * ## Why a theme file goes through the main process at all
 *
 * An earlier version of the studio moved `.keeptheme` files with an `<input type="file">`
 * and an `<a download>`, on the argument that a theme holds no secret material so the
 * renderer may as well handle it. The argument is true about *secrecy* and wrong about
 * everything else:
 *
 *  - **A save dialog is the act of consent, and only the main process can open one.** Every
 *    other file operation in Keyhold — vault open, vault save, attachment add and save,
 *    import, export — opens its dialog in the main process, because a path the renderer
 *    chose would be attacker-controlled if the renderer were ever compromised, while a path
 *    the user picked in an OS dialog is a genuine act of consent and the OS decides what
 *    they were allowed to reach. A theme is not exempt from that; it was just cheap to
 *    pretend it was.
 *  - **An `<a download>` in a packaged app is not a save dialog.** It drops a file in the
 *    downloads folder with no chance to choose a name or a place, and no overwrite warning.
 *  - **An `<input type="file">` cannot be reached from a menu item**, and the OS already
 *    hands us `.keeptheme` files on double-click — `src/main/shell/file-open-request.ts`
 *    accepts the extension. A transport that only a click inside one React screen can start
 *    has nowhere to put those.
 *  - **The parse belongs where the bytes are.** A `.keeptheme` is untrusted input from a
 *    download, a friend, or a forum post. Handing 64 KB of it to the renderer and asking the
 *    renderer to be careful puts hostile text on the wrong side of the boundary for no gain.
 *
 * ## What crosses, and what deliberately does not
 *
 * **Never crosses:** the file's bytes, the file's own JSON, any absolute path, and any
 * string the file chose except the two named below. `parseKeepTheme` runs in the main
 * process; the renderer receives a {@link KeepTheme} whose every palette value is a
 * `#rrggbb` literal **this app wrote** after parsing the file's colour into RGB. That is the
 * property that matters: a colour token is written into a CSS custom property, and a custom
 * property is a place where a well-chosen string is an injection. The renderer cannot set
 * one to `url(…)` or to anything containing `}` because it never sees the file's string.
 *
 * **Does cross, deliberately:** `theme.name` and `theme.description`. They are the theme's
 * identity and the feature is pointless without them. They are the *only* file-supplied
 * text on this bridge, and they arrive length-capped (80 / 240), trimmed, and free of
 * control characters — see `readString` in `keeptheme.ts` — and are rendered as React text
 * nodes, never as markup and never as a style value.
 *
 * Refusals name the token and the category of problem and **never quote the file back**.
 * A refusal message is a string that ends up on screen, in a screenshot, and in a bug
 * report; a hostile file does not get to choose its contents. Notices are projected the same
 * way — see {@link ThemeNotice}.
 */

// ── Channels ─────────────────────────────────────────────────────────────────

export const THEME_CHANNELS = {
  /** Opens the OS open-dialog, reads, parses. No argument, and no path in the result. */
  themeImport: 'kh:theme:import',
  /** Opens the OS save-dialog and writes. Takes a theme, returns a file name. */
  themeExport: 'kh:theme:export',
  /**
   * Collects a theme the OS handed the app on double-click, if one is waiting.
   *
   * Takes **no path**. The path was validated by `parseFileOpenRequest` and is held in the
   * main process; a channel that accepted one would be the renderer choosing what the app
   * reads, which is the whole thing this group exists to avoid.
   */
  themeTakeOpened: 'kh:theme:take-opened',
} as const;

/** Main → renderer. Pushed, not requested, so it belongs with `EVENTS`, not `CHANNELS`. */
export const THEME_EVENTS = {
  /**
   * A `.keeptheme` arrived from the OS. Carries **no payload** — it is a nudge to call
   * `themeTakeOpened`, so there is no shape for a future edit to widen into a path.
   */
  themeFileOpened: 'kh:event:theme-file-opened',
} as const;

// ── Refusals ─────────────────────────────────────────────────────────────────

/**
 * The refusal codes a theme operation can come back with.
 *
 * Shared, like `IMPORT_ERROR_CODES`, because both sides need the same strings and a code
 * declared twice is a code that will disagree with itself. The studio reacts to
 * `illegible` by name — it is the one refusal with no override anywhere in the app — and
 * renders the rest generically.
 */
export const THEME_ERROR_CODES = {
  /** The file could not be opened or read. Never says which path. */
  unreadable: 'theme/unreadable',
  /** Larger than `KEEPTHEME_MAX_BYTES`, refused by `stat` before a byte was read. */
  tooLarge: 'theme/too-large',
  notJson: 'theme/not-json',
  /** Valid JSON, but not a theme: wrong `format` marker, or not an object at all. */
  notATheme: 'theme/not-a-theme',
  futureVersion: 'theme/future-version',
  /** A malformed `name`, `description`, `scheme`, `basedOn`, or `palette`. */
  invalidField: 'theme/invalid-field',
  /** One or more palette values were not colours. The offending tokens are named. */
  invalidColours: 'theme/invalid-colours',
  /** Below the legibility floor. No override exists — see `admitPalette`. */
  illegible: 'theme/illegible',
  /**
   * Export only: the theme fails WCAG AA and carried no matching acknowledgement.
   *
   * The studio's own gate makes this unreachable through the UI, so it is what a renderer
   * that skipped the gate gets. The refusal deliberately does **not** carry the token that
   * would admit the theme: handing it back on request would make the consent gate
   * self-serve, and the token exists precisely so consent cannot be given without the
   * failures having been rendered.
   */
  notAcknowledged: 'theme/not-acknowledged',
  /** The save dialog was answered but the file could not be written. */
  writeFailed: 'theme/write-failed',
} as const;

export type ThemeErrorCode = (typeof THEME_ERROR_CODES)[keyof typeof THEME_ERROR_CODES];

const THEME_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(Object.values(THEME_ERROR_CODES));

export function isThemeErrorCode(value: unknown): value is ThemeErrorCode {
  return typeof value === 'string' && THEME_ERROR_CODE_SET.has(value);
}

/**
 * A refused theme operation.
 *
 * `tokens` names the palette entries at fault, drawn from `COLOUR_TOKENS` and therefore
 * from our own vocabulary — a hostile file cannot get an arbitrary string into it by
 * inventing a key, because an unrecognised key is dropped as a notice long before this.
 * `message` is written by this app from the code and the token list, and contains nothing
 * out of the file.
 */
export interface ThemeFileRefusal {
  readonly kind: 'refused';
  readonly code: ThemeErrorCode;
  readonly message: string;
  readonly tokens: readonly ColourToken[];
}

// ── Notices ──────────────────────────────────────────────────────────────────

/**
 * A survivable oddity in an accepted theme, projected for the renderer.
 *
 * This is deliberately **not** `KeepThemeWarning`. Two of that type's three cases carry a
 * string the file chose — the unrecognised key, and the name of a base theme this build
 * does not have — and those are exactly the values that must not cross a boundary just to
 * be rendered. The count is the part that is useful ("this theme knows about colours yours
 * does not"); the attacker-chosen key is not.
 *
 * `token`, `filledFrom` and `usedInstead` are all ours: a `ColourToken` and built-in theme
 * ids.
 */
export type ThemeNotice =
  | {
      readonly kind: 'missing-token';
      readonly token: ColourToken;
      readonly filledFrom: string;
      readonly message: string;
    }
  | { readonly kind: 'unknown-tokens'; readonly count: number; readonly message: string }
  | { readonly kind: 'unknown-base'; readonly usedInstead: string; readonly message: string };

// ── Import ───────────────────────────────────────────────────────────────────

/**
 * A theme that parsed.
 *
 * `imported` cleared WCAG AA outright. `needs-review` cleared the legibility floor but
 * fails AA, so it loads into the studio — where the failures are listed and the user
 * decides — and the studio's existing gate keeps it off the app until they do. A theme
 * *below* the floor never reaches either state: it comes back as `theme/illegible` and the
 * renderer is never handed the palette at all.
 */
export interface ThemeImportAccepted {
  readonly kind: 'imported' | 'needs-review';
  /** The file's own name, for "imported from …". Never a path, never a directory. */
  readonly fileName: string;
  readonly theme: KeepTheme;
  readonly notices: readonly ThemeNotice[];
}

export type ThemeImportResponse =
  { readonly kind: 'cancelled' } | ThemeImportAccepted | ThemeFileRefusal;

// ── Export ───────────────────────────────────────────────────────────────────

/**
 * What the renderer asks to have written.
 *
 * A **theme object, not a blob of text.** The renderer does not get to choose the bytes
 * that land in a file the user named: the main process re-serialises from these fields
 * after re-validating them, so the file on disk is one this app wrote. That closes the gap
 * where a compromised renderer picks a `.keeptheme` filter in a save dialog and writes a
 * script through it.
 *
 * `acknowledgement` is the token from `contrastAcknowledgement`, echoed back by a renderer
 * that has shown the user the failing pairs. Anything else leaves a failing theme refused.
 */
export interface ThemeExportRequest {
  readonly theme: KeepTheme;
  readonly acknowledgement: string | null;
}

export type ThemeExportResponse =
  | { readonly kind: 'saved'; readonly fileName: string }
  | { readonly kind: 'cancelled' }
  | ThemeFileRefusal;

// ── The renderer-facing namespace ────────────────────────────────────────────

/**
 * `window.keyhold.theme`.
 *
 * Spread into `KeyholdApi` as `theme: ThemeApi` rather than written out there, for the same
 * reason `ImporterApi` is re-exported rather than restated: two copies of a signature list
 * diverge, and the one that compiles is not necessarily the one that is right.
 *
 * Named `importTheme` / `exportTheme` rather than `import` / `export`. Both are legal
 * property names, and both read as a syntax error at every call site.
 */
export interface ThemeApi {
  /** Opens the dialog, reads, parses. Cancelling is an outcome, not an error. */
  importTheme: () => Promise<IpcResult<ThemeImportResponse>>;
  /** Opens the dialog, re-validates, serialises, writes. Returns only a file name. */
  exportTheme: (request: ThemeExportRequest) => Promise<IpcResult<ThemeExportResponse>>;
  /** A theme the OS handed us, or `null` when none is waiting. */
  takeOpenedTheme: () => Promise<IpcResult<ThemeImportResponse | null>>;
  /**
   * Fires when the OS hands the app a `.keeptheme`. Returns an unsubscribe function.
   *
   * Payload-free by design: the listener's job is to call `takeOpenedTheme`, so no path or
   * file content rides on an event that a future edit might widen.
   */
  onFileOpened: (listener: () => void) => () => void;
}
