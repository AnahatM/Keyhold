// SPDX-License-Identifier: GPL-3.0-or-later
import { deriveAccentRamp } from '@shared/theme/accent.js';
import {
  keepThemeFromDefinition,
  normaliseColour,
  normalisePalette,
  type ColourRejectionReason,
  type KeepTheme,
} from '@shared/theme/keeptheme.js';
import type { ThemeNotice } from '@shared/theme/theme-channels.js';
import { FALLBACK_THEME, findTheme } from '@shared/theme/themes.js';
import type { ColourToken, Palette } from '@shared/theme/tokens.js';

/**
 * The studio's editing state, as a pure reducer.
 *
 * Kept out of the components so the interesting behaviour — what a bad colour does, when an
 * acknowledgement goes stale, what "reset" means — is testable without rendering anything.
 * `@testing-library/react` is not a dependency of this project and adding one for a settings
 * screen would be the wrong trade, so everything that can be a pure function is one.
 *
 * ## The two-layer palette
 *
 * `palette` only ever holds canonical `#rrggbb` values. What the user is currently typing
 * lives in `typing`, and moves into `palette` only when it parses. That is what lets the
 * field show "not a colour" mid-keystroke instead of the preview flickering through the
 * meaningless intermediate states of `#`, `#3`, `#33`… — the same reasoning `accent.ts`
 * gives for returning `null` rather than throwing.
 */

export interface ThemeDraft {
  readonly name: string;
  readonly description: string;
  readonly scheme: 'light' | 'dark';
  /** The built-in this draft started from, and what "Reset" returns to. */
  readonly basedOn: string;
  readonly palette: Palette;
  /** Raw text per token, present only while a token is being edited. */
  readonly typing: Readonly<Record<string, string>>;
  readonly invalid: Readonly<Record<string, ColourRejectionReason>>;
  /**
   * The contrast override the user has given, or `null`.
   *
   * Cleared by **every** palette change, in one place (`withPalette`), so no future action
   * can forget to invalidate it.
   */
  readonly acknowledgement: string | null;
  /** Where this draft came from — a file name or a built-in's name. For display only. */
  readonly source: string | null;
  /**
   * Notes from the last import, shown until the draft is replaced.
   *
   * `ThemeNotice`, not `KeepThemeWarning`: the parse happens in the main process now, and
   * two of that type's three cases carry a string the imported file chose. `theme-projection.ts`
   * is where they are dropped, and this type is why nothing downstream can put one back.
   */
  readonly notices: readonly ThemeNotice[];
}

export type ThemeDraftAction =
  | { readonly type: 'set-colour'; readonly token: ColourToken; readonly text: string }
  | { readonly type: 'revert-colour'; readonly token: ColourToken }
  | { readonly type: 'set-name'; readonly name: string }
  | { readonly type: 'set-description'; readonly description: string }
  | { readonly type: 'set-scheme'; readonly scheme: 'light' | 'dark' }
  | { readonly type: 'apply-accent'; readonly colour: string }
  | {
      readonly type: 'load';
      readonly theme: KeepTheme;
      readonly source: string | null;
      readonly notices: readonly ThemeNotice[];
    }
  | { readonly type: 'reset' }
  | { readonly type: 'acknowledge'; readonly acknowledgement: string | null };

export function draftFromKeepTheme(
  theme: KeepTheme,
  source: string | null,
  notices: readonly ThemeNotice[] = []
): ThemeDraft {
  return {
    name: theme.name,
    description: theme.description,
    scheme: theme.scheme,
    basedOn: theme.basedOn,
    palette: normalisePalette(theme.palette),
    typing: {},
    invalid: {},
    acknowledgement: null,
    source,
    notices,
  };
}

export function draftFromThemeId(themeId: string): ThemeDraft {
  const definition = findTheme(themeId) ?? FALLBACK_THEME;
  return draftFromKeepTheme(keepThemeFromDefinition(definition), definition.name);
}

export function draftToKeepTheme(draft: ThemeDraft): KeepTheme {
  return {
    format: 'keyhold-theme',
    version: 1,
    name: draft.name.trim() === '' ? 'Untitled theme' : draft.name.trim(),
    description: draft.description.trim(),
    scheme: draft.scheme,
    basedOn: draft.basedOn,
    palette: draft.palette,
  };
}

export function hasInvalidColours(draft: ThemeDraft): boolean {
  return Object.keys(draft.invalid).length > 0;
}

/**
 * The single place a palette is replaced.
 *
 * Every palette change drops the acknowledgement, because consent was given to a specific
 * set of colours and a specific set of failures. Routing all of them through here is what
 * makes that true of actions written later, not just the ones written today.
 */
function withPalette(draft: ThemeDraft, palette: Palette): ThemeDraft {
  return { ...draft, palette, acknowledgement: null };
}

/**
 * A copy of `record` without one key.
 *
 * Rebuilt rather than spread-and-`delete`: deleting a computed key off a fresh object works,
 * but it is also the shape that quietly mutates a shared object when someone later drops the
 * spread, and this record is read straight into the editor's rendering.
 */
function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

export function themeDraftReducer(draft: ThemeDraft, action: ThemeDraftAction): ThemeDraft {
  switch (action.type) {
    case 'set-colour': {
      const typing = { ...draft.typing, [action.token]: action.text };
      const normalised = normaliseColour(action.text);

      if (!normalised.ok) {
        // The palette keeps its last good value, so the preview stays coherent and the
        // contrast report keeps reporting on something real while the field is mid-edit.
        return {
          ...draft,
          typing,
          invalid: { ...draft.invalid, [action.token]: normalised.reason },
        };
      }

      const next = withPalette(draft, { ...draft.palette, [action.token]: normalised.hex });
      return {
        ...next,
        typing,
        invalid: withoutKey(draft.invalid, action.token),
      };
    }

    case 'revert-colour':
      return {
        ...draft,
        typing: withoutKey(draft.typing, action.token),
        invalid: withoutKey(draft.invalid, action.token),
      };

    case 'set-name':
      return { ...draft, name: action.name };

    case 'set-description':
      return { ...draft, description: action.description };

    case 'set-scheme':
      // The scheme is not itself a colour, but it decides which way `accent.ts` pushes a
      // derived ramp, and which `color-scheme` the native controls get.
      return { ...draft, scheme: action.scheme };

    case 'apply-accent': {
      const ramp = deriveAccentRamp(action.colour, draft.palette, draft.scheme);
      // Unparseable input is a no-op here; the field validates and reports it. Silently
      // wrecking six tokens because someone was mid-type would be the worse behaviour.
      if (ramp === null) return draft;

      const next = withPalette(draft, { ...draft.palette, ...ramp });
      return {
        ...next,
        typing: {},
        invalid: {},
      };
    }

    case 'load':
      return draftFromKeepTheme(action.theme, action.source, action.notices);

    case 'reset': {
      const definition = findTheme(draft.basedOn) ?? FALLBACK_THEME;
      return draftFromKeepTheme(keepThemeFromDefinition(definition), definition.name);
    }

    case 'acknowledge':
      return { ...draft, acknowledgement: action.acknowledgement };
  }
}
