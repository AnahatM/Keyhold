// SPDX-License-Identifier: GPL-3.0-or-later
import { useId } from 'react';
import {
  IMPORT_DUPLICATE_ACTIONS,
  type ImportDuplicateAction,
  type ImportDuplicateGroup,
} from '@shared/model/import-plan.js';
import { Badge } from '../components/Feedback.js';
import {
  decisionFor,
  DUPLICATE_ACTION_COPY,
  MERGE_EFFECT_COPY,
  mergeReplacesPassword,
} from './duplicate-decisions.js';
import { SecretMask } from './SecretMask.js';
import './import.css';

/**
 * The duplicates, and what to do about each one.
 *
 * This is the wizard's reason to exist. Every other step is plumbing; **this** is the
 * difference between an importer someone can run twice and one they can only run once and
 * hope. A user who imports the same export a second time — because the first attempt was
 * interrupted, because they were not sure it worked — must not end up with two of everything.
 *
 * Three deliberate choices:
 *
 * - **Every group is shown, and every group is decidable.** No "resolve all duplicates
 *   automatically" that hides what it did.
 * - **The default is `skip` and it is stated as the default**, because it is the only answer
 *   that cannot go wrong: nothing is added and nothing is changed.
 * - **`merge` shows what it would replace before it is chosen.** Overwriting the password the
 *   user is currently using with one out of a file of unknown age is the most expensive
 *   mistake this screen can make, so it is never a surprise.
 */
export function DuplicateGroupList({
  groups,
  decisions,
  onDecision,
  onDecideAll,
}: {
  readonly groups: readonly ImportDuplicateGroup[];
  readonly decisions: Readonly<Record<string, ImportDuplicateAction>>;
  readonly onDecision: (key: string, action: ImportDuplicateAction) => void;
  readonly onDecideAll: (action: ImportDuplicateAction) => void;
}): React.JSX.Element {
  const bulkId = useId();

  if (groups.length === 0) {
    return (
      <section className="kh-import-section">
        <h4 className="kh-import-section__heading">Duplicates</h4>
        <p className="kh-import-section__lead">
          <span aria-hidden="true">✓ </span>
          Nothing in this file matches anything already in your vault, and nothing in it is
          repeated. Everything here is new.
        </p>
      </section>
    );
  }

  return (
    <section className="kh-import-section" aria-labelledby={`${bulkId}-heading`}>
      <h4 className="kh-import-section__heading" id={`${bulkId}-heading`}>
        Duplicates ({groups.length})
      </h4>
      <p className="kh-import-section__lead">
        Matched on the title, the login and the web address — the three things you can see below.
        Every one is set to <strong>skip</strong> unless you change it, so importing twice does not
        give you two of everything.
      </p>

      <div className="kh-import-bulk">
        <span id={`${bulkId}-bulk-label`} className="kh-import-bulk__label">
          Apply to all {groups.length}:
        </span>
        {/* A group of buttons, not a select: each is one keystroke away and each says what it
            does, where a dropdown hides two of the three answers behind an interaction. */}
        <div
          role="group"
          aria-labelledby={`${bulkId}-bulk-label`}
          className="kh-import-bulk__actions"
        >
          {IMPORT_DUPLICATE_ACTIONS.map((action) => (
            <button
              key={action}
              type="button"
              className="kh-button kh-button--secondary kh-button--sm"
              onClick={() => {
                onDecideAll(action);
              }}
            >
              <span className="kh-button__label">{DUPLICATE_ACTION_COPY[action].label} all</span>
            </button>
          ))}
        </div>
      </div>

      <ul className="kh-import-groups">
        {groups.map((group) => (
          <li key={group.key}>
            <DuplicateGroupCard
              group={group}
              action={decisionFor(decisions, group.key)}
              onDecision={onDecision}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function DuplicateGroupCard({
  group,
  action,
  onDecision,
}: {
  readonly group: ImportDuplicateGroup;
  readonly action: ImportDuplicateAction;
  readonly onDecision: (key: string, action: ImportDuplicateAction) => void;
}): React.JSX.Element {
  const groupId = useId();
  const withinFile = group.existing === null;
  const first = group.incoming[0];

  return (
    <section className="kh-import-group" aria-labelledby={`${groupId}-title`}>
      <header className="kh-import-group__header">
        <h5 className="kh-import-group__title" id={`${groupId}-title`}>
          {first?.title ?? group.matchedOn.title}
        </h5>
        <Badge tone={withinFile ? 'info' : 'warning'} symbol={withinFile ? '⧉' : '⚠'}>
          {withinFile ? `${group.incoming.length} copies in this file` : 'Already in your vault'}
        </Badge>
      </header>

      <dl className="kh-import-group__match">
        <div>
          <dt>Login</dt>
          <dd>{group.matchedOn.identity === '' ? 'none' : group.matchedOn.identity}</dd>
        </div>
        <div>
          <dt>Site</dt>
          <dd>{group.matchedOn.host === '' ? 'none' : group.matchedOn.host}</dd>
        </div>
        <div>
          <dt>Rows in the file</dt>
          <dd>{group.incoming.length}</dd>
        </div>
      </dl>

      {group.existing !== null && (
        <p className="kh-import-group__existing">
          In your vault: <SecretMask length={group.existing.passwordLength} what="password" />{' '}
          <span className="kh-import-group__existing-meta">
            — last changed {new Date(group.existing.updatedAt).toLocaleDateString()}
          </span>
        </p>
      )}

      <fieldset className="kh-import-fieldset kh-import-fieldset--inline">
        <legend className="kh-visually-hidden">
          What to do about {first?.title ?? group.matchedOn.title}
        </legend>
        {IMPORT_DUPLICATE_ACTIONS.map((option) => (
          <label key={option} className="kh-import-choice kh-import-choice--compact">
            <input
              type="radio"
              name={`${groupId}-action`}
              value={option}
              checked={action === option}
              onChange={() => {
                onDecision(group.key, option);
              }}
            />
            <span className="kh-import-choice__body">
              <span className="kh-import-choice__label">
                {DUPLICATE_ACTION_COPY[option].label}
                {option === 'skip' && <span className="kh-import-choice__tag">Default</span>}
              </span>
              <span className="kh-import-choice__help">{DUPLICATE_ACTION_COPY[option].help}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {action === 'merge' && (
        <div
          className={
            mergeReplacesPassword(group)
              ? 'kh-import-merge kh-import-merge--danger'
              : 'kh-import-merge'
          }
        >
          <p className="kh-import-merge__lead">
            {mergeReplacesPassword(group) ? (
              <>
                <span aria-hidden="true">⚠ </span>
                <strong>This would replace the password you are using now.</strong> If the file is
                older than your vault, that is a working password swapped for a stale one.
              </>
            ) : (
              'Merging would change:'
            )}
          </p>
          {group.mergeableFields.length === 0 ? (
            <p className="kh-import-merge__item">
              Nothing — the file has nothing this record does not already have.
            </p>
          ) : (
            <ul className="kh-import-merge__items">
              {group.mergeableFields.map((field) => (
                <li key={field.field}>
                  <strong>{field.field}</strong> — {MERGE_EFFECT_COPY[field.effect]}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
