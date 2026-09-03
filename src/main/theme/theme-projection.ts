// SPDX-License-Identifier: GPL-3.0-or-later
import {
  THEME_ERROR_CODES,
  type ThemeFileRefusal,
  type ThemeImportResponse,
  type ThemeNotice,
} from '@shared/theme/theme-channels.js';
import type {
  KeepThemeParseResult,
  KeepThemeRejection,
  KeepThemeWarning,
} from '@shared/theme/keeptheme.js';
import type { ColourToken } from '@shared/theme/tokens.js';

/**
 * The one place a parsed `.keeptheme` is turned into something the renderer may see.
 *
 * This is the theme bridge's equivalent of the vault's safe projection, and it is a security
 * boundary for the same reason: what it copies is what a hostile file gets to put on screen.
 * `parseKeepTheme` produces a rich result full of diagnostics — including, deliberately, the
 * offending colour literal so a theme author can find their typo. Those diagnostics are
 * excellent inside this process and must not cross.
 *
 * ## The rule this file enforces
 *
 * **Nothing the file chose crosses, except `name` and `description`.** Everything else in a
 * response is either a constant written in this source tree, a `ColourToken` out of our own
 * vocabulary, a built-in theme id, a number, or a `#rrggbb` literal this app formatted from
 * parsed RGB channels.
 *
 * The palette is the reason. A palette value is written into a CSS custom property, and a
 * custom property is a place where a well-chosen string is an injection — `}` closes the
 * rule, `;` starts another declaration, `url(` and `expression(` are a fetch and, on old
 * engines, an evaluation. `normaliseColour` refuses all of those and re-emits the survivors
 * as `#rrggbb`, so the string that eventually reaches `style.setProperty` is one *we* wrote.
 * Projecting rather than forwarding means a future bug in that validator still cannot turn
 * into an injection, because a value that failed it is not in the object at all.
 *
 * `keeptheme-transport.test.ts` plants markers inside every field of a hostile file and
 * asserts none of them appears anywhere in the serialised response.
 *
 * ## Why the rejection messages are forwarded rather than rewritten
 *
 * Every top-level message `parseKeepTheme` produces is already written from constants, field
 * names and token names — never from a value in the file. Rewriting them here would create a
 * second set of strings saying the same things slightly differently, which is the duplicate
 * list rule 8 exists to prevent. The per-colour messages, which *do* quote the file, are the
 * ones that stop here: only the token names travel.
 */

function refuse(
  code: ThemeFileRefusal['code'],
  message: string,
  tokens: readonly ColourToken[] = []
): ThemeFileRefusal {
  return { kind: 'refused', code, message, tokens };
}

/**
 * Collapses parse warnings into notices carrying no file-chosen text.
 *
 * `unknown-token` warnings arrive one per unrecognised key and each names the key. The count
 * is the useful part — "this theme knows about colours your build does not" — and the key is
 * an attacker-chosen string with no reason to be on screen, so they collapse into one
 * notice. `unknown-base` loses the requested id for the same reason and keeps the id we
 * actually used, which is ours.
 */
export function projectWarnings(warnings: readonly KeepThemeWarning[]): readonly ThemeNotice[] {
  const notices: ThemeNotice[] = [];
  let unknownTokens = 0;

  for (const warning of warnings) {
    switch (warning.kind) {
      case 'unknown-token':
        unknownTokens += 1;
        break;

      case 'missing-token':
        // `token` is a `ColourToken` and `filledFrom` a built-in id, so the message — which
        // is built from those and the base theme's name — carries nothing from the file.
        notices.push({
          kind: 'missing-token',
          token: warning.token,
          filledFrom: warning.filledFrom,
          message: warning.message,
        });
        break;

      case 'unknown-base':
        notices.push({
          kind: 'unknown-base',
          usedInstead: warning.usedInstead,
          message: `This theme is based on a theme this build does not have. Missing colours were taken from ${warning.usedInstead} instead.`,
        });
        break;
    }
  }

  if (unknownTokens > 0) {
    notices.push({
      kind: 'unknown-tokens',
      count: unknownTokens,
      message: `Ignored ${unknownTokens} colour${unknownTokens === 1 ? '' : 's'} this build does not recognise. This theme may have been made for a newer version of Keyhold.`,
    });
  }

  return notices;
}

/**
 * Every rejection, as a refusal the renderer may see.
 *
 * Shared by both directions. On import, the `contrast` case is intercepted before this is
 * called and becomes `needs-review`; on export it lands here, because an export whose
 * acknowledgement is missing or stale is a refusal — the file would otherwise be written and
 * then refused by the next build that read it.
 */
export function projectRejection(rejection: KeepThemeRejection): ThemeFileRefusal {
  switch (rejection.kind) {
    case 'too-large':
      return refuse(THEME_ERROR_CODES.tooLarge, rejection.message);

    case 'not-json':
      return refuse(THEME_ERROR_CODES.notJson, rejection.message);

    case 'not-a-theme':
      return refuse(THEME_ERROR_CODES.notATheme, rejection.message);

    case 'future-version':
      // The only file-supplied datum in any response other than the name and description,
      // and it is a **number** that already satisfied `Number.isInteger`. A number cannot
      // carry markup, a quote, or a CSS token, and telling the user which format version
      // they were handed is the difference between "this failed" and "you need a newer
      // Keyhold".
      return refuse(THEME_ERROR_CODES.futureVersion, rejection.message);

    case 'invalid-field':
      return refuse(THEME_ERROR_CODES.invalidField, rejection.message);

    case 'invalid-colours':
      // The token names cross; the values do not. `rejection.message` names the tokens and
      // the count and nothing else — the per-colour messages, which quote the file back so
      // an author can find a typo, stop here.
      return refuse(
        THEME_ERROR_CODES.invalidColours,
        rejection.message,
        rejection.colours.map((colour) => colour.token)
      );

    case 'illegible':
      // No override exists for this one, anywhere in the app. See `admitPalette`: consent to
      // a theme you cannot read is consent you cannot revoke, because the screen that would
      // undo it is the screen the theme made unreadable.
      return refuse(THEME_ERROR_CODES.illegible, rejection.message);

    case 'contrast':
      // Reached only on export, and only when the renderer asked to write a theme that
      // fails AA without a matching acknowledgement. Neither the failing pairs nor the
      // token that would admit them cross: handing the renderer the token in response to an
      // unacknowledged request would make the consent gate self-serve, which is exactly the
      // shortcut `contrastAcknowledgement` exists to make impossible.
      return refuse(THEME_ERROR_CODES.notAcknowledged, rejection.message);
  }
}

/**
 * Projects a parse result for the renderer.
 *
 * `fileName` is supplied by the caller and is always a basename — never a directory, never
 * an absolute path. A path in a UI string is a small, free information leak that also ends
 * up in the screenshots people attach to bug reports.
 */
export function projectParseResult(
  result: KeepThemeParseResult,
  fileName: string
): ThemeImportResponse {
  if (result.ok) {
    return {
      kind: 'imported',
      fileName,
      theme: result.theme,
      notices: projectWarnings(result.warnings),
    };
  }

  // Not a refusal on the way in. It clears the legibility floor, so it loads into the studio
  // — where the failing pairs are listed — and the studio's gate keeps it off the app until
  // the user acknowledges them. Refusing here would hide the report that makes the choice
  // informed; see the three admission tiers in `admitPalette`.
  if (result.rejection.kind === 'contrast') {
    return {
      kind: 'needs-review',
      fileName,
      theme: result.rejection.theme,
      notices: projectWarnings(result.rejection.warnings),
    };
  }

  return projectRejection(result.rejection);
}
