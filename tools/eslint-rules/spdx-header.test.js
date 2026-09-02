// SPDX-License-Identifier: GPL-3.0-or-later
import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
import { spdxHeader } from './spdx-header.js';

/**
 * Guard for the guard.
 *
 * CLAUDE.md requires every guard to be fault-injected with the exact bug it claims to
 * catch before it is trusted. The `invalid` cases below ARE that fault injection, and
 * they have already paid for themselves: the block-comment case caught a real hole in
 * the first version of the rule, which happily accepted `/* SPDX... *\/` because it
 * only compared the comment text and never its type.
 *
 * A rule whose failure path has never been exercised is a false sense of coverage,
 * not coverage.
 */

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
});

const HEADER = '// SPDX-License-Identifier: GPL-3.0-or-later';

describe('keyhold/spdx-header', () => {
  it('accepts a correct header', () => {
    ruleTester.run('spdx-header', spdxHeader, {
      valid: [
        { code: `${HEADER}\nexport const a = 1;\n` },
        // Whitespace inside the comment is tolerated; the identifier is what matters.
        { code: '//   SPDX-License-Identifier: GPL-3.0-or-later  \nexport const a = 1;\n' },
        // A file that is only the header is fine.
        { code: `${HEADER}\n` },
      ],
      invalid: [],
    });
  });

  it('rejects a missing header, and inserts one', () => {
    ruleTester.run('spdx-header', spdxHeader, {
      valid: [],
      invalid: [
        {
          code: 'export const a = 1;\n',
          errors: [{ messageId: 'missing' }],
          output: `${HEADER}\nexport const a = 1;\n`,
        },
      ],
    });
  });

  it('rejects a header that is not the first line — a scanner reading the top would miss it', () => {
    ruleTester.run('spdx-header', spdxHeader, {
      valid: [],
      invalid: [
        {
          code: `export const a = 1;\n${HEADER}\n`,
          errors: [{ messageId: 'missing' }],
          output: `${HEADER}\nexport const a = 1;\n${HEADER}\n`,
        },
      ],
    });
  });

  it('rejects a block comment — the convention is the // form, and accepting both means drifting into both', () => {
    ruleTester.run('spdx-header', spdxHeader, {
      valid: [],
      invalid: [
        {
          code: '/* SPDX-License-Identifier: GPL-3.0-or-later */\nexport const a = 1;\n',
          errors: [{ messageId: 'missing' }],
          output: `${HEADER}\n/* SPDX-License-Identifier: GPL-3.0-or-later */\nexport const a = 1;\n`,
        },
      ],
    });
  });

  it('reports a wrong licence WITHOUT auto-fixing — two conflicting SPDX lines is worse', () => {
    ruleTester.run('spdx-header', spdxHeader, {
      valid: [],
      invalid: [
        {
          code: '// SPDX-License-Identifier: MIT\nexport const a = 1;\n',
          errors: [{ messageId: 'wrongLicence' }],
          // No `output` key means the rule must not produce a fix for this case.
          output: null,
        },
      ],
    });
  });
});
