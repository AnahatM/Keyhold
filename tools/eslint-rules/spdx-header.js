// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Requires an SPDX licence identifier as the first line of every source file.
 *
 * Keyhold is GPL-3.0-or-later and distributed as source; a per-file identifier is how
 * automated licence scanners — and humans reading a single file out of context — know
 * that. Written as a local rule rather than pulling a dependency because it is forty
 * lines and every published plugin for this is either unmaintained or flat-config
 * hostile.
 *
 * Two distinct failures, deliberately handled differently:
 *
 *   missing      — no header, or one that is not the first line comment in the file.
 *                  Safe to auto-fix by inserting.
 *   wrongLicence — a header is there, at the top, but names a different licence.
 *                  NOT auto-fixed: inserting would leave two contradictory SPDX lines
 *                  in one file, which is worse than the original problem. A human
 *                  decides, because a different licence may be deliberate (vendored code).
 *
 * Guard for this guard: spdx-header.test.js
 */

const EXPECTED = 'SPDX-License-Identifier: GPL-3.0-or-later';
const SPDX_PREFIX = 'SPDX-License-Identifier:';

/** @type {import('eslint').Rule.RuleModule} */
export const spdxHeader = {
  meta: {
    type: 'suggestion',
    docs: { description: 'require an SPDX licence identifier at the top of each file' },
    fixable: 'whitespace',
    schema: [],
    messages: {
      missing: `Missing licence header. The first line must be: // ${EXPECTED}`,
      wrongLicence: `Wrong licence header: found "{{found}}". Keyhold is GPL-3.0-or-later. Fix it by hand — auto-fixing would leave two conflicting SPDX lines.`,
    },
  },
  create(context) {
    return {
      Program(node) {
        const source = context.sourceCode ?? context.getSourceCode();
        const [first] = source.getAllComments();

        // The header must be the very first thing in the file, and must be a LINE
        // comment. A block comment does not count: scanners and humans both expect
        // the `//` form, and accepting both means the codebase drifts into having both.
        const isHeaderSlot = first !== undefined && first.range[0] === 0 && first.type === 'Line';

        if (isHeaderSlot && first.value.trim() === EXPECTED) return;

        if (isHeaderSlot && first.value.trim().startsWith(SPDX_PREFIX)) {
          context.report({
            node,
            messageId: 'wrongLicence',
            data: { found: first.value.trim() },
          });
          return;
        }

        context.report({
          node,
          messageId: 'missing',
          fix: (fixer) => fixer.insertTextBeforeRange([0, 0], `// ${EXPECTED}\n`),
        });
      },
    };
  },
};

export default {
  rules: { 'spdx-header': spdxHeader },
};
