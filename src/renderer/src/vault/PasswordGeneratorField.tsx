// SPDX-License-Identifier: GPL-3.0-or-later
import { useMemo } from 'react';
import { ruleForUrl, type SiteRule } from '@shared/model/site-rules.js';
import { Icon } from '../components/Icon.js';
import { InlineGenerator } from '../generator/index.js';
import { useSiteRules } from '../organisation/site-rule-store.js';

/**
 * The generator, beside the password field in the editor, honouring this site's own rule.
 *
 * ## Why this component exists at all
 *
 * `InlineGenerator` was written, tested and exported, and mounted nowhere — the same shape as
 * the activity log and the setup tour before them. A user editing a credential had a password
 * box and no way to fill it, while a complete generator sat one import away. This is the
 * mount, plus the one thing the generator cannot know on its own: which site the password is
 * for.
 *
 * ## The rule is resolved from the URL in the form, not from the saved record
 *
 * Somebody typing a new credential has not saved anything yet, and somebody correcting a URL
 * expects the next password to obey the *new* site's rule. Reading the saved record would get
 * both cases wrong in the same direction — silently generating against a constraint that no
 * longer applies, which is exactly the failure per-site rules exist to prevent.
 *
 * ## No rule is the normal case, and says nothing
 *
 * Most sites have no constraint worth recording. A banner reading "no rule for this site" on
 * every ordinary credential would be noise that teaches people to stop reading the line that
 * matters. It speaks only when a rule *is* being applied, because that is the case where the
 * user needs to know why the generator did something unexpected — a shorter password, a
 * missing character class.
 */

export interface PasswordGeneratorFieldProps {
  /** The URLs currently in the form, in order. The first that resolves a rule wins. */
  readonly urls: readonly string[];
  readonly onUse: (secret: string) => void;
}

export function PasswordGeneratorField({
  urls,
  onUse,
}: PasswordGeneratorFieldProps): React.JSX.Element {
  const rules = useSiteRules((state) => state.rules);

  const rule = useMemo<SiteRule | null>(() => {
    for (const url of urls) {
      const match = ruleForUrl(rules, url);
      if (match !== null) return match;
    }
    return null;
  }, [rules, urls]);

  return (
    <div className="kh-editor__generate">
      <InlineGenerator onUse={onUse} openLabel="Generate a password" useLabel="Use this password" />

      {rule !== null && (
        <p className="kh-editor__rule">
          <Icon name="wrench" size="sm" /> Using your saved rule for{' '}
          <code className="kh-path">{rule.host}</code>
          {rule.note === undefined ? '.' : ` — ${rule.note}.`}
        </p>
      )}
    </div>
  );
}
